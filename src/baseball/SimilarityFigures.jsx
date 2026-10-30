import { useTheme } from "./ThemeContext.jsx";
import { NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";

// ═══════════════════════════════════════════════════════════
// SIMILARITY FIGURES (pitcher comparison)
// ═══════════════════════════════════════════════════════════
// Two SVG figures for an expanded comp on the pitcher card's Similar Players
// panel. Both use the files' arm-side convention (positive x = toward the
// pitcher's arm side), so a LHP and a RHP overlay directly.
//
//   MovementPlot   — per-pitch-type average movement (arm-side HB vs IVB) for
//                    the target (filled) and the comp (hollow), matched types
//                    joined by a line.
//   ReleaseDiagram — catcher's-view pitcher figure with the throwing arm drawn
//                    at the measured arm angle, per-pitch-type release points,
//                    release height / horizontal release callouts, and a
//                    side-view strip for extension.

export const PITCH_COLORS = {
  FF: "#D22D49", SI: "#FE9D00", FC: "#933F2C",
  SL: "#EEE716", ST: "#DDB33A", SV: "#C9A227",
  CU: "#00D1ED", KC: "#6236CD", CS: "#3B6CD1",
  CH: "#1DBE3A", FS: "#3BACAC", FO: "#2E8B57", SC: "#7FBF7F",
  KN: "#888888", EP: "#AAAAAA",
};
export const PITCH_NAMES = {
  FF: "4-seam", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", SV: "Slurve",
  CU: "Curve", KC: "Knuckle curve", CS: "Slow curve", CH: "Change", FS: "Splitter",
  FO: "Fork", SC: "Screwball", KN: "Knuckle", EP: "Eephus",
};
const colorOf = pt => PITCH_COLORS[pt] || "#999";
const isNum = v => typeof v === "number" && Number.isFinite(v);
const ft = v => (isNum(v) ? `${v.toFixed(1)} ft` : "—");
const lastName = n => (n || "").split(" ").slice(-1)[0];

// ── Movement plot ───────────────────────────────────────────
export function MovementPlot({ a, b, nameA, nameB, size = 300 }) {
  const { theme: t } = useTheme();
  const R = 25;                         // ± inches shown
  const pad = 30;
  const c = size / 2;
  const s = (size - 2 * pad) / (2 * R); // px per inch
  const X = hb => c + hb * s;
  const Y = ivb => c - ivb * s;
  const arsA = a?.arsenal || {}, arsB = b?.arsenal || {};
  const types = [...new Set([...Object.keys(arsA), ...Object.keys(arsB)])].sort();
  const grid = [];
  for (let g = -20; g <= 20; g += 10) if (g !== 0) grid.push(g);
  const txt = { fontSize: 9, fill: t.textFaint, fontFamily: "inherit" };
  const pt = (ars, pt) => {
    const p = ars[pt];
    return p && isNum(p.hb) && isNum(p.ivb) ? { x: X(Math.max(-R, Math.min(R, p.hb))), y: Y(Math.max(-R, Math.min(R, p.ivb))), usage: p.usage ?? 0 } : null;
  };
  return (
    <svg viewBox={`0 0 ${size} ${size + 30}`} width={size} height={size + 30} style={{ display: "block" }}>
      <text x={c} y={11} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: t.textMuted, fontFamily: "inherit" }}>
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
        {/* connectors first so the dots sit on top */}
        {types.map(k => {
          const pa = pt(arsA, k), pb = pt(arsB, k);
          return pa && pb ? <line key={`l${k}`} x1={pa.x} y1={pa.y} x2={pb.x} y2={pb.y} stroke={colorOf(k)} strokeWidth={1} strokeDasharray="3 2" opacity={0.7} /> : null;
        })}
        {types.map(k => {
          const pb = pt(arsB, k);
          return pb ? <circle key={`b${k}`} cx={pb.x} cy={pb.y} r={4 + pb.usage * 10} fill="none" stroke={colorOf(k)} strokeWidth={2} /> : null;
        })}
        {types.map(k => {
          const pa = pt(arsA, k);
          return pa ? (
            <g key={`a${k}`}>
              <circle cx={pa.x} cy={pa.y} r={4 + pa.usage * 10} fill={colorOf(k)} stroke={t.cardBg} strokeWidth={1} />
              <text x={pa.x + 6 + pa.usage * 10} y={pa.y + 3} style={{ fontSize: 9, fontWeight: 700, fill: t.text, fontFamily: "inherit" }}>{k}</text>
            </g>
          ) : null;
        })}
      </g>
      <Legend x={pad} y={size + 27} t={t} nameA={nameA} nameB={nameB} />
    </svg>
  );
}

