// MLB Stats API helper functions
// All requests go through Vite proxy: /mlb-api → https://statsapi.mlb.com

const API = "/mlb-api/api/v1";

// ── Pitch type colors matching R app ──
export const PITCH_COLORS = {
  FF: "#E84855", SI: "#F4A259", FC: "#E8956A", SL: "#FFD166",
  CU: "#06D6A0", CH: "#57CC99", FS: "#E07BE0", ST: "#E8956A",
  KC: "#118AB2", CS: "#7B68EE", SV: "#FFD166", KN: "#999",
};
export const PITCH_NAMES = {
  FF: "4-Seam", SI: "Sinker", FC: "Cutter", SL: "Slider",
  CU: "Curveball", CH: "Changeup", FS: "Splitter", ST: "Sweeper",
  KC: "Knuckle Curve", CS: "Slow Curve", SV: "Slurve", KN: "Knuckleball",
};

// ── Hit result colors ──
export const HIT_COLORS = {
  home_run: "#E84855", triple: "#F4A259", double: "#FFD166",
  single: "#57CC99", out: "#888",
};

// ── Game type codes ──
export const GAME_TYPES = {
  spring: "S", regular: "R", postseason: "P",
};
export const GAME_TYPE_LABELS = {
  spring: "Spring Training", regular: "Regular Season", postseason: "Postseason",
};

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
export async function fetchSchedule(season, gameType = "S") {
  let startDate, endDate;
  if (gameType === "S") {
    startDate = `${season}-02-20`;
    endDate = `${season}-03-28`;
  } else if (gameType === "R") {
    startDate = `${season}-03-20`;
    endDate = `${season}-11-05`;
  } else {
    startDate = `${season}-10-01`;
    endDate = `${season}-11-15`;
  }
  const d = await fetchJson(
    `${API}/schedule?sportId=1&gameType=${gameType}&startDate=${startDate}&endDate=${endDate}&hydrate=team,probablePitcher`
  );
  const games = [];
  for (const date of (d.dates || [])) {
    for (const g of date.games) {
      games.push({
        gamePk: g.gamePk,
        date: date.date,
        status: g.status?.detailedState,
        away: g.teams?.away?.team,
        home: g.teams?.home?.team,
        awayScore: g.teams?.away?.score,
        homeScore: g.teams?.home?.score,
      });
    }
  }
  return games;
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
    `${API}/people/${playerId}/stats?stats=gameLog&group=${group}&season=${season}&gameType=S,R,P`
  );
  return d.stats?.[0]?.splits || [];
}

