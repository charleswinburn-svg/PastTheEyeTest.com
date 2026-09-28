import { useState, useEffect, useMemo, useRef } from "react";
import { useTheme } from "./ThemeContext.jsx";
import {
  PlayerHeader, SearchableSelect, NewBadge, useISwingNew, useFallbackTeamId,
  saveCardAsPng, teamMarkColor, hexLuminance, mixHex, binColor, textOnBin,
  TEAM_IDS, MLB_TEAM_PRIMARY,
} from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";

// One-season iSwing+ waterfall (SUMMARIES → Hitter iSwing+).
// Reads /iswing_waterfall_{season}.json (iswing_update.py): batterId ->
//   { name, iswing, pct, n, c: { feature: iSwing+ points } }
// where the points are the model's feature contributions vs the average
// qualified hitter and sum exactly to iswing − 100.

const FEATURE_LABELS = {
  bat_speed: "Bat Speed",
  swing_length: "Swing Length",
  speed_over_expected: "Speed Over Expected",
  speed_vs_location: "Speed vs Location",
  aa_vs_optimal: "Attack Angle vs Optimal",
  aa_adjustment: "Attack Angle Adjustment",
  tilt_for_height: "Tilt for Height",
  direction_from_optimal: "Direction vs Optimal",
  length_for_location: "Length for Location",
  effort_level: "90th Percentile Bat Speed",
  hard_swing_contact: "Hard-Swing Contact",
  aa_adaptability: "Attack Angle Adaptability",
  dir_adaptability: "Direction Adaptability",
};
const featureLabel = (f) =>
  FEATURE_LABELS[f] || f.split("_").map(w => w[0].toUpperCase() + w.slice(1)).join(" ");

// MLB team id → an abbreviation MLB_TEAM_PRIMARY knows (for the API fallback).
const ABBR_BY_TEAM_ID = Object.entries(TEAM_IDS).reduce((m, [abbr, id]) => {
  if (MLB_TEAM_PRIMARY[abbr] && !(id in m)) m[id] = abbr;
  return m;
}, {});

