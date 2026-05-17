import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip } from "recharts";
import { useTheme } from "./ThemeContext.jsx";
import { fetchGameLog, fetchSavantPlayerSeason } from "./mlbApi.js";
import { saveCardAsPng } from "./SharedComponents.jsx";

// ── Statcast counter aggregation ───────────────────────────────────────────
// Aggregate per-pitch Savant rows into per-game counters that can be summed
// in a sliding window. Returns { [gameDate]: { ...counters } }.
function aggregateSavantToGames(rows) {
  const out = {};
  for (const r of rows) {
    const date = r.game_date;
    if (!date) continue;
    if (!out[date]) {
      out[date] = {
        date,
        // PA-level
        PA_sav: 0, AB_sav: 0,
        xwoba_num: 0, xwoba_den: 0,
        xba_num: 0, xba_den: 0,
        xslg_num: 0, xslg_den: 0,
        xwoba_con_num: 0, xwoba_con_den: 0,
        bbe: 0, barrels: 0, hard_hits: 0,
        sum_ev: 0, sum_la: 0,
        // Pitch-level
        pitches: 0, swings: 0, whiffs: 0,
        oz_pitches: 0, oz_swings: 0,
        iz_swings: 0, iz_whiffs: 0,
        // Bat tracking
        bs_n: 0, sum_bs: 0, fast_swings: 0,
        sl_n: 0, sum_sl: 0,
        aa_n: 0, sum_aa: 0,
        // Pitcher-specific
        ff_n: 0, sum_ff_velo: 0,
      };
    }
    const g = out[date];
    const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

    // Pitch-level counters
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
    const isWhiff =
      desc === "swinging_strike" || desc === "swinging_strike_blocked" ||
      desc === "missed_bunt";
    if (isSwing) {
      g.swings += 1;
      if (ozPitch) g.oz_swings += 1;
      if (inZone) g.iz_swings += 1;
    }
    if (isWhiff) {
      g.whiffs += 1;
      if (inZone) g.iz_whiffs += 1;
    }

    // Bat tracking — competitive swings only (excludes bunts and any
    // checked / non-competitive swing as recorded by Savant).
    const isCompetitiveSwing = isSwing && desc !== "foul_bunt" && desc !== "missed_bunt";
    if (isCompetitiveSwing) {
      const bs = num(r.bat_speed);
      if (bs != null) { g.sum_bs += bs; g.bs_n += 1; if (bs >= 75) g.fast_swings += 1; }
      const sl = num(r.swing_length);
      if (sl != null) { g.sum_sl += sl; g.sl_n += 1; }
      const aa = num(r.attack_angle);
      if (aa != null) { g.sum_aa += aa; g.aa_n += 1; }
    }

    // Pitcher-specific FF velo
    if ((r.pitch_type || "").toUpperCase() === "FF") {
      const v = num(r.release_speed);
      if (v != null) { g.sum_ff_velo += v; g.ff_n += 1; }
    }

    // Batted-ball metrics (terminal BIP) — counted on the BIP itself,
    // not on the AB. xBA/xSLG denominators are filled in the PA block
    // below so strikeouts contribute 0 to the numerator and 1 to the AB.
    if (desc === "hit_into_play") {
      g.bbe += 1;
      const ev = num(r.launch_speed);
      const la = num(r.launch_angle);
      if (ev != null) { g.sum_ev += ev; if (ev >= 95) g.hard_hits += 1; }
      if (la != null) g.sum_la += la;
      const lsa = num(r.launch_speed_angle);
      if (lsa === 6) g.barrels += 1;
      const xwc = num(r.estimated_woba_using_speedangle);
      if (xwc != null) { g.xwoba_con_num += xwc; g.xwoba_con_den += 1; }
    }

    // PA-level (terminal pitch of an at-bat)
    const wDen = num(r.woba_denom);
    if (wDen && wDen > 0) {
      g.PA_sav += 1;
      const events = (r.events || "").toLowerCase();
      const nonAb = events === "walk" || events === "hit_by_pitch" ||
                    events === "sac_fly" || events === "sac_bunt" ||
                    events === "intent_walk" || events === "catcher_interf";
      if (!nonAb) {
        g.AB_sav += 1;
        // xBA / xSLG are expected stats per AB. BIPs contribute their
        // estimated values; non-BIP ABs (strikeouts) contribute 0.
        g.xba_den  += 1;
        g.xslg_den += 1;
        if (desc === "hit_into_play") {
          const xba  = num(r.estimated_ba_using_speedangle);
          const xslg = num(r.estimated_slg_using_speedangle);
          if (xba  != null) g.xba_num  += xba;
          if (xslg != null) g.xslg_num += xslg;
        }
      }

      let contrib = null;
      if (desc === "hit_into_play") {
        contrib = num(r.estimated_woba_using_speedangle);
      }
      if (contrib == null) contrib = num(r.woba_value) ?? 0;
      g.xwoba_num += contrib;
      g.xwoba_den += wDen;
    }
  }
  return out;
}

