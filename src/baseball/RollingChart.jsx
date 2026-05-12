import { useEffect, useMemo, useState } from "react";
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine, Tooltip } from "recharts";
import { useTheme } from "./ThemeContext.jsx";
import { fetchGameLog } from "./mlbApi.js";

// ── Supported metrics ──
// Only metrics that can be computed from standard MLB Stats API gameLog
// counters. Each entry: id (matches a player.categories key), display label,
// and compute(window) → number, where window is a summed counter object.
const HITTER_METRICS = [
  { id: "AVG",  label: "AVG",   compute: w => safe(w.H,  w.AB)              },
  { id: "OBP",  label: "OBP",   compute: w => safe(w.H + w.BB + w.HBP, w.AB + w.BB + w.HBP + w.SF) },
  { id: "SLG",  label: "SLG",   compute: w => safe(w.TB, w.AB)              },
  { id: "OPS",  label: "OPS",   compute: w => safe(w.H + w.BB + w.HBP, w.AB + w.BB + w.HBP + w.SF) + safe(w.TB, w.AB) },
  { id: "ISO",  label: "ISO",   compute: w => safe(w.TB, w.AB) - safe(w.H, w.AB) },
  { id: "BB%",  label: "BB%",   compute: w => safe(w.BB, w.PA) * 100, suffix: "%" },
  { id: "K%",   label: "K%",    compute: w => safe(w.K,  w.PA) * 100, suffix: "%" },
];

// FIP constant varies year to year (~3.10); using 3.15 as a reasonable mid.
const FIP_C = 3.15;
const PITCHER_METRICS = [
  { id: "ERA",     label: "ERA",     compute: w => safe(9 * w.ER, w.IP) },
  { id: "FIP",     label: "FIP",     compute: w => w.IP > 0 ? (13*w.HR + 3*(w.BB + w.HBP) - 2*w.K)/w.IP + FIP_C : 0 },
  { id: "WHIP",    label: "WHIP",    compute: w => safe(w.BB + w.H, w.IP) },
  { id: "K%",      label: "K%",      compute: w => safe(w.K,  w.BF) * 100, suffix: "%" },
  { id: "BB%",     label: "BB%",     compute: w => safe(w.BB, w.BF) * 100, suffix: "%" },
  { id: "K-BB%",   label: "K-BB%",   compute: w => (safe(w.K, w.BF) - safe(w.BB, w.BF)) * 100, suffix: "%" },
  { id: "HR/9",    label: "HR/9",    compute: w => safe(9 * w.HR, w.IP) },
];

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
  };
}

function addRow(acc, r, keys) {
  for (const k of keys) acc[k] = (acc[k] || 0) + (r[k] || 0);
}

function subRow(acc, r, keys) {
  for (const k of keys) acc[k] = (acc[k] || 0) - (r[k] || 0);
}

const HITTER_KEYS  = ["PA", "AB", "H", "BB", "HBP", "SF", "TB", "K"];
const PITCHER_KEYS = ["IP", "BF", "H", "BB", "HBP", "K", "HR", "ER"];

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

export default function RollingChart({ playerId, season, type, defaultMetric }) {
  const { theme: t } = useTheme();
  const metrics = type === "pitcher" ? PITCHER_METRICS : HITTER_METRICS;
  const [metric, setMetric] = useState(() => {
    const def = metrics.find(m => m.id === defaultMetric);
    return def?.id || metrics[0].id;
  });
  const [rows, setRows] = useState(null);  // chronologically-sorted game rows
  const [err, setErr] = useState(null);

  // Reset metric whenever player changes if previous selection no longer in list
  useEffect(() => {
    if (!metrics.some(m => m.id === metric)) setMetric(metrics[0].id);
  }, [type]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let cancelled = false;
    setRows(null);
    setErr(null);

    if (!playerId) return;

    const target = type === "pitcher" ? 10 : 50;
    const targetKey = type === "pitcher" ? "IP" : "PA";
    const rowFor = type === "pitcher" ? gameRowPitcher : gameRowHitter;
    const group = type === "pitcher" ? "pitching" : "hitting";

    (async () => {
      try {
        const yr = Number(season);
        const collected = [];
        let total = 0;
        // Walk back up to 5 seasons until we reach the target
        for (let s = yr; s > yr - 5 && total < target; s--) {
          const log = await fetchGameLog(playerId, s, group);
          if (cancelled) return;
          const seasonRows = (log || []).map(rowFor).filter(r => r.date);
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

  const series = useMemo(() => {
    if (!rows || !rows.length) return [];
    const target = type === "pitcher" ? 10 : 50;
    const targetKey = type === "pitcher" ? "IP" : "PA";
    const keys = type === "pitcher" ? PITCHER_KEYS : HITTER_KEYS;
    const def = metrics.find(m => m.id === metric);
    if (!def) return [];
    return buildRolling(rows, target, targetKey, keys, def.compute);
  }, [rows, metric, type]);  // eslint-disable-line react-hooks/exhaustive-deps

  // Don't render anything if we couldn't reach the threshold or no points
  if (err) return null;
  if (rows == null) return null;          // loading
  if (rows.length === 0) return null;     // insufficient data, hide
  if (series.length < 2) return null;

  const def = metrics.find(m => m.id === metric);
  const suffix = def?.suffix || "";
  const target = type === "pitcher" ? 10 : 50;
  const unitLbl = type === "pitcher" ? "IP" : "PA";

  return (
    <div style={{
      background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
      maxWidth: 600, margin: "16px auto 0", padding: "12px 0 8px",
    }}>
      {/* Metric selector */}
      <div style={{ padding: "4px 16px 8px", display: "flex", alignItems: "center", gap: 8 }}>
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
          {metrics.map(m => (<option key={m.id} value={m.id}>{m.label}</option>))}
        </select>
        <span style={{ fontSize: 10, color: t.textFaintest, marginLeft: "auto" }}>
          Trailing {target} {unitLbl}
        </span>
      </div>

      <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, textAlign: "center", marginBottom: 4 }}>
        {def.label} — Rolling {target}-{unitLbl}
      </div>

      <div style={{ padding: "0 12px" }}>
        <ResponsiveContainer width="100%" height={160}>
          <LineChart data={series} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke={t.cardBorder} />
            <XAxis
              dataKey="date"
              tick={{ fill: t.textMuted, fontSize: 10 }}
              tickLine={false}
              axisLine={{ stroke: t.divider }}
              tickFormatter={(d) => (d || "").slice(5)}   // MM-DD
              minTickGap={28}
            />
            <YAxis
              tick={{ fill: t.textFaint, fontSize: 10 }} tickLine={false}
              axisLine={false} width={40}
              domain={["auto", "auto"]}
              tickFormatter={v => (suffix === "%" ? v.toFixed(0) : v.toFixed(suffix ? 0 : 3))}
            />
            <Tooltip
              contentStyle={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, fontSize: 11 }}
              labelStyle={{ color: t.textMuted }}
              formatter={(v) => [`${(suffix === "%" ? v.toFixed(1) : v.toFixed(3))}${suffix}`, def.label]}
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
    </div>
  );
}
