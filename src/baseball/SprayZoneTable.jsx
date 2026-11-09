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
// [key, header, decimals, signed, colored]. BBE% and LA have no "better"
// direction, so their percentile pills are neutral rather than blue→red.
const COLS = [
  ["rv",   "RV",      1, true,  true],
  ["xrv",  "xRV",     1, true,  true],
  ["pct",  "BBE%",    1, false, false],
  ["brl",  "Barrels", 0, false, true],
  ["ev",   "Avg EV",  1, false, true],
  ["ev90", "EV90",    1, false, true],
  ["la",   "Avg LA",  1, false, false],
];
const HAND_LABEL = { L: "LHH", R: "RHH" };

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
      <table style={{ borderCollapse: "collapse", width: "100%" }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left" }}>Zone</th>
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
