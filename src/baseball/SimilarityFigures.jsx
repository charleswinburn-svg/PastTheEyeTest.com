import { useTheme } from "./ThemeContext.jsx";
import { NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";
import { PITCH_COLORS, PITCH_NAMES } from "./mlbApi.js";

// ═══════════════════════════════════════════════════════════
// SIMILARITY FIGURES (pitcher comparison)
// ═══════════════════════════════════════════════════════════
// Figures for an expanded comp on the pitcher card's Similar Players panel,
// one column per pitcher (card's pitcher on the left, the comp on the right)
// so the two can be read side by side on identical scales. Everything uses the
// files' arm-side convention (positive x = toward the pitcher's arm side), so
// a LHP and a RHP line up directly.
//
//   MovementPlot   — per-pitch-type average movement (arm-side HB vs IVB),
//                    dot size = usage.
//   ReleaseDiagram — catcher's-view pitcher at the instant of release: lead leg
//                    striding at the plate, back leg bent with the toe on the
//                    rubber, throwing arm at the measured arm angle ending at
//                    the release point, per-pitch-type release balls, release
//                    height / horizontal release callouts, and a side-view
//                    strip for extension.

// Same pitch colours and names as the pitcher summaries / arsenal panel.
export { PITCH_COLORS, PITCH_NAMES };
const colorOf = pt => PITCH_COLORS[pt] || "#888";
const nameOf = pt => PITCH_NAMES[pt] || pt;
const isNum = v => typeof v === "number" && Number.isFinite(v);
const ft = v => (isNum(v) ? `${v.toFixed(1)} ft` : "—");
const lastName = n => (n || "").split(" ").slice(-1)[0];

// ── Movement plot (one pitcher) ─────────────────────────────
export function MovementPlot({ p, accent, size = 360 }) {
  const { theme: t } = useTheme();
  const R = 25;                         // ± inches shown
  const pad = 30;
  const c = size / 2;
  const s = (size - 2 * pad) / (2 * R); // px per inch
  const X = hb => c + hb * s;
  const Y = ivb => c - ivb * s;
  const ars = p?.arsenal || {};
  const types = Object.keys(ars).sort((a, b) => (ars[b].usage ?? 0) - (ars[a].usage ?? 0));
  const grid = [-20, -10, 10, 20];
  const txt = { fontSize: 9, fill: t.textFaint, fontFamily: "inherit" };
  const pt = k => {
    const a = ars[k];
    return a && isNum(a.hb) && isNum(a.ivb)
      ? { x: X(Math.max(-R, Math.min(R, a.hb))), y: Y(Math.max(-R, Math.min(R, a.ivb))), usage: a.usage ?? 0 }
      : null;
  };
  return (
    <svg viewBox={`0 0 ${size} ${size + 14}`} width={size} height={size + 14} style={{ display: "block" }}>
      <text x={c} y={11} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: accent || t.textMuted, fontFamily: "inherit" }}>
        Movement · arm-side corrected
      </text>
      <g transform="translate(0,14)">
        <rect x={pad} y={pad} width={size - 2 * pad} height={size - 2 * pad} fill={t.inputBg} stroke={t.divider} />
        {grid.map(g => (
          <g key={g}>
            <line x1={X(g)} y1={pad} x2={X(g)} y2={size - pad} stroke={t.divider} strokeWidth={0.6} />
            <line x1={pad} y1={Y(g)} x2={size - pad} y2={Y(g)} stroke={t.divider} strokeWidth={0.6} />
            <text x={X(g)} y={size - pad + 10} textAnchor="middle" style={txt}>{g}</text>
            <text x={pad - 4} y={Y(g) + 3} textAnchor="end" style={txt}>{g}</text>
          </g>
        ))}
        <line x1={X(0)} y1={pad} x2={X(0)} y2={size - pad} stroke={t.textFaint} strokeWidth={0.8} />
        <line x1={pad} y1={Y(0)} x2={size - pad} y2={Y(0)} stroke={t.textFaint} strokeWidth={0.8} />
        <text x={c} y={size - 4} textAnchor="middle" style={txt}>← glove side · HB (in) · arm side →</text>
        <text x={10} y={c} textAnchor="middle" transform={`rotate(-90 10 ${c})`} style={txt}>IVB (in)</text>
        {types.map(k => {
          const q = pt(k);
          if (!q) return null;
          const r = 4 + q.usage * 12;
          return (
            <g key={k}>
              <circle cx={q.x} cy={q.y} r={r} fill={colorOf(k)} stroke={t.cardBg} strokeWidth={1}>
                <title>{`${PITCH_NAMES[k] || k} · ${Math.round(q.usage * 100)}% · ${ars[k].hb.toFixed(1)}" HB, ${ars[k].ivb.toFixed(1)}" IVB`}</title>
              </circle>
              <text x={q.x + r + 3} y={q.y + 3} style={{ fontSize: 9, fontWeight: 700, fill: colorOf(k), fontFamily: "inherit", paintOrder: "stroke", stroke: t.cardBg, strokeWidth: 2 }}>{nameOf(k)}</text>
            </g>
          );
        })}
      </g>
    </svg>
  );
}

