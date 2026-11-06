import { useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { BIN_COLORS, NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";

// Catcher ABS challenges plotted on the zone, catcher's view.
//   challenges: [{ x, z, sz_top?, sz_bot?, overturned, runs, date?, count?, opp?, call? }]
//     x: plate_x (ft, + = 1B side from behind the plate), z: plate_z (ft).
//     With sz_top / sz_bot, z is normalised to that batter's zone so every
//     pitch sits on one shared zone box.
//   summary: { challenges, overturns, confirms, runs_gained, runs_cost }
//
// The box is the ABS strike region for the ball's centre: a pitch is a strike
// when any part of the ball touches the zone, i.e. the 17" plate and the
// batter's sz_bot..sz_top, each widened by the ball's radius. That rule
// matches 99.65% of 2026 challenge outcomes (and Savant's edge_distance), so
// every overturned catcher challenge lands inside and every upheld one
// outside. The rare pitch whose measured spot disagrees with the ABS call by
// a hair is nudged just across the line to the side the call says.
const W = 300, H = 300;
const ZONE = { left: 95, right: 205, top: 70, bottom: 210 };   // px box = ball-centre strike region
const BALL_R_FT = 1.45 / 12;
const HALF_W_FT = 17 / 24 + BALL_R_FT;                            // ½ plate + ball radius
const NUDGE_FT = 0.02;
const BLUE = BIN_COLORS["10-25"], RED = BIN_COLORS["90-100"];

const FLIP = { Ball: "Strike", Strike: "Ball", B: "S", S: "B" };
function finalIsStrike(c) {
  const called = c.call;
  if (!called) return c.overturned;                               // catcher challenges: strike if overturned
  const fin = c.overturned ? FLIP[called] : called;
  return fin === "Strike" || fin === "S";
}

// Pitch position in zone units: u = horizontal (−1..1 = box edges),
// v = vertical (0 = bottom edge, 1 = top edge), both for the ball's centre.
function zoneUnits(c) {
  const top = (c.sz_top ?? 3.5) + BALL_R_FT, bot = (c.sz_bot ?? 1.5) - BALL_R_FT;
  let u = c.x / HALF_W_FT, v = (c.z - bot) / (top - bot);
  const inside = Math.abs(u) <= 1 && v >= 0 && v <= 1;
  const strike = finalIsStrike(c);
  if (inside !== strike) {
    const du = NUDGE_FT / HALF_W_FT, dv = NUDGE_FT / (top - bot);
    if (strike) {                                                 // pull in to the nearest edge
      u = Math.max(-1 + du, Math.min(1 - du, u));
      v = Math.max(dv, Math.min(1 - dv, v));
    } else {                                                      // push out across the nearest edge
      const gaps = [[1 - Math.abs(u), "u"], [v, "b"], [1 - v, "t"]].sort((a, b) => a[0] - b[0]);
      const side = gaps[0][1];
      if (side === "u") u = Math.sign(u || 1) * (1 + du);
      else if (side === "b") v = -dv;
      else v = 1 + dv;
    }
  }
  return [u, v];
}

function toPx(c) {
  const [u, v] = zoneUnits(c);
  const x = (ZONE.left + ZONE.right) / 2 + u * (ZONE.right - ZONE.left) / 2;
  const y = ZONE.bottom - v * (ZONE.bottom - ZONE.top);
  return [Math.max(8, Math.min(W - 8, x)), Math.max(8, Math.min(H - 8, y))];
}

const signed = (v) => (v == null ? "—" : `${v > 0 ? "+" : v < 0 ? "−" : ""}${Math.abs(v).toFixed(2)}`);

// aboveAvg: Savant's runs_above_average (the card's "ABS Challenge Runs" row) —
// results vs. what an average challenger earns on the same pitches. It can
// differ in sign from the raw net (runs gained − runs lost), so both are shown.
export default function ABSChallengeDiagram({ challenges, summary, aboveAvg }) {
  const { theme: t } = useTheme();
  const [active, setActive] = useState(null);
  const list = challenges || [];
  if (!list.length && !summary) return null;

  const over = summary?.overturns ?? list.filter(c => c.overturned).length;
  const total = summary?.challenges ?? list.length;
  const gained = summary?.runs_gained ?? list.filter(c => c.overturned).reduce((s, c) => s + (c.runs || 0), 0);
  const lost = summary?.runs_cost ?? -list.filter(c => !c.overturned).reduce((s, c) => s + (c.runs || 0), 0);
  const net = gained - lost;
  const num = { fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT };
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
            <span style={{ fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>≈ {signed(a.runs)} runs</span>
            {a.call && ` · called ${a.call}`}{a.count && ` · ${a.count} count`}{a.inning && ` · inn ${a.inning}`}
            {a.date && ` · ${a.date}`}{a.opp && ` vs ${a.opp}`}
          </>
        ) : (
          <>
            <span style={num}>{total}</span> challenges ·{" "}
            <span style={{ color: BLUE, fontWeight: 700 }}>● {over} overturned</span>{" "}
            <span style={{ color: RED, fontWeight: 700 }}>● {total - over} upheld</span>
            <div>
              Runs: <span style={num}>{signed(gained)}</span> gained,{" "}
              <span style={num}>{signed(-lost)}</span> lost ={" "}
              <span style={num}>{signed(net)}</span> net
              {aboveAvg != null && (
                <> · <span style={num}>{signed(aboveAvg)}</span> vs. an average challenger</>
              )}
            </div>
            {list.length > 0 && (
              <div style={{ fontSize: 10, color: t.textFaint }}>
                box = ABS strike zone for the ball's centre (zone + ball radius, scaled to each batter) · hover or tap a ball for its run value (estimated by count; adds up to the gained / lost totals)
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}
