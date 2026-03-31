// MLB Stats API helper functions
// All requests go through Vite proxy: /mlb-api → https://statsapi.mlb.com

const API = "/mlb-api/api/v1";

// ── Pitch type colors matching R app ──
export const PITCH_COLORS = {
  FF: "#D22D49", SI: "#FE9D00", FC: "#933F2C", SL: "#EEE716",
  CU: "#00D1ED", CH: "#1DBE3A", FS: "#3BACAC", ST: "#DDB33A",
  KC: "#6236CD", CS: "#0068FF", SV: "#93AFD4", KN: "#3C44CD",
  SC: "#60DB33", FO: "#55CCAB", GY: "#FFFF99",
  EP: "#999999", FA: "#D22D49",
};
export const PITCH_NAMES = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curveball", CH: "Changeup", FS: "Splitter", ST: "Sweeper",
  KC: "Knuckle Curve", CS: "Slow Curve", SV: "Slurve", KN: "Knuckleball",
};

// ── Hit result colors ──
export const HIT_COLORS = {
  home_run: "#D22D49", triple: "#FE9D00", double: "#EDE252",
  single: "#3BACAC", out: "#888",
};

// ── Game type codes ──
export const GAME_TYPES = {
  spring: "S", regular: "R", postseason: "P",
};
export const GAME_TYPE_LABELS = {
  S: "Spring Training", R: "Regular Season", P: "Postseason", W: "World Baseball Classic",
};

// ── MLB team IDs (for distinguishing MLB vs WBC teams) ──
const MLB_IDS = new Set([108,109,110,111,112,113,114,115,116,117,118,119,120,121,133,134,135,136,137,138,139,140,141,142,143,144,145,146,147,158]);

// ── WBC country flags ──
export const WBC_FLAGS = {
  "United States": "🇺🇸", "USA": "🇺🇸", "US": "🇺🇸", "Team USA": "🇺🇸",
  "Japan": "🇯🇵", "JPN": "🇯🇵", "Team Japan": "🇯🇵", "Samurai Japan": "🇯🇵",
  "Dominican Republic": "🇩🇴", "DOM": "🇩🇴", "Dominican Rep.": "🇩🇴",
  "Puerto Rico": "🇵🇷", "PUR": "🇵🇷", "PR": "🇵🇷",
  "Venezuela": "🇻🇪", "VEN": "🇻🇪",
  "Cuba": "🇨🇺", "CUB": "🇨🇺",
  "Mexico": "🇲🇽", "MEX": "🇲🇽",
  "Korea": "🇰🇷", "South Korea": "🇰🇷", "KOR": "🇰🇷", "Republic of Korea": "🇰🇷",
  "Netherlands": "🇳🇱", "NED": "🇳🇱", "Kingdom of the Netherlands": "🇳🇱", "The Netherlands": "🇳🇱",
  "Canada": "🇨🇦", "CAN": "🇨🇦",
  "Australia": "🇦🇺", "AUS": "🇦🇺",
  "Chinese Taipei": "🇹🇼", "TPE": "🇹🇼", "Taiwan": "🇹🇼", "CT": "🇹🇼",
  "Italy": "🇮🇹", "ITA": "🇮🇹",
  "Colombia": "🇨🇴", "COL": "🇨🇴",
  "Panama": "🇵🇦", "PAN": "🇵🇦",
  "Israel": "🇮🇱", "ISR": "🇮🇱",
  "Great Britain": "🇬🇧", "GBR": "🇬🇧", "United Kingdom": "🇬🇧",
  "Nicaragua": "🇳🇮", "NCA": "🇳🇮", "NIC": "🇳🇮",
  "Czech Republic": "🇨🇿", "Czechia": "🇨🇿", "CZE": "🇨🇿",
  "Brazil": "🇧🇷", "BRA": "🇧🇷",
  "China": "🇨🇳", "CHN": "🇨🇳",
  "Germany": "🇩🇪", "GER": "🇩🇪",
  "Spain": "🇪🇸", "ESP": "🇪🇸",
  "India": "🇮🇳", "IND": "🇮🇳",
  "France": "🇫🇷", "FRA": "🇫🇷",
  "Philippines": "🇵🇭", "PHI": "🇵🇭",
  "Pakistan": "🇵🇰", "PAK": "🇵🇰",
  "New Zealand": "🇳🇿", "NZL": "🇳🇿",
  "South Africa": "🇿🇦", "RSA": "🇿🇦",
  "Hong Kong": "🇭🇰", "HKG": "🇭🇰",
  "Peru": "🇵🇪", "PER": "🇵🇪",
  "Argentina": "🇦🇷", "ARG": "🇦🇷",
  "Sweden": "🇸🇪", "SWE": "🇸🇪",
  "Thailand": "🇹🇭", "THA": "🇹🇭",
  "Costa Rica": "🇨🇷", "CRC": "🇨🇷", "CRI": "🇨🇷",
  "Bahamas": "🇧🇸", "BAH": "🇧🇸",
  "Guatemala": "🇬🇹", "GUA": "🇬🇹",
  "Honduras": "🇭🇳", "HON": "🇭🇳",
  "El Salvador": "🇸🇻", "ESA": "🇸🇻",
  "Aruba": "🇦🇼", "ARU": "🇦🇼",
  "Curacao": "🇨🇼", "CUR": "🇨🇼", "Curaçao": "🇨🇼",
  "US Virgin Islands": "🇻🇮", "ISV": "🇻🇮", "Virgin Islands": "🇻🇮",
  "British Virgin Islands": "🇻🇬", "IVB": "🇻🇬",
};

