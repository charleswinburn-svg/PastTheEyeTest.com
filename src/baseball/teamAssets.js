// Team assets for the release-diagram figure: the team's cap logo, returned as
// a data URL so html2canvas PNG exports include it (it can't draw cross-origin
// <image> hrefs inside SVG).
import { TEAM_IDS } from "./SharedComponents.jsx";

const _logoCache = new Map();   // teamAbbr → Promise<dataURL|null>

export function teamIdFor(abbr) {
  const k = String(abbr || "").trim().toUpperCase().replace(/\./g, "");
  return TEAM_IDS[k] ?? null;
}

async function toDataUrl(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  const blob = await r.blob();
  // An SPA fallback (index.html) or error page must not end up as the "logo".
  if (!blob.size || !/^image\//.test(blob.type || r.headers.get("content-type") || "")) throw new Error("not an image");
  return await new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onload = () => resolve(fr.result);
    fr.onerror = reject;
    fr.readAsDataURL(blob);
  });
}

// MLB's cap insignia (light version for dark caps) via the /mlb-static proxy,
// falling back to the round "spots" logo the site already uses in headers.
export function loadCapLogo(teamAbbr) {
  const id = teamIdFor(teamAbbr);
  if (!id) return Promise.resolve(null);
  if (!_logoCache.has(id)) {
    const p = toDataUrl(`/mlb-static/team-logos/team-cap-on-dark/${id}.svg`)
      .catch(() => toDataUrl(`/mlb-logos/v1/team/${id}/spots/128`))
      .catch(() => null);
    _logoCache.set(id, p);
  }
  return _logoCache.get(id);
}
