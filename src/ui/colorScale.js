// ═══════════════════════════════════════════════════════════
// ONE COLOR SCALE FOR THE WHOLE SITE
// ═══════════════════════════════════════════════════════════
// Every color that encodes a value (percentiles, Plus stats, stat-vs-average cells,
// density maps, NHL tiers and signed bars) comes from here. Categorical colors (pitch
// types, team colors) and UI chrome do not.
//
// The scale runs 0 (worst) → 50 (average, neutral) → 100 (best). Change ACTIVE_PALETTE
// to re-color the site; /palette previews every option.

const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
const rgbStr = rgb => `rgb(${rgb.join(",")})`;
const even5 = hs => hs.map((h, i) => [i * 25, h]);

// `stops`: [percentile, hex]. `darkLift`: replaces the first stop on dark cards, where
// the deepest end would otherwise disappear into the background.
export const PALETTES = {
  iceFire: {
    name: "Ice → Fire", diverging: true,
    // Bad = glacier ice (cyan hue ≈ 192°), fading evenly through frost to warm peach,
    // then building to a strong pure orange (hue ≈ 28–33°, short of red) at the top.
    // Same hues in both themes, saturated; light mode is a deeper set so the ice and
    // the pale middle still read on a white card.
    stops: [[0, "#5EC3DA"], [18, "#8AD3E5"], [36, "#BCE6F1"], [50, "#E2E8EC"],
            [64, "#FFC791"], [80, "#FF9B33"], [100, "#FF7300"]],
    stopsLight: [[0, "#2FA6C4"], [18, "#5DBFD8"], [36, "#9AD7E7"], [50, "#CDD6DD"],
                 [64, "#FFB061"], [80, "#FF8A14"], [100, "#EE6A00"]],
  },
  purpleGold:  { name: "Purple → gold",       diverging: true,  stops: even5(["#3B1C6E", "#8A6FC4", "#CFCFD4", "#F2B84B", "#C98A00"]), darkLift: "#5A3A99" },
  tealOrange:  { name: "Teal → orange",       diverging: true,  stops: even5(["#00535C", "#3FA7A8", "#D4D4D4", "#F28C4B", "#C4420F"]), darkLift: "#0B7A85" },
  brandBlueAmber: { name: "Brand blue → amber", diverging: true, stops: even5(["#1E3A8A", "#60A5FA", "#D1D5DB", "#FBBF24", "#D97706"]), darkLift: "#2F4FB0" },
  pinkGreen:   { name: "Pink → green",        diverging: true,  stops: even5(["#8E0152", "#DE77AE", "#D9D9D9", "#7FBC41", "#276419"]), darkLift: "#B0206F" },
  indigoCoral: { name: "Indigo → coral",      diverging: true,  stops: even5(["#2E2A7A", "#7B7FD1", "#D6D6DA", "#FF8F70", "#D9472B"]), darkLift: "#4440A8" },
  navyEmerald: { name: "Navy → emerald",      diverging: true,  stops: even5(["#1E3A5F", "#6C8EB5", "#D1D5DB", "#34D399", "#047857"]), darkLift: "#2D5584" },
  iceMagenta:  { name: "Ice → magenta",       diverging: true,  stops: even5(["#0E7490", "#22D3EE", "#94A3B8", "#F472B6", "#BE185D"]) },
  amberRamp:   { name: "Amber ramp",          diverging: false, stops: even5(["#334155", "#6B5B45", "#B07A1E", "#F59E0B", "#FDE68A"]), darkLift: "#475569" },
  viridis:     { name: "Viridis",             diverging: false, stops: even5(["#440154", "#3B528B", "#21918C", "#5EC962", "#FDE725"]), darkLift: "#5B2A86" },
  savant: {
    name: "Savant blue → red (current)", diverging: true,
    stops: [[0, "#08306B"], [17.5, "#2171B5"], [35, "#6BAED6"], [50, "#D9D9D9"],
            [65, "#FC9272"], [82.5, "#FB6A4A"], [100, "#CB181D"]],
    darkLift: "#11509F",
  },
};

export const ACTIVE_PALETTE = "iceFire";