export function getWbcFlag(teamName) {
  if (!teamName) return null;
  // Direct lookup
  if (WBC_FLAGS[teamName]) return WBC_FLAGS[teamName];
  // Strip prefixes
  const cleaned = teamName.replace(/^Team\s+/i, "").trim();
  if (WBC_FLAGS[cleaned]) return WBC_FLAGS[cleaned];
  // Case-insensitive search
  const lower = cleaned.toLowerCase();
  for (const [key, flag] of Object.entries(WBC_FLAGS)) {
    if (key.toLowerCase() === lower) return flag;
  }
  return null;
}

function isMLBTeam(teamId) {
  return MLB_IDS.has(teamId);
}

// ── Fetch helpers ──
async function fetchJson(url) {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`MLB API ${r.status}: ${url}`);
  return r.json();
}

// ── Get all teams ──
export async function fetchTeams() {
  const d = await fetchJson(`${API}/teams?sportId=1`);
  const map = {};
  for (const t of d.teams) map[t.id] = t;
  return map;
}

// ── Get schedule for a date range ──
export async function fetchSchedule(season, gameType = "S", sportId = null) {

  // Helper: parse a single game into our format
  const parseGame = (g, date, extra = {}) => {
    const state = g.status?.abstractGameState;
    const detail = g.status?.detailedState;
    const awayTeam = g.teams?.away?.team;
    const homeTeam = g.teams?.home?.team;
    return {
      gamePk: g.gamePk,
      date: date,
      status: detail,
      isLive: state === "Live" || detail === "In Progress",
      away: awayTeam,
      home: homeTeam,
      awayScore: g.teams?.away?.score,
      homeScore: g.teams?.home?.score,
      awayFlag: !isMLBTeam(awayTeam?.id) ? (getWbcFlag(awayTeam?.teamName || awayTeam?.name) || getWbcFlag(awayTeam?.abbreviation)) : null,
      homeFlag: !isMLBTeam(homeTeam?.id) ? (getWbcFlag(homeTeam?.teamName || homeTeam?.name) || getWbcFlag(homeTeam?.abbreviation)) : null,
      ...extra,
    };
  };

  // ── WBC TAB: all WBC games, tagged as exhibition if MLB team involved ──
  if (gameType === "W") {
    const d = await fetchJson(
      `${API}/schedule?sportId=51&season=${season}&hydrate=team,probablePitcher`
    );
    const allGames = [];
    for (const date of (d.dates || [])) {
      for (const g of date.games) {
        const awayId = g.teams?.away?.team?.id;
        const homeId = g.teams?.home?.team?.id;
        const exhibition = isMLBTeam(awayId) || isMLBTeam(homeId);
        allGames.push(parseGame(g, date.date, { isExhibition: exhibition }));
      }
    }
    return allGames;
  }

  // ── SPRING TRAINING: regular ST games + Spring Breakout + WBC exhibition games ──
  if (gameType === "S") {
    const startDate = `${season}-02-20`;
    const endDate = `${season}-03-28`;
    const allGames = [];
    const seenPks = new Set();

    // Regular spring training (sportId=1, gameType=S)
    const d = await fetchJson(
      `${API}/schedule?sportId=1&gameType=S&startDate=${startDate}&endDate=${endDate}&hydrate=team,probablePitcher`
    );
    for (const date of (d.dates || [])) {
      for (const g of date.games) {
        seenPks.add(g.gamePk);
        allGames.push(parseGame(g, date.date));
      }
    }

    // Spring Breakout (sportId=21, gameType=E)
    // Teams are prospect squads with names like "Miami Marlins Prospects"
    // Remap to parent MLB org by matching team name
    try {
      // Fetch MLB teams to build name→team lookup
      const mlbNameMap = {}; // "miami marlins" → team object
      const mlbTeams2 = await fetchJson(`${API}/teams?sportId=1`);
      for (const t of (mlbTeams2.teams || [])) {
        if (t.name) mlbNameMap[t.name.toLowerCase()] = t;
        if (t.teamName) mlbNameMap[t.teamName.toLowerCase()] = t;
      }

      const remapTeam = (t) => {
        if (!t) return t;
        // Strip "Prospects" from name and match to MLB team
        const cleaned = (t.name || t.teamName || "").replace(/\s*Prospects?\s*/i, "").trim().toLowerCase();
        const mlb = mlbNameMap[cleaned];
        if (mlb) {
          return { ...t, id: mlb.id, abbreviation: mlb.abbreviation, teamName: mlb.teamName, name: mlb.name };
        }
        return t;
      };

      const sb = await fetchJson(
        `${API}/schedule?sportId=21&gameType=E&startDate=${startDate}&endDate=${endDate}&hydrate=team,probablePitcher`
      );
      let sbAdded = 0;
      for (const date of (sb.dates || [])) {
        for (const g of date.games) {
          if (seenPks.has(g.gamePk)) continue;
          seenPks.add(g.gamePk);
          const patched = {
            ...g,
            teams: {
              away: { ...g.teams?.away, team: remapTeam(g.teams?.away?.team) },
              home: { ...g.teams?.home, team: remapTeam(g.teams?.home?.team) },
            },
          };
          allGames.push(parseGame(patched, date.date, { isExhibition: true }));
          sbAdded++;
        }
      }
      if (sbAdded > 0) console.log(`[Spring Breakout] Added ${sbAdded} games`);
    } catch (e) { /* no Spring Breakout games */ }

    // WBC exhibition games (sportId=51, at least one team is MLB)
    try {
      const wbc = await fetchJson(
        `${API}/schedule?sportId=51&season=${season}&hydrate=team,probablePitcher`
      );
      for (const date of (wbc.dates || [])) {
        for (const g of date.games) {
          if (seenPks.has(g.gamePk)) continue;
          const awayId = g.teams?.away?.team?.id;
          const homeId = g.teams?.home?.team?.id;
          if (isMLBTeam(awayId) || isMLBTeam(homeId)) {
            seenPks.add(g.gamePk);
            allGames.push(parseGame(g, date.date, { isExhibition: true }));
          }
        }
      }
    } catch (e) { /* WBC schedule may not exist */ }

    allGames.sort((a, b) => b.date.localeCompare(a.date));
    return allGames;
  }

  // ── REGULAR SEASON / POSTSEASON ──
  let startDate, endDate;
  if (gameType === "R") {
    startDate = `${season}-03-20`;
    endDate = `${season}-11-05`;
  } else {
    startDate = `${season}-10-01`;
    endDate = `${season}-11-15`;
  }

  const sid = sportId || 1;
  const gameTypes = gameType === "P" ? ["F", "D", "L", "W"] : [gameType];
  const allGames = [];

  for (const gt of gameTypes) {
    const d = await fetchJson(
      `${API}/schedule?sportId=${sid}&gameType=${gt}&startDate=${startDate}&endDate=${endDate}&hydrate=team,probablePitcher`
    );
    for (const date of (d.dates || [])) {
      for (const g of date.games) {
        allGames.push(parseGame(g, date.date));
      }
    }
  }
  return allGames;
}