// Merge Savant per-game counters into the gameLog row array by date.
function mergeSavant(gameLogRows, savantByDate) {
  return gameLogRows.map(r => {
    const sav = savantByDate[r.date];
    if (!sav) return r;
    return { ...r, ...sav };
  });
}

// ── Computable metrics ──
// Each entry maps an id (matched against card category labels + a few of our
// own additions) to a compute(window) → number, where window is a summed
// counter object built from gameLog rows. Metrics not present here are
// surfaced in the dropdown but render a "not available" message — those
// stats are Statcast-derived and aren't in the MLB Stats API gameLog.

// FIP constant varies year to year (~3.10); using 3.15 as a reasonable mid.
const FIP_C = 3.15;

// Stats whose compute uses Savant counters; flagged so we know to fetch
// per-pitch CSVs for the player.
const STATCAST_COMPUTE = {
  "xwOBA":    { compute: w => safe(w.xwoba_num, w.xwoba_den), digits: 3 },
  "xBA":      { compute: w => safe(w.xba_num, w.xba_den),     digits: 3 },
  "xSLG":     { compute: w => safe(w.xslg_num, w.xslg_den),   digits: 3 },
  "xwOBACON": { compute: w => safe(w.xwoba_con_num, w.xwoba_con_den), digits: 3 },
  "Barrel%":  { compute: w => safe(w.barrels, w.bbe) * 100, suffix: "%" },
  "Hard Hit%":{ compute: w => safe(w.hard_hits, w.bbe) * 100, suffix: "%" },
  "Avg Exit Velo":  { compute: w => safe(w.sum_ev, w.bbe), suffix: " mph", digits: 1 },
  "Avg Launch Angle": { compute: w => safe(w.sum_la, w.bbe), suffix: "°", digits: 1 },
  "Whiff%":   { compute: w => safe(w.whiffs, w.swings) * 100, suffix: "%" },
  "Z-Contact%": { compute: w => (1 - safe(w.iz_whiffs, w.iz_swings)) * 100, suffix: "%" },
  "Chase%":   { compute: w => safe(w.oz_swings, w.oz_pitches) * 100, suffix: "%" },
  "Avg Bat Speed":   { compute: w => safe(w.sum_bs, w.bs_n), suffix: " mph", digits: 1 },
  "Fast Swing %":    { compute: w => safe(w.fast_swings, w.bs_n) * 100, suffix: "%" },
  "Avg Swing Length":{ compute: w => safe(w.sum_sl, w.sl_n), suffix: " ft", digits: 2 },
  "Avg. Attack Angle":{ compute: w => safe(w.sum_aa, w.aa_n), suffix: "°", digits: 1 },
  "Avg FB Velo":     { compute: w => safe(w.sum_ff_velo, w.ff_n), suffix: " mph", digits: 1 },
};

const HITTER_COMPUTE = {
  "AVG":  { compute: w => safe(w.H,  w.AB), digits: 3 },
  "OBP":  { compute: w => safe(w.H + w.BB + w.HBP, w.AB + w.BB + w.HBP + w.SF), digits: 3 },
  "SLG":  { compute: w => safe(w.TB, w.AB), digits: 3 },
  "OPS":  { compute: w => safe(w.H + w.BB + w.HBP, w.AB + w.BB + w.HBP + w.SF) + safe(w.TB, w.AB), digits: 3 },
  "ISO":  { compute: w => safe(w.TB, w.AB) - safe(w.H, w.AB), digits: 3 },
  "BB%":  { compute: w => safe(w.BB, w.PA) * 100, suffix: "%" },
  "K%":   { compute: w => safe(w.K,  w.PA) * 100, suffix: "%" },
  ...STATCAST_COMPUTE,
};

