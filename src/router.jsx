import { useEffect, useMemo, useState } from "react";

// ═══════════════════════════════════════════════════════════
// TINY HISTORY-API ROUTER
// ═══════════════════════════════════════════════════════════
// Routes: /  ·  /posts/:slug  ·  /mlb/...  ·  /nhl/...  ·  /palette (dev preview).
// The MLB / NHL section paths live in src/nav/navConfig.js. vercel.json rewrites
// unknown paths to index.html, and `vite` / `vite preview` do the same, so a refresh
// on any route works. Query strings carry the view's state (player, season, …).

const listeners = new Set();
const notify = () => listeners.forEach(f => f());

const normalize = p => p.replace(/\/+$/, "") || "/";

// Go to `to` (path plus optional ?query). push by default; replace for redirects and
// state tweaks. Scrolls to the top unless `scroll: false`.
export function navigate(to, { replace = false, scroll = true } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  notify();
  if (scroll) window.scrollTo(0, 0);
}

// Patch the current query string: null / "" removes a key. Replaces the history entry
// by default (so picking players doesn't flood the back button) and never scrolls.
export function setQuery(patch, { replace = true } = {}) {
  const u = new URL(window.location.href);
  for (const [k, v] of Object.entries(patch)) {
    if (v == null || v === "") u.searchParams.delete(k);
    else u.searchParams.set(k, String(v));
  }
  navigate(u.pathname + u.search, { replace, scroll: false });
}

function useLocationRaw() {
  const read = () => ({ path: normalize(window.location.pathname), search: window.location.search });
  const [loc, setLoc] = useState(read);
  useEffect(() => {
    const update = () => setLoc(prev => {
      const next = read();
      return next.path === prev.path && next.search === prev.search ? prev : next;
    });
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => { listeners.delete(update); window.removeEventListener("popstate", update); };
  }, []);
  return loc;
}

// { path, query } with query as a plain object of strings.
export function useLocation() {
  const loc = useLocationRaw();
  return useMemo(() => ({
    path: loc.path,
    search: loc.search,
    query: Object.fromEntries(new URLSearchParams(loc.search)),
  }), [loc.path, loc.search]);
}

export function usePath() {
  return useLocationRaw().path;
}

// A normal <a href> (so open-in-new-tab and copy-link work) that navigates in-app on a plain click.
export function Link({ to, children, onClick, ...rest }) {
  return (
    <a href={to} {...rest} onClick={e => {
      onClick?.(e);
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      e.preventDefault();
      navigate(to);
    }}>{children}</a>
  );
}
