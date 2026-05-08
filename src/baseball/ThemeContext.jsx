import { createContext, useContext, useState, useEffect, useCallback } from "react";

// ── Theme color tokens ──
const DARK = {
  id: "dark",
  bg: "#0a0f1a",
  cardBg: "#111827",
  cardBorder: "#1e3a5f",
  headerBg: "linear-gradient(90deg, #1a237e 0%, #0d1421 50%, #e65100 100%)",
  headerBgSolid: "#0d1421",
  headerBorder: "#1e3a5f",
  inputBg: "#0f172a",
  inputBorder: "#334155",
  tableRowA: "#0f172a",
  tableRowB: "#1e293b",
  tableBorder: "#1e3a5f",
  tableHeaderBg: "#111827",
  tableHeaderBorder: "#334155",
  text: "#f8fafc",
  textSecondary: "#e2e8f0",
  textMuted: "#94a3b8",
  textFaint: "#64748b",
  textFaintest: "#475569",
  accent: "#f59e0b",
  accentSecondary: "#3b82f6",
  divider: "#1e3a5f",
  shadow: "rgba(0,0,0,0.5)",
  // Summary eff colors
  effGoodBg: (alpha) => `rgba(34,197,94,${alpha})`,
  effBadBg: (alpha) => `rgba(239,68,68,${alpha})`,
  effGoodText: null,
  effBadText: null,
};

const LIGHT = {
  id: "light",
  bg: "#f0f4f8",
  cardBg: "#ffffff",
  cardBorder: "#c7d2fe",
  headerBg: "linear-gradient(90deg, #3949ab 0%, #ffffff 50%, #ff9800 100%)",
  headerBgSolid: "#ffffff",
  headerBorder: "#c7d2fe",
  inputBg: "#f8fafc",
  inputBorder: "#cbd5e1",
  tableRowA: "#ffffff",
  tableRowB: "#f1f5f9",
  tableBorder: "#e2e8f0",
  tableHeaderBg: "#f8fafc",
  tableHeaderBorder: "#cbd5e1",
  text: "#0f172a",
  textSecondary: "#1e293b",
  textMuted: "#475569",
  textFaint: "#64748b",
  textFaintest: "#94a3b8",
  accent: "#ea580c",
  accentSecondary: "#2563eb",
  divider: "#e2e8f0",
  shadow: "rgba(0,0,0,0.1)",
  // Summary eff colors: text-only coloring, transparent bg
  effGoodBg: () => "transparent",
  effBadBg: () => "transparent",
  effGoodText: (alpha) => `rgba(22,163,74,${Math.min(1, parseFloat(alpha) + 0.3).toFixed(2)})`,
  effBadText: (alpha) => `rgba(220,38,38,${Math.min(1, parseFloat(alpha) + 0.3).toFixed(2)})`,
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
