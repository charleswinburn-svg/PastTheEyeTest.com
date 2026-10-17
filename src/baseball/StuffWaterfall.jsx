import { useState, useEffect, useMemo, useRef } from "react";
import { useTheme } from "./ThemeContext.jsx";
import {
  PlayerHeader, SearchableSelect, useFallbackTeamId,
  saveCardAsPng, teamMarkColor, hexLuminance, mixHex, binColor, textOnBin,
  TEAM_IDS, MLB_TEAM_PRIMARY,
} from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";

// One-season Stuff+ waterfall per pitch type (SUMMARIES → Pitcher Stuff+), split by
// platoon: vs same-handed hitters | vs opposite-handed hitters, side by side.
// Reads /stuff_waterfall_{season}.json (build_stuff_waterfall.py): pitcherId ->
//   { name, throws, n, types: { FF: { stuff_plus, pct, n, base, c: { group: Stuff+ points },
//                                     same: { stuff_plus, pct, n, base, c }, oppo: {…} } } }
// `base` is the league-average pitch of that type (vs that side); the bars are the Stuff
// model's TreeSHAP contributions vs that average and sum exactly to stuff_plus − base.

const PITCH_NAMES = {
  FF: "Four-Seamer", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", SV: "Slurve",
  CU: "Curveball", KC: "Knuckle Curve", CS: "Slow Curve", CH: "Changeup", FS: "Splitter",
  FO: "Forkball", SC: "Screwball", KN: "Knuckleball",
};
const pitchName = (pt) => PITCH_NAMES[pt] || pt;

// MLB team id → an abbreviation MLB_TEAM_PRIMARY knows (for the API fallback).
const ABBR_BY_TEAM_ID = Object.entries(TEAM_IDS).reduce((m, [abbr, id]) => {
  if (MLB_TEAM_PRIMARY[abbr] && !(id in m)) m[id] = abbr;
  return m;
}, {});

