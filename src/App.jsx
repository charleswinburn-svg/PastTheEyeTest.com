import { lazy, Suspense, useEffect, useRef, useState } from "react";
import HockeyApp from "./hockey/HockeyApp.jsx";
import BaseballApp from "./baseball/BaseballApp.jsx";
import { ThemeProvider, ThemeToggle, useTheme } from "./baseball/ThemeContext.jsx";
import { navigate, useLocation } from "./router.jsx";
import HomePage from "./home/HomePage.jsx";
import PostPage from "./home/PostPage.jsx";
import Sidebar from "./nav/Sidebar.jsx";
import { ToolbarSlotProvider } from "./nav/Toolbar.jsx";
import { mlbLeafForPath, nhlLeafForPath, titleForPath, MLB_DEFAULT_PATH, NHL_DEFAULT_PATH } from "./nav/navConfig.js";

// Dev-only color scale preview at /palette (not linked from the nav).
const PalettePreview = lazy(() => import("./ui/PalettePreview.jsx"));
// World Cup tab hidden for now; src/soccer stays in the repo to bring it back.

// Routes: /  ·  /posts/:slug  ·  /mlb/<section>  ·  /nhl/<section>  (src/nav/navConfig.js)
const WIDE = 1024;   // sidebar column at/above this width; drawer + bottom bar below

export default function App() {
  return (
    <ThemeProvider>
      <Shell />
    </ThemeProvider>
  );
}

function useWindowWidth() {
  const [w, setW] = useState(() => window.innerWidth);
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

const store = {
  get: (k, d) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } },
  set: (k, v) => { try { localStorage.setItem(k, v); } catch { /* private mode */ } },
};