// ── Get all roster players for a season ──
export async function fetchAllPlayers(season) {
  const teams = await fetchJson(`${API}/teams?sportId=1`);
  const players = { pitchers: [], hitters: [] };
  const seen = new Set();

  for (const team of teams.teams) {
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

// ── Extract pitches from play-by-play for a specific pitcher ──
export function extractPitcherData(pbp, pitcherId) {
  const pitches = [];
  let ip = 0, hits = 0, runs = 0, ers = 0, ks = 0, bbs = 0;
  const atBats = [];

  for (const play of (pbp.allPlays || [])) {
    if (play.matchup?.pitcher?.id !== pitcherId) continue;
    const result = play.result;

    // Count line score
    if (result?.type === "atBat") {
      atBats.push(play);
      if (result.event === "Strikeout" || result.event === "Strikeout Double Play") ks++;
      if (result.event === "Walk" || result.event === "Intent Walk") bbs++;
      if (result.event === "Hit By Pitch") bbs++;
      if (["Single","Double","Triple","Home Run"].includes(result.event)) hits++;
      runs += result.rbi || 0; // approximate
    }

    for (const evt of (play.playEvents || [])) {
      if (evt.isPitch && evt.pitchData) {
        const pd = evt.pitchData;
        const br = pd.breaks || {};
        pitches.push({
          pitchType: evt.details?.type?.code || "UN",
          pitchName: evt.details?.type?.description || "Unknown",
          velo: pd.startSpeed,
          spin: br.spinRate,
          hBreak: br.breakHorizontal,
          vBreak: br.breakVerticalInduced,
          pX: pd.coordinates?.pX,
          pZ: pd.coordinates?.pZ,
          szTop: pd.strikeZoneTop,
          szBot: pd.strikeZoneBottom,
          relHeight: pd.coordinates?.y0,
          extension: pd.extension,
          vaa: null, // computed below
          isStrike: evt.details?.isStrike,
          isInPlay: evt.details?.isInPlay,
          isWhiff: evt.details?.call?.code === "S" && evt.details?.description?.includes("Swinging"),
          isSwing: ["S","D","E","F","L","M","O","T","W","X"].includes(evt.details?.call?.code),
          callCode: evt.details?.call?.code,
          result: play.result?.event,
          hitData: evt.hitData || null,
        });
      }
    }
  }

  // Compute VAA for each pitch
  for (const p of pitches) {
    if (p.pZ != null && p.relHeight != null && p.extension != null) {
      const dist = 60.5 - p.extension;
      if (dist > 0) {
        p.vaa = Math.atan((p.pZ - p.relHeight) / dist) * (180 / Math.PI);
      }
    }
  }

  // Compute IP from outs
  const outs = atBats.reduce((sum, ab) => sum + (ab.result?.isOut ? 1 : 0), 0);
  ip = Math.floor(outs / 3) + (outs % 3) / 10;

  return { pitches, ip, hits, runs, ers, ks, bbs, totalPitches: pitches.length };
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
          isStrike: evt.details?.isStrike,
          isInPlay: evt.details?.isInPlay,
          isWhiff: evt.details?.call?.code === "S" && evt.details?.description?.includes("Swinging"),
          isSwing: ["S","D","E","F","L","M","O","T","W","X"].includes(evt.details?.call?.code),
          callCode: evt.details?.call?.code,
          result: play.result?.event,
          hitData: evt.hitData || null,
        });
      }
    }
  }

  // Compute batting stats
  const h = atBats.filter(ab => ["Single","Double","Triple","Home Run"].includes(ab.result?.event)).length;
  const abs = atBats.filter(ab => !["Walk","Intent Walk","Hit By Pitch","Sacrifice Fly","Sacrifice Bunt","Catcher Interference"].includes(ab.result?.event)).length;
  const tb = atBats.reduce((s, ab) => {
    const e = ab.result?.event;
    if (e === "Single") return s + 1;
    if (e === "Double") return s + 2;
    if (e === "Triple") return s + 3;
    if (e === "Home Run") return s + 4;
    return s;
  }, 0);

  const obp = pas > 0 ? (h + atBats.filter(ab => ["Walk","Intent Walk","Hit By Pitch"].includes(ab.result?.event)).length) / pas : 0;
  const slg = abs > 0 ? tb / abs : 0;
  const ks = atBats.filter(ab => ab.result?.event?.includes("Strikeout")).length;
  const bbs = atBats.filter(ab => ["Walk","Intent Walk"].includes(ab.result?.event)).length;

  // Get batted ball data
  const battedBalls = pitches.filter(p => p.isInPlay && p.hitData);
  const evs = battedBalls.map(b => b.hitData.launchSpeed).filter(v => v != null);
  const avgEV = evs.length > 0 ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
  const maxEV = evs.length > 0 ? Math.max(...evs) : null;

  // xwOBA approximation (use hitData if available, else null)
  const totalSwings = pitches.filter(p => p.isSwing).length;
  const whiffs = pitches.filter(p => p.isWhiff).length;
  const chases = pitches.filter(p => p.isSwing && p.pX != null && p.pZ != null && (Math.abs(p.pX) > 0.83 || p.pZ > p.szTop || p.pZ < p.szBot)).length;
  const outsideTotal = pitches.filter(p => p.pX != null && p.pZ != null && (Math.abs(p.pX) > 0.83 || p.pZ > p.szTop || p.pZ < p.szBot)).length;

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
    xwoba: null, // Would need Savant data
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
    const inZone = group.filter(p => p.pX != null && p.pZ != null && Math.abs(p.pX) <= 0.83 && p.pZ <= p.szTop && p.pZ >= p.szBot);
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