// Black or white text, whichever reads better on a fill.
export function inkOn(rgb) {
  const [r, g, b] = rgb.map(c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#111111" : "#ffffff";
}

// inkOn for any color string ("#rrggbb", "#rrggbbaa" ignoring alpha, "rgb(...)").
export function inkOnColor(color, fallback = "#ffffff") {
  if (!color || typeof color !== "string") return fallback;
  const rgb = color.startsWith("#") ? hexRgb(color.slice(0, 7)) : (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  return rgb.length === 3 && rgb.every(Number.isFinite) ? inkOn(rgb) : fallback;
}

// Any color string or rgb array → rgba() at the given alpha.
export function tint(color, alpha) {
  if (color == null) return null;
  let rgb = color;
  if (typeof color === "string") {
    if (color.startsWith("#")) rgb = hexRgb(color);
    else rgb = (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  }
  return `rgba(${rgb.map(Math.round).join(",")},${(+alpha).toFixed(2)})`;
}

// Text drawn in a scale color on a card: very dark colors are lifted toward white on a
// dark card, and very light ones (the icy end, the frost middle) are deepened on a
// light card, keeping the hue so it still reads as ice or fire.
export function readableOnCard(color, t) {
  if (!color) return t.textFaint;
  const m = color.startsWith("#")
    ? hexRgb(color)
    : (color.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
  const lin = c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
  const L = 0.2126 * lin(m[0]) + 0.7152 * lin(m[1]) + 0.0722 * lin(m[2]);
  if (t.id === "dark" && L < 0.12) return rgbStr(m.map(c => Math.round(c + (255 - c) * 0.4)));
  if (t.id === "light" && L > 0.25) {
    // Same hue and saturation, lightness capped at 38%: orange stays orange (not brown),
    // ice becomes a deep glacier teal.
    const [h, s, l] = rgbToHsl(m);
    return rgbStr(hslToRgb([h, Math.max(s, 0.45), Math.min(l, 0.38)]));
  }
  return color;
}

function rgbToHsl([r, g, b]) {
  r /= 255; g /= 255; b /= 255;
  const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l = (mx + mn) / 2;
  if (mx === mn) return [0, 0, l];
  const d = mx - mn, s = l > 0.5 ? d / (2 - mx - mn) : d / (mx + mn);
  const h = mx === r ? ((g - b) / d + (g < b ? 6 : 0)) : mx === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h / 6, s, l];
}
function hslToRgb([h, s, l]) {
  if (s === 0) return [l, l, l].map(v => Math.round(v * 255));
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s, p = 2 * l - q;
  const f = tt => { tt = (tt + 1) % 1; return tt < 1 / 6 ? p + (q - p) * 6 * tt : tt < 1 / 2 ? q : tt < 2 / 3 ? p + (q - p) * (2 / 3 - tt) * 6 : p; };
  return [f(h + 1 / 3), f(h), f(h - 1 / 3)].map(v => Math.round(v * 255));
}

// Standard normal CDF (Abramowitz–Stegun 7.1.26), for turning a Plus stat into a percentile.
function normCdf(z) {
  const x = Math.abs(z) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * x);
  const erf = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return z >= 0 ? (1 + erf) / 2 : (1 - erf) / 2;
}

export function makeScale(key = ACTIVE_PALETTE) {
  const pal = PALETTES[key] || PALETTES[ACTIVE_PALETTE];
  const build = isDark => (!isDark && pal.stopsLight ? pal.stopsLight : pal.stops).map(([p, h], i) => {
    if (i === 0 && isDark && pal.darkLift) h = pal.darkLift;
    if (i === 0 && !isDark && pal.lightLift) h = pal.lightLift;
    return [p, hexRgb(h)];
  });
  const STOPS = { true: build(true), false: build(false) };

  // 0–100 percentile → [r, g, b], smooth between the stops.
  const pctRgb = (pct, isDark = true) => {
    const s = STOPS[!!isDark];
    const p = clamp(pct, 0, 100);
    let i = 1;
    while (i < s.length - 1 && p > s[i][0]) i++;
    const [p0, a] = s[i - 1], [p1, b] = s[i];
    const u = (p - p0) / (p1 - p0);
    return a.map((c, k) => Math.round(c + (b[k] - c) * u));
  };
  const ok = v => v != null && isFinite(v);
  const pctColor = (pct, isDark = true) => (ok(pct) ? rgbStr(pctRgb(pct, isDark)) : null);
  // Hex form, for callers that append an alpha suffix (`${color}cc`) or parse hex.
  const pctHex = (pct, isDark = true) =>
    (ok(pct) ? "#" + pctRgb(pct, isDark).map(c => c.toString(16).padStart(2, "0")).join("") : null);
  const pctInk = (pct, isDark = true) => (ok(pct) ? inkOn(pctRgb(pct, isDark)) : null);

  // 100-centered Plus stats (league sd ≈ 10) → percentile → color.
  const plusPct = (v, sd = 10) => (ok(v) ? 100 * normCdf((v - 100) / sd) : null);
  const plusColor = (v, isDark = true, sd = 10) => pctColor(plusPct(v, sd), isDark);

  // A signed, normalized difference from average (−1 … 1, already flipped so + is good)
  // → percentile on the scale.
  const diffPct = d => (ok(d) ? 50 + 50 * clamp(d, -1, 1) : null);
  const diffColor = (d, isDark = true) => pctColor(diffPct(d), isDark);

  // Density maps: 0 → 1 across the whole scale, more opaque as it gets denser.
  const densityColor = (t, isDark = true) => {
    if (!ok(t) || t <= 0) return "transparent";
    const u = Math.min(1, t);
    return tint(pctRgb(u * 100, isDark), 0.35 + u * 0.6);
  };

  // Table cells / stat chips: a translucent fill that gets stronger away from average,
  // plus the text color that reads on that fill over the given card background.
  // Returns null near average (|pct − 50| < 4) so plain cells stay plain.
  // On dark cards a thin warm tint over navy turns muddy brown, so dark mode fills
  // with the scale color at near-full strength and lets the scale's own lightness
  // near average do the softening.
  const cell = (pct, isDark = true, cardBg = isDark ? "#111827" : "#ffffff", minA = 0.22, maxA = 0.86) => {
    if (!ok(pct)) return null;
    const d = Math.abs(pct - 50);
    if (pal.diverging && d < 4) return null;
    if (isDark) { minA = Math.max(minA, 0.82); maxA = Math.max(maxA, 0.95); }
    const a = minA + (maxA - minA) * Math.min(1, (pal.diverging ? (d - 4) / 46 : pct / 100));
    const fg = pctRgb(pct, isDark);
    const bg = cardBg.startsWith("#") ? hexRgb(cardBg) : (cardBg.match(/[\d.]+/g) || []).slice(0, 3).map(Number);
    const mixed = fg.map((c, k) => Math.round(c * a + bg[k] * (1 - a)));
    return { bg: tint(fg, a), border: tint(fg, Math.min(1, a + 0.15)), ink: inkOn(mixed), solid: rgbStr(fg) };
  };

  return {
    key, name: pal.name, diverging: pal.diverging, stops: pal.stops,
    pctRgb, pctColor, pctHex, pctInk, plusPct, plusColor, diffPct, diffColor, densityColor, cell,
    // Ends and middle, for signed bars and legends.
    positive: rgbStr(pctRgb(88, true)),
    negative: rgbStr(pctRgb(12, false)),
    neutral: rgbStr(pctRgb(50, true)),
    gradient: (isDark = true, n = 20) =>
      `linear-gradient(90deg, ${Array.from({ length: n + 1 }, (_, i) => rgbStr(pctRgb((i / n) * 100, isDark))).join(", ")})`,
  };
}

const SCALE = makeScale(ACTIVE_PALETTE);
export default SCALE;
export const {
  pctRgb, pctColor, pctHex, pctInk, plusPct, plusColor, diffPct, diffColor, densityColor, cell,
} = SCALE;
export const POSITIVE = SCALE.positive;
export const NEGATIVE = SCALE.negative;
export const NEUTRAL = SCALE.neutral;