// ── Release diagram (one pitcher, catcher's view) ───────────
function releaseOf(p) {
  const v = p?.v || {};
  return { x: v.release_x, z: v.release_z, ext: v.extension, angle: v.arm_angle };
}

export function ReleaseDiagram({ p, accent, width = 360 }) {
  const { theme: t } = useTheme();
  const S = 34;                     // px per ft (±5.3 ft across: room for 4.5 ft release sides)
  const Z0 = -1.1;                  // ft at the bottom edge (room for the slope)
  const H = 10.0;                   // ft of height shown (headroom for over-the-top releases)
  const height = Math.round(H * S);
  // True catcher's view (not side-corrected): the body is modelled in arm-side
  // coordinates and flipped at draw time, so a RHP's arm comes from the
  // catcher's left (3B side) and a LHP's from the right (1B side).
  const dir = p?.hand === "L" ? 1 : -1;
  const X0 = -(width / S) / 2;      // rubber centred
  const X = x => (dir * x - X0) * S;
  const Y = z => height - 10 - (z - Z0) * S;
  const r = releaseOf(p);
  const hasRel = isNum(r.x) && isNum(r.z);
  const angle = isNum(r.angle) ? r.angle : 45;
  const txt = { fontSize: 9, fill: t.textFaint, fontFamily: "inherit" };
  const num = { fontSize: 10, fill: t.text, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT };
  const color = accent || t.accent;

  // Body geometry (arm-side coordinates, flipped at draw time):
  //  1. The throwing shoulder sits on the measured arm-angle ray behind the
  //     release point, one arm length back — so the drawn arm IS the measured
  //     angle (Savant's definition: shoulder → release).
  //  2. The hips stay near the rubber (drifting a little to the arm side and
  //     sinking for low slots).
  //  3. The trunk is solved to connect hip and shoulder with the shoulder line
  //     perpendicular to it: hip + T·u + ½w·v = shoulder, v ⟂ u. That makes an
  //     over-the-top arm lean the trunk toward the glove side and a submariner
  //     bend toward the arm side, by exactly as much as the numbers demand.
  //     The trunk length is clamped to a human range by sliding the hips.
  const hFt = isNum(p?.height) ? p.height / 12 : 6.2;
  const ARM = 0.33 * hFt;                                 // shoulder → ball at release, ft
  const HALF_SH = 0.55, T_MIN = 1.15, T_MAX = 1.95;         // ft
  const low = Math.max(0, Math.min(1, (30 - angle) / 90)); // 0 conventional … 1 deep submarine
  const thm = (angle * Math.PI) / 180;
  const ts = hasRel ? { x: r.x - ARM * Math.cos(thm), z: r.z - ARM * Math.sin(thm) }
                    : { x: 0.5, z: 0.7 * hFt };            // throwing shoulder
  const sh = hasRel ? ts : null;
  let hip = { x: 0.45 + 0.4 * low, z: 2.55 - 0.3 * low };
  const rot = (x, z, a) => ({ x: x * Math.cos(a) - z * Math.sin(a), z: x * Math.sin(a) + z * Math.cos(a) });
  // solve trunk tilt α and length T from d = hip→shoulder = R(α)·(½w, T)
  let d = { x: ts.x - hip.x, z: ts.z - hip.z };
  let T = Math.sqrt(Math.max(0.01, d.x * d.x + d.z * d.z - HALF_SH * HALF_SH));
  let alpha = Math.atan2(d.z, d.x) - Math.atan2(T, HALF_SH);
  if (T > T_MAX || T < T_MIN) {                            // slide the hips along to keep the trunk human-sized
    T = Math.max(T_MIN, Math.min(T_MAX, T));
    const off = rot(HALF_SH, T, alpha);
    hip = { x: ts.x - off.x, z: Math.max(2.1, Math.min(3.2, ts.z - off.z)) };
    d = { x: ts.x - hip.x, z: ts.z - hip.z };
    T = Math.sqrt(Math.max(0.01, d.x * d.x + d.z * d.z - HALF_SH * HALF_SH));
    alpha = Math.atan2(d.z, d.x) - Math.atan2(T, HALF_SH);
  }
  const u = { x: -Math.sin(alpha), z: Math.cos(alpha) };  // trunk direction (hip → shoulders)
  const v = { x: Math.cos(alpha), z: Math.sin(alpha) };   // shoulder line, toward the arm side
  const shC = { x: hip.x + T * u.x, z: hip.z + T * u.z }; // shoulder centre
  const gs = { x: shC.x - HALF_SH * v.x, z: shC.z - HALF_SH * v.z };
  const headR = 0.42;
  const head = { x: shC.x + 0.95 * u.x, z: shC.z + 0.95 * u.z };
  const leadKnee = { x: hip.x - 0.35, z: hip.z - 0.95 };
  const leadFoot = { x: hip.x - 0.45, z: -0.5 };
  const backKnee = { x: hip.x + 0.55, z: hip.z - 1.05 };
  const backFoot = { x: 0.4, z: 0.08 };
  const gloveElbow = { x: gs.x - 0.3 * v.x - 0.7 * u.x, z: gs.z - 0.3 * v.z - 0.7 * u.z };
  const glove = { x: shC.x - 0.45 * u.x, z: shC.z - 0.45 * u.z };
  const skin = t.id === "dark" ? "#9fb3c8" : "#b7c7d6";
  const skinBack = t.id === "dark" ? "#6f8299" : "#93a3b3";
  const limb = (a, b, w, col = skin) => <line x1={X(a.x)} y1={Y(a.z)} x2={X(b.x)} y2={Y(b.z)} stroke={col} strokeWidth={w} strokeLinecap="round" />;
  const moundPath = `M 0 ${Y(-0.35)} Q ${X(0)} ${Y(0.25)} ${width} ${Y(-0.35)} L ${width} ${height} L 0 ${height} Z`;
  const contour = z => `M ${X(X0 + 0.3)} ${Y(z - 0.12)} Q ${X(0)} ${Y(z + 0.14)} ${X(X0 + width / S - 0.3)} ${Y(z - 0.12)}`;

  // Per-pitch-type release balls only for 2026+; earlier seasons get one ball at
  // the average release point.
  const typeDots = Number(p?.season) >= 2026
    ? Object.entries(p?.arsenal || {}).filter(([, a]) => isNum(a.rel_x) && isNum(a.rel_z))
    : [];
  const arcRad = 0.75 * S;
  const th = thm;                                              // the drawn arm is the measured angle
  // keep labels fully inside the frame whatever the slot or hand: clamp by the
  // label's own width (≈6.2 px per character at 10 px) and keep clear of the top
  const inside = (x, pad = 70) => Math.max(pad, Math.min(width - pad, x));
  const fitX = (x, text, anchor = "middle") => {
    const w = String(text).length * 6.2 + 6;
    const left = anchor === "start" ? w : anchor === "end" ? 0 : w / 2;
    const right = anchor === "start" ? 0 : anchor === "end" ? w : w / 2;
    return Math.max(2 + left, Math.min(width - 2 - right, x));
  };
  const fitY = y => Math.max(30, Math.min(height - 4, y));
  const armLabel = isNum(r.angle) ? `${Math.round(r.angle)}° arm` : "";

  const extW = width, extS = Math.floor((width - 60) / 8.5), extPad = 24;
  const EX = e => extPad + e * extS;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: "block", overflow: "visible" }}>
        <text x={width / 2} y={11} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: color, fontFamily: "inherit" }}>
          Release point · catcher's view{p?.hand ? ` · ${p.hand}HP` : ""}
        </text>
        <text x={width / 2} y={22} textAnchor="middle" style={txt}>← 3B side · 1B side →</text>
        {/* mound: rubber on the crest, front slope below it */}
        <path d={moundPath} fill={t.id === "dark" ? "#3b2a1a" : "#c8a97e"} />
        {[-0.45, -0.8].map(z => <path key={z} d={contour(z)} fill="none" stroke={t.id === "dark" ? "#5a4530" : "#a88a62"} strokeWidth={0.8} />)}
        <rect x={X(0) - S} y={Y(0) - 4} width={2 * S} height={4} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.5} />
        <line x1={X(0)} y1={Y(0)} x2={X(0)} y2={Y(1.3)} stroke={t.textFaint} strokeWidth={0.6} strokeDasharray="2 3" />
        <text x={X(0) + 1.1 * S} y={Y(0) - 1} style={{ ...txt, fill: "#d6c6b0" }}>rubber</text>
        <text x={width - 4} y={Y(-0.95)} textAnchor="end" style={{ ...txt, fill: "#d6c6b0" }}>front slope → plate</text>
        {/* height axis */}
        {[2, 4, 6].map(z => (
          <g key={z}>
            <line x1={2} y1={Y(z)} x2={8} y2={Y(z)} stroke={t.textFaint} strokeWidth={0.8} />
            <text x={10} y={Y(z) + 3} style={txt}>{z} ft</text>
          </g>
        ))}
        {/* body */}
        <g fill={skin} opacity={0.85}>
          <g opacity={0.85}>
            {limb({ x: hip.x + 0.25, z: hip.z }, backKnee, 10, skinBack)}
            {limb(backKnee, backFoot, 9, skinBack)}
            <ellipse cx={X(backFoot.x)} cy={Y(backFoot.z)} rx={0.26 * S} ry={0.11 * S} fill={skinBack} />
          </g>
          <ellipse cx={X(leadFoot.x)} cy={Y(leadFoot.z) + 6} rx={0.42 * S} ry={0.1 * S} fill="#000" opacity={0.25} />
          {limb({ x: hip.x - 0.25, z: hip.z }, leadKnee, 13)}
          {limb(leadKnee, leadFoot, 12)}
          <ellipse cx={X(leadFoot.x)} cy={Y(leadFoot.z)} rx={0.3 * S} ry={0.17 * S} />
          <polygon
            points={[[gs.x + 0.12 * u.x, gs.z + 0.12 * u.z], [ts.x + 0.12 * u.x, ts.z + 0.12 * u.z], [hip.x + 0.4 * v.x, hip.z + 0.4 * v.z], [hip.x - 0.4 * v.x, hip.z - 0.4 * v.z]].map(([x, z]) => `${X(x)},${Y(z)}`).join(" ")}
            stroke={skin} strokeWidth={10} strokeLinejoin="round" />
          {limb(gs, gloveElbow, 8)}
          {limb(gloveElbow, glove, 7)}
          <circle cx={X(glove.x)} cy={Y(glove.z)} r={0.25 * S} />
          <circle cx={X(head.x)} cy={Y(head.z)} r={headR * S} />
        </g>
        {/* throwing arm at the measured slot */}
        {sh && (
          <g>
            <line x1={X(sh.x)} y1={Y(sh.z)} x2={X(r.x)} y2={Y(r.z)} stroke={color} strokeWidth={9} strokeLinecap="round" opacity={0.9} />
            <circle cx={X(sh.x)} cy={Y(sh.z)} r={6} fill={color} stroke={color} strokeWidth={2} />
            {/* arm-angle arc, opening toward the arm side (screen left for RHP, right for LHP) */}
            <line x1={X(sh.x)} y1={Y(sh.z)} x2={X(sh.x) + dir * (arcRad + 8)} y2={Y(sh.z)} stroke={color} strokeWidth={0.8} strokeDasharray="2 2" />
            <path d={`M ${X(sh.x) + dir * arcRad} ${Y(sh.z)} A ${arcRad} ${arcRad} 0 0 ${(dir > 0) === (th >= 0) ? 0 : 1} ${X(sh.x) + dir * arcRad * Math.cos(th)} ${Y(sh.z) - arcRad * Math.sin(th)}`} fill="none" stroke={color} strokeWidth={1.2} />
            {/* label: above the reference line for normal slots, below it when the arm runs along or under the line */}
            {isNum(r.angle) && (
              <text x={fitX(X(sh.x) + dir * (arcRad + 10), armLabel)} y={fitY(Y(sh.z) + (th < 0.38 ? 14 : -5))} textAnchor="middle" style={{ ...num, fill: color }}>{armLabel}</text>
            )}
          </g>
        )}
        {/* callouts */}
        {isNum(r.z) && isNum(r.x) && (
          <g>
            <line x1={40} y1={Y(r.z)} x2={X(r.x)} y2={Y(r.z)} stroke={color} strokeWidth={0.8} strokeDasharray="3 3" />
            {/* height label: above the ball, or beside it on the side away from the body when the ball is near the top */}
            {/* height label: above the ball normally; below it when the arm points down (the arm-angle
                label then sits above), or beside it when the ball is near the top edge */}
            {Y(r.z) <= 44
              ? <text x={fitX(X(r.x) - dir * 12, `${ft(r.z)} high`, dir > 0 ? "end" : "start")} y={fitY(Y(r.z) + 4)} textAnchor={dir > 0 ? "end" : "start"} style={{ ...num, fill: color }}>{ft(r.z)} high</text>
              : th < -0.4
                ? <text x={fitX(X(r.x), `${ft(r.z)} high`)} y={fitY(Y(r.z) + 18)} textAnchor="middle" style={{ ...num, fill: color }}>{ft(r.z)} high</text>
                : <text x={fitX(X(r.x), `${ft(r.z)} high`)} y={fitY(Y(r.z) - 11)} textAnchor="middle" style={{ ...num, fill: color }}>{ft(r.z)} high</text>}
            <line x1={X(r.x)} y1={Y(r.z)} x2={X(r.x)} y2={Y(0)} stroke={color} strokeWidth={0.8} strokeDasharray="3 3" />
            <line x1={X(0)} y1={Y(0.55)} x2={X(r.x)} y2={Y(0.55)} stroke={color} strokeWidth={0.8} />
            {Math.abs(r.x) < 1.2
              ? <text x={fitX(X(r.x) + dir * 8, `${ft(r.x)} side`, dir > 0 ? "start" : "end")} y={Y(0.55) - 3} textAnchor={dir > 0 ? "start" : "end"} style={{ ...num, fill: color }}>{ft(r.x)} side</text>
              : <text x={fitX(X(r.x / 2), `${ft(r.x)} side`)} y={Y(0.55) - 3} textAnchor="middle" style={{ ...num, fill: color }}>{ft(r.x)} side</text>}
          </g>
        )}
        {/* release balls per pitch type (or one ball at the average release) */}
        {typeDots.length ? typeDots.map(([k, a]) => (
          <circle key={k} cx={X(a.rel_x)} cy={Y(a.rel_z)} r={5} fill={colorOf(k)} stroke={t.cardBg} strokeWidth={1}>
            <title>{`${PITCH_NAMES[k] || k}: ${a.rel_x.toFixed(2)} ft side, ${a.rel_z.toFixed(2)} ft high`}</title>
          </circle>
        )) : (isNum(r.x) && isNum(r.z) && <circle cx={X(r.x)} cy={Y(r.z)} r={6} fill={color} stroke={t.cardBg} />)}
      </svg>
      {/* Extension strip (side view) */}
      <svg viewBox={`0 0 ${extW} 62`} width={extW} height={62} style={{ display: "block", marginTop: 4 }}>
        <text x={extW / 2} y={10} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: t.textMuted, fontFamily: "inherit" }}>Extension · side view (rubber → release)</text>
        <line x1={extPad} y1={44} x2={extW - 8} y2={44} stroke={t.textFaint} strokeWidth={1} />
        <rect x={extPad - 3} y={34} width={6} height={10} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.5} />
        {[2, 4, 6, 8].map(e => (
          <g key={e}>
            <line x1={EX(e)} y1={42} x2={EX(e)} y2={46} stroke={t.textFaint} />
            <text x={EX(e)} y={57} textAnchor="middle" style={txt}>{e} ft</text>
          </g>
        ))}
        <text x={extW - 8} y={57} textAnchor="end" style={txt}>→ plate</text>
        {isNum(r.ext) && (
          <g>
            <line x1={extPad} y1={44} x2={EX(r.ext)} y2={44} stroke={color} strokeWidth={3} />
            <circle cx={EX(r.ext)} cy={44} r={6} fill={color} stroke={t.cardBg} />
            <text x={EX(r.ext)} y={30} textAnchor="middle" style={{ ...num, fill: color }}>{ft(r.ext)}</text>
          </g>
        )}
      </svg>
    </div>
  );
}