// ── Get play-by-play for a game ──
export async function fetchPlayByPlay(gamePk) {
  return fetchJson(`${API}/game/${gamePk}/playByPlay`);
}

// ── Get boxscore ──
export async function fetchBoxscore(gamePk) {
  return fetchJson(`${API}/game/${gamePk}/boxscore`);
}

// ── Get game log for a player ──
export async function fetchGameLog(playerId, season, group = "pitching") {
  const d = await fetchJson(
    `${API}/people/${playerId}/stats?stats=gameLog&group=${group}&season=${season}&gameType=S,E,R,P,W`
  );
  return d.stats?.[0]?.splits || [];
}

// ── Get all roster players for a season ──
export async function fetchAllPlayers(season, sportId = 1) {
  const teams = await fetchJson(`${API}/teams?sportId=${sportId}&season=${season}&hydrate=parentOrg`);
  const players = { pitchers: [], hitters: [] };
  const seen = new Set();

  for (const team of (teams.teams || [])) {
    try {
      const r = await fetch(`${API}/teams/${team.id}/roster?season=${season}`);
      if (!r.ok) continue;
      const d = await r.json();
      for (const p of (d.roster || [])) {
        const id = p.person.id;
        if (seen.has(id)) continue;
        seen.add(id);
        const entry = {
          id, name: p.person.fullName,
          team: team.abbreviation, teamId: team.id,
          parentOrgId: team.parentOrgId || team.parentOrganization?.id || null,
          position: p.position?.abbreviation,
        };
        if (p.position?.type === "Pitcher") {
          players.pitchers.push(entry);
        } else {
          players.hitters.push(entry);
        }
      }
    } catch (e) { /* skip */ }
  }
  players.pitchers.sort((a, b) => a.name.localeCompare(b.name));
  players.hitters.sort((a, b) => a.name.localeCompare(b.name));
  return players;
}

