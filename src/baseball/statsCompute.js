import { useState, useEffect } from "react";
import { fetchGameLog, fetchSavantPlayerDateRange } from "./mlbApi.js";

const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

// ── Label aliases: card labels → compute keys (mirrors RollingChart) ──
const LABEL_ALIASES = {
  "Barrel %": "Barrel%",
  "Avg Exit Velocity": "Avg Exit Velo",
  "Whiff %": "Whiff%",
  "Chase %": "Chase%",
};
const canon = (label) => LABEL_ALIASES[label] || label;

function safe(n, d) { return d > 0 ? n / d : 0; }
function num(v) { const n = parseFloat(v); return Number.isFinite(n) ? n : null; }
function parseIP(s) {
  if (s == null) return 0;
  const [whole, frac] = String(s).split(".");
  return (parseInt(whole, 10) || 0) + (parseInt(frac, 10) || 0) / 3;
}
function percentile(arr, p) {
  if (!arr || !arr.length) return 0;
  const sorted = [...arr].sort((a, b) => a - b);
  const idx = (sorted.length - 1) * p;
  const lo = Math.floor(idx), hi = Math.ceil(idx);
  return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo);
}

// ── Savant per-pitch → per-game counters ──
function aggregateSavantToGames(rows) {
  // Competitive-swing threshold: drop each batter's slowest ~10% of swings
  // (mirrors iswing_update.py). Bat-tracking metrics — Avg Bat Speed, Fast
  // Swing%, Avg Swing Length — are computed over competitive swings only, so the
  // date-range values line up with Savant's published, competitive-only season
  // numbers (and the iSwing+ swing set the server already filters the same way).
  const SWING_DESCS = new Set([
    "swinging_strike", "swinging_strike_blocked", "foul", "foul_tip",
    "hit_into_play", "foul_bunt", "missed_bunt",
  ]);
  const _batSpeeds = [];
  for (const r of rows) {
    if (!SWING_DESCS.has((r.description || "").toLowerCase())) continue;
    const bs = num(r.bat_speed);
    if (bs != null) _batSpeeds.push(bs);
  }
  const batSpeedP10 = _batSpeeds.length ? percentile(_batSpeeds, 0.10) : 0;

  const out = {};
  for (const r of rows) {
    const date = r.game_date;
    if (!date) continue;
    if (!out[date]) {
      out[date] = {
        date,
        PA_sav: 0, AB_sav: 0,
        xwoba_num: 0, xwoba_den: 0,
        xba_num: 0, xba_den: 0,
        xslg_num: 0, xslg_den: 0,
        xwoba_con_num: 0, xwoba_con_den: 0,
        bbe: 0, barrels: 0, hard_hits: 0,
        sum_ev: 0, sum_la: 0, ev_arr: [],
        sweet_spots: 0,
        pitches: 0, swings: 0, whiffs: 0,
        oz_pitches: 0, oz_swings: 0,
        iz_swings: 0, iz_whiffs: 0,
        bs_n: 0, sum_bs: 0, fast_swings: 0,
        sl_n: 0, sum_sl: 0,
        aa_n: 0, sum_aa: 0,
        ff_n: 0, sum_ff_velo: 0,
      };
    }
    const g = out[date];

    g.pitches += 1;
    const zone = num(r.zone);
    const inZone = zone != null && zone >= 1 && zone <= 9;
    const ozPitch = zone != null && zone >= 10;
    if (ozPitch) g.oz_pitches += 1;

    const desc = (r.description || "").toLowerCase();
    const isSwing =
      desc === "swinging_strike" || desc === "swinging_strike_blocked" ||
      desc === "foul" || desc === "foul_tip" || desc === "hit_into_play" ||
      desc === "foul_bunt" || desc === "missed_bunt";
    const isWhiff = desc === "swinging_strike" || desc === "swinging_strike_blocked" || desc === "missed_bunt";
    if (isSwing) {
      g.swings += 1;
      if (ozPitch) g.oz_swings += 1;
      if (inZone) g.iz_swings += 1;
    }
    if (isWhiff) {
      g.whiffs += 1;
      if (inZone) g.iz_whiffs += 1;
    }

    // Bat tracking over competitive swings only: bat speed at/above the batter's
    // 10th-percentile threshold, with a hard-hit safety net (matches the
    // definition used to build competitive_swings_*.csv and the iSwing+ norms).
    const bs = num(r.bat_speed);
    const ls = num(r.launch_speed);
    const isCompetitive = isSwing && desc !== "foul_bunt" && desc !== "missed_bunt"
      && bs != null && (bs >= batSpeedP10 || (bs >= 60 && ls != null && ls >= 90));
    if (isCompetitive) {
      g.sum_bs += bs; g.bs_n += 1; if (bs >= 75) g.fast_swings += 1;
      const sl = num(r.swing_length);
      if (sl != null) { g.sum_sl += sl; g.sl_n += 1; }
      const aa = num(r.attack_angle);
      if (aa != null) { g.sum_aa += aa; g.aa_n += 1; }
    }

    if ((r.pitch_type || "").toUpperCase() === "FF") {
      const v = num(r.release_speed);
      if (v != null) { g.sum_ff_velo += v; g.ff_n += 1; }
    }

    if (desc === "hit_into_play") {
      g.bbe += 1;
      const ev = num(r.launch_speed);
      const la = num(r.launch_angle);
      if (ev != null) { g.sum_ev += ev; if (ev >= 95) g.hard_hits += 1; if (!g.ev_arr) g.ev_arr = []; g.ev_arr.push(ev); }
      if (la != null) { g.sum_la += la; if (la >= 8 && la <= 32) g.sweet_spots += 1; }
      const lsa = num(r.launch_speed_angle);
      if (lsa === 6) g.barrels += 1;
      const xwc = num(r.estimated_woba_using_speedangle);
      if (xwc != null) { g.xwoba_con_num += xwc; g.xwoba_con_den += 1; }
    }

    const wDen = num(r.woba_denom);
    if (wDen && wDen > 0) {
      g.PA_sav += 1;
      const events = (r.events || "").toLowerCase();
      const nonAb = events === "walk" || events === "hit_by_pitch" || events === "sac_fly" ||
                    events === "sac_bunt" || events === "intent_walk" || events === "catcher_interf";
      if (!nonAb) {
        g.AB_sav += 1;
        g.xba_den += 1; g.xslg_den += 1;
        if (desc === "hit_into_play") {
          const xba  = num(r.estimated_ba_using_speedangle);
          const xslg = num(r.estimated_slg_using_speedangle);
          if (xba  != null) g.xba_num  += xba;
          if (xslg != null) g.xslg_num += xslg;
        }
      }
      let contrib = desc === "hit_into_play" ? num(r.estimated_woba_using_speedangle) : null;
      if (contrib == null) contrib = num(r.woba_value) ?? 0;
      g.xwoba_num += contrib;
      g.xwoba_den += wDen;
    }
  }
  return out;
}