const PITCHER_COMPUTE = {
  "ERA":   { compute: w => safe(9 * w.ER, w.IP) },
  "FIP":   { compute: w => w.IP > 0 ? (13*w.HR + 3*(w.BB + w.HBP) - 2*w.K)/w.IP + FIP_C : 0 },
  "WHIP":  { compute: w => safe(w.BB + w.H, w.IP) },
  "K%":    { compute: w => safe(w.K,  w.BF) * 100, suffix: "%" },
  "BB%":   { compute: w => safe(w.BB, w.BF) * 100, suffix: "%" },
  "K-BB%": { compute: w => (safe(w.K, w.BF) - safe(w.BB, w.BF)) * 100, suffix: "%" },
  "HR/9":  { compute: w => safe(9 * w.HR, w.IP) },
  "GB%":   { compute: w => safe(w.GO, w.GO + w.AO) * 100, suffix: "%" },
  ...STATCAST_COMPUTE,
};

const STATCAST_KEYS = [
  "xwoba_num", "xwoba_den", "xba_num", "xba_den", "xslg_num", "xslg_den",
  "xwoba_con_num", "xwoba_con_den",
  "bbe", "barrels", "hard_hits", "sum_ev", "sum_la",
  "pitches", "swings", "whiffs", "oz_pitches", "oz_swings",
  "iz_swings", "iz_whiffs",
  "bs_n", "sum_bs", "fast_swings", "sl_n", "sum_sl", "aa_n", "sum_aa",
  "ff_n", "sum_ff_velo",
];

// Some card labels differ from the canonical id above. Map them so the same
// compute fn fires whether the card calls it "Avg Exit Velo" or "Avg Exit
// Velocity", "Barrel%" or "Barrel %", etc.
const LABEL_ALIASES = {
  "Barrel %": "Barrel%",
  "Avg Exit Velocity": "Avg Exit Velo",
  "Whiff %": "Whiff%",
  "Chase %": "Chase%",
};
const canon = (label) => LABEL_ALIASES[label] || label;

function safe(n, d) { return d > 0 ? n / d : 0; }

// Parse an MLB Stats API innings-pitched string like "5.1" → 5 + 1/3 outs as
// fractional innings (5.1 = five and one-third). "5.2" = 5.667.
function parseIP(s) {
  if (s == null) return 0;
  const str = String(s);
  const [whole, frac] = str.split(".");
  const w = parseInt(whole, 10) || 0;
  const f = parseInt(frac, 10) || 0;
  return w + f / 3;
}

function gameRowHitter(g) {
  const s = g.stat || {};
  return {
    date: g.date || g.gameDate,
    PA:  Number(s.plateAppearances) || 0,
    AB:  Number(s.atBats)            || 0,
    H:   Number(s.hits)              || 0,
    BB:  Number(s.baseOnBalls)       || 0,
    HBP: Number(s.hitByPitch)        || 0,
    SF:  Number(s.sacFlies)          || 0,
    TB:  Number(s.totalBases)        || 0,
    K:   Number(s.strikeOuts)        || 0,
  };
}

