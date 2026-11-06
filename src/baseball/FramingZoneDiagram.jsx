import { useId } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { binColor, textOnBin, NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";

// Savant numbers the eight shadow zones 11–19 around the heart (15 is the
// heart itself), read from the catcher's view: top row 11-12-13, middle
// 14 · 16, bottom 17-18-19.
const LAYOUT = [
  ["11", "12", "13"],
  ["14", null, "16"],
  ["17", "18", "19"],
];

const CELL = 84;
const GAP = 3;
const PAD = 4;
const SIDE = 18; // room for the 3B / 1B side labels

// 1 → "1st", 22 → "22nd", 13 → "13th"
function ordinal(n) {
  const v = n % 100;
  if (v >= 11 && v <= 13) return `${n}th`;
  return `${n}${{ 1: "st", 2: "nd", 3: "rd" }[n % 10] || "th"}`;
}

export default function FramingZoneDiagram({ zones }) {
  const { theme: t } = useTheme();
  const hatchId = `hatch-${useId().replace(/:/g, "")}`;
  if (!zones || !Object.keys(zones).length) return null;

  const size = PAD * 2 + CELL * 3 + GAP * 2;
  const width = size + SIDE * 2;
  const pos = (i) => PAD + i * (CELL + GAP);

  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", margin: "6px 0 10px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: t.textSecondary, marginBottom: 4 }}>
        Catcher's view (from behind the plate)
      </div>
      <svg
        width={width} height={size} viewBox={`${-SIDE} 0 ${width} ${size}`}
        role="img" aria-label="Called-strike rate by shadow zone, catcher's view from behind the plate"
      >
        <text transform={`translate(${-SIDE / 2 - 2} ${size / 2}) rotate(-90)`} textAnchor="middle"
          fontSize="9.5" fontWeight="600" fill={t.textFaint}>3B side</text>
        <text transform={`translate(${size + SIDE / 2 + 2} ${size / 2}) rotate(90)`} textAnchor="middle"
          fontSize="9.5" fontWeight="600" fill={t.textFaint}>1B side</text>
        <defs>
          <pattern id={hatchId} width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={t.inputBg} />
            <line x1="0" y1="0" x2="0" y2="6" stroke={t.inputBorder} strokeWidth="2" />
          </pattern>
        </defs>
        {LAYOUT.map((row, r) => row.map((z, c) => {
          const x = pos(c), y = pos(r);
          if (!z) {
            return (
              <g key="heart">
                <rect x={x} y={y} width={CELL} height={CELL} rx={4} fill={`url(#${hatchId})`} />
                <text x={x + CELL / 2} y={y + CELL / 2 + 4} textAnchor="middle"
                  fontSize="11" fontWeight="600" fill={t.textFaint}>Heart</text>
              </g>
            );
          }
          const d = zones[z];
          const p = d?.pctile;
          const fill = d && p != null ? binColor(p) : t.inputBg;
          const ink = d && p != null ? textOnBin(p) : t.textSecondary;
          return (
            <g key={z}>
              <title>{d ? `Zone ${z}: ${d.rate}% called strikes (league ${d.lg ?? "—"}%)${p != null ? `, ${ordinal(p)} percentile` : ""}` : `Zone ${z}: no data`}</title>
              <rect x={x} y={y} width={CELL} height={CELL} rx={4} fill={fill}
                stroke={p != null ? "none" : t.inputBorder} />
              <text x={x + CELL / 2} y={y + 30} textAnchor="middle" fontSize="15"
                fontFamily={NUM_FONT} fontWeight={NUM_WEIGHT} fill={ink}>
                {d ? `${d.rate.toFixed(1)}%` : "—"}
              </text>
              <text x={x + CELL / 2} y={y + 46} textAnchor="middle" fontSize="9.5"
                fontFamily={NUM_FONT} fill={ink} opacity="0.85">
                {d?.lg != null ? `Lg ${d.lg.toFixed(1)}%` : ""}
              </text>
              <text x={x + CELL / 2} y={y + 60} textAnchor="middle" fontSize="9"
                fontFamily={NUM_FONT} fill={ink} opacity="0.85">
                {p != null ? `${ordinal(p)} percentile` : ""}
              </text>
            </g>
          );
        }))}
      </svg>
      <div style={{ fontSize: 10, color: t.textFaint, marginTop: 4 }}>
        Called-strike rate by shadow zone · percentile among catchers
      </div>
    </div>
  );
}
