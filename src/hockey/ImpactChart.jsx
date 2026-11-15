import { useMemo, useRef, useState } from "react";
import { TIERS, TIER_COLORS } from "./nhlColors.js";
import { MEASURES, fixed } from "./rows.js";
import { seasonLabel, seasonShort } from "./nhlData.js";

// ═══════════════════════════════════════════════════════════
// IMPACT BY SEASON
// One player's WAR (or GAR, GAA) each season, drawn over the tiers his position ranked in
// that season. A tier's lower edge in a season is the lowest value that made it, so the
// edges move from season to season; they are drawn as smooth curves, not a block per season.
//
// Shapes are SVG; every piece of text is HTML laid over it, so the numbers stay in the
// site's number font on screen and in the saved PNG (html2canvas draws an <svg> as a
// picture, where web fonts are not available).
// ═══════════════════════════════════════════════════════════

const PAD = { left: 46, right: 14, top: 12, bottom: 24 };
const COL = { war: 2, gar: 3, gaa: 4 }, TIER_COL = { tier_war: 5, tier_gar: 6, tier_gaa: 7 };

// Monotone cubic segments through the points (never overshoots a value).
function segments(pts) {
  const n = pts.length;
  if (n < 2) return [];
  const dx = [], m = [];
  for (let i = 0; i < n - 1; i++) { dx.push(pts[i + 1][0] - pts[i][0]); m.push((pts[i + 1][1] - pts[i][1]) / dx[i]); }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) {
    t.push(m[i - 1] * m[i] <= 0 ? 0
      : 3 * (dx[i - 1] + dx[i]) / ((2 * dx[i] + dx[i - 1]) / m[i - 1] + (dx[i] + 2 * dx[i - 1]) / m[i]));
  }
  t.push(m[n - 2]);
  return dx.map((d, i) => ({
    p0: pts[i], p1: pts[i + 1],
    c1: [pts[i][0] + d / 3, pts[i][1] + t[i] * d / 3],
    c2: [pts[i + 1][0] - d / 3, pts[i + 1][1] - t[i + 1] * d / 3],
  }));
}
const f = v => v.toFixed(1);
const forward = segs => segs.map(s => `C${f(s.c1[0])},${f(s.c1[1])} ${f(s.c2[0])},${f(s.c2[1])} ${f(s.p1[0])},${f(s.p1[1])}`).join(" ");
const backward = segs => [...segs].reverse().map(s => `C${f(s.c2[0])},${f(s.c2[1])} ${f(s.c1[0])},${f(s.c1[1])} ${f(s.p0[0])},${f(s.p0[1])}`).join(" ");
const linePath = pts => (pts.length < 2 ? "" : `M${f(pts[0][0])},${f(pts[0][1])} ${forward(segments(pts))}`);
function bandPath(upper, lower) {
  const u = segments(upper), l = segments(lower);
  return `M${f(upper[0][0])},${f(upper[0][1])} ${forward(u)} L${f(lower[lower.length - 1][0])},${f(lower[lower.length - 1][1])} ${backward(l)} Z`;
}

function niceTicks(lo, hi, want = 5) {
  const raw = (hi - lo) / want, mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 2.5, 5, 10].map(k => k * mag).find(s => s >= raw) || raw;
  const out = [];
  for (let v = Math.ceil(lo / step) * step; v <= hi + 1e-9; v += step) out.push(Math.abs(v) < 1e-9 ? 0 : v);
  return { ticks: out, decimals: step < 1 ? (step < 0.1 ? 2 : 1) : 0 };
}

