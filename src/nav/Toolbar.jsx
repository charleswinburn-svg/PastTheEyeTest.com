import { createContext, useContext } from "react";
import { createPortal } from "react-dom";
import { useTheme } from "../baseball/ThemeContext.jsx";

// The top bar holds a slot for the current page's controls (MLB: season + player
// search; NHL: skaters/goalies, season, version, team, search). Pages keep their own
// state and render <Toolbar>…</Toolbar>; on wide screens it's portaled into the slot.
// On narrow screens there's no slot (the sticky bar stays one line), so the controls
// render as an ordinary row at the top of the page instead.
const SlotContext = createContext(null);
export const ToolbarSlotProvider = SlotContext.Provider;

export function Toolbar({ children }) {
  const el = useContext(SlotContext);
  const { theme: t } = useTheme();
  if (el) return createPortal(children, el);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px", padding: "10px 12px",
                  borderBottom: `1px solid ${t.divider}` }}>
      {children}
    </div>
  );
}