const _wfCache = new Map();
function loadWaterfall(season) {
  if (!_wfCache.has(season)) {
    _wfCache.set(season, fetch(`/iswing_waterfall_${season}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return _wfCache.get(season);
}

// Keep the team color readable on the card: lift very dark colors on the dark
// theme, deepen very light ones (e.g. White Sox silver) on the light theme.
function readableOn(hex, isDark) {
  const lum = hexLuminance(hex);
  if (isDark && lum < 0.05) return mixHex(hex, "#ffffff", 0.35);
  if (!isDark && lum > 0.45) return mixHex(hex, "#000000", 0.35);
  return hex;
}

// The whole card (header, numbers, chart) is set in Pliant.
const FONT = "'Pliant', sans-serif";

const fmtPts = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;

export default function ISwingWaterfall({ season, hitters }) {
  const { theme: t, isDark } = useTheme();
  const cardRef = useRef(null);
  const [data, setData] = useState(undefined);   // undefined = loading, null = no file
  const [pid, setPid] = useState(null);
  const isNew = useISwingNew(season);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    loadWaterfall(season).then(d => { if (alive) setData(d && typeof d === "object" ? d : null); });
    return () => { alive = false; };
  }, [season]);

  // Drop the selection when the new season doesn't have that hitter.
  useEffect(() => {
    if (data && pid && !data[pid]) setPid(null);
  }, [data, pid]);

  const hitterById = useMemo(() => {
    const m = new Map();
    for (const h of hitters || []) if (h.player_id != null) m.set(String(h.player_id), h);
    return m;
  }, [hitters]);

  const options = useMemo(() => {
    if (!data) return [];
    return Object.entries(data)
      .filter(([k, r]) => k !== "meta" && r?.c)
      .map(([id, r]) => {
        const h = hitterById.get(id);
        const name = h?.name || r.name;
        return { value: id, name, label: `${name}${h?.team ? ` (${h.team})` : ""} — iSwing+ ${r.iswing}` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, hitterById]);

  const rec = data && pid ? data[pid] : null;
  const hitter = pid ? hitterById.get(pid) : null;
  const fallbackTeamId = useFallbackTeamId(pid ? Number(pid) : null, !!pid && !hitter?.team);
  const team = hitter?.team || ABBR_BY_TEAM_ID[fallbackTeamId] || null;
  const name = hitter?.name || rec?.name || "";
  const barColor = readableOn(teamMarkColor(team) || t.accentSecondary, isDark);

  const saveCard = async () => {
    await saveCardAsPng(cardRef, `${name.replace(/\s+/g, "_")}_iSwing_breakdown_${season}.png`);
  };

  const msg = (text) => <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>{text}</div>;

  return (
    <div style={{ padding: "16px 20px" }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SearchableSelect
          value={pid || ""}
          options={options}
          onChange={(v) => setPid(v || null)}
          placeholder="Search hitter…"
          style={{ padding: "6px 12px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`, borderRadius: 6, fontSize: 12, minWidth: 320 }}
        />
        {data === undefined && <span style={{ fontSize: 11, color: t.textMuted }}>Loading {season} iSwing+…</span>}
      </div>

      {data === null && msg(`No iSwing+ breakdown for ${season} yet.`)}
      {data && !rec && msg("Select a hitter")}

      {rec && (
        <>
          <FitToWidth designWidth={700}>
            <div ref={cardRef} style={{ fontFamily: FONT, background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`, overflow: "hidden", maxWidth: 700, margin: "0 auto", boxShadow: `0 4px 24px ${t.shadow}` }}>
              <PlayerHeader
                name={name}
                team={team}
                teamId={hitter?.team_id ?? fallbackTeamId}
                season={season}
                playerId={Number(pid)}
                subtitle={`${season} iSwing+ Breakdown`}
              />
              <SummaryStrip rec={rec} isNew={isNew} />
              <Waterfall rec={rec} color={barColor} />
              <div style={{ padding: "2px 20px 6px", fontSize: 10, color: t.textFaint, lineHeight: 1.4, textAlign: "center" }}>
                Each bar is how much that part of the swing moved this hitter's predicted contact quality versus the
                average qualified hitter (100), in iSwing+ points. Solid = helped, striped = hurt.
              </div>
              <div style={{ padding: "6px 16px 8px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
                <span>Created by: @PastTheEyeTest on X</span>
                <span style={{ fontStyle: "italic" }}>Data: Baseball Savant · iSwing+ {data?.meta?.model || ""}</span>
              </div>
            </div>
          </FitToWidth>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={saveCard} style={{ padding: "6px 16px", fontSize: 11, fontWeight: 600, background: t.inputBg, color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer" }}>📥 Save as PNG</button>
          </div>
        </>
      )}
    </div>
  );
}

function SummaryStrip({ rec, isNew }) {
  const { theme: t } = useTheme();
  const stat = (label, value, extra) => (
    <div style={{ textAlign: "center", minWidth: 110 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: t.text, lineHeight: 1.2 }}>{value}</div>
      {extra}
    </div>
  );
  return (
    <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 36, padding: "14px 16px 4px" }}>
      {stat("iSwing+", rec.iswing, isNew ? <NewBadge style={{ fontSize: 10 }} /> : null)}
      {stat("Percentile", (
        <span style={{ display: "inline-block", minWidth: 44, padding: "0 8px", borderRadius: 14, background: binColor(rec.pct), color: textOnBin(rec.pct), fontSize: 20 }}>
          {rec.pct}
        </span>
      ))}
      {stat("Swings", rec.n)}
    </div>
  );
}

// ── The waterfall itself (SVG). x-axis is symmetric around 100 and wide enough
// for every step of the running total, so nothing clips on either side. ──
function Waterfall({ rec, color }) {
  const { theme: t } = useTheme();
  const rows = useMemo(() => {
    const feats = Object.entries(rec.c).sort((a, b) => Math.abs(b[1]) - Math.abs(a[1]));
    let run = 100;
    return feats.map(([f, v]) => {
      const start = run;
      run += v;
      return { f, v, start, end: run };
    });
  }, [rec]);
  const final = rec.iswing;

  const W = 660, labelW = 178, padR = 44, rowH = 26, top = 30, bottom = 34;
  const plotL = labelW, plotR = W - padR, plotW = plotR - plotL;
  const H = top + rows.length * rowH + bottom;

  const maxDev = Math.max(1, ...rows.map(r => Math.abs(r.end - 100)), ...rows.map(r => Math.abs(r.start - 100)));
  const needed = maxDev + Math.max(4, maxDev * 0.15);   // headroom for the value labels
  const step = needed <= 20 ? 5 : needed <= 60 ? 10 : 20;
  const R = Math.max(10, Math.ceil(needed / step) * step);
  const x = (v) => plotL + ((v - (100 - R)) / (2 * R)) * plotW;
  const ticks = [];
  for (let v = 100 - R; v <= 100 + R + 1e-9; v += step) ticks.push(v);

  const patternId = `iswing-neg-${color.slice(1)}`;
  const yBottom = top + rows.length * rowH;
  // Final-value label sits on its own side of the line (flipping inward near the
  // right edge); "Avg 100" takes the other side so the two never collide.
  const finalRight = final >= 100 && x(final) + 96 <= W;
  const halo = { stroke: t.cardBg, strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" };

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "4px 12px 0" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: "100%", height: "auto", fontFamily: FONT }} role="img"
        aria-label={`iSwing+ waterfall: ${rows.map(r => `${featureLabel(r.f)} ${fmtPts(r.v)}`).join(", ")}; final ${final}`}>
        <defs>
          <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={color} fillOpacity="0.28" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="2.4" />
          </pattern>
        </defs>

        {/* Gridlines + tick labels */}
        {ticks.map(v => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={top - 6} y2={yBottom} stroke={t.divider} strokeWidth="1" />
            <text x={x(v)} y={yBottom + 14} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textFaint}>{v}</text>
          </g>
        ))}
        <text x={(plotL + plotR) / 2} y={H - 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textMuted} letterSpacing="0.06em">iSWING+ POINTS</text>

        {/* League average (100) and the hitter's final iSwing+ */}
        <line x1={x(100)} x2={x(100)} y1={top - 6} y2={yBottom} stroke={t.textMuted} strokeWidth="1.2" strokeDasharray="4 3" />
        <text x={x(100)} y={top - 10} textAnchor={finalRight ? "end" : "start"} dx={finalRight ? -4 : 4}
          fontSize="10" fill={t.textMuted}>Avg 100</text>
        <line x1={x(final)} x2={x(final)} y1={top - 6} y2={yBottom} stroke={t.text} strokeWidth="1.6" opacity="0.7" />
        <text x={x(final)} y={top - 10} textAnchor={finalRight ? "start" : "end"} dx={finalRight ? 4 : -4}
          fontSize="11" fontWeight="800" fill={t.text}>iSwing+ = {final}</text>

        {rows.map((r, j) => {
          const y = top + j * rowH;
          const x0 = x(Math.min(r.start, r.end)), x1 = x(Math.max(r.start, r.end));
          const pos = r.v >= 0;
          return (
            <g key={r.f}>
              <text x={labelW - 10} y={y + rowH / 2 + 4} textAnchor="end" fontSize="11" fill={t.text}>{featureLabel(r.f)}</text>
              <rect x={x0} y={y + 4} width={Math.max(1.5, x1 - x0)} height={rowH - 8} rx="2"
                fill={pos ? color : `url(#${patternId})`}
                stroke={color} strokeWidth={pos ? 0 : 1} />
              {j < rows.length - 1 && (
                <line x1={x(r.end)} x2={x(r.end)} y1={y + rowH - 4} y2={y + rowH + 4} stroke={t.textFaint} strokeWidth="1" />
              )}
              <text x={pos ? x1 + 4 : x0 - 4} y={y + rowH / 2 + 3.5} textAnchor={pos ? "start" : "end"}
                fontSize="10" fontWeight="700" fill={t.textSecondary} {...halo}>{fmtPts(r.v)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