function Legend({ x, y, t, nameA, nameB }) {
  const txt = { fontSize: 9, fill: t.textMuted, fontFamily: "inherit" };
  return (
    <g transform={`translate(${x},${y})`}>
      <circle cx={4} cy={-3} r={4} fill={t.textMuted} />
      <text x={12} y={0} style={txt}>{nameA}</text>
      <circle cx={104} cy={-3} r={4} fill="none" stroke={t.textMuted} strokeWidth={2} />
      <text x={112} y={0} style={txt}>{nameB}</text>
    </g>
  );
}

// ── Release diagram (catcher's view) ────────────────────────
const ARM_LEN = 2.0;   // ft, shoulder → ball at release (upper arm + forearm + hand)

function releaseOf(p) {
  const v = p?.v || {};
  return { x: v.release_x, z: v.release_z, ext: v.extension, angle: v.arm_angle };
}
// Shoulder placed so the arm from shoulder to the release point sits at the
// measured arm angle (what Savant reports), with a fixed arm length.
function shoulderOf(r) {
  if (!isNum(r.x) || !isNum(r.z) || !isNum(r.angle)) return null;
  const th = (r.angle * Math.PI) / 180;
  return { x: r.x - ARM_LEN * Math.cos(th), z: r.z - ARM_LEN * Math.sin(th) };
}

