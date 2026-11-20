import { useEffect, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { NewBadge } from "../baseball/SharedComponents.jsx";
import { Link, navigate } from "../router.jsx";
import {
  MLB_NAV, NHL_NAV, mlbLeafForPath, nhlLeafForPath, mlbSeasonFrom, isOffInSeason,
  DEFAULT_MLB_SEASON, LATEST_MLB_SEASON, PROJ_OFF_TITLE,
} from "./navConfig.js";

// ═══════════════════════════════════════════════════════════
// SIDEBAR: Home · MLB sections · NHL sections
// ═══════════════════════════════════════════════════════════
// Desktop: a sticky 240 px column. Phones/tablets: the same list in a slide-out drawer.
// The section you're in is expanded; others expand on click (and jump to their first
// sub-tab). MLB links keep the selected season; NHL links keep the NHL filters.

const CSS = `
.ptet-sb { font-family: 'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; letter-spacing: 0; }
.ptet-sb-row { display: flex; align-items: center; gap: 8px; width: 100%; padding: 7px 12px; border-radius: 7px;
  color: var(--sb-text); font-size: 14px; font-weight: 500; line-height: 1.3; text-decoration: none; background: none;
  border: none; cursor: pointer; text-align: left; position: relative; font-family: inherit; }
.ptet-sb-row:hover { background: var(--sb-hover); }
.ptet-sb-row.active { color: var(--sb-active); background: var(--sb-active-bg); font-weight: 600; }
.ptet-sb-row.active::before { content: ""; position: absolute; left: 0; top: 7px; bottom: 7px; width: 3px; border-radius: 2px; background: var(--sb-accent); }
.ptet-sb-row.sub { padding-left: 28px; font-size: 13.5px; }
.ptet-sb-row.off { opacity: 0.38; cursor: not-allowed; }
.ptet-sb-row.off:hover { background: none; }
.ptet-sb-row:focus-visible { outline: 2px solid var(--sb-accent); outline-offset: -2px; }
.ptet-sb-chev { margin-left: auto; font-size: 10px; color: var(--sb-muted); transition: transform 0.15s; }
.ptet-sb-group { display: flex; align-items: center; gap: 8px; padding: 18px 12px 6px; font-size: 12px; font-weight: 600; color: var(--sb-muted); }
`;

export default function Sidebar({ path, query, search, onNavigate, onHide, drawer = false }) {
  const { theme: t } = useTheme();
  const season = mlbSeasonFrom(query);
  const active = mlbLeafForPath(path) || nhlLeafForPath(path);
  const [open, setOpen] = useState(() => new Set(active ? [active.sectionKey] : []));
  useEffect(() => {
    if (active?.sectionKey) setOpen(s => (s.has(active.sectionKey) ? s : new Set([...s, active.sectionKey])));
  }, [active?.sectionKey]);

  const mlbHref = p => (season !== DEFAULT_MLB_SEASON ? `${p}?season=${season}` : p);
  const nhlHref = p => (path.startsWith("/nhl") ? `${p}${search}` : p);
  const go = to => { navigate(to); onNavigate?.(); };

  const vars = {
    "--sb-text": t.textSecondary, "--sb-muted": t.textFaint, "--sb-hover": t.id === "dark" ? "rgba(255,255,255,0.05)" : "rgba(15,23,42,0.05)",
    "--sb-active": t.text, "--sb-active-bg": `${t.accent}1f`, "--sb-accent": t.accent,
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
    const isOpen = open.has(s.key);
    const inSection = active?.sectionKey === s.key;
    const first = s.items[0];
    return (
      <div key={s.key}>
        <button type="button" className={`ptet-sb-row${inSection && !isOpen ? " active" : ""}`} aria-expanded={isOpen}
          onClick={() => {
            setOpen(o => { const n = new Set(o); if (n.has(s.key) && inSection) n.delete(s.key); else n.add(s.key); return n; });
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
      <Link to="/" onClick={() => onNavigate?.()} style={{ display: "flex", alignItems: "center", gap: 10, textDecoration: "none", padding: "16px 4px 10px" }}>
        <img src="/logo.jpg" alt="" style={{ height: 30, width: 30, borderRadius: 6, objectFit: "cover" }} />
        <span style={{ fontSize: 15, fontWeight: 700, letterSpacing: "-0.02em", fontStyle: "italic", whiteSpace: "nowrap" }}>
          <span style={{ color: t.accentSecondary }}>Past The</span> <span style={{ color: t.brand }}>Eye Test</span>
        </span>
      </Link>

      {leafRow({ label: "Articles and Updates", path: "/" }, "/", false)}

      <div className="ptet-sb-group"><span aria-hidden>⚾</span> MLB</div>
      {MLB_NAV.map(s => section(s, mlbHref))}

      <div className="ptet-sb-group">
        <span aria-hidden>🏒</span> NHL
        <span style={{ padding: "1px 6px", borderRadius: 4, background: "#ea580c", color: "#fff", fontSize: 9.5, fontWeight: 700 }}>Beta</span>
      </div>
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
