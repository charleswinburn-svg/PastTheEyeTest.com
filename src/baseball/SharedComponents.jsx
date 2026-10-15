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
// Numbers on every card (percentiles, stat values, chart ticks) — the Pliant
// face the Summaries stat bar and pitch table use, always bold.
export const NUM_FONT = "'Pliant', sans-serif";
export const NUM_WEIGHT = 700;

export const binColor = (p) => BIN_COLORS[pctToBin(p)] || "#333";
export const textOnBin = (p) => {
  if (p == null) return "#aaa";
  return (p < 25 || p >= 75) ? "#fff" : "#111";
};

// ── Projection deltas (projected − last season) ──
// Read from the card's display strings so the change carries the stat's own units
// and decimals. Shaded with the percentile bins by how big the change is relative to
// the spread of changes across all projected hitters: red = up, blue = down.
const _deltaNum = (s) => {
  const v = parseFloat(String(s ?? "").replace("\u2212", "-").replace(/[^0-9.+-]/g, ""));
  return isFinite(v) ? v : null;
};
const _rawDelta = (cat) => {
  if (!cat?.last) return null;
  const a = _deltaNum(cat.display), b = _deltaNum(cat.last.display);
  return a == null || b == null ? null : a - b;
};
export function deltaSpread(cats) {
  const ds = cats.map(_rawDelta).filter(d => d != null);
  if (ds.length < 10) return null;
  const rms = Math.sqrt(ds.reduce((acc, d) => acc + d * d, 0) / ds.length);
  return rms > 0 ? rms : null;
}
export function projDelta(cat, spread) {
  const raw = _rawDelta(cat);
  if (raw == null || spread == null) return null;
  const dec = (String(cat.display).split(".")[1] || "").length;
  const d = +raw.toFixed(dec);
  let txt = Math.abs(d).toFixed(dec);
  if (dec === 3 && txt.startsWith("0.")) txt = txt.slice(1);
  const p = Math.max(0, Math.min(100, 50 + 20 * d / spread));
  return {
    text: `${d > 0 ? "+" : d < 0 ? "\u2212" : "\u00b1"}${txt}`,
    color: pctToBin(p) === "45-55" ? null : binColor(p),
  };
}

// ── Projected-card "Show" setting (shared by the cards and the Movers board) ──
// Every projected value is stored as history + age + model ("parts"): history is
// league average plus the regressed blend of the player's own seasons (his stats),
// age is the aging curve, model is what iSwing+ / Stuff+ add.
//   Full projection     the projection itself; percentile vs last season's players;
//                       line = change vs last season
//   History             his stats alone (no age, no model); same percentile and line
//   Age + model / Age / Model
//                       just that adjustment, e.g. "−.012"; percentile = where it
//                       ranks among all projected players (direction-aware, so a
//                       drop in SIERA ranks high); no line — the value is the change
// Only "Full projection" is the actual projection.
export const PROJ_VIEWS = [
  { id: "full",    label: "Full projection",        short: "Change", parts: ["history", "age", "model"] },
  { id: "history", label: "History (stats only)",   short: "Change", parts: ["history"] },
  { id: "signal",  label: "Age + model",            short: "Age + model", parts: ["age", "model"], pure: true },
  { id: "age",     label: "Age",                    short: "Age",   parts: ["age"], pure: true },
  { id: "model",   label: "Model",                  short: "Model", parts: ["model"], pure: true },
];
const PROJ_VIEW_KEY = "ptet-proj-view";
const PROJ_VIEW_EVENT = "ptet-proj-view";
const readProjView = (fallback) => {
  try { const v = localStorage.getItem(PROJ_VIEW_KEY); return PROJ_VIEWS.some(x => x.id === v) ? v : fallback; }
  catch { return fallback; }
};

// One remembered setting; changing it on a card also changes the board, and back.
export function useProjView(fallback = "full") {
  const [view, setView] = useState(() => readProjView(fallback));
  useEffect(() => {
    const on = (e) => setView(e.detail);
    window.addEventListener(PROJ_VIEW_EVENT, on);
    return () => window.removeEventListener(PROJ_VIEW_EVENT, on);
  }, []);
  const set = (v) => {
    try { localStorage.setItem(PROJ_VIEW_KEY, v); } catch { /* storage blocked */ }
    window.dispatchEvent(new CustomEvent(PROJ_VIEW_EVENT, { detail: v }));
  };
  return [view, set];
}

