// ═══════════════════════════════════════════════════════════
// NAVIGATION: the one list of sections, their URLs and labels
// ═══════════════════════════════════════════════════════════
// The sidebar, the page titles and the MLB / NHL apps all read this. Each MLB leaf
// carries the app's existing tab id (BaseballApp's `tab`), so the app logic is unchanged.

// ── MLB seasons (moved here from BaseballApp so the sidebar knows the projection rules) ──
export const MLB_SEASONS = ["2027P", "2026", "2025", "2024", "2023"];
export const PROJ_SEASON = MLB_SEASONS.find(x => String(x).endsWith("P")) || null;
export const DEFAULT_MLB_SEASON = PROJ_SEASON || "2026";
// Newest real (non-projection) season: sections without a projection version open in it.
export const LATEST_MLB_SEASON = MLB_SEASONS.find(x => !String(x).endsWith("P")) || "2026";
// Tabs that exist for the projection season; everything else is off while it's selected.
export const PROJ_TABS = new Set(["hitter", "pitcher", "hitter_lb", "hitter_xrv_lb", "pitcher_lb",
                                  "proj_movers", "proj_ci_hitters", "proj_ci_pitchers"]);
export const PROJ_OFF_TITLE = "Not available for 2027 projections: opens the latest season";
export const mlbSeasonFrom = q => (q?.season && MLB_SEASONS.includes(q.season) ? q.season : DEFAULT_MLB_SEASON);
export const isOffInSeason = (id, season) => season === PROJ_SEASON && !PROJ_TABS.has(id);

const projYear = PROJ_SEASON ? PROJ_SEASON.slice(0, 4) : "";

// Sections. A section has either an `id` + `path` (a leaf) or `items` (sub-tabs).
export const MLB_NAV = [
  { key: "hitters", label: "Hitters", items: [
    { id: "hitter", label: "MLB", path: "/mlb/hitters" },
    { id: "hitter_aaa", label: "AAA", path: "/mlb/hitters/aaa" },
  ] },
  { key: "pitchers", label: "Pitchers", items: [
    { id: "pitcher", label: "MLB", path: "/mlb/pitchers" },
    { id: "pitcher_aaa", label: "AAA", path: "/mlb/pitchers/aaa" },
  ] },
  { key: "fielders", label: "Fielders", id: "fielder", path: "/mlb/fielders" },
  { key: "summaries", label: "Summaries", items: [
    { id: "pitcher_game", label: "Pitcher game", path: "/mlb/summaries/pitcher-game" },
    { id: "pitcher_season", label: "Pitcher season", path: "/mlb/summaries/pitcher-season" },
    { id: "pitcher_plinko", label: "Pitcher Plinko", path: "/mlb/summaries/pitcher-plinko" },
    { id: "hitter_plinko", label: "Hitter Plinko", path: "/mlb/summaries/hitter-plinko" },
    { id: "hitter_iswing", label: "Hitter iSwing+", path: "/mlb/summaries/hitter-iswing", isNew: true },
    { id: "pitcher_stuff_wf", label: "Pitcher Stuff+", path: "/mlb/summaries/pitcher-stuff", isNew: true },
  ] },
  { key: "leaderboards", label: "Leaderboards", items: [
    { id: "hitter_lb", label: "Hitters", path: "/mlb/leaderboards/hitters" },
    { id: "hitter_xrv_lb", label: "Hitters (xRV)", path: "/mlb/leaderboards/hitters-xrv" },
    { id: "pitcher_lb", label: "Pitchers", path: "/mlb/leaderboards/pitchers" },
    { id: "pitch_modeling_lb", label: "Pitch modeling", path: "/mlb/leaderboards/pitch-modeling" },
    ...(PROJ_SEASON ? [{ id: "proj_movers", label: `${projYear} movers`, path: "/mlb/leaderboards/movers", isNew: true }] : []),
  ] },
  ...(PROJ_SEASON ? [{ key: "ranges", label: `${projYear} ranges`, items: [
    { id: "proj_ci_hitters", label: "Hitters", path: "/mlb/ranges/hitters", isNew: true },
    { id: "proj_ci_pitchers", label: "Pitchers", path: "/mlb/ranges/pitchers", isNew: true },
  ] }] : []),
  { key: "team-plots", label: "Team plots", id: "team_plots", path: "/mlb/team-plots" },
  { key: "race2k", label: "Race to 2K", id: "race2k", path: "/mlb/race-to-2k" },
  { key: "evla", label: "EV/LA fan", id: "evla", path: "/mlb/ev-la" },
];

// NHL: `view` is the HockeyApp view, `kind` skaters / goalies (from the path, not a toggle).
export const NHL_NAV = [
  { key: "nhl-skaters", label: "Skater cards", id: "skaters", path: "/nhl/skaters", view: "player", kind: "skaters" },
  { key: "nhl-goalies", label: "Goalie cards", id: "goalies", path: "/nhl/goalies", view: "player", kind: "goalies" },
  { key: "nhl-leaderboards", label: "Leaderboards", items: [
    { id: "lb_skaters", label: "Skaters", path: "/nhl/leaderboards/skaters", view: "leaderboard", kind: "skaters" },
    { id: "lb_goalies", label: "Goalies", path: "/nhl/leaderboards/goalies", view: "leaderboard", kind: "goalies" },
  ] },
  { key: "nhl-about", label: "About the numbers", id: "about", path: "/nhl/about", view: "about" },
];

export const MLB_DEFAULT_PATH = "/mlb/hitters";
export const NHL_DEFAULT_PATH = "/nhl/skaters";

// Older NHL addresses (?kind= toggle era) → the new paths, keeping the rest of the query.
export function nhlLegacyRedirect(path, query) {
  const goalies = query?.kind === "goalies";
  const rest = new URLSearchParams(Object.entries(query || {}).filter(([k]) => k !== "kind"));
  const qs = rest.toString() ? `?${rest}` : "";
  if (path === "/nhl/player") return (goalies ? "/nhl/goalies" : "/nhl/skaters") + qs;
  if (path === "/nhl/leaderboard" || path === "/nhl/leaderboards") return (goalies ? "/nhl/leaderboards/goalies" : "/nhl/leaderboards/skaters") + qs;
  return null;
}

// Flat leaf list: { id, path, label, section, sectionKey, isNew, view?, kind? }
const leaves = nav => nav.flatMap(s => (s.items
  ? s.items.map(i => ({ ...i, section: s.label, sectionKey: s.key }))
  : [{ ...s, section: s.label, sectionKey: s.key }]));
export const MLB_LEAVES = leaves(MLB_NAV);
export const NHL_LEAVES = leaves(NHL_NAV);

export const mlbLeafForPath = path => MLB_LEAVES.find(l => l.path === path) || null;
export const mlbLeafForTab = id => MLB_LEAVES.find(l => l.id === id) || null;
export const nhlLeafForPath = path => NHL_LEAVES.find(l => l.path === path) || null;

// Page title for the top bar / document title.
export function titleForPath(path) {
  const m = mlbLeafForPath(path);
  if (m) return { sport: "MLB", title: m.section === m.label ? m.label : `${m.section} · ${m.label}` };
  const n = nhlLeafForPath(path);
  if (n) return { sport: "NHL", title: n.section === n.label ? n.label : `${n.section} · ${n.label}` };
  return null;
}
