// All bzzoiro API calls for the World Cup dashboard.
// Proxy route: /bzzoiro → https://sports.bzzoiro.com

const TOKEN = import.meta.env.VITE_BZZOIRO_TOKEN || "";
const BASE = "/bzzoiro/api";

function authHeaders() {
  return { Authorization: `Token ${TOKEN}` };
}

async function get(path, params = {}) {
  const url = new URL(BASE + path, location.origin);
  Object.entries(params).forEach(([k, v]) => v != null && url.searchParams.set(k, v));
  // Cache-buster: prevents stale edge-cached HTML from being served for API paths
  url.searchParams.set("_", Date.now());
  const r = await fetch(url.toString(), { headers: authHeaders() });
  if (!r.ok) throw new Error(`bzzoiro ${path} → ${r.status}`);
  const text = await r.text();
  if (text.trimStart().startsWith("<")) {
    throw new Error("Proxy returned HTML instead of JSON — check the /bzzoiro rewrite");
  }
  return JSON.parse(text);
}

// ── League discovery ──────────────────────────────────────────
// FIFA World Cup 2026 — confirmed against the live API. League 188 is an
// empty duplicate; 27 holds all fixtures (season id 188).
export const WC_LEAGUE = { id: 27, name: "World Cup 2026", season_id: 188 };

export async function findWorldCupLeague() {
  return WC_LEAGUE;
}

// The leagues endpoint is paginated (~10 per page, alphabetical).
export async function fetchLeagues(page) {
  return get("/leagues/", page ? { page } : {});
}

// Generic discovery (kept for future tournaments) — walks the paginated list.
export async function discoverWorldCupLeague() {
  const cached = sessionStorage.getItem("bzz_wc_league");
  if (cached) return JSON.parse(cached);

  const all = [];
  let pageData = await fetchLeagues();
  for (let i = 0; i < 15; i++) {
    const list = Array.isArray(pageData) ? pageData : (pageData.results ?? pageData.data ?? []);
    all.push(...list);
    const next = !Array.isArray(pageData) && pageData.next;
    if (!next) break;
    const pageNum = new URL(next).searchParams.get("page");
    if (!pageNum) break;
    pageData = await fetchLeagues(pageNum);
  }

  const cups = all.filter(l => /world\s*cup|fifa/i.test(l.name ?? ""));
  // Exclude qualification rounds, Club World Cup, youth, futsal, women's variants
  let candidates = cups.filter(l =>
    !/qualif|club|u-?\d{2}|youth|futsal|beach/i.test(l.name) && !l.is_women
  );
  if (candidates.length === 0) candidates = cups;

  // bzzoiro has duplicate "World Cup 2026" entries — prefer one with an active
  // season, then probe which actually has fixtures
  candidates.sort((a, b) => (b.current_season ? 1 : 0) - (a.current_season ? 1 : 0));

  let wc = candidates.length === 1 ? candidates[0] : null;
  if (!wc && candidates.length > 1) {
    for (const cand of candidates) {
      const id = cand.id ?? cand.league_id ?? cand.pk;
      try {
        const ev = await get("/events/", { league: id });
        const list = Array.isArray(ev) ? ev : (ev.results ?? ev.data ?? []);
        if (list.length > 0) { wc = cand; break; }
      } catch { /* dead entry — try the next */ }
    }
    wc = wc ?? candidates[0];
  }

  if (wc) sessionStorage.setItem("bzz_wc_league", JSON.stringify(wc));
  return wc ?? null;
}

// ── Fixtures / live scores ────────────────────────────────────
export async function fetchFixtures(leagueId, params = {}) {
  return get("/events/", { league: leagueId, ...params });
}