export function ProjViewSelect({ value, onChange, style }) {
  const { theme: t } = useTheme();
  return (
    <select value={value} onChange={e => onChange(e.target.value)} title="Which parts of the projection to show"
      style={{ padding: "6px 10px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`,
               borderRadius: 6, fontSize: 12, fontFamily: "inherit", ...style }}>
      {PROJ_VIEWS.map(v => <option key={v.id} value={v.id}>Show: {v.label}</option>)}
    </select>
  );
}

// Percentile pools (last season's values per stat) for a projection season, read
// once from the projection file's meta.
const _poolCache = new Map();
export function useProjPools(season) {
  const isProj = typeof season === "string" && season.endsWith("P");
  const [pools, setPools] = useState(null);
  useEffect(() => {
    if (!isProj) { setPools(null); return; }
    let alive = true;
    if (!_poolCache.has(season)) {
      _poolCache.set(season, fetch(`/baseball_data_${season}.json`).then(r => (r.ok ? r.json() : null))
        .then(d => d && {
          hitters: d.meta?.pools || {}, xrv: d.meta?.xrv_pools || {},
          pitchers: d.pitcher_meta?.pools || {}, grades: d.pitcher_meta?.grade_pools || {},
          hitterLower: new Set(d.meta?.lower_better || []),
          pitcherLower: new Set(d.pitcher_meta?.lower_better || []),
        }).catch(() => null));
    }
    _poolCache.get(season).then(p => { if (alive) setPools(p); });
    return () => { alive = false; };
  }, [season, isProj]);
  return pools;
}

const _scaleOf = (cat) => {
  const shown = _deltaNum(cat.display), raw = Number(cat.value);
  return raw && shown != null && Math.abs(shown / raw) > 50 ? 100 : 1;   // K% etc. stored as fractions
};
const _decOf = (cat) => (String(cat.display).split(".")[1] || "").length;
// A raw value written the way this stat's card value is (".281", "28.0", "+5.2").
function _formatLike(cat, raw) {
  const dec = _decOf(cat);
  let s = (raw * _scaleOf(cat)).toFixed(dec);
  const d = String(cat.display);
  if (d.startsWith(".") || d.startsWith("-.")) s = s.replace(/^(-?)0\./, "$1.");
  if (d.startsWith("+") && !s.startsWith("-")) s = `+${s}`;
  return s;
}

export const projViewDef = (view) => PROJ_VIEWS.find(x => x.id === view) || PROJ_VIEWS[0];

// An adjustment-only view's value (age / model / both), in the card's display units.
export function projPureValue(cat, view) {
  const v = projViewDef(view);
  if (!v.pure || !cat?.parts) return null;
  return v.parts.reduce((a, k) => a + Number(cat.parts[k] || 0), 0) * _scaleOf(cat);
}

// Sorted adjustment values across every projected player — the percentile pool for
// the adjustment-only views.
export function adjPoolFor(cats, view) {
  if (!projViewDef(view).pure) return null;
  return cats.map(c => projPureValue(c, view)).filter(x => x != null && isFinite(x)).sort((a, b) => a - b);
}

function _ecdf(pool, x, lowerBetter) {
  if (!Array.isArray(pool) || !pool.length || x == null || !isFinite(x)) return null;
  if (pool[0] === pool[pool.length - 1]) return null;            // everyone the same (e.g. no model layer)
  let lo = 0, hi = pool.length;                                  // count of pool values < x
  while (lo < hi) { const m = (lo + hi) >> 1; if (pool[m] < x) lo = m + 1; else hi = m; }
  const p = (lo / pool.length) * 100;
  return Math.round((lowerBetter ? 100 - p : p) * 10) / 10;
}

