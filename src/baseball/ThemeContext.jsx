import { createContext, useContext, useState, useEffect, useCallback } from "react";

// ── Theme color tokens ──
const DARK = {
  id: "dark",
  bg: "#0d0d0d",
  cardBg: "#151515",
  cardBorder: "#2a2a2a",
  headerBg: "#111",
  headerBorder: "#222",
  inputBg: "#1a1a1a",
  inputBorder: "#333",
  tableRowA: "#111",
  tableRowB: "#161616",
  tableBorder: "#1e1e1e",
  tableHeaderBg: "#151515",
  tableHeaderBorder: "#333",
  text: "#fff",
  textSecondary: "#ccc",
  textMuted: "#888",
  textFaint: "#555",
  textFaintest: "#444",
  accent: "#d22d49",
  divider: "#333",
  shadow: "rgba(0,0,0,0.4)",
  // Summary eff colors: keep backgrounds in dark, no change needed
  effGoodBg: (alpha) => `rgba(30,160,30,${alpha})`,
  effBadBg: (alpha) => `rgba(200,35,35,${alpha})`,
  effGoodText: null, // null = use bg coloring (default dark behavior)
  effBadText: null,
};

const LIGHT = {
  id: "light",
  bg: "#f4f5f7",
  cardBg: "#ffffff",
  cardBorder: "#ddd",
  headerBg: "#ffffff",
  headerBorder: "#e0e0e0",
  inputBg: "#f0f0f0",
  inputBorder: "#ccc",
  tableRowA: "#ffffff",
  tableRowB: "#f8f8fa",
  tableBorder: "#e8e8e8",
  tableHeaderBg: "#f4f5f7",
  tableHeaderBorder: "#ddd",
  text: "#111",
  textSecondary: "#333",
  textMuted: "#666",
  textFaint: "#999",
  textFaintest: "#bbb",
  accent: "#d22d49",
  divider: "#ddd",
  shadow: "rgba(0,0,0,0.08)",
  // Summary eff colors: text-only coloring, transparent bg
  effGoodBg: () => "transparent",
  effBadBg: () => "transparent",
  effGoodText: (alpha) => `rgba(20,140,20,${Math.min(1, parseFloat(alpha) + 0.3).toFixed(2)})`,
  effBadText: (alpha) => `rgba(190,30,30,${Math.min(1, parseFloat(alpha) + 0.3).toFixed(2)})`,
};

const ThemeContext = createContext({ theme: DARK, isDark: true, toggle: () => {} });

export function ThemeProvider({ children }) {
  const [isDark, setIsDark] = useState(() => {
    try { return localStorage.getItem("ptet-theme") !== "light"; } catch { return true; }
  });

  const toggle = useCallback(() => {
    setIsDark(prev => {
      const next = !prev;
      try { localStorage.setItem("ptet-theme", next ? "dark" : "light"); } catch {}
      return next;
    });
  }, []);

  const theme = isDark ? DARK : LIGHT;

  return (
    <ThemeContext.Provider value={{ theme, isDark, toggle }}>
      {children}
    </ThemeContext.Provider>
  );
}

export function useTheme() {
  return useContext(ThemeContext);
}

// ── Toggle Switch ──
export function ThemeToggle() {
  const { isDark, toggle } = useTheme();
  return (
    <button
      onClick={toggle}
      aria-label="Toggle theme"
      style={{
        position: "relative",
        width: 44, height: 24,
        borderRadius: 12,
        border: "none",
        background: isDark ? "#333" : "#ccc",
        cursor: "pointer",
        padding: 0,
        transition: "background 0.2s",
        flexShrink: 0,
      }}
    >
      <div style={{
        position: "absolute",
        top: 2, left: isDark ? 2 : 22,
        width: 20, height: 20,
        borderRadius: "50%",
        background: isDark ? "#888" : "#fff",
        boxShadow: "0 1px 3px rgba(0,0,0,0.3)",
        transition: "left 0.2s, background 0.2s",
        display: "flex", alignItems: "center", justifyContent: "center",
        fontSize: 11,
      }}>
        {isDark ? "🌙" : "☀️"}
      </div>
    </button>
  );
}

// ── Helpers for components to get common styles ──
export function useThemedStyles() {
  const { theme } = useTheme();
  return {
    page: { minHeight: "100vh", background: theme.bg, color: theme.text },
    card: {
      background: theme.cardBg, borderRadius: 12,
      border: `1px solid ${theme.cardBorder}`,
      overflow: "hidden", boxShadow: `0 4px 24px ${theme.shadow}`,
    },
    header: {
      background: theme.headerBg, borderBottom: `1px solid ${theme.headerBorder}`,
      padding: "10px 20px", display: "flex", alignItems: "center",
      justifyContent: "space-between", flexWrap: "wrap", gap: 10,
    },
    input: {
      background: theme.inputBg, border: `1px solid ${theme.inputBorder}`,
      borderRadius: 6, color: theme.text, outline: "none", fontFamily: "inherit",
    },
    tab: (active) => ({
      padding: "5px 12px", fontSize: 11,
      fontWeight: active ? 700 : 500,
      background: active ? (theme.id === "dark" ? "#333" : "#e0e0e0") : "transparent",
      color: active ? theme.text : theme.textMuted,
      border: "none", borderRadius: 6, cursor: "pointer",
      transition: "all 0.15s", fontFamily: "inherit",
    }),
    select: {
      padding: "5px 10px", background: theme.inputBg,
      border: `1px solid ${theme.inputBorder}`,
      borderRadius: 6, color: theme.text, fontSize: 12,
      outline: "none", fontFamily: "inherit",
    },
    footer: { fontSize: 10, color: theme.textFaint },
  };
}

export { DARK, LIGHT };