// Fetch the full fixture list, following pagination (the endpoint pages like
// /leagues/ does — only reading page 1 made finished matches disappear once
// the feed grew). page_size is a hint; some APIs reject unknown params, so
// retry bare if it errors. On total failure, serve the cached fixture list.
export async function fetchAllFixtures(leagueId) {
  const key = `bzz_events_${leagueId}`;
  let cached = [];
  try { cached = JSON.parse(localStorage.getItem(key) ?? "[]"); } catch { /* corrupt cache */ }

  const all = [];
  try {
    let raw;
    try {
      raw = await get("/events/", { league: leagueId, page_size: 200 });
    } catch {
      raw = await get("/events/", { league: leagueId });
    }
    for (let i = 0; i < 30; i++) {
      const list = Array.isArray(raw) ? raw : (raw.results ?? raw.data ?? raw.events ?? []);
      all.push(...list);
      const next = !Array.isArray(raw) && raw.next;
      if (!next || list.length === 0) break;
      // Re-use every param from the next link so page/page_size stay consistent
      let params = null;
      try {
        params = Object.fromEntries(new URL(next, location.origin).searchParams.entries());
        delete params._;
      } catch { /* malformed next */ }
      if (!params || !params.page) break;
      raw = await get("/events/", params);
    }
  } catch (e) {
    if (cached.length === 0) throw e;
    console.warn("bzzoiro events fetch failed — serving cached fixtures", e);
  }

  // Merge with previously seen events so results never vanish from the UI
  // if the feed drops or reorders past matches. Fresh data wins per id.
  const byId = new Map();
  for (const m of cached) byId.set(m.id ?? m.event_id, m);
  for (const m of all) byId.set(m.id ?? m.event_id, m);
  byId.delete(undefined);
  byId.delete(null);
  const merged = [...byId.values()];
  try { localStorage.setItem(key, JSON.stringify(merged)); } catch { /* storage full */ }
  if (typeof window !== "undefined") window.__bzzEvents = merged;
  return merged;
}

// Kickoff timestamp — confirmed bzzoiro field is event_date
export function eventStart(m) {
  return m.event_date ?? m.start_time ?? m.start_at ?? m.date ?? m.kickoff ?? m.datetime ?? m.start ?? null;
}

// Combined status string — period ("FT", "1H", "HT") backs up status, since
// either field alone has been unreliable
export function eventStatus(m) {
  return `${m.status ?? m.state ?? ""} ${m.period ?? ""}`.trim();
}

export const isFinishedEvent = m => /ft|finished|ended|after/i.test(eventStatus(m));
export const isLiveEvent = m => /live|inprogress|halftime|break|1h|2h|ht/i.test(eventStatus(m)) && !isFinishedEvent(m);

// Team object — events return home_team/away_team as plain strings with the
// full object in home_team_obj/away_team_obj
export function eventTeam(m, side) {
  const obj = m[`${side}_team_obj`];
  const raw = m[`${side}_team`];
  if (obj && typeof obj === "object") return obj;
  if (raw && typeof raw === "object") return raw;
  return { name: raw ?? "" };
}

// Full event detail (lineups, stats, live score, incidents)
export async function fetchEventDetail(eventId) {
  return get(`/events/${eventId}/`);
}

// ── Group standings ───────────────────────────────────────────
// Computed client-side from fixtures — the bzzoiro /standings/ endpoint 404s.
export function computeStandingsFromFixtures(fixtures) {
  const groups = {};

  for (const m of fixtures) {
    if (!isFinishedEvent(m)) continue;
    const group = m.group_name ?? m.group ?? m.stage ?? null;
    if (!group || /round|knockout|final/i.test(group)) continue;

    const home = eventTeam(m, "home");
    const away = eventTeam(m, "away");
    const homeName = home.name ?? home.shortName ?? "";
    const awayName = away.name ?? away.shortName ?? "";
    if (!homeName || !awayName) continue;

    const hs = Number(m.home_score ?? m.score?.home ?? 0);
    const as_ = Number(m.away_score ?? m.score?.away ?? 0);

    if (!groups[group]) groups[group] = {};
    const ensure = (name, obj) => {
      if (!groups[group][name]) groups[group][name] = {
        team: obj, played: 0, won: 0, drawn: 0, lost: 0,
        goals_for: 0, goals_against: 0, points: 0,
      };
    };
    ensure(homeName, home);
    ensure(awayName, away);

    const ht = groups[group][homeName];
    const at = groups[group][awayName];
    ht.played++; at.played++;
    ht.goals_for += hs; ht.goals_against += as_;
    at.goals_for += as_; at.goals_against += hs;

    if (hs > as_) { ht.won++; at.lost++; ht.points += 3; }
    else if (hs < as_) { at.won++; ht.lost++; at.points += 3; }
    else { ht.drawn++; at.drawn++; ht.points++; at.points++; }
  }

  return Object.entries(groups)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([group, teams]) => ({
      name: group,
      group,
      table: Object.values(teams)
        .sort((a, b) =>
          b.points - a.points ||
          (b.goals_for - b.goals_against) - (a.goals_for - a.goals_against) ||
          b.goals_for - a.goals_for
        )
        .map((t, i) => ({ ...t, position: i + 1 })),
    }));
}