const _fmtSigned = (cat, x) => {
  const dec = _decOf(cat);
  const d = +x.toFixed(dec);
  let txt = Math.abs(d).toFixed(dec);
  if (dec === 3 && txt.startsWith("0.")) txt = txt.slice(1);
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${txt}`;
};

// What the card shows for one projected stat under a view:
//   { display, pctile, line, value }   line / value in display units
// pool = last season's values (Full / History); adjPool = every projected player's
// adjustment (Age + model / Age / Model).
export function projShow(cat, view, pool, lowerBetter = false, adjPool = null) {
  if (!cat) return null;
  const v = projViewDef(view);
  const lastShown = cat.last ? _deltaNum(cat.last.display) : null;
  if (v.pure) {
    const x = projPureValue(cat, view);
    if (x == null || !isFinite(x)) return { display: "—", pctile: null, line: null, value: null };
    return { display: _fmtSigned(cat, x), pctile: _ecdf(adjPool, x, lowerBetter), line: null, value: x };
  }
  if (v.id === "full") {
    const shown = _deltaNum(cat.display);
    return { display: cat.display, pctile: cat.pctile, value: shown,
             line: lastShown == null || shown == null ? null : shown - lastShown };
  }
  // History: his stats alone, ranked against last season's players
  if (!cat.parts) return { display: "—", pctile: null, line: null, value: null };
  const disp = _formatLike(cat, Number(cat.parts.history));
  const shown = _deltaNum(disp);
  return { display: disp, pctile: _ecdf(pool, Number(cat.parts.history), lowerBetter) ?? null, value: shown,
           line: lastShown == null || shown == null ? null : shown - lastShown };
}

// Spread used to shade a view's numbers: the change line (Full / History) or the
// adjustment itself (Age + model / Age / Model).
export function adjSpread(cats, view) {
  const pure = projViewDef(view).pure;
  const ds = cats.map(c => {
    const sh = projShow(c, view);
    return pure ? sh?.value : sh?.line;
  }).filter(d => d != null && isFinite(d));
  if (ds.length < 10) return null;
  const rms = Math.sqrt(ds.reduce((acc, d) => acc + d * d, 0) / ds.length);
  return rms > 0 ? rms : null;
}

// Red (up) / blue (down) shade for a number, scaled by `spread`; null near zero.
export function projShade(x, spread) {
  if (x == null || !isFinite(x) || !spread) return null;
  const p = Math.max(0, Math.min(100, 50 + 20 * x / spread));
  return pctToBin(p) === "45-55" ? null : binColor(p);
}

// {text, color} for the small line under a value (Full / History only).
export function projLine(cat, shown, view, spread) {
  if (projViewDef(view).pure) return null;
  const v = shown?.line;
  if (v == null || !isFinite(v) || spread == null) return null;
  return { text: _fmtSigned(cat, v), color: projShade(+v.toFixed(_decOf(cat)), spread) };
}

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

// ── MLB team secondary colors — used where a team's primary is black/white ──
export const MLB_TEAM_SECONDARY = {
  ARI: "#E3D4AD", AZ:  "#E3D4AD",
  ATL: "#13274F",
  BAL: "#27251F",
  BOS: "#0C2340",
  CHC: "#CC3433",
  CWS: "#C4CED4", CHW: "#C4CED4",
  CIN: "#27251F",
  CLE: "#E50022",
  COL: "#C4CED4",
  DET: "#FA4616",
  HOU: "#EB6E1F",
  KC:  "#BD9B60", KCR: "#BD9B60",
  LAA: "#003263",
  LAD: "#EF3E42",
  MIA: "#EF3340",
  MIL: "#12284B",
  MIN: "#D31145",
  NYM: "#FF5910",
  NYY: "#C4CED3",
  OAK: "#EFB21E", ATH: "#EFB21E",
  PHI: "#002D72",
  PIT: "#27251F",
  SD:  "#FFC425", SDP: "#FFC425",
  SEA: "#005C5C",
  SF:  "#27251F", SFG: "#27251F",
  STL: "#0C2340",
  TB:  "#8FBCE6", TBR: "#8FBCE6",
  TEX: "#C0111F",
  TOR: "#1D2D5C",
  WSH: "#14225A", WSN: "#14225A",
};

// Near-black (dark AND nearly colorless — so navy stays navy) or near-white.
function isBlackOrWhite(hex) {
  const [r, g, b] = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const hi = Math.max(r, g, b), lo = Math.min(r, g, b);
  return (hi < 0x40 && hi - lo < 24) || lo > 0xE0;
}

// Team color for chart marks: the primary, unless it's black or white
// (White Sox, Padres brown-black), then the secondary.
export function teamMarkColor(team) {
  const primary = MLB_TEAM_PRIMARY[team];
  if (!primary) return null;
  return isBlackOrWhite(primary) ? (MLB_TEAM_SECONDARY[team] || primary) : primary;
}

export function hexLuminance(hex) {
  return [hex.slice(1,3), hex.slice(3,5), hex.slice(5,7)].reduce((sum, h, i) => {
    const c = parseInt(h, 16) / 255;
    const lin = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return sum + lin * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

// Blend hex toward another hex by w (0..1).
export function mixHex(hex, toward, w) {
  const a = [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
  const b = [1, 3, 5].map(i => parseInt(toward.slice(i, i + 2), 16));
  return "#" + a.map((v, i) => Math.round(v + (b[i] - v) * w).toString(16).padStart(2, "0")).join("");
}

// ── "new" label for everything driven by the current iSwing+ model ──
// Flip to false to retire every iSwing+ "new" label at once.
export const SHOW_ISWING_NEW = true;

export function NewBadge({ style }) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      fontSize: 9, fontWeight: 800, fontStyle: "italic", letterSpacing: "0.04em",
      color: t.accent, lineHeight: 1, marginTop: 2, textTransform: "none", ...style,
    }}>new</div>
  );
}

// public/iswing_meta.json (written by iswing_update.py) lists the seasons scored
// by the current model; the "new" label only shows on those seasons.
let _iswingMetaPromise = null;
function loadISwingMeta() {
  if (!_iswingMetaPromise) {
    _iswingMetaPromise = fetch("/iswing_meta.json")
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null);
  }
  return _iswingMetaPromise;
}

export function useISwingNew(season) {
  const [seasons, setSeasons] = useState(null);
  useEffect(() => {
    if (!SHOW_ISWING_NEW) return;
    let alive = true;
    loadISwingMeta().then(m => { if (alive) setSeasons(Array.isArray(m?.seasons) ? m.seasons.map(Number) : []); });
    return () => { alive = false; };
  }, []);
  return SHOW_ISWING_NEW && !!seasons && seasons.includes(Number(season));
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

export function BubblePercentileBar({ label, pctile, display, labelWidth = 110, badge = false, delta = null }) {
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
        width: labelWidth, textAlign: "right", fontSize: 11, fontWeight: 500,
        color: t.text, flexShrink: 0, lineHeight: 1.2,
      }}>
        {label}
        {badge && <NewBadge />}
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
              fontFamily: NUM_FONT,
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
        width: 48, textAlign: "right", fontSize: 11, fontWeight: NUM_WEIGHT,
        color: hasValue ? t.textSecondary : t.textFaintest,
        fontFamily: NUM_FONT, whiteSpace: "nowrap",
        flexShrink: 0,
      }}>
        {display || "—"}
        {delta && (
          <div style={{
            fontSize: 8.5, fontStyle: "italic", fontWeight: 600, lineHeight: 1, marginTop: 1,
            // the deepest blue bin is unreadable as text on a dark card — lift it there
            color: !delta.color ? t.textFaint
              : delta.color === BIN_COLORS["0-10"] && hexLuminance(t.cardBg || t.bg) < 0.4 ? "#4F8FD6"
              : delta.color,
          }}>
            {delta.text}
          </div>
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PLAYER HEADER
// ═══════════════════════════════════════════════════════════

// player_id → resolved team id (or null), cached for the session so each
// player is looked up at most once.
const _fallbackTeamIdCache = new Map();

// Resolve a player's current team id from the MLB Stats API. Used only as a
// fallback when the pipeline data carries no team (IL stints / AAA options
// strip the abbreviation), so the card still shows a logo. Prefers the MLB
// parent org when the player is on a minor-league roster.
export function useFallbackTeamId(playerId, needed) {
  const [tid, setTid] = useState(() => _fallbackTeamIdCache.get(playerId) ?? null);
  useEffect(() => {
    if (!needed || !playerId) return;
    if (_fallbackTeamIdCache.has(playerId)) { setTid(_fallbackTeamIdCache.get(playerId)); return; }
    setTid(null); // clear any prior player's value while we resolve
    let alive = true;
    fetch(`/mlb-api/api/v1/people/${playerId}?hydrate=currentTeam`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => {
        const ct = d?.people?.[0]?.currentTeam;
        const id = ct?.parentOrgId || ct?.id || null;
        _fallbackTeamIdCache.set(playerId, id);
        if (alive) setTid(id);
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [playerId, needed]);
  return tid;
}

export function PlayerHeader({ name, team, teamId, season, playerId, subtitle }) {
  const headshot = getHeadshotUrl(playerId);
  const directLogo = getLogoUrl(team, teamId);
  const fallbackTeamId = useFallbackTeamId(playerId, !directLogo);
  const logo = directLogo || getLogoUrl(null, fallbackTeamId);

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
            dataKey="season" tick={{ fill: t.textMuted, fontSize: 11, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}
            tickLine={false} axisLine={{ stroke: t.divider }}
          />
          <YAxis
            tick={{ fill: t.textFaint, fontSize: 10, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }} tickLine={false}
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

// True for phones/tablets, where a programmatic <a download> is ignored and we
// must hand the PNG to the OS share sheet instead. iPadOS 13+ reports as desktop
// Safari on "MacIntel", so detect it via touch points.
export function isMobileDevice() {
  if (typeof navigator === "undefined") return false;
  const ua = navigator.userAgent || "";
  if (/Android|iPhone|iPad|iPod/i.test(ua)) return true;
  if (navigator.platform === "MacIntel" && (navigator.maxTouchPoints || 0) > 1) return true;
  return false;
}

// Deliver a finished canvas to the user as a PNG. Desktop browsers get a normal
// file download; mobile browsers (where <a download> silently does nothing) get
// the Web Share sheet with the image file, so the user can "Save Image" to
// Photos or share it. Falls back to a download if sharing isn't available.
export async function exportCanvasAsPng(canvas, filename) {
  const blob = await new Promise(res => { try { canvas.toBlob(res, "image/png"); } catch { res(null); } });
  const triggerDownload = (href, revoke) => {
    const link = document.createElement("a");
    link.download = filename;
    link.href = href;
    document.body.appendChild(link);
    link.click();
    link.remove();
    if (revoke) setTimeout(() => URL.revokeObjectURL(href), 10000);
  };

  if (blob && isMobileDevice() && typeof navigator !== "undefined" && navigator.canShare) {
    const file = new File([blob], filename, { type: "image/png" });
    if (navigator.canShare({ files: [file] })) {
      try {
        await navigator.share({ files: [file], title: filename });
        return;                       // shared/saved successfully
      } catch (e) {
        if (e && e.name === "AbortError") return;   // user dismissed the sheet
        // otherwise fall through to a download attempt
      }
    }
  }

  if (blob) {
    triggerDownload(URL.createObjectURL(blob), true);
  } else {
    // Oversized canvases can make toBlob return null — last-ditch data URL.
    triggerDownload(canvas.toDataURL("image/png"), false);
  }
}

// Escape one CSV cell (RFC 4180): quote if it contains a comma, quote, CR or LF.
function csvCell(v) {
  const s = v == null ? "" : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// Deliver a table as a CSV file. `rows` is an array of arrays; the first row is
// the header. Same mobile/desktop delivery as exportCanvasAsPng: desktop gets a
// download, mobile (where <a download> is ignored) gets the OS share sheet.
export async function exportRowsAsCsv(rows, filename) {
  const csv = "﻿" + rows.map(r => r.map(csvCell).join(",")).join("\r\n");  // BOM so Excel reads UTF-8
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const triggerDownload = () => {
    const href = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.download = filename; link.href = href;
    document.body.appendChild(link); link.click(); link.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
  };
  if (isMobileDevice() && typeof navigator !== "undefined" && navigator.canShare) {
    const file = new File([blob], filename, { type: "text/csv" });
    if (navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: filename }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }  // else fall through to download
    }
  }
  triggerDownload();
}

export async function saveCardAsPng(cardRef, filename) {
  if (!cardRef.current) return;
  const originals = await convertImagesForCapture(cardRef.current);
  // If the card is wrapped in a <FitToWidth> scaler (so it fits mobile without
  // clipping), neutralize that ancestor's transform for the capture only.
  // html2canvas sizes its output from the element's on-screen (post-transform)
  // rect, so a scaled ancestor would otherwise shrink the PNG. Restored in finally.
  const fit = cardRef.current.closest("[data-ptet-fit]");
  const prevTransform = fit ? fit.style.transform : "";
  if (fit) fit.style.transform = "none";
  let canvas = null;
  try {
    const html2canvas = (await import("html2canvas")).default;
    canvas = await html2canvas(cardRef.current, {
      backgroundColor: "#0d0d0d", scale: 2, logging: false,
      // The site-wide body letter-spacing (-0.01em) makes html2canvas split every
      // text node into single characters and place each from the browser's
      // per-character rects, which iOS Safari reports unreliably (letters spread
      // apart, spaces dropped). Zero it in the capture clone so ordinary text is
      // drawn word by word; labels with their own tracking keep it.
      onclone: (doc) => { doc.body.style.letterSpacing = "0px"; },
    });
  } catch (e) {
    console.error("Capture failed:", e);
  } finally {
    if (fit) fit.style.transform = prevTransform;
    restoreImages(originals);
  }
  if (canvas) await exportCanvasAsPng(canvas, filename);
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