// ── Fetch WBC rosters (sportId=51) ──
export async function fetchWbcPlayers(season) {
  const pitcherMap = new Map(); // id -> entry
  const hitterMap = new Map();

  // 1. Get all completed/live WBC games from schedule
  let allGamePks = [];
  try {
    const sched = await fetchJson(`${API}/schedule?sportId=51&season=${season}&hydrate=team`);
    for (const date of (sched.dates || [])) {
      for (const g of (date.games || [])) {
        const state = g.status?.abstractGameState;
        const detail = g.status?.detailedState || "";
        if (state === "Final" || state === "Live" || detail === "Game Over" || detail === "In Progress") {
          allGamePks.push(g.gamePk);
        }
      }
    }
  } catch (e) { /* schedule failed */ }

  // 2. Scan EVERY completed game boxscore — this is the ground truth
  // For WBC: always prefer the national team (non-MLB) assignment
  for (const gPk of allGamePks) {
    try {
      const box = await fetchJson(`${API}/game/${gPk}/boxscore`);
      for (const side of ["away", "home"]) {
        const teamData = box.teams?.[side];
        if (!teamData) continue;
        const teamId = teamData.team?.id;
        const teamName = teamData.team?.abbreviation || teamData.team?.teamName || "";
        const teamIsMLB = isMLBTeam(teamId);

        for (const [, p] of Object.entries(teamData.players || {})) {
          const person = p.person;
          if (!person) continue;
          const ps = p.stats || {};
          const pitching = ps.pitching || {};
          const batting = ps.batting || {};

          const pitched = (parseInt(pitching.pitchesThrown) || 0) >= 1 ||
                          (pitching.inningsPitched != null && pitching.inningsPitched !== "0.0");
          const batted = (parseInt(batting.atBats) || 0) >= 1 ||
                         (parseInt(batting.plateAppearances) || 0) >= 1;

          const entry = {
            id: person.id, name: person.fullName,
            team: teamName, teamId,
            position: p.position?.abbreviation || (pitched ? "P" : "DH"),
          };

          // Always overwrite if this is a national team (non-MLB), or if player not seen yet
          if (pitched) {
            const existing = pitcherMap.get(person.id);
            if (!existing || (existing && isMLBTeam(existing.teamId) && !teamIsMLB)) {
              pitcherMap.set(person.id, entry);
            }
          }
          if (batted) {
            const existing = hitterMap.get(person.id);
            if (!existing || (existing && isMLBTeam(existing.teamId) && !teamIsMLB)) {
              hitterMap.set(person.id, entry);
            }
          }
        }
      }
    } catch (e) { /* skip */ }
  }

  // 3. Supplement with rosters for players who haven't played yet
  const seen = new Set([...pitcherMap.keys(), ...hitterMap.keys()]);
  try {
    const sched = await fetchJson(`${API}/schedule?sportId=51&season=${season}&hydrate=team`);
    const teamMap = new Map();
    for (const date of (sched.dates || [])) {
      for (const g of (date.games || [])) {
        for (const side of ["away", "home"]) {
          const t = g.teams?.[side]?.team;
          if (t && t.id && !teamMap.has(t.id)) {
            teamMap.set(t.id, { abbreviation: t.abbreviation || "", teamName: t.teamName || t.name || "" });
          }
        }
      }
    }
    for (const [teamId, info] of teamMap) {
      // Only fetch rosters for national teams, not MLB exhibition teams
      if (isMLBTeam(teamId)) continue;
      try {
        const r = await fetch(`${API}/teams/${teamId}/roster?season=${season}`);
        if (!r.ok) continue;
        const d = await r.json();
        for (const p of (d.roster || [])) {
          const id = p.person.id;
          if (seen.has(id)) continue;
          seen.add(id);
          const teamLabel = info.abbreviation || info.teamName;
          const entry = { id, name: p.person.fullName, team: teamLabel, teamId, position: p.position?.abbreviation };
          if (p.position?.type === "Pitcher") pitcherMap.set(id, entry);
          else hitterMap.set(id, entry);
        }
      } catch (e) { /* skip */ }
    }
  } catch (e) { /* failed */ }

  const pitchers = [...pitcherMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  const hitters = [...hitterMap.values()].sort((a, b) => a.name.localeCompare(b.name));
  console.log(`[WBC] ${pitchers.length} pitchers, ${hitters.length} hitters from ${allGamePks.length} games`);
  return { pitchers, hitters };
}

// ── Extract pitches from play-by-play for a specific pitcher ──
export function extractPitcherData(pbp, pitcherId) {
  const pitches = [];
  let ip = 0, hits = 0, runs = 0, ers = 0, ks = 0, bbs = 0, hbps = 0, outs = 0;
  const atBats = [];

  for (const play of (pbp.allPlays || [])) {
    if (play.matchup?.pitcher?.id !== pitcherId) continue;
    const result = play.result;

    // Count line score (atBat plays only)
    if (result?.type === "atBat") {
      atBats.push(play);
      if (result.event === "Strikeout" || result.event === "Strikeout Double Play") ks++;
      if (result.event === "Walk" || result.event === "Intent Walk") bbs++;
      if (result.event === "Hit By Pitch") hbps++;
      if (["Single","Double","Triple","Home Run"].includes(result.event)) hits++;
    }

    // Count outs, runs, ER from ALL play types (handles DP, CS, pickoffs)
    for (const runner of (play.runners || [])) {
      if (runner.movement?.isOut) outs++;
      if (runner.movement?.end === "score") {
        const responsible = runner.details?.responsiblePitcher?.id || play.matchup?.pitcher?.id;
        if (responsible === pitcherId) {
          runs++;
          if (runner.details?.isEarned || runner.details?.earned) ers++;
        }
      }
    }

    let prevBalls = 0, prevStrikes = 0;
    for (const evt of (play.playEvents || [])) {
      if (evt.isPitch && evt.pitchData) {
        const pd = evt.pitchData;
        const br = pd.breaks || {};
        const coords = pd.coordinates || {};
        pitches.push({
          pitchType: evt.details?.type?.code || "UN",
          pitchName: evt.details?.type?.description || "Unknown",
          velo: pd.startSpeed,
          spin: br.spinRate,
          hBreak: br.breakHorizontal,
          vBreak: br.breakVerticalInduced,
          pX: coords.pX,
          pZ: coords.pZ,
          szTop: pd.strikeZoneTop,
          szBot: pd.strikeZoneBottom,
          relHeight: coords.z0,
          extension: pd.extension,
          vY0: coords.vY0, vZ0: coords.vZ0,
          aY: coords.aY, aZ: coords.aZ,
          vaa: null,
          balls: prevBalls,
          strikes: prevStrikes,
          isStrike: evt.details?.isStrike,
          isInPlay: evt.details?.isInPlay,
          isWhiff: ["S","W","T"].includes(evt.details?.call?.code),
          isSwing: ["S","D","E","F","L","M","O","T","W","X"].includes(evt.details?.call?.code),
          callCode: evt.details?.call?.code,
          result: play.result?.event,
          hitData: evt.hitData || null,
          batSide: play.matchup?.batSide?.code || null,
        });
        // Update count for next pitch (evt.count is count AFTER this pitch)
        if (evt.count) {
          prevBalls = evt.count.balls ?? prevBalls;
          prevStrikes = evt.count.strikes ?? prevStrikes;
        }
      }
    }
  }

  // Compute VAA for each pitch — kinematic first, geometric fallback
  for (const p of pitches) {
    if (p.vY0 != null && p.vZ0 != null && p.aY != null && p.aZ != null) {
      // Kinematic VAA (matches old pitch-plots script exactly)
      const dist = 50.0 - 17.0 / 12.0;
      const disc = p.vY0 * p.vY0 - 2.0 * p.aY * dist;
      if (disc >= 0) {
        const t = (-p.vY0 - Math.sqrt(disc)) / p.aY;
        if (t > 0 && t <= 1) {
          const vzPlate = p.vZ0 + p.aZ * t;
          const vyPlate = p.vY0 + p.aY * t;
          p.vaa = Math.round(Math.atan(vzPlate / Math.abs(vyPlate)) * 180 / Math.PI * 10) / 10;
        }
      }
    }
    // Geometric fallback only if kinematic failed
    if (p.vaa == null && p.pZ != null && p.relHeight != null && p.extension != null) {
      const dist = 60.5 - p.extension;
      if (dist > 0) {
        p.vaa = Math.round(Math.atan((p.pZ - p.relHeight) / dist) * (180 / Math.PI) * 10) / 10;
      }
    }
  }

  // IP from outs counted via runners
  ip = Math.floor(outs / 3) + (outs % 3) / 10;
  const hrs = atBats.filter(ab => ab.result?.event === "Home Run").length;
  const bf = atBats.length;

  return { pitches, ip, hits, runs, ers, ks, bbs, hbps, hrs, bf, totalPitches: pitches.length };
}

// ── Extract batter data from play-by-play ──
export function extractBatterData(pbp, batterId) {
  const pitches = [];
  const atBats = [];
  let pas = 0;

  for (const play of (pbp.allPlays || [])) {
    if (play.matchup?.batter?.id !== batterId) continue;
    if (play.result?.type === "atBat") {
      pas++;
      atBats.push(play);
    }

    let prevBalls = 0, prevStrikes = 0;
    for (const evt of (play.playEvents || [])) {
      if (evt.isPitch && evt.pitchData) {
        const pd = evt.pitchData;
        pitches.push({
          pitchType: evt.details?.type?.code || "UN",
          velo: pd.startSpeed,
          pX: pd.coordinates?.pX,
          pZ: pd.coordinates?.pZ,
          szTop: pd.strikeZoneTop,
          szBot: pd.strikeZoneBottom,
          balls: prevBalls,
          strikes: prevStrikes,
          isStrike: evt.details?.isStrike,
          isInPlay: evt.details?.isInPlay,
          isWhiff: ["S","W","T"].includes(evt.details?.call?.code),
          isSwing: ["S","D","E","F","L","M","O","T","W","X"].includes(evt.details?.call?.code),
          callCode: evt.details?.call?.code,
          result: play.result?.event,
          hitData: evt.hitData || null,
        });
        if (evt.count) {
          prevBalls = evt.count.balls ?? prevBalls;
          prevStrikes = evt.count.strikes ?? prevStrikes;
        }
      }
    }
  }

  // Compute batting stats
  const h = atBats.filter(ab => ["Single","Double","Triple","Home Run"].includes(ab.result?.event)).length;
  const ks = atBats.filter(ab => ab.result?.event?.includes("Strikeout")).length;
  const bbs = atBats.filter(ab => ["Walk","Intent Walk"].includes(ab.result?.event)).length;
  const hbps = atBats.filter(ab => ab.result?.event === "Hit By Pitch").length;
  const sfs = atBats.filter(ab => ["Sac Fly","Sacrifice Fly","Sac Fly DP"].includes(ab.result?.event)).length;
  const abs = atBats.filter(ab => !["Walk","Intent Walk","Hit By Pitch","Sacrifice Fly","Sacrifice Bunt","Sac Fly","Sac Bunt","Sac Fly DP","Catcher Interference","Batter Interference"].includes(ab.result?.event)).length;
  const tb = atBats.reduce((s, ab) => {
    const e = ab.result?.event;
    if (e === "Single") return s + 1;
    if (e === "Double") return s + 2;
    if (e === "Triple") return s + 3;
    if (e === "Home Run") return s + 4;
    return s;
  }, 0);

  const obpDenom = abs + bbs + hbps + sfs;
  const obp = obpDenom > 0 ? (h + bbs + hbps) / obpDenom : 0;
  const slg = abs > 0 ? tb / abs : 0;

  // Get batted ball data
  const battedBalls = pitches.filter(p => p.isInPlay && p.hitData);
  const evs = battedBalls.map(b => b.hitData.launchSpeed).filter(v => v != null);
  const avgEV = evs.length > 0 ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
  const maxEV = evs.length > 0 ? Math.max(...evs) : null;

  // xwOBA: only from Savant enrichment (no EV/LA approximation)
  const xwoba = null;

  const totalSwings = pitches.filter(p => p.isSwing).length;
  const whiffs = pitches.filter(p => p.isWhiff).length;
  const chases = pitches.filter(p => p.isSwing && p.pX != null && p.pZ != null && (Math.abs(p.pX) > 0.83 || p.pZ > (p.szTop || 3.5) || p.pZ < (p.szBot || 1.5))).length;
  const outsideTotal = pitches.filter(p => p.pX != null && p.pZ != null && (Math.abs(p.pX) > 0.95 || p.pZ > (p.szTop || 3.5) + 0.1 || p.pZ < (p.szBot || 1.5) - 0.1)).length;

  return {
    pitches, pas,
    obp: Math.round(obp * 1000) / 1000,
    slg: Math.round(slg * 1000) / 1000,
    avgEV: avgEV ? Math.round(avgEV * 10) / 10 : null,
    maxEV: maxEV ? Math.round(maxEV * 10) / 10 : null,
    kPct: pas > 0 ? Math.round(ks / pas * 1000) / 10 : 0,
    bbPct: pas > 0 ? Math.round(bbs / pas * 1000) / 10 : 0,
    chasePct: outsideTotal > 0 ? Math.round(chases / outsideTotal * 1000) / 10 : 0,
    whiffPct: totalSwings > 0 ? Math.round(whiffs / totalSwings * 1000) / 10 : 0,
    xwoba, // null unless enriched by Savant
    atBats,
    battedBalls,
  };
}

// ── Aggregate pitch data by type ──
export function aggregateByPitchType(pitches) {
  const groups = {};
  for (const p of pitches) {
    if (!groups[p.pitchType]) groups[p.pitchType] = [];
    groups[p.pitchType].push(p);
  }

  const total = pitches.length;
  const rows = [];

  for (const [type, group] of Object.entries(groups)) {
    const n = group.length;
    const velos = group.map(p => p.velo).filter(Boolean);
    const spins = group.map(p => p.spin).filter(Boolean);
    const hBrks = group.map(p => p.hBreak).filter(v => v != null);
    const vBrks = group.map(p => p.vBreak).filter(v => v != null);
    const vaas = group.map(p => p.vaa).filter(v => v != null);
    const relHts = group.map(p => p.relHeight).filter(Boolean);
    const exts = group.map(p => p.extension).filter(Boolean);
    const inZone = group.filter(p => p.pX != null && p.pZ != null && Math.abs(p.pX) <= 0.83 && p.pZ <= (p.szTop || 3.5) && p.pZ >= (p.szBot || 1.5));
    const swings = group.filter(p => p.isSwing);
    const whiffs = group.filter(p => p.isWhiff);

    const avg = arr => arr.length > 0 ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

    rows.push({
      type,
      name: PITCH_NAMES[type] || type,
      color: PITCH_COLORS[type] || "#888",
      n,
      usagePct: total > 0 ? Math.round(n / total * 1000) / 10 : 0,
      velo: avg(velos) ? Math.round(avg(velos) * 10) / 10 : null,
      spin: avg(spins) ? Math.round(avg(spins)) : null,
      hBreak: avg(hBrks) != null ? Math.round(avg(hBrks) * 10) / 10 : null,
      vBreak: avg(vBrks) != null ? Math.round(avg(vBrks) * 10) / 10 : null,
      vaa: avg(vaas) != null ? Math.round(avg(vaas) * 10) / 10 : null,
      relHeight: avg(relHts) ? Math.round(avg(relHts) * 100) / 100 : null,
      extension: avg(exts) ? Math.round(avg(exts) * 10) / 10 : null,
      zonePct: n > 0 ? Math.round(inZone.length / n * 1000) / 10 : null,
      whiffPct: swings.length > 0 ? Math.round(whiffs.length / swings.length * 1000) / 10 : null,
    });
  }

  // Sort by usage descending
  rows.sort((a, b) => b.n - a.n);
  return rows;
}


// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// SAVANT BULK xwOBA (aggregated per player for a season)
// ═══════════════════════════════════════════════════════════

export async function fetchSavantBulkXwoba(season, seasonType, playerType = "batter") {
  // Game type codes for Savant statcast_search
  // R = Regular, E = Exhibition (Spring Training), F/D/L/W = Postseason rounds
  const gtMap = {
    S: "E%7C",                    // Spring Training = Exhibition
    R: "R%7C",                    // Regular Season
    P: "F%7CD%7CL%7CW%7C",       // Postseason (all rounds)
  };

  // 1. For RS: try leaderboard first (fast, reliable)
  if (seasonType === "R") {
    try {
      const url = `/savant-api/leaderboard/expected_statistics?type=${playerType}&year=${season}&position=&team=&min=1&csv=true`;
      const r = await fetch(url);
      if (r.ok) {
        const text = await r.text();
        if (text && text.length > 50 && !text.includes("<!DOCTYPE")) {
          const map = parseSavantXwobaCSV(text, playerType);
          if (map.size > 0) {
            console.log(`[Savant xwOBA] Leaderboard: ${map.size} ${playerType}s`);
            return map;
          }
        }
      }
    } catch (e) { /* try next */ }
  }

  // 2. For ST/RS/PS: use statcast_search/csv with game type filter
  if (seasonType !== "W") {
    const gt = gtMap[seasonType] || "R%7C";
    try {
      const url = `/savant-api/statcast_search/csv?all=true&hfSea=${season}%7C&hfGT=${gt}&player_type=${playerType}&group_by=name&min_pitches=0&min_results=0&min_pas=1&sort_col=xwoba&sort_order=desc&chk_stats_xwoba=on&type=detail`;
      console.log(`[Savant xwOBA] Fetching: ${seasonType} ${playerType}s...`);
      const r = await fetch(url);
      if (r.ok) {
        const text = await r.text();
        console.log(`[Savant xwOBA] Response: ${text.length} chars, starts with: ${text.substring(0, 100)}`);
        if (text && text.length > 50 && !text.includes("<!DOCTYPE")) {
          const map = parseSavantXwobaCSV(text, playerType);
          if (map.size > 0) {
            console.log(`[Savant xwOBA] Search: ${map.size} ${playerType}s for ${season} ${seasonType}`);
            return map;
          }
          console.log(`[Savant xwOBA] Parsed 0 players. Headers:`, text.split("\n")[0]?.substring(0, 200));
        }
      }
    } catch (e) {
      console.log(`[Savant xwOBA] Search failed:`, e.message);
    }
  }

  // 3. For WBC: fetch all individual game data and aggregate manually
  if (seasonType === "W") {
    console.log(`[Savant xwOBA] WBC: fetching via individual games...`);
    try {
      const sched = await fetchJson(`${API}/schedule?sportId=51&season=${season}`);
      const gamePks = [];
      for (const date of (sched.dates || [])) {
        for (const g of (date.games || [])) {
          if (g.status?.abstractGameState === "Final" || g.status?.detailedState === "Game Over") {
            gamePks.push(g.gamePk);
          }
        }
      }
      // Fetch Savant data for each WBC game
      const allRows = [];
      for (const gPk of gamePks) {
        try {
          const rows = await fetchSavantGameData(gPk);
          if (rows) allRows.push(...rows);
        } catch (e) { /* skip */ }
      }
      if (allRows.length > 0) {
        // Group by player and compute xwOBA from estimated_woba_using_speedangle
        const playerPAs = new Map(); // pid -> { wobaSum, paCount, hasXwoba }
        const idField = playerType === "pitcher" ? "pitcher" : "batter";
        const WALK_WOBA = 0.696, HBP_WOBA = 0.726;

        // Group by PA
        const paGroups = {};
        for (const row of allRows) {
          const pid = row[idField];
          if (!pid) continue;
          const paKey = `${pid}-${row.game_pk}-${row.inning}-${row.at_bat_number}`;
          if (!paGroups[paKey]) paGroups[paKey] = { pid, rows: [] };
          paGroups[paKey].rows.push(row);
        }

        for (const { pid, rows } of Object.values(paGroups)) {
          const eventRow = rows.find(r => (r.events || "").trim() !== "");
          if (!eventRow) continue;
          if (!playerPAs.has(pid)) playerPAs.set(pid, { wobaSum: 0, paCount: 0, hasXwoba: false });
          const p = playerPAs.get(pid);
          p.paCount++;
          const xw = parseFloat(eventRow.estimated_woba_using_speedangle);
          if (!isNaN(xw) && xw >= 0) {
            p.wobaSum += xw;
            p.hasXwoba = true;
          } else {
            const event = eventRow.events.trim();
            if (event === "walk" || event === "intent_walk") p.wobaSum += WALK_WOBA;
            else if (event === "hit_by_pitch") p.wobaSum += HBP_WOBA;
          }
        }

        const result = new Map();
        for (const [pid, data] of playerPAs) {
          if (data.paCount > 0 && data.hasXwoba) {
            result.set(parseInt(pid), Math.round(data.wobaSum / data.paCount * 1000) / 1000);
          }
        }
        if (result.size > 0) {
          console.log(`[Savant xwOBA] WBC aggregated: ${result.size} ${playerType}s from ${gamePks.length} games`);
          return result;
        }
      }
    } catch (e) {
      console.log(`[Savant xwOBA] WBC failed:`, e.message);
    }
  }

  console.log(`[Savant xwOBA] No data for ${season} ${seasonType} ${playerType}`);
  return null;
}

function parseSavantXwobaCSV(text, playerType = "batter") {
  const result = new Map();
  const rows = parseCSV(text);
  if (!rows.length) return result;

  // Check if this is aggregated (has xwoba column) or raw pitch data
  if (rows[0].xwoba != null && rows[0].xwoba !== "") {
    // Aggregated format
    for (const row of rows) {
      const pid = parseInt(row.player_id || row.batter || row.pitcher);
      const xwoba = parseFloat(row.xwoba);
      if (!isNaN(pid) && !isNaN(xwoba) && xwoba > 0 && xwoba < 1) {
        result.set(pid, xwoba);
      }
    }
    return result;
  }

  // Raw pitch data — aggregate manually
  const idField = playerType === "pitcher" ? "pitcher" : "batter";
  const WALK_WOBA = 0.696, HBP_WOBA = 0.726;

  // Debug: check what columns and values we have
  if (rows.length > 0) {
    const sample = rows[0];
    const hasEvents = rows.filter(r => (r.events || "").trim() !== "").length;
    const hasXw = rows.filter(r => { const v = parseFloat(r.estimated_woba_using_speedangle); return !isNaN(v) && v > 0; }).length;
    console.log(`[Savant xwOBA] Raw data: ${rows.length} rows, ${hasEvents} with events, ${hasXw} with xwoba`);
    console.log(`[Savant xwOBA] idField="${idField}", sample ${idField}="${sample[idField]}", events="${sample.events}", xwoba="${sample.estimated_woba_using_speedangle}"`);
    console.log(`[Savant xwOBA] All columns:`, Object.keys(sample).join(", "));
  }

  // Group by PA (player + game + inning + at_bat_number)
  const paGroups = {};
  for (const row of rows) {
    const pid = row[idField];
    if (!pid) continue;
    const paKey = `${pid}-${row.game_pk}-${row.inning}-${row.at_bat_number}`;
    if (!paGroups[paKey]) paGroups[paKey] = { pid, rows: [] };
    paGroups[paKey].rows.push(row);
  }

  // Compute xwOBA per player
  const playerPAs = new Map();
  for (const { pid, rows: paRows } of Object.values(paGroups)) {
    const eventRow = paRows.find(r => (r.events || "").trim() !== "");
    if (!eventRow) continue;

    if (!playerPAs.has(pid)) playerPAs.set(pid, { wobaSum: 0, paCount: 0, hasXwoba: false });
    const p = playerPAs.get(pid);
    p.paCount++;

    // Try estimated xwOBA first
    const xw = parseFloat(eventRow.estimated_woba_using_speedangle);
    if (!isNaN(xw) && xw >= 0) {
      p.wobaSum += xw;
      p.hasXwoba = true;
    } else {
      const event = (eventRow.events || "").trim();
      if (event === "walk" || event === "intent_walk") p.wobaSum += WALK_WOBA;
      else if (event === "hit_by_pitch") p.wobaSum += HBP_WOBA;
    }
  }

  for (const [pid, data] of playerPAs) {
    if (data.paCount > 0 && data.hasXwoba) {
      result.set(parseInt(pid), Math.round(data.wobaSum / data.paCount * 1000) / 1000);
    }
  }

  console.log(`[Savant xwOBA] Aggregated ${rows.length} pitches → ${result.size} players`);
  return result;
}

// SAVANT GAME DATA (xwOBA + kinematic VAA)
// ═══════════════════════════════════════════════════════════

export async function fetchSavantGameData(gamePk) {
  const url = `/savant-api/statcast_search/csv?all=true&type=detail&game_pk=${gamePk}`;
  const r = await fetch(url);
  if (!r.ok) return null;
  const text = await r.text();
  if (!text || text.length < 50) return null;

  const rows = parseCSV(text);
  return rows;
}

function parseCSV(text) {
  const lines = text.trim().split("\n");
  if (lines.length < 2) return [];
  const headers = lines[0].split(",").map(h => h.trim().replace(/"/g, ""));
  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const vals = splitCSVLine(lines[i]);
    if (vals.length !== headers.length) continue;
    const obj = {};
    for (let j = 0; j < headers.length; j++) {
      obj[headers[j]] = vals[j]?.replace(/"/g, "").trim() || "";
    }
    rows.push(obj);
  }
  return rows;
}

function splitCSVLine(line) {
  const result = [];
  let current = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (ch === "," && !inQuotes) { result.push(current); current = ""; continue; }
    current += ch;
  }
  result.push(current);
  return result;
}

// Compute kinematic VAA from Savant pitch data (matches old pitch-plots script)
function computeKinematicVAA(row) {
  const vy0 = parseFloat(row.vy0);
  const vz0 = parseFloat(row.vz0);
  const ay = parseFloat(row.ay);
  const az = parseFloat(row.az);

  if ([vy0, vz0, ay, az].some(v => isNaN(v))) return null;

  const dist = 50.0 - 17.0 / 12.0;
  const disc = vy0 * vy0 - 2.0 * ay * dist;
  if (disc < 0) return null;
  const t = (-vy0 - Math.sqrt(disc)) / ay;
  if (t <= 0 || t > 1) return null;

  const vzPlate = vz0 + az * t;
  const vyPlate = vy0 + ay * t;
  return Math.round(Math.atan(vzPlate / Math.abs(vyPlate)) * 180 / Math.PI * 10) / 10;
}

// Enrich pitcher/batter extracted data with Savant xwOBA and VAA
export function enrichWithSavant(savantRows, playerId, type = "pitcher") {
  if (!savantRows || !savantRows.length) return { xwoba: null, pitchVAAs: {} };

  const idField = type === "pitcher" ? "pitcher" : "batter";
  const playerRows = savantRows.filter(r => r[idField] === String(playerId));

  if (!playerRows.length) return { xwoba: null, pitchVAAs: {} };

  // Group all rows by PA (game_pk + inning + at_bat_number)
  const paGroups = {};
  for (const row of playerRows) {
    const paKey = `${row.game_pk}-${row.inning}-${row.at_bat_number}`;
    if (!paGroups[paKey]) paGroups[paKey] = [];
    paGroups[paKey].push(row);
  }

  // xwOBA: for each PA, find the event-ending row
  const WALK_WOBA = 0.696;
  const HBP_WOBA = 0.726;
  let wobaSum = 0;
  let paCount = 0;
  let hasAnyXwoba = false;

  for (const [paKey, rows] of Object.entries(paGroups)) {
    // Find the row with the event (PA-ending pitch)
    const eventRow = rows.find(r => (r.events || "").trim() !== "");
    if (!eventRow) continue;

    const event = eventRow.events.trim();
    paCount++;

    const xw = parseFloat(eventRow.estimated_woba_using_speedangle);
    if (!isNaN(xw) && xw >= 0) {
      wobaSum += xw;
      hasAnyXwoba = true;
    } else if (event === "walk" || event === "intent_walk") {
      wobaSum += WALK_WOBA;
    } else if (event === "hit_by_pitch") {
      wobaSum += HBP_WOBA;
    }
    // strikeouts, non-batted-ball outs without xwOBA = 0
  }

  // Only show xwOBA if Savant actually provided xwOBA values for at least some batted balls
  const xwoba = (paCount > 0 && hasAnyXwoba)
    ? Math.round(wobaSum / paCount * 1000) / 1000
    : null;

  // VAA per pitch type (kinematic) — use ALL pitches, not just events
  const vaaByType = {};
  for (const row of playerRows) {
    const pt = row.pitch_type;
    if (!pt) continue;
    const vaa = computeKinematicVAA(row);
    if (vaa != null) {
      if (!vaaByType[pt]) vaaByType[pt] = [];
      vaaByType[pt].push(vaa);
    }
  }

  const pitchVAAs = {};
  for (const [pt, vals] of Object.entries(vaaByType)) {
    pitchVAAs[pt] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 10) / 10;
  }

  return { xwoba, pitchVAAs };
}