export async function fetchStandings(leagueId) {
  return get("/standings/", { league: leagueId });
}

// ── Odds ─────────────────────────────────────────────────────
export async function fetchEventOdds(eventId) {
  return get(`/v2/events/${eventId}/odds/`);
}

// Tournament outright winner odds (all teams)
export async function fetchOutrightOdds(leagueId) {
  return get("/outrights/", { league: leagueId });
}

// ── Player stats ──────────────────────────────────────────────
// Per-event player stats (all players in a specific match)
export async function fetchEventPlayerStats(eventId) {
  return get("/player-stats/", { event: eventId });
}

// Tournament aggregate stats for a single player
export async function fetchPlayerStats(playerId, leagueId) {
  return get(`/player-stats/${playerId}/`, { league: leagueId });
}

// All player stats for a tournament (may be paginated)
export async function fetchAllTournamentPlayerStats(leagueId) {
  const cacheKey = `bzz_player_stats_${leagueId}`;
  const cached = sessionStorage.getItem(cacheKey);
  if (cached) {
    const { ts, data } = JSON.parse(cached);
    if (Date.now() - ts < 30 * 60 * 1000) return data; // 30-min cache
  }

  // Collect stats across all completed fixtures (filter client-side)
  const allFixtures = await fetchAllFixtures(leagueId);
  const fixtures = allFixtures.filter(isFinishedEvent);

  // Aggregate per-player stats across all matches
  const playerMap = {};
  for (const fixture of fixtures) {
    let matchStats;
    try {
      matchStats = await fetchEventPlayerStats(fixture.id);
    } catch {
      continue;
    }
    const rows = Array.isArray(matchStats)
      ? matchStats
      : (matchStats.results ?? matchStats.data ?? []);

    for (const row of rows) {
      const pid = row.player_id ?? row.player?.id;
      if (!pid) continue;
      if (!playerMap[pid]) {
        playerMap[pid] = {
          player_id: pid,
          name: row.player?.name ?? row.player_name ?? "",
          team: row.team?.name ?? row.team_name ?? "",
          team_id: row.team?.id ?? row.team_id,
          country_code: row.team?.country_code ?? row.country_code ?? "",
          photo: row.player?.photo ?? row.photo ?? null,
          minutes: 0, matches: 0,
          goals: 0, assists: 0,
          xg: 0, xag: 0,
          shots: 0, shots_on_target: 0,
          key_passes: 0,
          passes: 0, passes_completed: 0,
          dribbles: 0, dribbles_successful: 0,
          duels: 0, duels_won: 0,
          tackles: 0, interceptions: 0,
          position: row.position ?? row.player?.position ?? "",
        };
      }
      const p = playerMap[pid];
      p.matches += 1;
      p.minutes += row.minutes_played ?? row.minutes ?? 0;
      p.goals += row.goals ?? 0;
      p.assists += row.assists ?? 0;
      p.xg += row.xg ?? row.expected_goals ?? 0;
      p.xag += row.xag ?? row.expected_assists ?? 0;
      p.shots += row.shots ?? 0;
      p.shots_on_target += row.shots_on_target ?? 0;
      p.key_passes += row.key_passes ?? 0;
      p.passes += row.passes ?? 0;
      p.passes_completed += row.passes_completed ?? row.accurate_passes ?? 0;
      p.dribbles += row.dribbles ?? row.dribble_attempts ?? 0;
      p.dribbles_successful += row.dribbles_successful ?? row.dribbles_completed ?? 0;
      p.duels += row.duels ?? row.duels_total ?? 0;
      p.duels_won += row.duels_won ?? 0;
      p.tackles += row.tackles ?? 0;
      p.interceptions += row.interceptions ?? 0;
    }
  }

  // Filter to players with meaningful minutes, compute derived rates
  const players = Object.values(playerMap)
    .filter(p => p.minutes >= 45)
    .map(p => ({
      ...p,
      xg_per90: p.minutes > 0 ? (p.xg / p.minutes) * 90 : 0,
      xag_per90: p.minutes > 0 ? (p.xag / p.minutes) * 90 : 0,
      shots_on_target_pct: p.shots > 0 ? (p.shots_on_target / p.shots) * 100 : 0,
      pass_pct: p.passes > 0 ? (p.passes_completed / p.passes) * 100 : 0,
      dribble_pct: p.dribbles > 0 ? (p.dribbles_successful / p.dribbles) * 100 : 0,
      duel_won_pct: p.duels > 0 ? (p.duels_won / p.duels) * 100 : 0,
      defensive_actions_per90: p.minutes > 0 ? ((p.tackles + p.interceptions) / p.minutes) * 90 : 0,
      key_passes_per90: p.minutes > 0 ? (p.key_passes / p.minutes) * 90 : 0,
    }));

  sessionStorage.setItem(cacheKey, JSON.stringify({ ts: Date.now(), data: players }));
  return players;
}

