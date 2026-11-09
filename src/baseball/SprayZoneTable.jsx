import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { binColor, textOnBin, NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";

// ═══════════════════════════════════════════════════════════
// SPRAY ZONE TABLE (hitter card, under the spray chart)
// ═══════════════════════════════════════════════════════════
// LF / CF / RF season totals from public/hitter_spray_{season}.json
// (build_hitter_xrv.py): actual RV vs model xRV, share of BBE, barrels, EV,
// 90th-pct EV and LA. Every value carries a percentile ranked among hitters
// batting from the same side; switch hitters get an L/R toggle. Season-only —
// the file has no per-game breakdown, so date-range mode still shows the season.

const ZONES = ["LF", "CF", "RF"];
// [key, header, decimals, signed, colored] — every stat's pill uses the percentile bins
// (higher value = higher percentile), matching the field wedges.
const COLS = [
  ["rv",   "RV",      1, true,  true],
  ["xrv",  "xRV",     1, true,  true],
  ["pct",  "BBE%",    1, false, true],
  ["brl",  "Barrels", 0, false, true],
  ["ev",   "Avg EV",  1, false, true],
  ["ev90", "EV90",    1, false, true],
  ["la",   "Avg LA",  1, false, true],
];
const HAND_LABEL = { L: "LHH", R: "RHH" };
const STAT_TITLE = {
  rv: "Run Value", xrv: "Expected Run Value (xRV)", pct: "Share of Batted Balls", brl: "Barrels",
  ev: "Average Exit Velocity", ev90: "90th-Percentile Exit Velocity", la: "Average Launch Angle",
};
const STAT_UNIT = { rv: "", xrv: "", pct: "%", brl: "", ev: " mph", ev90: " mph", la: "°" };
// Spray-angle edges (degrees, 0 = straight to CF, negative = LF side).
const ZONE_EDGES = { LF: [-45, -15], CF: [-15, 15], RF: [15, 45] };

const ordinal = (n) => {
  const v = Math.round(n), m100 = v % 100, m10 = v % 10;
  const suf = m100 >= 11 && m100 <= 13 ? "th" : m10 === 1 ? "st" : m10 === 2 ? "nd" : m10 === 3 ? "rd" : "th";
  return `${v}${suf}`;
};

const _cache = new Map();   // season → Promise<file|null>
function loadSpray(season) {
  if (!_cache.has(season)) {
    _cache.set(season, fetch(`/hitter_spray_${season}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return _cache.get(season);
}

function fmt(v, dec, signed) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const s = Number(v).toFixed(dec);
  if (!signed) return s;
  return Number(s) > 0 ? `+${s}` : Number(s) < 0 ? `−${s.replace("-", "")}` : s.replace("-", "");
}

export default function SprayZoneTable({ playerId, season, seasonOnlyNote = false }) {
  const { theme: t } = useTheme();
  const [file, setFile] = useState(undefined);   // undefined = loading, null = missing
  const [side, setSide] = useState(null);
  const [stat, setStat] = useState("xrv");   // which stat colors the field wedges

  useEffect(() => {
    let cancelled = false;
    setFile(undefined);
    loadSpray(season).then(f => { if (!cancelled) setFile(f); });
    return () => { cancelled = true; };
  }, [season]);

  const rec = file?.players?.[String(playerId)] || null;
  const sides = useMemo(
    () => (rec ? ["L", "R"].filter(s => rec[s]).sort((a, b) => rec[b].bbe - rec[a].bbe) : []),
    [rec],
  );
  useEffect(() => { setSide(sides[0] || null); }, [sides]);

  if (file === undefined) return <Muted t={t}>Loading spray zones…</Muted>;
  if (!file) return null;   // no file for this season (e.g. not built yet)
  if (!rec || !side || !rec[side]) return <Muted t={t}>No spray-zone table — not a qualified hitter in {season}.</Muted>;

  const data = rec[side];
  const pool = file.meta?.pool?.[side];
  const ranked = data.bbe >= (file.meta?.min_side_bbe ?? 0);

  const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, color: t.textFaint, textAlign: "right",
               whiteSpace: "nowrap", borderBottom: `1px solid ${t.divider}`, letterSpacing: "0.03em" };
  const td = { padding: "6px 8px", fontSize: 12, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT, textAlign: "right",
               whiteSpace: "nowrap", color: t.text };

  return (
    <div style={{ margin: "6px 16px 2px" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8, marginBottom: 4 }}>
        <div style={{ fontSize: 11, fontWeight: 800, color: t.text, letterSpacing: "0.02em" }}>
          Spray Zones
          <span style={{ fontWeight: 600, color: t.textFaint }}>
            {" "}· {season} season totals · {data.bbe} BBE as {HAND_LABEL[side]}
            {ranked && pool ? ` · pctile vs ${pool} ${HAND_LABEL[side]}` : " · too few BBE to rank"}
          </span>
          {seasonOnlyNote && (
            <span style={{ fontWeight: 600, color: t.accent }}> · full season (not the date range)</span>
          )}
        </div>
        {sides.length > 1 && (
          <div style={{ display: "inline-flex", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 7, padding: 2, flexShrink: 0 }}>
            {sides.map(s => (
              <button key={s} onClick={() => setSide(s)} style={{
                padding: "3px 10px", fontSize: 10, fontWeight: 700, borderRadius: 5, cursor: "pointer",
                border: "none", fontFamily: "inherit",
                background: s === side ? t.accent : "transparent", color: s === side ? "#fff" : t.textMuted,
              }}>as {HAND_LABEL[s]}</button>
            ))}
          </div>
        )}
      </div>
      <div style={{ display: "flex", justifyContent: "center", flexWrap: "wrap", gap: 4, margin: "4px 0 6px" }}>
        {COLS.map(([k, label]) => (
          <button key={k} onClick={() => setStat(k)} style={{
            padding: "3px 10px", fontSize: 10, fontWeight: 700, borderRadius: 12, cursor: "pointer",
            fontFamily: "inherit", border: `1px solid ${k === stat ? t.accent : t.inputBorder}`,
            background: k === stat ? t.accent : t.inputBg, color: k === stat ? "#fff" : t.textMuted,
          }}>{label}</button>
        ))}
      </div>
      <ZoneField t={t} zones={data.zones || {}} stat={stat} />
      <table style={{ borderCollapse: "collapse", width: "100%", marginTop: 6 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Zone · BBE</th>
            {COLS.map(([k, label]) => <th key={k} style={th}>{label}</th>)}
          </tr>
        </thead>
        <tbody>
          {ZONES.map((zn, i) => {
            const z = data.zones?.[zn] || {};
            return (
              <tr key={zn} style={{ background: i % 2 ? t.tableRowB : "transparent" }}>
                <td style={{ ...td, textAlign: "left", fontFamily: "inherit", fontWeight: 800, color: t.textSecondary }}>
                  {zn}<span style={{ fontSize: 10, fontWeight: 600, color: t.textFaint }}> {z.n ?? 0}</span>
                </td>
                {COLS.map(([k, , dec, signed, colored]) => (
                  <td key={k} style={td}>
                    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, justifyContent: "flex-end" }}>
                      <span>{fmt(z[k]?.value, dec, signed)}</span>
                      <Pill t={t} p={z[k]?.pctile} colored={colored} />
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// Mock field split into the three spray wedges, each filled with the selected
// stat's percentile bin color. Same fence shape as SprayChart (400 ft center,
// 330 ft corners, smooth blend), drawn from home plate out to the fence.
function ZoneField({ t, zones, stat, width = 700, height = 420 }) {
  const isDark = t.id === "dark";
  const cx = width / 2;
  const base = height * 0.95;
  const centerR = height * 0.86;
  const cornerR = centerR * (330 / 400);
  const fenceHalf = 0.28 * 180;   // SprayChart's fence spans ±0.28π around straight away
  const rad = (deg) => (deg * Math.PI) / 180;
  const fenceR = (deg) => {
    const f = Math.min(1, Math.abs(deg) / fenceHalf);
    return centerR + (cornerR - centerR) * f * f;
  };
  const pt = (deg, r) => [cx + r * Math.sin(rad(deg)), base - r * Math.cos(rad(deg))];
  const wedgePath = ([a, b]) => {
    const pts = [];
    for (let i = 0; i <= 24; i++) {
      const d = a + ((b - a) * i) / 24;
      pts.push(pt(d, fenceR(d)));
    }
    return `M ${cx} ${base} ` + pts.map(([x, y]) => `L ${x.toFixed(1)} ${y.toFixed(1)}`).join(" ") + " Z";
  };
  const [dec, signed] = (() => { const c = COLS.find(c => c[0] === stat); return [c[2], c[3]]; })();
  const line = isDark ? "rgba(255,255,255,0.35)" : "rgba(0,0,0,0.3)";
  const dR = cornerR * 0.17;
  const infR = cornerR * 0.42;

  return (
    <div style={{ background: isDark ? "#1a1a1a" : "#f0f0f0", borderRadius: 8, padding: "6px 0 2px" }}>
      <div style={{ textAlign: "center", fontSize: 11, fontWeight: 800, color: t.text, letterSpacing: "0.02em" }}>
        {STAT_TITLE[stat]} by Spray Zone
      </div>
      <svg width="100%" viewBox={`0 0 ${width} ${height}`} style={{ display: "block", maxWidth: width, margin: "0 auto" }}>
        {ZONES.map(zn => {
          const p = zones[zn]?.[stat]?.pctile;
          const has = p != null && Number.isFinite(p);
          return (
            <path key={zn} d={wedgePath(ZONE_EDGES[zn])}
              fill={has ? binColor(p) : (isDark ? "#2a2f3a" : "#d9dde3")}
              fillOpacity={has ? 0.92 : 1} stroke={isDark ? "#1a1a1a" : "#f0f0f0"} strokeWidth={3} strokeLinejoin="round" />
          );
        })}
        {/* infield arc + diamond drawn over the wedges */}
        <path d={`M ${pt(-45, infR).join(" ")} A ${infR} ${infR} 0 0 1 ${pt(45, infR).join(" ")}`}
          fill="none" stroke={line} strokeWidth={1} />
        <polygon fill="none" stroke={line} strokeWidth={1}
          points={`${cx},${base} ${cx - dR * 0.7},${base - dR * 0.7} ${cx},${base - dR * 1.4} ${cx + dR * 0.7},${base - dR * 0.7}`} />
        {ZONES.map(zn => {
          const z = zones[zn] || {};
          const cell = z[stat] || {};
          const p = cell.pctile;
          const has = p != null && Number.isFinite(p);
          const fg = has ? textOnBin(p) : t.textMuted;
          const [a, b] = ZONE_EDGES[zn];
          const mid = (a + b) / 2;
          const [x, y] = pt(mid, fenceR(mid) * 0.66);
          const val = cell.value == null ? "—" : `${fmt(cell.value, dec, signed)}${STAT_UNIT[stat]}`;
          return (
            <g key={`l-${zn}`} fill={fg} textAnchor="middle" style={{ pointerEvents: "none" }}>
              <text x={x} y={y - 26} fontSize={13} fontWeight={800} opacity={0.9}>{zn}</text>
              <text x={x} y={y + 2} fontSize={24} fontWeight={NUM_WEIGHT} fontFamily={NUM_FONT}>{val}</text>
              <text x={x} y={y + 22} fontSize={12} fontWeight={700}>{has ? `${ordinal(p)} percentile` : "not ranked"}</text>
              <text x={x} y={y + 38} fontSize={10} fontWeight={600} opacity={0.8}>{z.n ?? 0} BBE</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function Pill({ t, p, colored }) {
  const has = p != null && Number.isFinite(p);
  const bg = !has ? t.inputBg : colored ? binColor(p) : t.tableRowB;
  const fg = !has ? t.textFaint : colored ? textOnBin(p) : t.textSecondary;
  return (
    <span style={{
      display: "inline-block", minWidth: 24, padding: "1px 5px", borderRadius: 10, fontSize: 10,
      fontFamily: NUM_FONT, fontWeight: 800, lineHeight: 1.3, textAlign: "center",
      background: bg, color: fg, border: colored && has ? "1px solid transparent" : `1px solid ${t.divider}`,
    }}>{has ? Math.round(p) : "—"}</span>
  );
}

function Muted({ t, children }) {
  return <div style={{ padding: "8px 16px", fontSize: 11, color: t.textMuted, textAlign: "center" }}>{children}</div>;
}