// ── Compute definitions (self-contained copy, no import from RollingChart) ──
const FIP_C = 3.15;

const STATCAST_COMPUTE = {
  "xwOBA":     { compute: w => safe(w.xwoba_num, w.xwoba_den) },
  "xBA":       { compute: w => safe(w.xba_num, w.xba_den) },
  "xSLG":      { compute: w => safe(w.xslg_num, w.xslg_den) },
  "xwOBACON":  { compute: w => safe(w.xwoba_con_num, w.xwoba_con_den) },
  "Barrel%":   { compute: w => safe(w.barrels, w.bbe) * 100 },
  "Hard Hit%": { compute: w => safe(w.hard_hits, w.bbe) * 100 },
  "Avg Exit Velo":    { compute: w => safe(w.sum_ev, w.bbe) },
  "90th % EV":        { compute: w => percentile(w.ev_arr || [], 0.9) },
  "Avg Launch Angle": { compute: w => safe(w.sum_la, w.bbe) },
  "Whiff%":    { compute: w => safe(w.whiffs, w.swings) * 100 },
  "Z-Contact%":{ compute: w => (1 - safe(w.iz_whiffs, w.iz_swings)) * 100 },
  "Chase%":    { compute: w => safe(w.oz_swings, w.oz_pitches) * 100 },
  "Avg Bat Speed":    { compute: w => safe(w.sum_bs, w.bs_n) },
  "Fast Swing %":     { compute: w => safe(w.fast_swings, w.bs_n) * 100 },
  "Avg Swing Length": { compute: w => safe(w.sum_sl, w.sl_n) },
  "Avg. Attack Angle":{ compute: w => safe(w.sum_aa, w.aa_n) },
  "Avg FB Velo":      { compute: w => safe(w.sum_ff_velo, w.ff_n) },
  "LA+SwtSpt%":       { compute: w => safe(w.sweet_spots, w.bbe) * 100 },
};

const HITTER_COMPUTE = {
  "BB%": { compute: w => safe(w.BB, w.PA) * 100 },
  "K%":  { compute: w => safe(w.K,  w.PA) * 100 },
  ...STATCAST_COMPUTE,
};

