import { lazy, Suspense, useEffect } from "react";
import HockeyApp from "./hockey/HockeyApp.jsx";
import BaseballApp from "./baseball/BaseballApp.jsx";
import { ThemeProvider, ThemeToggle, useTheme } from "./baseball/ThemeContext.jsx";
import { Link, usePath } from "./router.jsx";
import HomePage from "./home/HomePage.jsx";
import PostPage from "./home/PostPage.jsx";

// Dev-only color scale preview at /palette (not linked from the nav).
const PalettePreview = lazy(() => import("./ui/PalettePreview.jsx"));
// World Cup tab hidden for now; src/soccer stays in the repo to bring it back.

// Routes: /  ·  /mlb  ·  /nhl  ·  /posts/:slug  (see src/router.jsx)
const NAV = [
  { to: "/",    label: "Home" },
  { to: "/mlb", label: "MLB", icon: "⚾" },
  { to: "/nhl", label: "NHL", icon: "🏒", badge: "beta" },
];

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function Shell() {
  const { theme: t } = useTheme();
  const path = usePath();
  const post = path.match(/^\/posts\/([^/]+)$/);
  const section = path === "/mlb" ? "/mlb" : path === "/nhl" ? "/nhl" : "/";

  useEffect(() => {
    if (path === "/mlb") document.title = "MLB · Past The Eye Test";
    if (path === "/nhl") document.title = "NHL · Past The Eye Test";
    document.body.style.background = t.bg;
  }, [path, t.bg]);

  if (path === "/palette") {
    return <Suspense fallback={null}><PalettePreview /></Suspense>;
  }

  return (
    <div style={{ minHeight: "100vh", background: t.bg }}>
      {/* flexWrap so the logo + nav stay fully visible on narrow screens
          (they wrap to a second row instead of clipping off the right). */}
      <header style={{
        background: t.id === "dark" ? "#0f172a" : t.cardBg,
        borderBottom: `2px solid ${t.accent}`,
        padding: "0 16px",
        display: "flex", alignItems: "stretch", flexWrap: "wrap",
        position: "sticky", top: 0, zIndex: 100,
        boxShadow: `0 2px 12px ${t.shadow}`,
      }}>
        <Link to="/" style={{
          display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
          padding: "10px 20px 10px 4px", marginRight: 8,
          borderRight: `1px solid ${t.divider}`, flexShrink: 0,
        }}>
          <img src="/logo.jpg" alt="Past The Eye Test" style={{ height: 32, width: 32, borderRadius: 6, objectFit: "cover" }} />
          <span style={{ fontSize: 14, fontWeight: 700, letterSpacing: "-0.02em", fontStyle: "italic" }}>
            <span style={{ color: t.accentSecondary }}>Past The</span>{" "}
            <span style={{ color: t.brand }}>Eye Test</span>
          </span>
        </Link>
        <nav style={{ display: "flex", alignItems: "stretch", flexWrap: "wrap" }}>
          {NAV.map(n => {
            const on = section === n.to && !(n.to === "/" && post === null && path !== "/");
            return (
              <Link key={n.to} to={n.to} aria-current={on ? "page" : undefined} style={{
                padding: "12px 20px", fontSize: 12, fontWeight: on ? 700 : 600, letterSpacing: "0.04em",
                color: on ? t.accent : t.textMuted, textDecoration: "none",
                background: on ? `${t.accent}1a` : "transparent",
                borderBottom: `3px solid ${on ? t.accent : "transparent"}`,
                transition: "all 0.2s", display: "flex", alignItems: "center", gap: 8, whiteSpace: "nowrap",
              }}>
                {n.icon && <span style={{ fontSize: 14 }}>{n.icon}</span>}
                {n.label}
                {n.badge && (
                  <span style={{ padding: "2px 6px", borderRadius: 4, background: "#ea580c", color: "#ffffff", fontSize: 9, fontWeight: 800,
                                 letterSpacing: "0.08em", textTransform: "uppercase", lineHeight: 1.2 }}>{n.badge}</span>
                )}
              </Link>
            );
          })}
        </nav>
        {/* The MLB and NHL pages have their own theme switch; Home and posts get this one. */}
        {section === "/" && (
          <div style={{ marginLeft: "auto", display: "flex", alignItems: "center", padding: "8px 0" }}><ThemeToggle /></div>
        )}
      </header>

      {path === "/mlb" ? <BaseballApp />
        : path === "/nhl" ? <HockeyApp />
        : post ? <PostPage slug={decodeURIComponent(post[1])} />
        : <HomePage />}
    </div>
  );
}
