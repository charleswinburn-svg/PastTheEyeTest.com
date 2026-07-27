import { useTheme } from "./ThemeContext.jsx";

// Reusable KDE bell-curve figure (SVG). Renders one or more precomputed density
// curves on a shared x-axis, with optional vertical reference lines (e.g. player
// mean solid, league average dashed).
//
// Props:
//   curves   : [{ densities:[...], color, label }]  — densities over the x-grid
//   xLo, xHi : x-axis bounds the densities span (linspace(xLo, xHi, densities.length))
//   width, height
//   refLines : [{ x, color, dashed, label }]         — vertical marker lines
//   fill     : bool  — fill under the curve (nice for a single curve)
//   xTicks   : number[] — x values to label (default 60..140 by 20)
//   title    : string — small heading above the plot
export default function KdeCurve({
  curves = [], xLo = 40, xHi = 160, width = 300, height = 120,
  refLines = [], fill = false, xTicks, title,
}) {
  const { theme: t } = useTheme();
  const padL = 8, padR = 8, padT = 6, padB = 16;
  const plotW = Math.max(1, width - padL - padR);
  const plotH = Math.max(1, height - padT - padB);
  const baseY = height - padB;

  const valid = curves.filter(c => Array.isArray(c.densities) && c.densities.length > 1);
  const maxD = Math.max(1e-9, ...valid.flatMap(c => c.densities));

  const sx = (xVal) => padL + ((xVal - xLo) / (xHi - xLo)) * plotW;
  const toPath = (densities) => {
    const n = densities.length;
    return densities.map((d, i) => {
      const x = padL + (i / (n - 1)) * plotW;
      const y = baseY - (d / maxD) * plotH;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    }).join(" ");
  };

  const ticks = (xTicks || [60, 80, 100, 120, 140, 160]).filter(v => v >= xLo && v <= xHi);

  return (
    <div style={{ width: "100%", maxWidth: width }}>
      {title && (
        <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: t.textMuted, marginBottom: 2 }}>
          {title}
        </div>
      )}
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" style={{ display: "block" }}>
        {/* baseline */}
        <line x1={padL} y1={baseY} x2={width - padR} y2={baseY} stroke={t.divider} strokeWidth={1} />
        {/* x ticks */}
        {ticks.map(v => (
          <g key={v}>
            <line x1={sx(v)} y1={baseY} x2={sx(v)} y2={baseY + 3} stroke={t.divider} strokeWidth={1} />
            <text x={sx(v)} y={baseY + 13} fontSize={8} fill={t.textFaint} textAnchor="middle" fontFamily="'DM Mono', monospace">{v}</text>
          </g>
        ))}
        {/* reference lines */}
        {refLines.filter(r => r.x != null && r.x >= xLo && r.x <= xHi).map((r, i) => (
          <line key={i} x1={sx(r.x)} y1={padT} x2={sx(r.x)} y2={baseY}
                stroke={r.color || t.textMuted} strokeWidth={1.5}
                strokeDasharray={r.dashed ? "4 3" : undefined} opacity={0.9} />
        ))}
        {/* curves */}
        {valid.map((c, i) => (
          <g key={i}>
            {fill && (
              <polygon points={`${padL},${baseY} ${toPath(c.densities)} ${width - padR},${baseY}`}
                       fill={c.color} opacity={0.18} />
            )}
            <polyline points={toPath(c.densities)} fill="none" stroke={c.color} strokeWidth={fill ? 2 : 1.5} opacity={0.95} />
          </g>
        ))}
      </svg>
    </div>
  );
}
