// Colours for the NHL tab. Everything is built from the site's percentile bins
// (BIN_COLORS in baseball/SharedComponents.jsx): blue = below average, grey = average, red = above.

const hex = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));

// Blue -> grey -> red through the bin colours, as a smooth scale for a 0-100 percentile.
// The darkest blue disappears on a dark card, so the low end is lifted there.
const stops = isDark => [
  [0, isDark ? "#11509F" : "#08306B"], [17.5, "#2171B5"], [35, "#6BAED6"], [50, "#D9D9D9"],
  [65, "#FC9272"], [82.5, "#FB6A4A"], [100, "#CB181D"],
].map(([p, h]) => [p, hex(h)]);
const STOPS = { true: stops(true), false: stops(false) };

export function spectrumRgb(pct, isDark = true) {
  const s = STOPS[!!isDark];
  const p = Math.max(0, Math.min(100, pct));
  let i = 1;
  while (i < s.length - 1 && p > s[i][0]) i++;
  const [p0, a] = s[i - 1], [p1, b] = s[i];
  const u = (p - p0) / (p1 - p0);
  return a.map((c, k) => Math.round(c + (b[k] - c) * u));
}
export const spectrum = (pct, isDark) => `rgb(${spectrumRgb(pct, isDark).join(",")})`;

// Black or white text, whichever reads better on a fill.
export function inkOn(rgb) {
  const [r, g, b] = rgb.map(c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#111111" : "#ffffff";
}

export const POSITIVE = "#CB181D";   // adds value
export const NEGATIVE = "#2171B5";   // costs value

// Impact-by-season tier bands, best tier first: bold -> neutral -> bold.
// Four for forwards (the four lines), three for defensemen (pairs) and goalies (roles).
// Skaters below the last line or pair ("Depth") sit on the plain card below the bands.
export const TIERS = {
  F: ["1st line", "2nd line", "3rd line", "4th line", "Depth"],
  D: ["1st pair", "2nd pair", "3rd pair", "Depth"],
  G: ["Starter (1)", "1B", "Backup"],
};
export const TIER_COLORS = {
  F: { "1st line": "#CB181D", "2nd line": "#FC9272", "3rd line": "#6BAED6", "4th line": "#2171B5" },
  D: { "1st pair": "#CB181D", "2nd pair": "#BDBDBD", "3rd pair": "#2171B5" },
  G: { "Starter (1)": "#CB181D", "1B": "#BDBDBD", "Backup": "#2171B5" },
};

export function luminance(hexColor) {
  return hex(hexColor).reduce((sum, c, i) => {
    const v = c / 255;
    return sum + (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)) * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}
