import { useState, useEffect, useId, useMemo } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { useTheme } from "./ThemeContext.jsx";

// ── Percentile bin colors ──
export const BIN_COLORS = {
  "0-10": "#08306B", "10-25": "#2171B5", "25-45": "#6BAED6",
  "45-55": "#D9D9D9", "55-75": "#FC9272", "75-90": "#FB6A4A", "90-100": "#CB181D",
};
export const pctToBin = (p) => {
  if (p == null || !isFinite(p)) return "NA";
  if (p >= 90) return "90-100"; if (p >= 75) return "75-90";
  if (p >= 55) return "55-75";  if (p >= 45) return "45-55";
  if (p >= 25) return "25-45";  if (p >= 10) return "10-25";
  return "0-10";
};
export const binColor = (p) => BIN_COLORS[pctToBin(p)] || "#333";
export const textOnBin = (p) => {
  if (p == null) return "#aaa";
  return (p < 25 || p >= 75) ? "#fff" : "#111";
};

// ── MLB team primary colors (all known abbreviation variants) ──
export const MLB_TEAM_PRIMARY = {
  // Standard + Fangraphs/Savant variants
  ARI: "#A71930", AZ:  "#A71930",              // Arizona
  ATL: "#CE1141",                              // Atlanta
  BAL: "#DF4601",                              // Baltimore
  BOS: "#BD3039",                              // Boston
  CHC: "#0E3386",                              // Cubs
  CWS: "#27251F", CHW: "#27251F",              // White Sox
  CIN: "#C6011F",                              // Cincinnati
  CLE: "#00385D",                              // Cleveland
  COL: "#33006F",                              // Colorado
  DET: "#0C2340",                              // Detroit
  HOU: "#002D62",                              // Houston
  KC:  "#004687", KCR: "#004687",              // Kansas City
  LAA: "#BA0021",                              // Angels
  LAD: "#005A9C",                              // Dodgers
  MIA: "#00A3E0",                              // Miami
  MIL: "#FFC52F",                              // Milwaukee
  MIN: "#002B5C",                              // Minnesota
  NYM: "#002D72",                              // Mets
  NYY: "#003087",                              // Yankees
  OAK: "#003831", ATH: "#003831",              // Athletics
  PHI: "#E81828",                              // Philadelphia
  PIT: "#FDB827",                              // Pittsburgh
  SD:  "#2F241D", SDP: "#2F241D",              // San Diego
  SEA: "#0C2C56",                              // Seattle
  SF:  "#FD5A1E", SFG: "#FD5A1E",              // San Francisco
  STL: "#C41E3A",                              // St. Louis
  TB:  "#092C5C", TBR: "#092C5C",              // Tampa Bay
  TEX: "#003278",                              // Texas
  TOR: "#134A8E",                              // Toronto
  WSH: "#AB0003", WSN: "#AB0003",              // Washington

  // AAA affiliates → parent org color
  SWB: "#003087",                              // Scranton/WB RailRiders → NYY
  WOR: "#BD3039",                              // Worcester Red Sox → BOS
  BUF: "#134A8E",                              // Buffalo Bisons → TOR
  DUR: "#092C5C",                              // Durham Bulls → TB
  NOR: "#DF4601",                              // Norfolk Tides → BAL
  CLB: "#00385D",                              // Columbus Clippers → CLE
  STP: "#002B5C",                              // St. Paul Saints → MIN
  CLT: "#27251F",                              // Charlotte Knights → CWS
  TOL: "#0C2340",                              // Toledo Mud Hens → DET
  OMA: "#004687",                              // Omaha Storm Chasers → KC
  SUG: "#002D62", SL:  "#002D62",             // Sugar Land Space Cowboys → HOU
  TAC: "#0C2C56",                              // Tacoma Rainiers → SEA
  SLC: "#BA0021",                              // Salt Lake Bees → LAA
  RR:  "#003278",                              // Round Rock Express → TEX
  LV:  "#003831",                              // Las Vegas Aviators → ATH
  SYR: "#002D72",                              // Syracuse Mets → NYM
  GWN: "#CE1141",                              // Gwinnett Stripers → ATL
  LHV: "#E81828",                              // Lehigh Valley IronPigs → PHI
  JAX: "#00A3E0",                              // Jacksonville Jumbo Shrimp → MIA
  ROC: "#AB0003",                              // Rochester Red Wings → WSH
  IOW: "#0E3386",                              // Iowa Cubs → CHC
  MEM: "#C41E3A",                              // Memphis Redbirds → STL
  NAS: "#FFC52F",                              // Nashville Sounds → MIL
  IND: "#FDB827",                              // Indianapolis Indians → PIT
  LOU: "#C6011F",                              // Louisville Bats → CIN
  OKC: "#005A9C",                              // Oklahoma City Baseball Club → LAD
  RNO: "#A71930",                              // Reno Aces → ARI
  EP:  "#2F241D", ELP: "#2F241D",             // El Paso Chihuahuas → SD
  SAC: "#FD5A1E",                              // Sacramento River Cats → SF
  ABQ: "#33006F",                              // Albuquerque Isotopes → COL
};

