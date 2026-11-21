import { useMemo } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import SCALE, { readableOnCard } from "./colorScale.js";

// ═══════════════════════════════════════════════════════════
// PERCENTILE BOXES: 100 small boxes, the player's box raised
// ═══════════════════════════════════════════════════════════
// The raised box is a square exactly as tall as the row, so it is as large as it can be
// without touching the rows above and below. The strip of small boxes is inset by half a
// square on each side, so the square never hangs over an edge at the 1st or 100th percentile.
//
// `BoxStrip` is the strip alone (the NHL card lays it out in its own grid).
// `PercentileBoxes` is a full row (label · strip · value) with the same props and
// height as the old BubblePercentileBar, so the MLB cards can swap one for the other.

const NUM_FONT = "'Pliant', sans-serif";

export function BoxStrip({ pct, isDark, t, row = 28, box = 8, num = 12, num3 = 10, scale = SCALE }) {
  const here = pct == null || !isFinite(pct) ? null : Math.min(99, Math.max(0, Math.floor(pct)));
  const cells = useMemo(() => Array.from({ length: 100 }, (_, i) => (
    <div key={i} style={{ flex: 1, height: box, borderRadius: 1.5,
                          background: here == null ? t.textFaintest : scale.pctColor(i + 0.5, isDark),
                          opacity: here == null ? 0.28 : isDark ? 0.65 : 0.8 }} />
  )), [here == null, isDark, t.textFaintest, box, scale]);
  const rgb = here == null ? null : scale.pctRgb(here + 0.5, isDark);
  return (
    <div style={{ position: "relative", height: row }}>
      <div style={{ position: "absolute", left: row / 2, right: row / 2, top: (row - box) / 2, display: "flex", gap: 1 }}>{cells}</div>
      {here != null && (
        <div style={{
          position: "absolute", top: 0, left: `calc((100% - ${row}px) * ${(here + 0.5) / 100})`, width: row, height: row,
          borderRadius: Math.round(row / 5), background: `rgb(${rgb.join(",")})`, color: inkFor(rgb), boxShadow: `0 0 0 2px ${t.cardBg}`,
          display: "flex", alignItems: "center", justifyContent: "center", fontFamily: NUM_FONT,
          fontSize: pct >= 99.5 ? num3 : num, fontWeight: 800, lineHeight: 1 }}>
          {Math.round(pct)}
        </div>
      )}
    </div>
  );
}

function inkFor(rgb) {
  const [r, g, b] = rgb.map(c => { const v = c / 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.3 ? "#111111" : "#ffffff";
}

export default function PercentileBoxes({
  label, pctile, display, labelWidth = 134, badge = null, delta = null,
  theme, isDark: isDarkProp, scale = SCALE, row = 38, valueWidth = 64,
}) {
  const ctx = useTheme();
  const t = theme || ctx.theme;
  const isDark = isDarkProp ?? (theme ? theme.id === "dark" : ctx.isDark);
  const has = pctile != null && isFinite(pctile);
  // Everything scales with the row height (38 px by default), with generous spacing.
  const fLabel = Math.round(row * 0.355 * 10) / 10, fValue = Math.round(row * 0.38 * 10) / 10;
  return (
    <div style={{ display: "flex", alignItems: "center", marginBottom: Math.round(row * 0.3), width: "100%", gap: Math.round(row * 0.32) }}>
      <div style={{ width: labelWidth, textAlign: "right", fontSize: fLabel, fontWeight: 500, color: t.text, flexShrink: 0, lineHeight: 1.2 }}>
        {label}
        {badge}
      </div>
      <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
        <BoxStrip pct={has ? pctile : null} isDark={isDark} t={t} row={row} box={Math.round(row * 0.3)}
                  num={Math.round(row * 0.43)} num3={Math.round(row * 0.36)} scale={scale} />
        {!has && (
          <div style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: fLabel - 1, color: t.textFaintest, fontStyle: "italic" }}>
            N/A
          </div>
        )}
      </div>
      <div style={{ width: valueWidth, textAlign: "right", fontSize: fValue, fontWeight: 700, color: has ? t.textSecondary : t.textFaintest,
                    fontFamily: NUM_FONT, whiteSpace: "nowrap", flexShrink: 0 }}>
        {display || "—"}
        {delta && (
          <div style={{ fontSize: Math.round(row * 0.28 * 10) / 10, fontStyle: "italic", fontWeight: 600, lineHeight: 1, marginTop: 2, color: readableOnCard(delta.color, t) }}>
            {delta.text}
          </div>
        )}
      </div>
    </div>
  );
}