const PITCHER_COMPUTE = {
  "FIP":   { compute: w => w.IP > 0 ? (13*w.HR + 3*(w.BB + w.HBP) - 2*w.K)/w.IP + FIP_C : 0 },
  "K%":    { compute: w => safe(w.K,  w.BF) * 100 },
  "BB%":   { compute: w => safe(w.BB, w.BF) * 100 },
  "K-BB%": { compute: w => (safe(w.K, w.BF) - safe(w.BB, w.BF)) * 100 },
  "GB%":   { compute: w => safe(w.GO, w.GO + w.AO) * 100 },
  ...STATCAST_COMPUTE,
};

const STATCAST_KEYS = [
  "xwoba_num", "xwoba_den", "xba_num", "xba_den", "xslg_num", "xslg_den",
  "xwoba_con_num", "xwoba_con_den",
  "bbe", "barrels", "hard_hits", "sum_ev", "sum_la", "ev_arr",
  "sweet_spots",
  "pitches", "swings", "whiffs", "oz_pitches", "oz_swings",
  "iz_swings", "iz_whiffs",
  "bs_n", "sum_bs", "fast_swings", "sl_n", "sum_sl", "aa_n", "sum_aa",
  "ff_n", "sum_ff_velo",
];
const HITTER_KEYS  = ["PA", "AB", "H", "BB", "HBP", "SF", "TB", "K", "d2", "d3", "HR", ...STATCAST_KEYS];
const PITCHER_KEYS = ["IP", "BF", "H", "BB", "HBP", "K", "HR", "ER", "GO", "AO", ...STATCAST_KEYS];

// Game log split → row object
function gameRowHitter(g) {
  const s = g.stat || {};
  return {
    date: ((g.date || g.gameDate) || "").slice(0, 10),
    PA:  Number(s.plateAppearances) || 0,
    AB:  Number(s.atBats)           || 0,
    H:   Number(s.hits)             || 0,
    BB:  Number(s.baseOnBalls)      || 0,
    HBP: Number(s.hitByPitch)       || 0,
    SF:  Number(s.sacFlies)         || 0,
    TB:  Number(s.totalBases)       || 0,
    K:   Number(s.strikeOuts)       || 0,
    d2:  Number(s.doubles)          || 0,
    d3:  Number(s.triples)          || 0,
    HR:  Number(s.homeRuns)         || 0,
  };
}

function gameRowPitcher(g) {
  const s = g.stat || {};
  return {
    date: ((g.date || g.gameDate) || "").slice(0, 10),
    IP:  parseIP(s.inningsPitched),
    BF:  Number(s.battersFaced) || 0,
    H:   Number(s.hits)         || 0,
    BB:  Number(s.baseOnBalls)  || 0,
    HBP: Number(s.hitByPitch)   || 0,
    K:   Number(s.strikeOuts)   || 0,
    HR:  Number(s.homeRuns)     || 0,
    ER:  Number(s.earnedRuns)   || 0,
    GO:  Number(s.groundOuts)   || 0,
    AO:  Number(s.airOuts)      || 0,
  };
}

// ── Public: aggregate game log + Savant rows into raw stats ──
export function computeStatsFromRows(gameLogSplits, savantRows, type) {
  const computeMap = type === "pitcher" ? PITCHER_COMPUTE : HITTER_COMPUTE;
  const keys = type === "pitcher" ? PITCHER_KEYS : HITTER_KEYS;
  const rowFor = type === "pitcher" ? gameRowPitcher : gameRowHitter;

  const savByDate = aggregateSavantToGames(savantRows || []);
  const acc = { ev_arr: [] };

  // Iterate the (already date-filtered) game log and merge in Savant data only
  // for dates that have an in-range game. This keeps Savant metrics bounded to
  // the requested window even when the Savant CSV returns extra dates.
  for (const g of (gameLogSplits || [])) {
    const row = rowFor(g);
    if (!row.date) continue;
    const sav = savByDate[row.date];
    const merged = sav ? { ...row, ...sav } : row;
    for (const k of keys) {
      if (k === "ev_arr") {
        const v = merged[k];
        if (Array.isArray(v)) acc.ev_arr = acc.ev_arr.concat(v);
        // no-op when missing — keeps ev_arr a clean array (avoids [] + 0 coercion)
      } else {
        acc[k] = (acc[k] || 0) + (Number(merged[k]) || 0);
      }
    }
  }

  const stats = {};
  for (const [label, def] of Object.entries(computeMap)) {
    try { stats[label] = def.compute(acc); } catch { stats[label] = null; }
  }

  return { stats, pa: acc.PA || 0, ip: acc.IP || 0 };
}