export function hexLuminance(hex) {
  return [hex.slice(1,3), hex.slice(3,5), hex.slice(5,7)].reduce((sum, h, i) => {
    const c = parseInt(h, 16) / 255;
    const lin = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return sum + lin * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

// ── Player bio hook — fetches age/height/weight/hand/birthplace from MLB API ──
export function useBio(playerId) {
  const [bio, setBio] = useState(null);
  useEffect(() => {
    if (!playerId) return;
    setBio(null);
    fetch(`/mlb-api/api/v1/people/${playerId}?fields=people,id,currentAge,height,weight,batSide,pitchHand,birthCity,birthStateProvince,birthCountry`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { const p = d?.people?.[0]; if (p) setBio(p); })
      .catch(() => {});
  }, [playerId]);
  return bio;
}

export function buildBioSubtitle(bio, hand) {
  if (!bio) return null;
  const parts = [];
  if (bio.currentAge) parts.push(`Age ${bio.currentAge}`);
  if (bio.height) parts.push(bio.height);
  if (bio.weight) parts.push(`${bio.weight} lbs`);
  if (hand === "bats" && bio.batSide?.code) parts.push(`Bats: ${bio.batSide.code}`);
  if (hand === "throws" && bio.pitchHand?.code) parts.push(`Throws: ${bio.pitchHand.code}`);
  const city = bio.birthCity || "";
  const state = bio.birthStateProvince || "";
  const country = bio.birthCountry || "";
  const place = city ? (state ? `${city}, ${state}` : country && country !== "USA" ? `${city}, ${country}` : city) : "";
  if (place) parts.push(place);
  return parts.join(" · ") || null;
}

// ── MLB Team ID mapping (for logos) ──

// Strip diacritics for accent-insensitive matching
export const norm = s => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Fuzzy name key: strip accents, periods, commas, Jr/Sr suffixes, extra spaces
const nameKey = s => norm(s).replace(/[.\-,]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

// Fuzzy lookup into an object by normalized name
export function fuzzyLookup(obj, name) {
  if (!obj || !name) return undefined;
  // Try exact match first
  if (obj[name] !== undefined) return obj[name];
  // Normalize and search
  const key = nameKey(name);
  for (const [k, v] of Object.entries(obj)) {
    if (nameKey(k) === key) return v;
  }
  return undefined;
}

// All known abbreviation variants → MLB team ID.
// MLB Stats API, FanGraphs, and Savant don't agree on every code, so we map them all.
export const TEAM_IDS = {
  // AL East
  BAL: 110, BOS: 111, NYY: 147, TB: 139, TBR: 139, TBD: 139, TOR: 141,
  // AL Central
  CHW: 145, CWS: 145, CLE: 114, DET: 116, KC: 118, KCR: 118, MIN: 142,
  // AL West
  HOU: 117, LAA: 108, ANA: 108, OAK: 133, ATH: 133, SEA: 136, TEX: 140,
  // NL East
  ATL: 144, MIA: 146, FLA: 146, NYM: 121, PHI: 143, WSH: 120, WSN: 120, WAS: 120, MON: 120,
  // NL Central
  CHC: 112, CIN: 113, MIL: 158, PIT: 134, STL: 138,
  // NL West
  ARI: 109, AZ: 109, COL: 115, LAD: 119, SD: 135, SDP: 135, SF: 137, SFG: 137,
};

// Normalize: trim, uppercase, strip dots ("S.F." → "SF").
const normAbbr = (s) => (s || "").toString().trim().toUpperCase().replace(/\./g, "");

export function getHeadshotUrl(playerId) {
  if (!playerId) return null;
  return `/mlb-photos/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,h_213,c_thumb,g_face,q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

// Resolve a team logo URL. Tries the abbreviation map first, then falls back
// to teamId — which works for ANY team id (MLB, AAA, WBC) since the logo
// endpoint is just /mlb-logos/v1/team/{id}/spots/128.
// Pass teamId whenever you have it; it makes the lookup bulletproof.
export function getLogoUrl(teamAbbr, teamId) {
  const tid = TEAM_IDS[normAbbr(teamAbbr)] ?? (teamId || null);
  if (!tid) return null;
  return `/mlb-logos/v1/team/${tid}/spots/128`;
}


// ═══════════════════════════════════════════════════════════
// BUBBLE PERCENTILE BAR
// ═══════════════════════════════════════════════════════════

export function BubblePercentileBar({ label, pctile, display }) {
  const { theme: t } = useTheme();
  const hasValue = pctile != null && isFinite(pctile);
  const barWidth = hasValue ? Math.max(3, pctile) : 0;
  const bubbleSize = 26;
  const barHeight = 22;
  const color = binColor(pctile);
  const txtColor = textOnBin(pctile);

  return (
    <div style={{
      display: "flex", alignItems: "center", marginBottom: 6, width: "100%", gap: 8,
    }}>
      {/* Label */}
      <div style={{
        width: 110, textAlign: "right", fontSize: 11, fontWeight: 500,
        color: t.text, flexShrink: 0, lineHeight: 1.2,
      }}>
        {label}
      </div>

      {/* Bar track + bubble */}
      <div style={{
        flex: 1, position: "relative", height: bubbleSize + 2,
        display: "flex", alignItems: "center",
      }}>
        {/* Track background */}
        <div style={{
          position: "absolute", left: 0, right: 0,
          top: "50%", transform: "translateY(-50%)",
          height: barHeight, background: t.inputBg,
          borderRadius: 4, border: `1px solid ${t.inputBorder}`,
        }} />

        {/* Filled bar */}
        {hasValue && (
          <div style={{
            position: "absolute", left: 0,
            top: "50%", transform: "translateY(-50%)",
            width: `${barWidth}%`, height: barHeight,
            background: `linear-gradient(90deg, ${color}cc, ${color})`,
            borderRadius: 4,
            transition: "width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }} />
        )}

        {/* Bubble */}
        {hasValue && (
          <div style={{
            position: "absolute",
            left: `${barWidth}%`,
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: bubbleSize, height: bubbleSize,
            borderRadius: "50%",
            background: color,
            border: `2px solid ${t.bg}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            transition: "left 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
            zIndex: 2,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 800,
              color: txtColor,
              fontFamily: "'DM Mono', monospace",
              lineHeight: 1,
            }}>
              {Math.round(pctile)}
            </span>
          </div>
        )}

        {/* N/A state */}
        {!hasValue && (
          <div style={{
            position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            fontSize: 10, color: t.textFaintest, fontStyle: "italic",
          }}>
            N/A
          </div>
        )}
      </div>

      {/* Raw value */}
      <div style={{
        width: 48, textAlign: "right", fontSize: 11, fontWeight: 600,
        color: hasValue ? t.textSecondary : t.textFaintest,
        fontFamily: "'DM Mono', monospace",
        flexShrink: 0,
      }}>
        {display || "—"}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PLAYER HEADER
// ═══════════════════════════════════════════════════════════

export function PlayerHeader({ name, team, teamId, season, playerId, subtitle }) {
  const headshot = getHeadshotUrl(playerId);
  const logo = getLogoUrl(team, teamId);

  const bgColor = MLB_TEAM_PRIMARY[team] || "#1e293b";
  const light = hexLuminance(bgColor) > 0.179;
  const textColor = light ? "#111111" : "#ffffff";
  const subColor = light ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.72)";
  const ringColor = light ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.25)";
  const initColor = light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.2)";

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 20px 14px", gap: 16, background: bgColor,
    }}>
      {/* Headshot */}
      <div style={{
        width: 72, height: 72, borderRadius: "50%", background: ringColor,
        overflow: "hidden", border: `2px solid ${ringColor}`, flexShrink: 0, position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: initColor, position: "absolute" }}>
          {name ? name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) : ""}
        </span>
        {headshot && (
          <img src={headshot} alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", position: "relative", zIndex: 1 }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>

      {/* Name + subtitle */}
      <div style={{ flex: 1, textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: textColor, letterSpacing: "-0.02em" }}>
          {name}
        </div>
        <div style={{ fontSize: 11, color: subColor, marginTop: 4, letterSpacing: "0.06em", fontStyle: "italic", fontWeight: 600, textTransform: "uppercase" }}>
          {subtitle || `${team ? `${team} | ` : ""}${season} Season`}
        </div>
      </div>

      {/* Logo */}
      <div style={{ width: 72, height: 72, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {logo && (
          <img src={logo} alt={team}
            style={{ width: 72, height: 72, objectFit: "contain", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.4))" }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// TREND CHART
// ═══════════════════════════════════════════════════════════

export function TrendChart({ data, metricLabel, metricKey }) {
  const { theme: t } = useTheme();
  if (!data || data.length < 2) return null;

  const sorted = [...data]
    .filter(d => d[metricKey] != null)
    .sort((a, b) => a.season - b.season);

  if (sorted.length < 2) return null;

  return (
    <div style={{ padding: "8px 12px 0" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, textAlign: "center", marginBottom: 4 }}>
        {metricLabel} — 3-Year Trend
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={sorted} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.cardBorder} />
          <XAxis
            dataKey="season" tick={{ fill: t.textMuted, fontSize: 11 }}
            tickLine={false} axisLine={{ stroke: t.divider }}
          />
          <YAxis
            tick={{ fill: t.textFaint, fontSize: 10 }} tickLine={false}
            axisLine={false} width={36}
          />
          <Line
            type="monotone" dataKey={metricKey}
            stroke="#f59e0b" strokeWidth={2.5}
            dot={{ r: 4, fill: "#f59e0b", stroke: t.headerBg, strokeWidth: 2 }}
          />
          <ReferenceLine y={0} stroke={t.textFaintest} strokeDasharray="4 4" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// METRIC SELECTOR (for trend chart)
// ═══════════════════════════════════════════════════════════

export function MetricSelector({ metrics, selected, onChange }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ padding: "4px 16px 8px", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, color: t.textFaint }}>Trend:</span>
      <select
        value={selected}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: "3px 8px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
          borderRadius: 4, color: t.textSecondary, fontSize: 11, outline: "none",
          fontFamily: "inherit",
        }}
      >
        {metrics.map(m => (
          <option key={m.label} value={m.label}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// PNG EXPORT HELPERS
// ═══════════════════════════════════════════════════════════

export async function convertImagesForCapture(container) {
  const imgs = [...container.querySelectorAll("img")];
  const originals = [];
  await Promise.allSettled(imgs.map(async (img) => {
    if (!img.src || img.src.startsWith("data:") || !img.naturalWidth) return;
    try {
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      originals.push({ img, orig: img.src });
      img.src = dataUrl;
    } catch (e) { /* skip failed images */ }
  }));
  await new Promise(r => setTimeout(r, 150));
  return originals;
}

export function restoreImages(originals) {
  originals.forEach(({ img, orig }) => { img.src = orig; });
}

export async function saveCardAsPng(cardRef, filename) {
  if (!cardRef.current) return;
  const originals = await convertImagesForCapture(cardRef.current);
  try {
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(cardRef.current, { backgroundColor: "#0d0d0d", scale: 2, logging: false });
    const link = document.createElement("a");
    link.download = filename;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    console.error("Save failed:", e);
  }
  restoreImages(originals);
}


// ═══════════════════════════════════════════════════════════
// SEARCHABLE PLAYER SELECT — input + datalist combo
// Works with either a plain string[] of labels OR {label, value}[]
// pairs. The current `value` is matched against option values (or
// labels, if options are strings). Typing filters via the native
// browser datalist; picking from the dropdown commits, hitting Enter
// commits the best prefix match, and blur reverts to the last
// committed value if the draft is invalid.
// ═══════════════════════════════════════════════════════════

export function SearchableSelect({
  value, options = [], onChange, style, placeholder = "Search…",
}) {
  const isObjOpts = options.length > 0 && typeof options[0] === "object";
  const labels = useMemo(
    () => isObjOpts ? options.map(o => String(o.label)) : options.map(String),
    [options, isObjOpts],
  );
  const labelByValue = useMemo(() => {
    if (!isObjOpts) return null;
    const m = new Map();
    for (const o of options) m.set(o.value, String(o.label));
    return m;
  }, [options, isObjOpts]);

  const currentLabel = isObjOpts ? (labelByValue.get(value) || "") : (value || "");
  const [draft, setDraft] = useState(currentLabel);
  useEffect(() => { setDraft(currentLabel); }, [currentLabel]);
  const listId = useId();

  const commit = (label) => {
    if (!labels.includes(label)) return false;
    if (isObjOpts) {
      const opt = options.find(o => String(o.label) === label);
      onChange?.(opt?.value, opt);
    } else {
      onChange?.(label);
    }
    return true;
  };

  return (
    <>
      <input
        list={listId}
        value={draft}
        onChange={e => {
          const v = e.target.value;
          setDraft(v);
          if (labels.includes(v)) commit(v);
        }}
        onBlur={() => {
          if (!labels.includes(draft)) setDraft(currentLabel);
        }}
        onKeyDown={e => {
          if (e.key === "Enter") {
            if (commit(draft)) return;
            const lower = draft.toLowerCase();
            const hit = labels.find(l => l.toLowerCase().startsWith(lower))
                     || labels.find(l => l.toLowerCase().includes(lower));
            if (hit) { setDraft(hit); commit(hit); }
          }
        }}
        placeholder={placeholder}
        style={{ fontFamily: "inherit", outline: "none", ...style }}
      />
      <datalist id={listId}>
        {labels.map(l => <option key={l} value={l} />)}
      </datalist>
    </>
  );
}