const _wfCache = new Map();
function loadWaterfall(season) {
  if (!_wfCache.has(season)) {
    _wfCache.set(season, fetch(`/stuff_waterfall_${season}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return _wfCache.get(season);
}

// Keep the team color readable on the card (same rule as the iSwing+ waterfall).
function readableOn(hex, isDark) {
  const lum = hexLuminance(hex);
  if (isDark && lum < 0.05) return mixHex(hex, "#ffffff", 0.35);
  if (!isDark && lum > 0.45) return mixHex(hex, "#000000", 0.35);
  return hex;
}

const FONT = "'Pliant', sans-serif";

// html2canvas draws each inline <svg> as a standalone image, which can't see the page's
// web fonts, so the PNG's chart text fell back to a system font. For the capture only,
// embed Pliant's latin subset into the SVGs as a data-URI @font-face.
const PLIANT_CSS = "https://fonts.googleapis.com/css2?family=Pliant:wght@100..900&display=swap";
let _pliantFace = null;
function pliantFace() {
  if (!_pliantFace) {
    _pliantFace = (async () => {
      const css = await (await fetch(PLIANT_CSS)).text();
      const block = (css.match(/\/\* latin \*\/\s*(@font-face\s*{[^}]*})/) || [])[1];
      const url = block && (block.match(/url\(([^)]+)\)/) || [])[1];
      if (!url) return "";
      const blob = await (await fetch(url)).blob();
      const data = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
      });
      return block.replace(url, data);
    })().catch(() => { _pliantFace = null; return ""; });
  }
  return _pliantFace;
}
async function embedPliant(root) {
  const face = await pliantFace();
  if (!face) return () => {};
  const added = [...root.querySelectorAll("svg")].map(svg => {
    const st = document.createElementNS("http://www.w3.org/2000/svg", "style");
    st.textContent = face;
    svg.insertBefore(st, svg.firstChild);
    return st;
  });
  return () => added.forEach(n => n.remove());
}
const fmtPts = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
const SIDES = [
  { key: "same", title: "vs. Same-Handed Hitters", short: "same-handed" },
  { key: "oppo", title: "vs. Opposite-Handed Hitters", short: "opposite-handed" },
];
const handedness = (throws, side) => {
  if (throws !== "L" && throws !== "R") return "";
  const bat = side === "same" ? throws : (throws === "L" ? "R" : "L");
  return `${throws}HP vs ${bat}HH`;
};

export default function StuffWaterfall({ season, pitchers }) {
  const { theme: t, isDark } = useTheme();
  const cardRef = useRef(null);
  const [data, setData] = useState(undefined);   // undefined = loading, null = no file
  const [pid, setPid] = useState(null);
  const [pt, setPt] = useState(null);

  useEffect(() => {
    let alive = true;
    setData(undefined);
    loadWaterfall(season).then(d => { if (alive) setData(d && typeof d === "object" ? d : null); });
    return () => { alive = false; };
  }, [season]);

  // Drop the selection when the new season doesn't have that pitcher.
  useEffect(() => {
    if (data && pid && !data[pid]) setPid(null);
  }, [data, pid]);

  const pitcherById = useMemo(() => {
    const m = new Map();
    for (const p of pitchers || []) if (p.player_id != null) m.set(String(p.player_id), p);
    return m;
  }, [pitchers]);

  const options = useMemo(() => {
    if (!data) return [];
    return Object.entries(data)
      .filter(([k, r]) => k !== "meta" && r?.types)
      .map(([id, r]) => {
        const p = pitcherById.get(id);
        const name = p?.name || r.name || id;
        const types = Object.keys(r.types).join(" · ");
        return { value: id, name, label: `${name}${p?.team ? ` (${p.team})` : ""} — ${types}` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, pitcherById]);

  const rec = data && pid ? data[pid] : null;
  // Pitch types by usage; keep the chosen type if this pitcher throws it, else his main pitch.
  const types = useMemo(
    () => (rec ? Object.entries(rec.types).sort((a, b) => b[1].n - a[1].n).map(([k]) => k) : []),
    [rec]);
  const activePt = types.includes(pt) ? pt : types[0] || null;
  const row = rec && activePt ? rec.types[activePt] : null;

  const groupLabels = useMemo(() => {
    const m = {};
    for (const g of data?.meta?.groups || []) m[g.key] = g.label;
    return m;
  }, [data]);

  // Both columns share one trait order (by combined size) and one x-axis range.
  const { order, range } = useMemo(() => {
    if (!row) return { order: [], range: 10 };
    const tot = {};
    for (const s of SIDES) for (const [f, v] of Object.entries(row[s.key]?.c || {})) tot[f] = (tot[f] || 0) + Math.abs(v);
    const order = Object.keys(tot).filter(f => tot[f] > 0).sort((a, b) => tot[b] - tot[a]);
    let maxDev = 1;
    for (const s of SIDES) {
      const r = row[s.key];
      if (!r) continue;
      let run = r.base;
      maxDev = Math.max(maxDev, Math.abs(run - 100), Math.abs(r.stuff_plus - 100));
      for (const f of order) { run += r.c[f] || 0; maxDev = Math.max(maxDev, Math.abs(run - 100)); }
    }
    const needed = maxDev + Math.max(4, maxDev * 0.15);   // headroom for the value labels
    const step = needed <= 20 ? 5 : needed <= 60 ? 10 : 20;
    return { order, range: { R: Math.max(10, Math.ceil(needed / step) * step), step } };
  }, [row]);

  const pitcher = pid ? pitcherById.get(pid) : null;
  const fallbackTeamId = useFallbackTeamId(pid ? Number(pid) : null, !!pid && !pitcher?.team);
  const team = pitcher?.team || ABBR_BY_TEAM_ID[fallbackTeamId] || null;
  const name = pitcher?.name || rec?.name || "";
  const barColor = readableOn(teamMarkColor(team) || t.accentSecondary, isDark);
  const minN = data?.meta?.min_n || 30;

  const saveCard = async () => {
    if (!cardRef.current) return;
    const undo = await embedPliant(cardRef.current);
    try {
      await saveCardAsPng(cardRef, `${name.replace(/\s+/g, "_")}_${activePt}_Stuff_platoon_${season}.png`);
    } finally {
      undo();
    }
  };

  const msg = (text) => <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>{text}</div>;
  const usage = (k) => (rec ? Math.round((100 * rec.types[k].n) / rec.n) : 0);

  return (
    <div style={{ padding: "16px 20px", fontFamily: FONT }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <SearchableSelect
          value={pid || ""}
          options={options}
          onChange={(v) => setPid(v || null)}
          placeholder="Search pitcher…"
          style={{ padding: "6px 12px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`, borderRadius: 6, fontSize: 12, minWidth: 320, fontFamily: FONT }}
        />
        {types.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setPt(k)}
            aria-pressed={k === activePt}
            title={`${pitchName(k)} · ${rec.types[k].n} pitches`}
            style={{
              padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 14, cursor: "pointer",
              fontFamily: FONT,
              background: k === activePt ? `${t.accent}26` : t.inputBg,
              color: k === activePt ? t.text : t.textMuted,
              border: `1px solid ${k === activePt ? t.accent : t.inputBorder}`,
            }}
          >
            {k} <span style={{ fontWeight: 500, opacity: 0.75 }}>{usage(k)}%</span>
          </button>
        ))}
        {data === undefined && <span style={{ fontSize: 11, color: t.textMuted }}>Loading {season} Stuff+…</span>}
      </div>

      {data === null && msg(`No Stuff+ breakdown for ${season} yet.`)}
      {data && !rec && msg("Select a pitcher")}

      {row && (
        <>
          <FitToWidth designWidth={1100}>
            <div ref={cardRef} style={{ fontFamily: FONT, background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`, overflow: "hidden", maxWidth: 1100, margin: "0 auto", boxShadow: `0 4px 24px ${t.shadow}` }}>
              <PlayerHeader
                name={name}
                team={team}
                teamId={pitcher?.team_id ?? fallbackTeamId}
                season={season}
                playerId={Number(pid)}
                subtitle={`${season} ${pitchName(activePt)} Stuff+ Breakdown`}
              />
              <SummaryStrip row={row} pt={activePt} usage={usage(activePt)} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "8px 14px 0" }}>
                {SIDES.map(s => (
                  <SidePanel key={s.key} side={s} r={row[s.key]} pt={activePt} throws={rec.throws}
                    order={order} range={range} labels={groupLabels} color={barColor} minN={minN} />
                ))}
              </div>
              <div style={{ padding: "8px 24px 6px", fontSize: 10, color: t.textFaint, lineHeight: 1.4, textAlign: "center" }}>
                Same-handed = RHP vs RHH or LHP vs LHH. Each column starts from the league-average {pitchName(activePt).toLowerCase()} thrown
                to that side; each bar after it is how much that trait moved this pitch's Stuff+ versus that average, from the
                Stuff model's own feature contributions. Both columns share one scale and trait order. Solid = helped, striped = hurt.
              </div>
              <div style={{ padding: "6px 16px 8px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
                <span>Created by: @PastTheEyeTest on X</span>
                <span style={{ fontStyle: "italic" }}>Data: Baseball Savant · Stuff+ {data?.meta?.model || ""}</span>
              </div>
            </div>
          </FitToWidth>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={saveCard} style={{ padding: "6px 16px", fontSize: 11, fontWeight: 600, fontFamily: FONT, background: t.inputBg, color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer" }}>📥 Save as PNG</button>
          </div>
        </>
      )}
    </div>
  );
}

const pctPill = (pct, size = 20) => (
  <span style={{ display: "inline-block", minWidth: size * 2.2, padding: "0 8px", borderRadius: 14, background: binColor(pct), color: textOnBin(pct), fontSize: size, textAlign: "center" }}>
    {pct}
  </span>
);

function SummaryStrip({ row, pt, usage }) {
  const { theme: t } = useTheme();
  const stat = (label, value) => (
    <div style={{ textAlign: "center", minWidth: 100 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: t.text, lineHeight: 1.2 }}>{value}</div>
    </div>
  );
  const split = SIDES.map(s => `vs. ${s.short} ${row[s.key] ? row[s.key].stuff_plus.toFixed(1) : "—"}`).join("  ·  ");
  return (
    <div style={{ padding: "14px 16px 4px" }}>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 30 }}>
        {stat(`${pt} Stuff+`, row.stuff_plus.toFixed(1))}
        {stat(`Pctile (${pt})`, pctPill(row.pct))}
        {stat("Pitches", row.n)}
        {stat("Usage", `${usage}%`)}
      </div>
      <div style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: t.textMuted, marginTop: 4, whiteSpace: "pre" }}>{split}</div>
    </div>
  );
}

// One platoon column: its own Stuff+, percentile and pitch count over its waterfall.
function SidePanel({ side, r, pt, throws, order, range, labels, color, minN }) {
  const { theme: t } = useTheme();
  const hand = handedness(throws, side.key);
  return (
    <div style={{ border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "10px 4px 2px" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: t.text }}>{side.title}</div>
        {hand && <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, letterSpacing: "0.08em" }}>{hand}</div>}
      </div>
      {r ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 18, padding: "6px 0 0", fontSize: 12, color: t.textMuted, fontWeight: 700 }}>
            <span>Stuff+ <span style={{ fontSize: 20, fontWeight: 800, color: t.text }}>{r.stuff_plus.toFixed(1)}</span></span>
            <span>Pctile {pctPill(r.pct, 14)}</span>
            <span>{r.n} pitches</span>
          </div>
          <Waterfall row={r} pt={pt} order={order} range={range} labels={labels} color={color} idSuffix={side.key} />
        </>
      ) : (
        <div style={{ color: t.textMuted, textAlign: "center", padding: "60px 12px", fontSize: 13 }}>
          Fewer than {minN} pitches vs. {side.short} hitters
        </div>
      )}
    </div>
  );
}

// ── The waterfall (SVG): 100 → league-average pitch of this type vs this side → one bar
// per trait (shared order) → this pitch's Stuff+. x-axis is symmetric around 100. ──
function Waterfall({ row, pt, order, range, labels, color, idSuffix }) {
  const { theme: t } = useTheme();
  const rows = useMemo(() => {
    const out = [{ f: "_base", label: `Avg ${pitchName(pt)}`, v: +(row.base - 100).toFixed(1), start: 100, end: row.base }];
    let run = row.base;
    for (const f of order) {
      const v = row.c[f] || 0;
      out.push({ f, label: labels[f] || f, v, start: run, end: run + v });
      run += v;
    }
    return out;
  }, [row, pt, order, labels]);
  const final = row.stuff_plus;

  const W = 520, labelW = 128, padR = 30, rowH = 24, top = 30, bottom = 34;
  const plotL = labelW, plotR = W - padR, plotW = plotR - plotL;
  const H = top + rows.length * rowH + bottom;
  const { R, step } = range;
  const x = (v) => plotL + ((v - (100 - R)) / (2 * R)) * plotW;
  const ticks = [];
  for (let v = 100 - R; v <= 100 + R + 1e-9; v += step) ticks.push(v);

  const patternId = `stuff-neg-${color.slice(1)}-${idSuffix}`;
  const baseNeg = `stuff-base-neg-${idSuffix}`;
  const yBottom = top + rows.length * rowH;
  const finalRight = final >= 100 && x(final) + 96 <= W;
  const halo = { stroke: t.cardBg, strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" };
  const baseColor = t.textMuted;

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2px 4px 0" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: "100%", height: "auto", fontFamily: FONT }} role="img"
        aria-label={`${pt} Stuff+ waterfall: ${rows.map(r => `${r.label} ${fmtPts(r.v)}`).join(", ")}; final ${final}`}>
        <defs>
          <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={color} fillOpacity="0.28" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="2.4" />
          </pattern>
          <pattern id={baseNeg} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={baseColor} fillOpacity="0.2" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={baseColor} strokeWidth="2.4" />
          </pattern>
        </defs>

        {ticks.map(v => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={top - 6} y2={yBottom} stroke={t.divider} strokeWidth="1" />
            <text x={x(v)} y={yBottom + 14} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textFaint}>{v}</text>
          </g>
        ))}
        <text x={(plotL + plotR) / 2} y={H - 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textMuted} letterSpacing="0.06em">STUFF+ POINTS</text>

        <line x1={x(100)} x2={x(100)} y1={top - 6} y2={yBottom} stroke={t.textMuted} strokeWidth="1.2" strokeDasharray="4 3" />
        <text x={x(100)} y={top - 10} textAnchor={finalRight ? "end" : "start"} dx={finalRight ? -4 : 4}
          fontSize="10" fill={t.textMuted}>Avg 100</text>
        <line x1={x(final)} x2={x(final)} y1={top - 6} y2={yBottom} stroke={t.text} strokeWidth="1.6" opacity="0.7" />
        <text x={x(final)} y={top - 10} textAnchor={finalRight ? "start" : "end"} dx={finalRight ? 4 : -4}
          fontSize="11" fontWeight="800" fill={t.text}>Stuff+ = {final.toFixed(1)}</text>

        {rows.map((r, j) => {
          const y = top + j * rowH;
          const x0 = x(Math.min(r.start, r.end)), x1 = x(Math.max(r.start, r.end));
          const pos = r.v >= 0;
          const isBase = r.f === "_base";
          const c = isBase ? baseColor : color;
          return (
            <g key={r.f}>
              <text x={labelW - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize="11"
                fontWeight={isBase ? 700 : 400} fill={isBase ? t.textSecondary : t.text}>{r.label}</text>
              {r.v !== 0 && (
                <rect x={x0} y={y + 4} width={Math.max(1.5, x1 - x0)} height={rowH - 8} rx="2"
                  fill={pos ? c : `url(#${isBase ? baseNeg : patternId})`}
                  fillOpacity={isBase && pos ? 0.55 : 1}
                  stroke={c} strokeWidth={pos ? 0 : 1} />
              )}
              {j < rows.length - 1 && (
                <line x1={x(r.end)} x2={x(r.end)} y1={y + rowH - 4} y2={y + rowH + 4} stroke={t.textFaint} strokeWidth="1" />
              )}
              <text x={pos ? x1 + 4 : x0 - 4} y={y + rowH / 2 + 3.5} textAnchor={pos ? "start" : "end"}
                fontSize="10" fontWeight="700" fill={r.v === 0 ? t.textFaint : t.textSecondary} {...halo}>{fmtPts(r.v)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