// ── Percentile ranking utilities ──

export function buildPctileLookup(allPlayers, label) {
  const points = [];
  for (const p of (allPlayers || [])) {
    const cat = (p.categories || {})[label];
    if (!cat || cat.pctile == null) continue;
    const raw = parseFloat(String(cat.display || "").replace(/%$/, "").trim());
    if (!isNaN(raw)) points.push([raw, cat.pctile]);
  }
  points.sort((a, b) => a[0] - b[0]);
  return points;
}

export function interpolatePctile(lookup, value) {
  if (!lookup || !lookup.length || value == null || isNaN(value)) return null;
  if (value <= lookup[0][0]) return lookup[0][1];
  if (value >= lookup[lookup.length - 1][0]) return lookup[lookup.length - 1][1];
  let lo = 0, hi = lookup.length - 1;
  while (lo < hi - 1) {
    const mid = (lo + hi) >> 1;
    if (lookup[mid][0] <= value) lo = mid; else hi = mid;
  }
  const [x0, y0] = lookup[lo];
  const [x1, y1] = lookup[hi];
  if (x1 === x0) return (y0 + y1) / 2;
  return y0 + (y1 - y0) * (value - x0) / (x1 - x0);
}

// ── Format a raw value to match the exemplar display string's format ──
export function fmtLike(value, exemplar) {
  const n = typeof value === "number" ? value : Number(value);
  if (!isFinite(n)) return "—";
  const ex = String(exemplar || "");
  if (ex === "—" || !ex) return String(Math.round(n));
  const clean = ex.replace(/%$/, "").trim();
  const parts = clean.split(".");
  if (parts.length === 2) return n.toFixed(parts[1].length);
  return String(Math.round(n));
}

// ── useDateRangeStats hook ──
export function useDateRangeStats(player, season, type, dateFrom, dateTo, allPlayers) {
  const [result, setResult] = useState({ categories: null, loading: false });

  useEffect(() => {
    const id = player?.player_id;
    const isActive = !!(dateFrom || dateTo);

    if (!id || !isActive || !player?.categories) {
      setResult({ categories: null, loading: false });
      return;
    }

    let cancelled = false;
    setResult({ categories: null, loading: true });

    const group = type === "pitcher" ? "pitching" : "hitting";
    const savantType = type === "pitcher" ? "pitcher" : "batter";

    (async () => {
      try {
        const serverUrl =
          `${PITCH_PLUS_API}/player_stats/${id}?season=${season}&group=${group}` +
          (dateFrom ? `&start=${dateFrom}` : "") +
          (dateTo ? `&end=${dateTo}` : "");

        const [gameLogRaw, savantRows, serverData] = await Promise.all([
          fetchGameLog(id, season, group, 1, "R").catch(() => []),
          fetchSavantPlayerDateRange(id, season, savantType, dateFrom, dateTo).catch(() => []),
          fetch(serverUrl).then(r => r.ok ? r.json() : null).catch(() => null),
        ]);

        if (cancelled) return;

        // Filter game log to date range
        const gameLog = gameLogRaw.filter(g => {
          const d = ((g.date || g.gameDate) || "").slice(0, 10);
          if (!d) return false;
          if (dateFrom && d < dateFrom) return false;
          if (dateTo && d > dateTo) return false;
          return true;
        });

        const { stats: computedStats, pa, ip } = computeStatsFromRows(gameLog, savantRows, type);

        // Merge server stats (server wins on overlap for server-only metrics)
        const mergedStats = { ...computedStats };
        if (serverData?.stats) {
          for (const [k, v] of Object.entries(serverData.stats)) {
            if (v != null) mergedStats[k] = v;
          }
        }

        // Build categories from merged stats
        const categories = {};
        for (const [label, origCat] of Object.entries(player.categories)) {
          const key = canon(label);
          const rawValue = mergedStats[key] ?? mergedStats[label];
          if (rawValue == null || isNaN(rawValue)) {
            categories[label] = { display: "—", pctile: null };
            continue;
          }
          const lookup = buildPctileLookup(allPlayers, label);
          const pctile = interpolatePctile(lookup, rawValue);
          const display = fmtLike(rawValue, origCat.display);
          categories[label] = { display, pctile };
        }
        // Store PA/IP for subtitle
        categories._pa = serverData?.pa ?? pa;
        categories._ip = serverData?.ip ?? ip;

        if (!cancelled) setResult({ categories, loading: false });
      } catch {
        if (!cancelled) setResult({ categories: null, loading: false });
      }
    })();

    return () => { cancelled = true; };
  }, [player?.player_id, season, type, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  return result;
}
