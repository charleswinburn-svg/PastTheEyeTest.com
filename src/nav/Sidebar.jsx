import { useEffect, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { NewBadge } from "../baseball/SharedComponents.jsx";
import { Link, navigate } from "../router.jsx";
import {
  MLB_NAV, NHL_NAV, mlbLeafForPath, nhlLeafForPath, mlbSeasonFrom, isOffInSeason,
  DEFAULT_MLB_SEASON, LATEST_MLB_SEASON, PROJ_OFF_TITLE, MLB_DEFAULT_PATH, NHL_DEFAULT_PATH,
} from "./navConfig.js";

// ═══════════════════════════════════════════════════════════
// SIDEBAR: Home · MLB sections · NHL sections
// ═══════════════════════════════════════════════════════════
// Desktop: a sticky 240 px column. Phones/tablets: the same list in a slide-out drawer.
// The section you're in is expanded; others expand on click (and jump to their first
// sub-tab). MLB links keep the selected season; NHL links keep the NHL filters.

const CSS = `
.ptet-sb { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0; }
/* Rows size with the window height (vh), so the whole list fits the screen without scrolling
   on short laptop screens and fills it on tall ones. */
.ptet-sb-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: clamp(2px, 0.62vh, 9px) 12px; border-radius: 7px;
  color: var(--sb-text); font-size: clamp(11.5px, 1.6vh, 15px); font-weight: 500; line-height: 1.3; text-decoration: none; background: none;
  border: none; cursor: pointer; text-align: left; position: relative; font-family: inherit; flex-shrink: 0; }
.ptet-sb-league { display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 4px; width: 100%;
  padding: clamp(5px, 1.3vh, 18px) 0 clamp(2px, 0.6vh, 10px); margin-top: clamp(2px, 0.8vh, 12px); border-top: 1px solid var(--sb-rule);
  background: none; border-left: none; border-right: none; border-bottom: none; cursor: pointer; flex-shrink: 0; }
.ptet-sb-league img { height: clamp(26px, 5.6vh, 64px); width: auto; max-width: 150px; display: block; }
.ptet-sb-league-text { font-size: clamp(17px, 2.7vh, 30px); font-weight: 800; letter-spacing: 0.02em; color: var(--sb-active); }
.ptet-sb-row:hover { background: var(--sb-hover); }
.ptet-sb-row.active { color: var(--sb-active); background: var(--sb-active-bg); font-weight: 600; }
.ptet-sb-row.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 2px; background: var(--sb-accent); }
.ptet-sb-row.sub { padding-left: 28px; font-size: clamp(11px, 1.5vh, 14px); }
.ptet-sb-row.off { opacity: 0.38; cursor: not-allowed; }
.ptet-sb-row.off:hover { background: none; }
.ptet-sb-row:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: -2px; }
.ptet-sb-chev { margin-left: auto; font-size: 10px; color: var(--sb-muted); transition: transform 0.15s; }
.ptet-sb-group { display: flex; align-items: center; gap: 8px; padding: 18px 12px 6px; font-size: 12px; font-weight: 600; color: var(--sb-muted); }
`;

// League logo heading, centred in the sidebar. Official marks through the same proxies the
// site already uses for team logos (vercel.json / vite.config.js); plain text if one fails.
const LEAGUE_LOGO = {
  MLB: dark => `/mlb-static/team-logos/league-on-${dark ? "dark" : "light"}/1.svg`,
  NHL: dark => `/nhl-assets/logos/nhl/svg/NHL_${dark ? "dark" : "light"}.svg`,
};
function LeagueLogo({ league, isDark, onClick, badge = null }) {
  const [failed, setFailed] = useState(false);
  return (
    <button type="button" className="ptet-sb-league" onClick={onClick} aria-label={`${league} home`} title={league}>
      {failed
        ? <span className="ptet-sb-league-text">{league}</span>
        : <img src={LEAGUE_LOGO[league](isDark)} alt={league} onError={() => setFailed(true)} />}
      {badge}
    </button>
  );
}

export default function Sidebar({ path, query, search, onNavigate, onHide, drawer = false }) {
  const { theme: t } = useTheme();
  const season = mlbSeasonFrom(query);
  const active = mlbLeafForPath(path) || nhlLeafForPath(path);
  // Accordion: one section open at a time (the one you're in), so the list always fits the screen.
  const [openKey, setOpenKey] = useState(active?.sectionKey || null);
  useEffect(() => { if (active?.sectionKey) setOpenKey(active.sectionKey); }, [active?.sectionKey]);

  const mlbHref = p => (season !== DEFAULT_MLB_SEASON ? `${p}?season=${season}` : p);
  // NHL links keep the season / 3-year-1-year / team, but not the picked player.
  const nhlHref = p => {
    if (!path.startsWith("/nhl")) return p;
    const q = new URLSearchParams(search); q.delete("id"); q.delete("kind");
    return q.toString() ? `${p}?${q}` : p;
  };
  const go = to => { navigate(to); onNavigate?.(); };

  const vars = {
    "--sb-text": t.textSecondary, "--sb-muted": t.textFaint, "--sb-hover": t.id === "dark" ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.05)",
    "--sb-active": t.text, "--sb-active-bg": `${t.accent}1f`, "--sb-accent": t.accent, "--sb-rule": t.divider,
  };

  // Sections with no 2027-projection version open in the latest real season instead.
  const leafHref = (leaf, href) => (href.startsWith("/mlb") && isOffInSeason(leaf.id, season)
    ? `${leaf.path}?season=${LATEST_MLB_SEASON}` : href);

  const leafRow = (leaf, href, sub) => {
    const to = leafHref(leaf, href);
    const isActive = active?.path === leaf.path;
    const cls = `ptet-sb-row${sub ? " sub" : ""}${isActive ? " active" : ""}`;
    return (
      <Link key={leaf.path} to={to} className={cls} aria-current={isActive ? "page" : undefined}
            title={to !== href ? PROJ_OFF_TITLE : undefined} onClick={() => onNavigate?.()}>
        {leaf.label}{leaf.isNew && <NewBadge style={{ pointerEvents: "none" }} />}
      </Link>
    );
  };

  const section = (s, hrefOf) => {
    if (!s.items) return leafRow({ ...s }, hrefOf(s.path), false);
    const isOpen = openKey === s.key;
    const inSection = active?.sectionKey === s.key;
    const first = s.items[0];
    return (
      <div key={s.key}>
        <button type="button" className={`ptet-sb-row${inSection && !isOpen ? " active" : ""}`} aria-expanded={isOpen}
          onClick={() => {
            setOpenKey(isOpen && inSection ? null : s.key);
            if (!inSection && first) go(leafHref(first, hrefOf(first.path)));
          }}>
          {s.label}
          <span className="ptet-sb-chev" style={{ transform: isOpen ? "rotate(90deg)" : "none" }}>▶</span>
        </button>
        {isOpen && s.items.map(i => leafRow(i, hrefOf(i.path), true))}
      </div>
    );
  };

  return (
    <nav className="ptet-sb" aria-label="Site" style={{
      ...vars, width: 240, height: drawer ? "100%" : "100vh", position: drawer ? "relative" : "sticky", top: 0,
      overflowY: "auto", background: t.id === "dark" ? "#0d1424" : t.cardBg, borderRight: `1px solid ${t.divider}`,
      display: "flex", flexDirection: "column", padding: "0 10px 16px", flexShrink: 0,
    }}>
      <style>{CSS}</style>
      <Link to="/" onClick={() => onNavigate?.()} style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none",
                                                          padding: "clamp(6px, 1.5vh, 18px) 4px clamp(3px, 0.9vh, 12px)", flexShrink: 0 }}>
        <img src="/logo.jpg" alt="" style={{ height: 30, width: 30, borderRadius: 6, objectFit: "cover" }} />
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em", fontStyle: "italic", whiteSpace: "nowrap" }}>
          <span style={{ color: t.accentSecondary }}>Past The</span> <span style={{ color: t.brand }}>Eye Test</span>
        </span>
      </Link>

      {leafRow({ label: "Articles and Updates", path: "/" }, "/", false)}

      <LeagueLogo league="MLB" isDark={t.id === "dark"} onClick={() => go(mlbHref(MLB_DEFAULT_PATH))} />
      {MLB_NAV.map(s => section(s, mlbHref))}

      <LeagueLogo league="NHL" isDark={t.id === "dark"} onClick={() => go(NHL_DEFAULT_PATH)}
        badge={<span style={{ padding: "1px 7px", borderRadius: 4, background: "#ea580c", color: "#fff", fontSize: 10, fontWeight: 700 }}>Beta</span>} />
      {NHL_NAV.map(s => section(s, nhlHref))}

      {onHide && (
        <button type="button" className="ptet-sb-row" onClick={onHide}
          style={{ marginTop: "auto", color: t.textFaint, fontSize: 13 }} title="Hide the sidebar">
          « Hide sidebar
        </button>
      )}
    </nav>
  );
}
