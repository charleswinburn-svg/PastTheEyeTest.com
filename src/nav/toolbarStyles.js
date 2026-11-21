import { inkOnColor } from "../ui/colorScale.js";

// ═══════════════════════════════════════════════════════════
// Shared look for the top-bar controls, so MLB and NHL match exactly:
// the season picker is the accent-gradient pill, the player search the plain field,
// and any other dropdowns (NHL 3-year/1-year, team) the same plain field look.
// ═══════════════════════════════════════════════════════════

export const seasonSelectStyle = t => ({
  padding: "8px 16px",
  background: `linear-gradient(135deg, ${t.accentSecondary || t.accent} 0%, ${t.accent} 100%)`,
  color: inkOnColor(t.accent),
  border: "none",
  borderRadius: 8,
  fontSize: 13,
  fontWeight: 700,
  cursor: "pointer",
  outline: "none",
  fontFamily: "inherit",
  boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
});

export const seasonOptionStyle = t => ({ background: t.inputBg, color: t.text });

export const searchStyle = (t, isMobile) => ({
  flex: isMobile ? "1 1 100%" : "0 1 280px",
  padding: "6px 12px",
  background: t.inputBg,
  border: `1px solid ${t.inputBorder}`,
  borderRadius: 6,
  color: t.text,
  fontSize: 12,
  minWidth: isMobile ? 0 : 200,
  maxWidth: isMobile ? "100%" : 280,
  width: isMobile ? "100%" : "auto",
  flexShrink: 1,
});

// Search panel props (the dropdown list under the search field).
export const searchPanelProps = isMobile => ({ panelMinWidth: isMobile ? 0 : 340, panelAlign: "right" });

// Plain dropdown matching the search field (height, border, font).
export const plainSelectStyle = t => ({
  padding: "7px 10px",
  background: t.inputBg,
  border: `1px solid ${t.inputBorder}`,
  borderRadius: 6,
  color: t.text,
  fontSize: 12,
  fontWeight: 600,
  outline: "none",
  fontFamily: "inherit",
  cursor: "pointer",
});