function gameRowPitcher(g) {
  const s = g.stat || {};
  return {
    date: g.date || g.gameDate,
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

function addRow(acc, r, keys) {
  for (const k of keys) acc[k] = (acc[k] || 0) + (r[k] || 0);
}

function subRow(acc, r, keys) {
  for (const k of keys) acc[k] = (acc[k] || 0) - (r[k] || 0);
}

const HITTER_KEYS  = ["PA", "AB", "H", "BB", "HBP", "SF", "TB", "K", ...STATCAST_KEYS];
const PITCHER_KEYS = ["IP", "BF", "H", "BB", "HBP", "K", "HR", "ER", "GO", "AO", ...STATCAST_KEYS];

// Walk games chronologically and emit one point per game once the trailing
// window (looking BACK from this game inclusive) accumulates at least
// `windowSize` of `windowKey`. Drops older games as the window slides forward.
function buildRolling(rows, windowSize, windowKey, keys, compute) {
  if (!rows.length) return [];
  const win = {};
  let lo = 0;
  const out = [];
  for (let i = 0; i < rows.length; i++) {
    addRow(win, rows[i], keys);
    // Shrink from the left while we can drop the oldest game and still keep
    // >= windowSize. This keeps the window the minimal contiguous suffix.
    while (lo < i && (win[windowKey] - rows[lo][windowKey]) >= windowSize) {
      subRow(win, rows[lo], keys);
      lo++;
    }
    if (win[windowKey] >= windowSize) {
      out.push({
        date: rows[i].date,
        idx: out.length + 1,
        value: compute(win),
      });
    }
  }
  return out;
}

export default function RollingChart({ playerId, playerName, season, type, cardMetrics }) {
  const { theme: t } = useTheme();
  const computeMap = type === "pitcher" ? PITCHER_COMPUTE : HITTER_COMPUTE;

  // Dropdown options: every label that appears on the card, plus any of
  // our computable extras that the card doesn't already cover. Card order
  // first, extras appended at the end.
  const options = useMemo(() => {
    const seen = new Set();
    const out = [];
    for (const lbl of cardMetrics || []) {
      const key = canon(lbl);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, label: lbl, supported: !!computeMap[key] });
    }
    for (const key of Object.keys(computeMap)) {
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ id: key, label: key, supported: true });
    }
    return out;
  }, [cardMetrics, computeMap]);

  // Default selection: first supported option, falling back to first option
  const [metric, setMetric] = useState(() => {
    const first = options.find(o => o.supported) || options[0];
    return first?.id;
  });
  useEffect(() => {
    if (!options.some(o => o.id === metric)) {
      const first = options.find(o => o.supported) || options[0];
      if (first) setMetric(first.id);
    }
  }, [options]); // eslint-disable-line react-hooks/exhaustive-deps

  const [rows, setRows] = useState(null);  // chronologically-sorted game rows
  const [err, setErr] = useState(null);
  const cardRef = useRef(null);

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);

    if (!playerId) return;

    const target = type === "pitcher" ? 10 : 50;
    const targetKey = type === "pitcher" ? "IP" : "PA";
    const rowFor = type === "pitcher" ? gameRowPitcher : gameRowHitter;
    const group = type === "pitcher" ? "pitching" : "hitting";
    const savantType = type === "pitcher" ? "pitcher" : "batter";

    (async () => {
      try {
        const yr = Number(season);
        const collected = [];
        let total = 0;
        // Walk back up to 5 seasons until we reach the target. For each
        // season we fetch the gameLog and the Savant per-pitch CSV in
        // parallel, then merge the per-game Statcast counters into the
        // gameLog rows by date.
        for (let s = yr; s > yr - 5 && total < target; s--) {
          const [log, savantRows] = await Promise.all([
            fetchGameLog(playerId, s, group),
            fetchSavantPlayerSeason(playerId, s, savantType).catch(() => []),
          ]);
          if (cancelled) return;
          const savByDate = aggregateSavantToGames(savantRows || []);
          let seasonRows = (log || []).map(rowFor).filter(r => r.date);
          seasonRows = mergeSavant(seasonRows, savByDate);
          // Sort within season by date (gameLog usually already chronological)
          seasonRows.sort((a, b) => a.date.localeCompare(b.date));
          // Prepend older season's rows so the full array is chronological
          collected.unshift(...seasonRows);
          total = collected.reduce((a, r) => a + (r[targetKey] || 0), 0);
        }
        if (cancelled) return;
        if (total < target) { setRows([]); return; }
        setRows(collected);
      } catch (e) {
        if (!cancelled) setErr(e.message || String(e));
      }
    })();

    return () => { cancelled = true; };
  }, [playerId, season, type]);

  const computeDef = computeMap[metric] || null;
  const series = useMemo(() => {
    if (!rows || !rows.length || !computeDef) return [];
    const target = type === "pitcher" ? 10 : 50;
    const targetKey = type === "pitcher" ? "IP" : "PA";
    const keys = type === "pitcher" ? PITCHER_KEYS : HITTER_KEYS;
    return buildRolling(rows, target, targetKey, keys, computeDef.compute);
  }, [rows, metric, type, computeDef]);

  const currentLabel = options.find(o => o.id === metric)?.label || metric;
  const saveChart = useCallback(async () => {
    const safeName = (playerName || "player").replace(/\s+/g, "_");
    const safeMetric = currentLabel.replace(/[^A-Za-z0-9]+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_${safeMetric}_rolling_${season}.png`);
  }, [playerName, currentLabel, season]);

  // Hide entirely if data fetch failed or we never reached the threshold
  if (err) return null;
  if (rows == null) return null;          // loading
  if (rows.length === 0) return null;     // insufficient career data, hide

  const suffix = computeDef?.suffix || "";
  const digits = computeDef?.digits ?? (suffix === "%" ? 1 : 3);
  const tickDigits = suffix === "%" ? 0 : (digits === 3 ? 3 : Math.max(0, digits - 1));
  const target = type === "pitcher" ? 10 : 50;
  const unitLbl = type === "pitcher" ? "IP" : "PA";
  return (
    <div>
    {/* Metric selector lives OUTSIDE cardRef so the saved PNG only contains
        the title + chart and renders cleanly centered. */}
    <div style={{
      maxWidth: 600, margin: "16px auto 4px",
      padding: "0 16px",
      display: "flex", alignItems: "center", gap: 8,
    }}>
      <span style={{ fontSize: 10, color: t.textFaint }}>Stat:</span>
      <select
        value={metric}
        onChange={e => setMetric(e.target.value)}
        style={{
          padding: "3px 8px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
          borderRadius: 4, color: t.textSecondary, fontSize: 11, outline: "none",
          fontFamily: "inherit",
        }}
      >
        {options.map(o => (
          <option key={o.id} value={o.id}>{o.label}{o.supported ? "" : " (Statcast only)"}</option>
        ))}
      </select>
      <span style={{ fontSize: 10, color: t.textFaintest, marginLeft: "auto" }}>
        Trailing {target} {unitLbl}
      </span>
    </div>

    <div ref={cardRef} style={{
      background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
      maxWidth: 600, margin: "0 auto", padding: "14px 0 10px",
    }}>
      <div style={{
        fontSize: 12, fontWeight: 700, color: t.text,
        textAlign: "center", width: "100%", marginBottom: 6,
        padding: "0 16px", boxSizing: "border-box",
      }}>
        {playerName ? `${playerName} — ` : ""}{currentLabel} — Rolling {target} {unitLbl}
      </div>

      {computeDef ? (
        series.length < 2 ? (
          <div style={{ padding: "24px 12px 28px", textAlign: "center", color: t.textFaint, fontSize: 12 }}>
            Not enough recent games to fill a trailing {target}-{unitLbl} window.
          </div>
        ) : (
          <div style={{ padding: "0 12px" }}>
            <ResponsiveContainer width="100%" height={160}>
              <LineChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={t.cardBorder} />
                <XAxis
                  dataKey="date"
                  tick={{ fill: t.textMuted, fontSize: 10 }}
                  tickLine={false}
                  axisLine={{ stroke: t.divider }}
                  tickFormatter={(d) => (d || "").slice(5)}
                  minTickGap={28}
                />
                <YAxis
                  tick={{ fill: t.textFaint, fontSize: 10 }} tickLine={false}
                  axisLine={false} width={40}
                  domain={["auto", "auto"]}
                  tickFormatter={v => v.toFixed(tickDigits)}
                />
                <Tooltip
                  contentStyle={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, fontSize: 11 }}
                  labelStyle={{ color: t.textMuted }}
                  formatter={(v) => [`${v.toFixed(digits)}${suffix}`, currentLabel]}
                />
                <Line
                  type="monotone" dataKey="value"
                  stroke="#f59e0b" strokeWidth={2.5}
                  dot={false}
                  isAnimationActive={false}
                />
                <ReferenceLine y={0} stroke={t.textFaintest} strokeDasharray="4 4" />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )
      ) : (
        <div style={{ padding: "24px 16px 28px", textAlign: "center", color: t.textFaint, fontSize: 12, lineHeight: 1.5 }}>
          Rolling chart not available for <b>{currentLabel}</b>.<br />
          Statcast-derived stats aren’t in the MLB Stats API gameLog.
        </div>
      )}
    </div>
    {computeDef && series.length >= 2 && (
      <div style={{ textAlign: "center", marginTop: 10 }}>
        <button
          onClick={saveChart}
          style={{
            padding: "6px 16px", fontSize: 11, fontWeight: 600,
            background: t.inputBg, color: t.textMuted,
            border: `1px solid ${t.inputBorder}`, borderRadius: 6,
            cursor: "pointer", transition: "all 0.15s",
            fontFamily: "inherit",
          }}
          onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
          onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
        >
          📥 Save as PNG
        </button>
      </div>
    )}
    </div>
  );
}