export function ReleaseDiagram({ a, b, nameA, nameB, width = 300 }) {
  const { theme: t } = useTheme();
  const S = 34;                     // px per ft
  const X0 = -2.6, Z0 = -0.4;       // ft at the left / bottom edge
  const H = 8.6;                    // ft of height shown
  const height = width / S * 0 + Math.round(H * S);
  const X = x => (x - X0) * S;
  const Y = z => height - 10 - (z - Z0) * S;
  const ra = releaseOf(a), rb = releaseOf(b);
  const sa = shoulderOf(ra), sb = shoulderOf(rb);
  const hA = isNum(a?.height) ? a.height / 12 : 6.2;
  const txt = { fontSize: 9, fill: t.textFaint, fontFamily: "inherit" };
  const num = { fontSize: 10, fill: t.text, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT };
  const accentA = t.accent, accentB = t.accentSecondary;

  // Body anchored on the target's shoulder (catcher's view: throwing arm on the
  // arm side, i.e. to the right in this corrected frame).
  const bodyX = sa ? sa.x - 0.55 : -0.6;
  const shoulderZ = sa ? sa.z : hA * 0.7;
  const headR = 0.42;
  const headZ = shoulderZ + 0.95;
  const torsoTop = shoulderZ + 0.25, torsoBot = Math.max(1.6, shoulderZ - 1.9);

  const perType = (p, hollow, stroke) => Object.entries(p?.arsenal || {}).map(([k, ar]) => (
    isNum(ar.rel_x) && isNum(ar.rel_z) ? (
      <circle key={k} cx={X(ar.rel_x)} cy={Y(ar.rel_z)} r={5} fill={hollow ? "none" : colorOf(k)}
              stroke={hollow ? colorOf(k) : stroke} strokeWidth={hollow ? 2 : 1}>
        <title>{`${PITCH_NAMES[k] || k}: ${ar.rel_x.toFixed(2)} ft side, ${ar.rel_z.toFixed(2)} ft high`}</title>
      </circle>
    ) : null
  ));
  const hasTypeDots = Object.values(a?.arsenal || {}).some(ar => isNum(ar.rel_x));

  const arm = (s, r, color, dashed) => s && (
    <g>
      <line x1={X(s.x)} y1={Y(s.z)} x2={X(r.x)} y2={Y(r.z)} stroke={color} strokeWidth={dashed ? 3 : 9} strokeLinecap="round" strokeDasharray={dashed ? "5 4" : undefined} opacity={dashed ? 0.9 : 0.85} />
      <circle cx={X(s.x)} cy={Y(s.z)} r={dashed ? 3.5 : 6} fill={dashed ? t.cardBg : color} stroke={color} strokeWidth={2} />
    </g>
  );
  const arc = (s, r, color, label, offset) => {
    if (!s || !isNum(r.angle)) return null;
    const rad = 0.75 * S;
    const th = (r.angle * Math.PI) / 180;
    const ex = X(s.x) + rad * Math.cos(th), ey = Y(s.z) - rad * Math.sin(th);
    const large = Math.abs(r.angle) > 180 ? 1 : 0, sweep = r.angle >= 0 ? 0 : 1;
    return (
      <g>
        <line x1={X(s.x)} y1={Y(s.z)} x2={X(s.x) + rad + 8} y2={Y(s.z)} stroke={color} strokeWidth={0.8} strokeDasharray="2 2" />
        <path d={`M ${X(s.x) + rad} ${Y(s.z)} A ${rad} ${rad} 0 ${large} ${sweep} ${ex} ${ey}`} fill="none" stroke={color} strokeWidth={1.2} />
        <text x={X(s.x) + rad + 10} y={Y(s.z) - 4 - offset} style={{ ...num, fill: color }}>{label}</text>
      </g>
    );
  };

  const extW = width, extS = 30, extPad = 24;
  const EX = e => extPad + e * extS;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: "block" }}>
        <text x={width / 2} y={11} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: t.textMuted, fontFamily: "inherit" }}>
          Release point · catcher's view
        </text>
        <text x={width / 2} y={22} textAnchor="middle" style={txt}>← glove side · arm side →</text>
        {/* mound + rubber */}
        <path d={`M 0 ${Y(0) + 2} Q ${X(0)} ${Y(0) - 14} ${width} ${Y(0) + 2} L ${width} ${height} L 0 ${height} Z`} fill={t.id === "dark" ? "#3b2a1a" : "#c8a97e"} />
        <rect x={X(-1)} y={Y(0) - 4} width={2 * S} height={4} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.5} />
        <line x1={X(0)} y1={Y(0)} x2={X(0)} y2={Y(1.3)} stroke={t.textFaint} strokeWidth={0.6} strokeDasharray="2 3" />
        <text x={X(0)} y={Y(0) + 13} textAnchor="middle" style={{ ...txt, fill: "#d6c6b0" }}>rubber</text>
        {/* height axis */}
        {[2, 4, 6].map(z => (
          <g key={z}>
            <line x1={X(X0) + 2} y1={Y(z)} x2={X(X0) + 8} y2={Y(z)} stroke={t.textFaint} strokeWidth={0.8} />
            <text x={X(X0) + 10} y={Y(z) + 3} style={txt}>{z} ft</text>
          </g>
        ))}
        {/* body (target) */}
        <g fill={t.id === "dark" ? "#9fb3c8" : "#b7c7d6"} opacity={0.75}>
          <line x1={X(bodyX - 0.28)} y1={Y(torsoBot)} x2={X(bodyX - 0.38)} y2={Y(0)} stroke={t.id === "dark" ? "#9fb3c8" : "#b7c7d6"} strokeWidth={11} strokeLinecap="round" />
          <line x1={X(bodyX + 0.28)} y1={Y(torsoBot)} x2={X(bodyX + 0.45)} y2={Y(0)} stroke={t.id === "dark" ? "#9fb3c8" : "#b7c7d6"} strokeWidth={11} strokeLinecap="round" />
          <rect x={X(bodyX - 0.62)} y={Y(torsoTop)} width={1.24 * S} height={(torsoTop - torsoBot) * S} rx={14} />
          <line x1={X(bodyX - 0.62)} y1={Y(shoulderZ)} x2={X(bodyX - 0.95)} y2={Y(shoulderZ - 1.9)} stroke={t.id === "dark" ? "#9fb3c8" : "#b7c7d6"} strokeWidth={8} strokeLinecap="round" />
          <circle cx={X(bodyX)} cy={Y(headZ)} r={headR * S} />
        </g>
        {/* comp arm (dashed), then target arm */}
        {arm(sb, rb, accentB, true)}
        {arm(sa, ra, accentA, false)}
        {/* callouts for the target */}
        {isNum(ra.z) && isNum(ra.x) && (
          <g>
            <line x1={X(X0) + 40} y1={Y(ra.z)} x2={X(ra.x)} y2={Y(ra.z)} stroke={accentA} strokeWidth={0.8} strokeDasharray="3 3" />
            <text x={X(X0) + 42} y={Y(ra.z) - 3} style={{ ...num, fill: accentA }}>{ft(ra.z)} high</text>
            <line x1={X(ra.x)} y1={Y(ra.z)} x2={X(ra.x)} y2={Y(0)} stroke={accentA} strokeWidth={0.8} strokeDasharray="3 3" />
            <line x1={X(0)} y1={Y(0.55)} x2={X(ra.x)} y2={Y(0.55)} stroke={accentA} strokeWidth={0.8} />
            <text x={X(ra.x / 2)} y={Y(0.55) - 3} textAnchor="middle" style={{ ...num, fill: accentA }}>{ft(ra.x)} side</text>
          </g>
        )}
        {arc(sa, ra, accentA, `${Math.round(ra.angle)}°`, 0)}
        {arc(sb, rb, accentB, `${isNum(rb.angle) ? Math.round(rb.angle) : "—"}°`, 12)}
        {/* release points */}
        {perType(b, true)}
        {hasTypeDots ? perType(a, false, t.cardBg) : (isNum(ra.x) && isNum(ra.z) && <circle cx={X(ra.x)} cy={Y(ra.z)} r={6} fill={accentA} stroke={t.cardBg} />)}
        {!hasTypeDots && isNum(rb.x) && isNum(rb.z) && <circle cx={X(rb.x)} cy={Y(rb.z)} r={6} fill="none" stroke={accentB} strokeWidth={2} />}
      </svg>
      {/* Extension strip (side view) */}
      <svg viewBox={`0 0 ${extW} 70`} width={extW} height={70} style={{ display: "block", marginTop: 4 }}>
        <text x={extW / 2} y={10} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: t.textMuted, fontFamily: "inherit" }}>Extension · side view (rubber → release)</text>
        <line x1={extPad} y1={50} x2={extW - 8} y2={50} stroke={t.textFaint} strokeWidth={1} />
        <rect x={extPad - 3} y={40} width={6} height={10} fill="#e5e7eb" stroke="#9ca3af" strokeWidth={0.5} />
        {[2, 4, 6, 8].map(e => (
          <g key={e}>
            <line x1={EX(e)} y1={48} x2={EX(e)} y2={52} stroke={t.textFaint} />
            <text x={EX(e)} y={63} textAnchor="middle" style={txt}>{e} ft</text>
          </g>
        ))}
        <text x={extW - 8} y={63} textAnchor="end" style={txt}>→ plate</text>
        {isNum(rb.ext) && <circle cx={EX(rb.ext)} cy={50} r={6} fill="none" stroke={accentB} strokeWidth={2} />}
        {isNum(ra.ext) && <circle cx={EX(ra.ext)} cy={50} r={6} fill={accentA} stroke={t.cardBg} />}
        {isNum(ra.ext) && <text x={EX(ra.ext)} y={36} textAnchor="middle" style={{ ...num, fill: accentA }}>{ft(ra.ext)}</text>}
        {isNum(rb.ext) && <text x={EX(rb.ext)} y={isNum(ra.ext) && Math.abs(ra.ext - rb.ext) < 0.9 ? 23 : 36} textAnchor="middle" style={{ ...num, fill: accentB }}>{ft(rb.ext)}</text>}
      </svg>
      {/* key */}
      <div style={{ display: "flex", gap: 14, fontSize: 10, color: t.textMuted, marginTop: 4, flexWrap: "wrap" }}>
        <span><span style={{ display: "inline-block", width: 18, height: 4, background: accentA, borderRadius: 2, verticalAlign: "middle", marginRight: 4 }} />{nameA} · arm {isNum(ra.angle) ? `${Math.round(ra.angle)}°` : "—"} · {ft(ra.z)} high · {ft(ra.x)} side · ext {ft(ra.ext)}</span>
        <span><span style={{ display: "inline-block", width: 18, height: 0, borderTop: `2px dashed ${accentB}`, verticalAlign: "middle", marginRight: 4 }} />{nameB} · arm {isNum(rb.angle) ? `${Math.round(rb.angle)}°` : "—"} · {ft(rb.z)} high · {ft(rb.x)} side · ext {ft(rb.ext)}</span>
      </div>
    </div>
  );
}

// Both figures side by side for a comp row.
export function PitcherCompareFigures({ target, other }) {
  const nameA = `${lastName(target.name)} ${target.season}`;
  const nameB = `${lastName(other.name)} ${other.season}`;
  return (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start", marginBottom: 10 }}>
      <MovementPlot a={target} b={other.player} nameA={nameA} nameB={nameB} />
      <ReleaseDiagram a={target} b={other.player} nameA={nameA} nameB={nameB} />
    </div>
  );
}