function Shell() {
  const { theme: t } = useTheme();
  const { path, query, search } = useLocation();
  const wide = useWindowWidth() >= WIDE;
  const [hidden, setHidden] = useState(() => store.get("ptet-sidebar", "shown") === "hidden");
  const [drawer, setDrawer] = useState(false);
  const [slot, setSlot] = useState(null);
  const last = useRef({ mlb: store.get("ptet-last-mlb", MLB_DEFAULT_PATH), nhl: store.get("ptet-last-nhl", NHL_DEFAULT_PATH) });

  const mlbLeaf = mlbLeafForPath(path), nhlLeaf = nhlLeafForPath(path);
  const post = path.match(/^\/posts\/([^/]+)$/);
  const head = titleForPath(path);

  // Old / partial addresses → the section's default (keeping any query, e.g. ?season=).
  useEffect(() => {
    if ((path === "/mlb" || path.startsWith("/mlb/")) && !mlbLeaf) navigate(MLB_DEFAULT_PATH + search, { replace: true, scroll: false });
    else if ((path === "/nhl" || path.startsWith("/nhl/")) && !nhlLeaf) navigate(NHL_DEFAULT_PATH + search, { replace: true, scroll: false });
  }, [path]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Remember the last MLB / NHL page (the bottom bar's MLB / NHL buttons reopen it).
  useEffect(() => {
    if (mlbLeaf) { last.current.mlb = path + search; store.set("ptet-last-mlb", path + search); }
    if (nhlLeaf) { last.current.nhl = path + search; store.set("ptet-last-nhl", path + search); }
  }, [path, search, mlbLeaf, nhlLeaf]);

  useEffect(() => {
    if (head) document.title = `${head.sport} · ${head.title} | Past The Eye Test`;
    document.body.style.background = t.bg;
  }, [head?.title, head?.sport, t.bg]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => { setDrawer(false); }, [path]);
  useEffect(() => {
    if (!drawer) return;
    const onKey = e => { if (e.key === "Escape") setDrawer(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [drawer]);

  if (path === "/palette") {
    return <Suspense fallback={null}><PalettePreview /></Suspense>;
  }

  const showColumn = wide && !hidden;
  const setHiddenStored = h => { setHidden(h); store.set("ptet-sidebar", h ? "hidden" : "shown"); };
  const openMenu = () => (wide ? setHiddenStored(false) : setDrawer(true));

  const page = mlbLeaf ? <BaseballApp />
    : nhlLeaf ? <HockeyApp />
    : post ? <PostPage slug={decodeURIComponent(post[1])} />
    : <HomePage />;

  return (
    <ToolbarSlotProvider value={wide ? slot : null}>
      <div style={{ minHeight: "100vh", background: t.bg, display: "grid", gridTemplateColumns: showColumn ? "240px minmax(0, 1fr)" : "minmax(0, 1fr)" }}>
        {showColumn && <Sidebar path={path} query={query} search={search} onHide={() => setHiddenStored(true)} />}

        <div style={{ minWidth: 0, paddingBottom: wide ? 0 : 68 }}>
          {/* ── Top bar: menu button (when the sidebar is hidden), page title, page controls, theme ── */}
          <header style={{
            position: "sticky", top: 0, zIndex: 100, background: t.id === "dark" ? "rgba(10,15,26,0.92)" : "rgba(240,244,248,0.92)",
            backdropFilter: "blur(8px)", WebkitBackdropFilter: "blur(8px)", borderBottom: `1px solid ${t.divider}`,
            display: "flex", alignItems: "center", flexWrap: "wrap", gap: "8px 14px", padding: wide ? "10px 24px" : "8px 12px", minHeight: 56,
          }}>
            {!showColumn && (
              <button type="button" onClick={openMenu} aria-label="Open navigation"
                style={{ display: "block", width: 38, height: 34, padding: 0, background: "transparent", border: `1px solid ${t.inputBorder}`,
                         borderRadius: 7, cursor: "pointer", lineHeight: 0 }}>
                <svg width="18" height="14" viewBox="0 0 18 14" aria-hidden="true" style={{ display: "block", margin: "0 auto" }}>
                  {[1, 7, 13].map(y => <line key={y} x1="1" y1={y} x2="17" y2={y} stroke={t.text} strokeWidth="1.8" strokeLinecap="round" />)}
                </svg>
              </button>
            )}
            {head && (
              <div style={{ display: "flex", alignItems: "baseline", gap: 8, minWidth: 0, whiteSpace: "nowrap" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600, color: t.textFaint }}>{head.sport}</span>
                <span style={{ fontSize: wide ? 16 : 14.5, fontWeight: 700, color: t.text, letterSpacing: "-0.01em", overflow: "hidden", textOverflow: "ellipsis" }}>{head.title}</span>
              </div>
            )}
            {wide
              ? <div ref={setSlot} style={{ flex: "1 1 auto", display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8, minWidth: 0, justifyContent: "flex-end" }} />
              : <div style={{ flex: "1 1 auto" }} />}
            <ThemeToggle />
          </header>

          {page}
        </div>

        {/* ── Phones / tablets: slide-out drawer + bottom bar ── */}
        {!wide && (
          <>
            <div onClick={() => setDrawer(false)} aria-hidden={!drawer}
              style={{ position: "fixed", inset: 0, zIndex: 290, background: "rgba(0,0,0,0.45)", opacity: drawer ? 1 : 0,
                       pointerEvents: drawer ? "auto" : "none", transition: "opacity 0.2s" }} />
            <div style={{ position: "fixed", top: 0, bottom: 0, left: 0, zIndex: 300, transform: drawer ? "none" : "translateX(-105%)",
                          transition: "transform 0.22s ease", boxShadow: drawer ? "0 0 40px rgba(0,0,0,0.4)" : "none" }}>
              <Sidebar path={path} query={query} search={search} drawer onNavigate={() => setDrawer(false)} />
            </div>
            <nav aria-label="Sections" style={{
              position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 280, display: "grid", gridTemplateColumns: "repeat(4, 1fr)",
              background: t.id === "dark" ? "#0d1424" : t.cardBg, borderTop: `1px solid ${t.divider}`,
              paddingBottom: "env(safe-area-inset-bottom)",
            }}>
              {[
                ["Home", "/", !mlbLeaf && !nhlLeaf, () => navigate("/")],
                ["MLB", null, !!mlbLeaf, () => navigate(last.current.mlb || MLB_DEFAULT_PATH)],
                ["NHL", null, !!nhlLeaf, () => navigate(last.current.nhl || NHL_DEFAULT_PATH)],
                ["Menu", null, drawer, () => setDrawer(d => !d)],
              ].map(([label, , on, act]) => (
                <button key={label} type="button" onClick={act} aria-current={on ? "page" : undefined}
                  style={{ padding: "10px 0 12px", background: "transparent", border: "none", cursor: "pointer", fontFamily: "inherit",
                           fontSize: 12.5, fontWeight: on ? 700 : 500, color: on ? t.accent : t.textMuted,
                           borderTop: `2px solid ${on ? t.accent : "transparent"}` }}>
                  {label}
                </button>
              ))}
            </nav>
          </>
        )}
      </div>
    </ToolbarSlotProvider>
  );
}