// One column per pitcher: movement plot over release diagram.
// show: "both" | "movement" | "release"
function PitcherColumn({ p, label, sub, accent, show = "both" }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ flex: "1 1 360px", minWidth: 300, maxWidth: 440 }}>
      <div style={{ padding: "0 0 6px", borderBottom: `2px solid ${accent}`, marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: t.text }}>{label}</div>
        <div style={{ fontSize: 10, color: t.textMuted }}>{sub}</div>
      </div>
      {show !== "release" && <MovementPlot p={p} accent={accent} />}
      {show === "both" && <div style={{ height: 10 }} />}
      {show !== "movement" && <ReleaseDiagram p={p} accent={accent} />}
    </div>
  );
}

// Which figure belongs to an isolated component (null = no figure for it).
export const FIGURE_FOR_COMPONENT = { arsenal: "movement", release: "release" };

export function PitcherCompareFigures({ target, other, show = "both" }) {
  const { theme: t } = useTheme();
  const sub = (p, season) => {
    const v = p?.v || {};
    const rel = show === "movement" ? "" : ` · arm ${isNum(v.arm_angle) ? `${Math.round(v.arm_angle)}°` : "—"} · ${ft(v.release_z)} high · ${ft(v.release_x)} side · ext ${ft(v.extension)}`;
    return `${season}${p?.team ? ` · ${p.team}` : ""}${p?.hand ? ` · ${p.hand}HP` : ""}${rel}`;
  };
  return (
    <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 14 }}>
      <PitcherColumn p={target} label={`${target.name} ${target.season}`} sub={sub(target, target.season)} accent={t.accent} show={show} />
      <PitcherColumn p={other.player} label={`${other.name} ${other.season}`} sub={sub(other.player, other.season)} accent={t.accentSecondary} show={show} />
    </div>
  );
}

export { lastName };