// ── Percentile computation ────────────────────────────────────
// Given an array of player objects and a stat key, compute percentile rank for each.
// Higher is always better EXCEPT for stats in LOWER_IS_BETTER.
const LOWER_IS_BETTER = new Set([]);

export function computePercentiles(players, statKey) {
  const vals = players.map(p => p[statKey]).filter(v => v != null && isFinite(v));
  if (!vals.length) return {};
  vals.sort((a, b) => a - b);
  const ranks = {};
  for (const player of players) {
    const v = player[statKey];
    if (v == null || !isFinite(v)) continue;
    const below = vals.filter(x => x < v).length;
    const pct = (below / vals.length) * 100;
    ranks[player.player_id] = LOWER_IS_BETTER.has(statKey) ? 100 - pct : pct;
  }
  return ranks;
}

// Build category map for a single player (same shape as baseball cards expect)
export function buildPlayerCategories(player, allPlayers) {
  const isGK = /goalkeeper|keeper|gk/i.test(player.position);

  const stats = isGK
    ? [
        { label: "Save %",           key: "save_pct",                 fmt: v => `${v.toFixed(1)}%` },
        { label: "Goals Allowed",     key: "goals_conceded",           fmt: v => v.toFixed(0) },
        { label: "Clean Sheets",      key: "clean_sheets",             fmt: v => v.toFixed(0) },
      ]
    : [
        { label: "xG",                key: "xg_per90",                 fmt: v => v.toFixed(2) },
        { label: "xAG",               key: "xag_per90",                fmt: v => v.toFixed(2) },
        { label: "Shots on Target %", key: "shots_on_target_pct",      fmt: v => `${v.toFixed(1)}%` },
        { label: "Key Passes/90",     key: "key_passes_per90",         fmt: v => v.toFixed(2) },
        { label: "Pass %",            key: "pass_pct",                 fmt: v => `${v.toFixed(1)}%` },
        { label: "Dribble %",         key: "dribble_pct",              fmt: v => `${v.toFixed(1)}%` },
        { label: "Duel Won %",        key: "duel_won_pct",             fmt: v => `${v.toFixed(1)}%` },
        { label: "Def. Actions/90",   key: "defensive_actions_per90",  fmt: v => v.toFixed(2) },
      ];

  const categories = {};
  for (const { label, key, fmt } of stats) {
    const pctileMap = computePercentiles(allPlayers, key);
    const val = player[key];
    categories[label] = {
      pctile: pctileMap[player.player_id] ?? null,
      display: val != null && isFinite(val) ? fmt(val) : "—",
    };
  }
  return categories;
}
