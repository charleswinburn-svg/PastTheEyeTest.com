import { useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { BIN_COLORS, NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";

// Catcher ABS challenges plotted on the zone, catcher's view.
//   challenges: [{ x, z, sz_top?, sz_bot?, overturned, runs, date?, count?, opp?, call? }]
//     x: plate_x (ft, + = 1B side from behind the plate), z: plate_z (ft).
//     With sz_top / sz_bot, z is normalised to that batter's zone so every
//     pitch sits on one shared zone box.
//   summary: { challenges, overturns, confirms, runs_gained, runs_cost }
const W = 300, H = 300;
const ZONE = { left: 95, right: 205, top: 70, bottom: 210 };   // px box for the rule-book zone
const HALF_PLATE_FT = 0.83;                                       // 17" plate / 2 + ball radius
const BLUE = BIN_COLORS["10-25"], RED = BIN_COLORS["90-100"];

function toPx(c) {
  const fx = (ZONE.right - ZONE.left) / (2 * HALF_PLATE_FT);
  const x = (ZONE.left + ZONE.right) / 2 + c.x * fx;
  const top = c.sz_top ?? 3.5, bot = c.sz_bot ?? 1.5;
  const t = (c.z - bot) / (top - bot);                            // 0 = bottom edge, 1 = top edge
  const y = ZONE.bottom - t * (ZONE.bottom - ZONE.top);
  return [Math.max(8, Math.min(W - 8, x)), Math.max(8, Math.min(H - 8, y))];
}

const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`);

export default function ABSChallengeDiagram({ challenges, summary }) {
  const { theme: t } = useTheme();
  const [active, setActive] = useState(null);
  const list = challenges || [];
  if (!list.length && !summary) return null;

  const over = summary?.overturns ?? list.filter(c => c.overturned).length;
  const total = summary?.challenges ?? list.length;
  const net = summary?.runs_gained != null && summary?.runs_cost != null
    ? summary.runs_gained - summary.runs_cost
    : list.reduce((s, c) => s + (c.runs || 0), 0);
  const a = active != null ? list[active] : null;

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", margin: "6px 0 10px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary, marginBottom: 4 }}>
        ABS challenges · catcher's view (from behind the plate)
      </div>
      {list.length > 0 && (
        <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img"
          aria-label={`${total} ABS challenges, ${over} overturned`}
          onMouseLeave={() => setActive(null)}>
          <rect x={ZONE.left} y={ZONE.top} width={ZONE.right - ZONE.left} height={ZONE.bottom - ZONE.top}
            fill="none" stroke={t.text} strokeOpacity="0.6" strokeWidth="1.5" />
          {[1, 2].map(i => (
            <g key={i} stroke={t.text} strokeOpacity="0.15">
              <line x1={ZONE.left + (i * (ZONE.right - ZONE.left)) / 3} x2={ZONE.left + (i * (ZONE.right - ZONE.left)) / 3} y1={ZONE.top} y2={ZONE.bottom} />
              <line y1={ZONE.top + (i * (ZONE.bottom - ZONE.top)) / 3} y2={ZONE.top + (i * (ZONE.bottom - ZONE.top)) / 3} x1={ZONE.left} x2={ZONE.right} />
            </g>
          ))}
          {/* home plate */}
          <path d={`M ${ZONE.left} 262 L ${ZONE.right} 262 L ${ZONE.right} 270 L ${(ZONE.left + ZONE.right) / 2} 282 L ${ZONE.left} 270 Z`}
            fill="none" stroke={t.text} strokeOpacity="0.4" />
          <text x={10} y={H / 2} fontSize="9.5" fontWeight="600" fill={t.textFaint}
            transform={`rotate(-90 10 ${H / 2})`} textAnchor="middle">3B side</text>
          <text x={W - 10} y={H / 2} fontSize="9.5" fontWeight="600" fill={t.textFaint}
            transform={`rotate(90 ${W - 10} ${H / 2})`} textAnchor="middle">1B side</text>
          {list.map((c, i) => {
            const [cx, cy] = toPx(c);
            const on = active === i;
            return (
              <circle key={i} cx={cx} cy={cy} r={on ? 7.5 : 5.5}
                fill={c.overturned ? BLUE : RED} fillOpacity={on ? 1 : 0.8}
                stroke={on ? t.text : t.cardBg} strokeWidth={on ? 2 : 1}
                style={{ cursor: "pointer" }}
                onMouseEnter={() => setActive(i)} onClick={() => setActive(i)} />
            );
          })}
        </svg>
      )}
      <div style={{ minHeight: 30, fontSize: 11, color: t.textSecondary, textAlign: "center", lineHeight: 1.4 }}>
        {a ? (
          <>
            <span style={{ fontWeight: 700, color: a.overturned ? BLUE : RED }}>
              {a.overturned ? "Overturned" : "Upheld"}
            </span>
            {" · "}
            <span style={{ fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>{signed(a.runs)} runs</span>
            {a.call && ` · called ${a.call}`}{a.count && ` · ${a.count} count`}
            {a.date && ` · ${a.date}`}{a.opp && ` vs ${a.opp}`}
          </>
        ) : (
          <>
            <span style={{ fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>{total}</span> challenges ·{" "}
            <span style={{ color: BLUE, fontWeight: 700 }}>● {over} overturned</span>{" "}
            <span style={{ color: RED, fontWeight: 700 }}>● {total - over} upheld</span> · net{" "}
            <span style={{ fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>{signed(net)}</span> runs
            {list.length > 0 && <div style={{ fontSize: 10, color: t.textFaint }}>hover or tap a ball for its run value</div>}
          </>
        )}
      </div>
    </div>
  );
}
