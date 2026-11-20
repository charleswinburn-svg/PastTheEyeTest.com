import { useEffect, useState } from "react";

// ═══════════════════════════════════════════════════════════
// TINY HISTORY-API ROUTER
// ═══════════════════════════════════════════════════════════
// Routes: /  ·  /mlb  ·  /nhl  ·  /posts/:slug  ·  /palette (dev preview).
// vercel.json already rewrites unknown paths to index.html, and `vite preview` /
// `vite` do the same, so a refresh on any route works.

const listeners = new Set();

export function navigate(to, { replace = false } = {}) {
  if (to === window.location.pathname + window.location.search) return;
  window.history[replace ? "replaceState" : "pushState"](null, "", to);
  listeners.forEach(f => f());
  window.scrollTo(0, 0);
}

export function usePath() {
  const [path, setPath] = useState(window.location.pathname);
  useEffect(() => {
    const update = () => setPath(window.location.pathname);
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => { listeners.delete(update); window.removeEventListener("popstate", update); };
  }, []);
  return path.replace(/\/+$/, "") || "/";
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
