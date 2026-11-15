// Data for the NHL tab: the JSON files the droplet's nightly run writes to public/nhl/
// (see nhl/README.md). Season files are column-oriented; toObjects() turns them into rows.
import { useEffect, useState } from "react";

const BASE = (import.meta.env.VITE_NHL_DATA_BASE || "/nhl").replace(/\/$/, "");
const cache = new Map();

export function fetchNhl(name) {
  if (!cache.has(name)) {
    const p = fetch(`${BASE}/${name}`)
      .then(r => { if (!r.ok) throw new Error(`${name}: HTTP ${r.status}`); return r.json(); })
      .catch(e => { cache.delete(name); throw e; });
    cache.set(name, p);
  }
  return cache.get(name);
}

// { data, error } for one file; `name` may be null while the caller is not ready.
export function useNhl(name) {
  const [state, setState] = useState({ name: null, data: null, error: null });
  useEffect(() => {
    if (!name) return;
    let live = true;
    fetchNhl(name)
      .then(data => { if (live) setState({ name, data, error: null }); })
      .catch(error => { if (live) setState({ name, data: null, error: error.message }); });
    return () => { live = false; };
  }, [name]);
  return state.name === name ? state : { name, data: null, error: null };
}

export function toObjects(file) {
  if (!file) return [];
  const cols = file.columns;
  return file.rows.map(r => {
    const o = {};
    for (let i = 0; i < cols.length; i++) o[cols[i]] = r[i];
    return o;
  });
}

export const seasonLabel = y => `${y}-${String(y + 1).slice(2)}`;
export const seasonShort = y => `${String(y).slice(2)}-${String(y + 1).slice(2)}`;

// ── NHL assets, through the site's existing proxies ──
export const logoUrl = team => (team ? `/nhl-assets/logos/nhl/svg/${team}_light.svg` : null);
export const headshotUrl = (id, team, season) =>
  (id && team ? `/nhl-assets/mugs/nhl/${season}${season + 1}/${team}/${id}.png` : null);
export const headshotFallback = id => `/nhl-assets/mugs/nhl/latest/${id}.png`;
export const flagUrl = code => (code ? `/flag-assets/w80/${code}.png` : null);

export const NHL_TEAM_PRIMARY = {
  ANA: "#F47A38", ARI: "#8C2633", BOS: "#FFB81C", BUF: "#003087", CAR: "#CC0000",
  CBJ: "#002654", CGY: "#C8102E", CHI: "#CF0A2C", COL: "#6F263D",
  DAL: "#006847", DET: "#CE1126", EDM: "#FF4C00", FLA: "#041E42",
  LAK: "#111111", MIN: "#154734", MTL: "#AF1E2D", NJD: "#CE1126",
  NSH: "#FFB81C", NYI: "#003087", NYR: "#0038A8", OTT: "#E31837",
  PHI: "#F74902", PIT: "#FCB514", SEA: "#001628", SJS: "#006D75",
  STL: "#002F87", TBL: "#002868", TOR: "#00205B", UTA: "#71B2C9",
  VAN: "#00205B", VGK: "#B4975A", WPG: "#041E42", WSH: "#C8102E",
};