export default function ImpactChart({ rows, cuts, pos, seasons, inProgress, measure, width, height = 300, big, t }) {
  const fs = big ? { tick: 12, point: 15, legend: 14, note: 12, sw: 14 } : { tick: 10, point: 12, legend: 11, note: 10, sw: 12 };
  const boxRef = useRef(null);
  const [hover, setHover] = useState(null);
  const M = MEASURES.find(x => x.id === measure) || MEASURES[0];

  const g = useMemo(() => {
    const tiers = TIERS[pos] || [];
    const edges = tiers.slice(0, -1);                           // tiers that have a lower edge
    const banded = pos === "G" ? tiers : edges;                 // tiers drawn as a coloured band
    const mine = (rows || []).map(r => ({ season: r[0], team: r[1], value: r[COL[M.col]], tier: r[TIER_COL[M.tier]] }))
      .filter(d => d.value != null && seasons.includes(d.season));
    const cut = seasons.map(y => edges.map(n => cuts?.[M.id]?.[y]?.[n]));
    const flat = cut.flat().filter(v => v != null);
    const mineVals = mine.map(d => d.value);
    if (!flat.length && !mineVals.length) return null;
    const cmin = flat.length ? Math.min(...flat) : Math.min(...mineVals), cmax = flat.length ? Math.max(...flat) : Math.max(...mineVals);
    const span = (cmax - cmin) || 1;
    let lo = Math.min(...mineVals, cmin - 0.45 * span) - 0.08 * span;
    let hi = Math.max(...mineVals, cmax + 0.6 * span);
    hi += 0.14 * (hi - lo);

    const plotW = width - PAD.left - PAD.right, plotH = height - PAD.top - PAD.bottom;
    const bw = plotW / seasons.length;
    const x = i => PAD.left + (i + 0.5) * bw;
    const y = v => PAD.top + (hi - v) / (hi - lo) * plotH;
    const xL = PAD.left, xR = PAD.left + plotW;
    const across = vals => [[xL, y(vals[0])], ...vals.map((v, i) => [x(i), y(v)]), [xR, y(vals[vals.length - 1])]];

    // lower edge of each tier per season, never above the tier before it
    const edgeVals = edges.map((_, j) => seasons.map((_, i) => cut[i][j]));
    for (let j = 0; j < edgeVals.length; j++) {
      for (let i = 0; i < seasons.length; i++) {
        let v = edgeVals[j][i];
        if (v == null) v = j ? edgeVals[j - 1][i] : lo;
        if (j) v = Math.min(v, edgeVals[j - 1][i]);
        edgeVals[j][i] = Math.max(lo, Math.min(hi, v));
      }
    }
    const top = seasons.map(() => hi), bottom = seasons.map(() => lo);
    const bands = banded.map((name, j) => ({
      name, color: TIER_COLORS[pos]?.[name] || "#888",
      d: bandPath(across(j ? edgeVals[j - 1] : top), across(j < edgeVals.length ? edgeVals[j] : bottom)),
    }));
    const pts = mine.map(d => ({ ...d, i: seasons.indexOf(d.season), x: x(seasons.indexOf(d.season)), y: y(d.value) }));
    return { tiers, banded, bands, pts, line: linePath(pts.map(p => [p.x, p.y])), x, y, bw, lo, hi, plotH,
             ticks: niceTicks(lo, hi), zeroY: lo < 0 && hi > 0 ? y(0) : null };
  }, [rows, cuts, pos, seasons, M, width, height]);

  if (!g) return <div style={{ color: t.textFaint, fontSize: 12, padding: "12px 0" }}>No seasons to show.</div>;

  const onMove = e => {
    const r = boxRef.current.getBoundingClientRect();
    const px = (e.clientX - r.left) * (width / r.width);        // the card may be scaled to fit a phone
    const i = Math.max(0, Math.min(seasons.length - 1, Math.floor((px - PAD.left) / g.bw)));
    setHover(i);
  };
  const hp = hover == null ? null : g.pts.find(p => p.i === hover);
  const halo = `0 0 3px ${t.cardBg}, 0 0 3px ${t.cardBg}, 0 0 2px ${t.cardBg}`;
  const txt = { position: "absolute", fontSize: fs.tick, fontWeight: 700, color: t.textMuted, lineHeight: 1, whiteSpace: "nowrap" };

  return (
    <div>
      {/* legend: one swatch per tier, best first */}
      <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginBottom: 10, fontSize: fs.legend, fontWeight: 600, color: t.textSecondary }}>
        {g.tiers.map(name => {
          const c = TIER_COLORS[pos]?.[name];
          return (
            <span key={name} style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
              <span style={{ width: fs.sw, height: fs.sw, borderRadius: 3, background: c || "transparent",
                             border: c ? "none" : `1.5px dashed ${t.textFaint}`, boxSizing: "border-box" }} />
              {name}
            </span>
          );
        })}
      </div>

      <div ref={boxRef} style={{ position: "relative", width, height, touchAction: "pan-y" }}
        onPointerMove={onMove} onPointerDown={onMove} onPointerLeave={() => setHover(null)}>
        <svg width={width} height={height} style={{ position: "absolute", inset: 0, display: "block" }}>
          <defs>
            <clipPath id="nhl-impact-plot"><rect x={PAD.left} y={PAD.top} width={width - PAD.left - PAD.right} height={g.plotH} rx="6" /></clipPath>
          </defs>
          <g clipPath="url(#nhl-impact-plot)">
            <rect x={PAD.left} y={PAD.top} width={width - PAD.left - PAD.right} height={g.plotH} fill={t.inputBg} />
            {g.bands.map(b => <path key={b.name} d={b.d} fill={b.color} stroke={t.cardBg} strokeWidth="1.5" />)}
            {g.zeroY != null && <line x1={PAD.left} x2={width - PAD.right} y1={g.zeroY} y2={g.zeroY} stroke={t.cardBg} strokeOpacity="0.55" strokeDasharray="4 4" />}
            {hover != null && <line x1={g.x(hover)} x2={g.x(hover)} y1={PAD.top} y2={PAD.top + g.plotH} stroke={t.text} strokeOpacity="0.55" strokeWidth="1" />}
          </g>
          {g.line && <path d={g.line} fill="none" stroke={t.cardBg} strokeWidth="7" strokeLinecap="round" strokeLinejoin="round" />}
          {g.line && <path d={g.line} fill="none" stroke={t.text} strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />}
          {g.pts.map(p => <circle key={p.season} cx={p.x} cy={p.y} r={hover === p.i ? 7 : 5.5} fill={t.text} stroke={t.cardBg} strokeWidth="2.5" />)}
        </svg>

        {/* axis text and point labels, as HTML */}
        {g.ticks.ticks.map(v => (
          <div key={v} style={{ ...txt, left: 0, width: PAD.left - 8, textAlign: "right", top: g.y(v) - fs.tick / 2 }}>{fixed(v, g.ticks.decimals)}</div>
        ))}
        {seasons.map((s, i) => (
          <div key={s} style={{ ...txt, left: g.x(i), top: height - PAD.bottom + 8, transform: "translateX(-50%)",
                                color: hover === i ? t.text : t.textMuted }}>
            {seasonShort(s)}{s === inProgress ? "*" : ""}
          </div>
        ))}
        {g.pts.map(p => (
          <div key={p.season} style={{ ...txt, left: p.x, top: Math.max(2, p.y - fs.point - 13), transform: "translateX(-50%)", fontSize: fs.point,
                                       fontWeight: 800, color: t.text, textShadow: halo }}>
            {fixed(p.value, 1)}
          </div>
        ))}

        {hover != null && (
          <div data-html2canvas-ignore="" style={{
            position: "absolute", top: PAD.top + 6, pointerEvents: "none", zIndex: 5,
            ...(g.x(hover) > width / 2 ? { right: width - g.x(hover) + 12 } : { left: g.x(hover) + 12 }),
            background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 8, padding: "8px 10px",
            boxShadow: `0 6px 18px ${t.shadow}`, fontSize: fs.tick + 1, lineHeight: 1.5, color: t.textSecondary, whiteSpace: "nowrap" }}>
            <div style={{ fontWeight: 800, color: t.text }}>{seasonLabel(seasons[hover])}{seasons[hover] === inProgress ? " (in progress)" : ""}</div>
            {hp ? (
              <>
                <div>{hp.team} · {M.id} <b style={{ color: t.text }}>{fixed(hp.value, 2)}</b></div>
                <div style={{ display: "flex", alignItems: "center", gap: 5 }}>
                  <span style={{ width: 9, height: 9, borderRadius: 2, background: TIER_COLORS[pos]?.[hp.tier] || "transparent",
                                 border: TIER_COLORS[pos]?.[hp.tier] ? "none" : `1px dashed ${t.textFaint}` }} />
                  {hp.tier}
                </div>
              </>
            ) : <div style={{ color: t.textFaint }}>Did not play</div>}
          </div>
        )}
      </div>
      {inProgress != null && seasons.includes(inProgress) && (
        <div style={{ fontSize: fs.note, color: t.textFaint, marginTop: 6 }}>* {seasonLabel(inProgress)} is in progress, so its totals and tier lines are still small.</div>
      )}
    </div>
  );
}
