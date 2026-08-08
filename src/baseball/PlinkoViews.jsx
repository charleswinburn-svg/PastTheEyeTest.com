import { useMemo, useState, useEffect, useRef } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { PITCH_COLORS, PITCH_NAMES } from "./mlbApi.js";
import { GROUP_COLORS, getPitchGroup } from "./SummaryComponents.jsx";

// ════════════════════════════════════════════════════════════════════════════
// PLINKO VIEWS — a vertical count-tree ("plinko") of usage donuts + split-aware,
// color-coded stat tables, for the Pitcher/Hitter "Plinko" tabs. Consumes RAW
// SAVANT ROWS (snake_case) so it has the contact outcomes (barrel / xwOBAcon /
// xSLG) the MLB-API pitch objects lack. Formulas mirror RollingChart.jsx /
// PitcherArsenal.jsx. Stuff+/Loc+/Pitch+ come from the pitch-plus scoring passed
// in from Summaries.
// ════════════════════════════════════════════════════════════════════════════

const num = (v) => { const f = parseFloat(v); return Number.isFinite(f) ? f : null; };

const SWING = new Set([
  "swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play",
  "foul_bunt", "missed_bunt", "bunt_foul_tip", "swinging_pitchout",
]);
const WHIFF = new Set(["swinging_strike", "swinging_strike_blocked", "missed_bunt", "swinging_pitchout"]);
const NON_AB_EVENTS = new Set([
  "walk", "hit_by_pitch", "sac_fly", "sac_bunt", "sac_fly_double_play", "intent_walk", "catcher_interf",
]);

function rowInZone(r) {
  const z = num(r.zone);
  if (z != null) return z >= 1 && z <= 9;
  const pX = num(r.plate_x), pZ = num(r.plate_z);
  if (pX == null || pZ == null) return false;
  return Math.abs(pX) <= 0.83 && pZ <= (num(r.sz_top) ?? 3.5) && pZ >= (num(r.sz_bot) ?? 1.5);
}
function rowOutZone(r) { const z = num(r.zone); return z != null ? z >= 10 : !rowInZone(r); }

function inWindow(date, from, to) {
  if (!date) return !from && !to;
  if (from && date < from) return false;
  if (to && date > to) return false;
  return true;
}

// Count-state buckets (overlapping lenses); last is "Behind" for pitchers / "Ahead" for hitters.
function countBuckets(isPitcher) {
  return [
    { id: "early", label: "Early",     test: (b, s) => (b === 0 && s === 0) || (b === 1 && s === 0) },
    { id: "pre2k", label: "Pre-2K",    test: (b, s) => s < 2 },
    { id: "two",   label: "2 Strikes", test: (b, s) => s === 2 },
    { id: "bhd",   label: isPitcher ? "Behind" : "Ahead",
      test: (b, s) => (b === 2 && s === 0) || (b === 2 && s === 1) || (b === 3 && s === 0) || (b === 3 && s === 1) },
  ];
}

// ── times-through-the-order (starters) ──────────────────────────────────────
const MIN_TTO_PITCHES = 25;
const TTO_LABELS = { "1": "1st Time", "2": "2nd Time", "3": "3rd Time" };
const ttoBucket = (n) => (n == null ? null : n >= 3 ? "3" : String(n));

function assignTTO(rows) {
  const byGame = {};
  for (const r of rows) { const g = r.game_pk; if (g != null) (byGame[g] ||= []).push(r); }
  const abTTO = {};
  for (const grows of Object.values(byGame)) {
    const batterOf = {};
    for (const r of grows) { const ab = parseInt(r.at_bat_number, 10); if (!Number.isNaN(ab)) batterOf[ab] = r.batter; }
    const seen = {};
    for (const ab of Object.keys(batterOf).map(Number).sort((a, b) => a - b)) {
      const bat = batterOf[ab];
      seen[bat] = (seen[bat] || 0) + 1;
      abTTO[`${grows[0].game_pk}|${ab}`] = seen[bat];
    }
  }
  return abTTO;
}

function usePitcherTTO(savRows, playerId, dateFrom, dateTo) {
  const base = useFiltered(savRows, playerId, true, dateFrom, dateTo);
  return useMemo(() => {
    const abTTO = assignTTO(base);
    const rows = base.map(r => ({ ...r, _tto: ttoBucket(abTTO[`${r.game_pk}|${r.at_bat_number}`]) }));
    const counts = { "1": 0, "2": 0, "3": 0 };
    for (const r of rows) if (r._tto) counts[r._tto]++;
    const present = ["1", "2", "3"].filter(k => counts[k] >= MIN_TTO_PITCHES);
    return { rows, present, counts };
  }, [base]);
}

// ── per-split counter accumulation ──────────────────────────────────────────
function newCtr() {
  return { n: 0, swings: 0, whiffs: 0, oz: 0, ozSw: 0, iz: 0, strikes: 0,
           bbe: 0, barrels: 0, xwcSum: 0, xwcN: 0, xslgSum: 0, ab: 0 };
}
function addRow(c, r) {
  c.n++;
  const desc = (r.description || "").toLowerCase();
  const sw = SWING.has(desc);
  if (sw) c.swings++;
  if (WHIFF.has(desc)) c.whiffs++;
  if (rowOutZone(r)) { c.oz++; if (sw) c.ozSw++; }
  if (rowInZone(r)) c.iz++;
  if (sw || desc === "called_strike") c.strikes++;
  if (desc === "hit_into_play") {
    c.bbe++;
    if (num(r.launch_speed_angle) === 6) c.barrels++;
    const xwc = num(r.estimated_woba_using_speedangle);
    if (xwc != null) { c.xwcSum += xwc; c.xwcN++; }
  }
  const wDen = num(r.woba_denom);
  if (wDen && wDen > 0 && !NON_AB_EVENTS.has((r.events || "").toLowerCase())) {
    c.ab++;
    if (desc === "hit_into_play") { const x = num(r.estimated_slg_using_speedangle); if (x != null) c.xslgSum += x; }
  }
}
const pct1 = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
function finalize(c, splitTotal) {
  return {
    n: c.n,
    usagePct: splitTotal > 0 ? Math.round((c.n / splitTotal) * 1000) / 10 : null,
    whiffPct: pct1(c.whiffs, c.swings),
    chasePct: pct1(c.ozSw, c.oz),
    zonePct:  pct1(c.iz, c.n),
    strikePct: pct1(c.strikes, c.n),
    barrelPct: pct1(c.barrels, c.bbe),
    xwobacon: c.xwcN ? Math.round((c.xwcSum / c.xwcN) * 1000) / 1000 : null,
    xslg:     c.ab   ? Math.round((c.xslgSum / c.ab) * 1000) / 1000 : null,
  };
}

// Aggregate ALREADY-FILTERED rows into { data: {group: {split: stats}}, splitTotal }.
function aggregateCounts(rows, { isPitcher, keyOf, dimension }) {
  const buckets = dimension === "count" ? countBuckets(isPitcher) : null;
  const splitsOf = dimension === "platoon"
    ? (r) => { const s = isPitcher ? r.stand : r.p_throws; return (s === "L" || s === "R") ? [s] : []; }
    : dimension === "tto"
    ? (r) => (r._tto ? [r._tto] : [])
    : (r) => {
        const b = parseInt(r.balls, 10), s = parseInt(r.strikes, 10);
        if (Number.isNaN(b) || Number.isNaN(s)) return [];
        return buckets.filter(bk => bk.test(b, s)).map(bk => bk.id);
      };
  const acc = {}, splitTotal = {};
  for (const r of rows) {
    const group = keyOf(r);
    if (!group) continue;
    for (const sid of splitsOf(r)) {
      const c = ((acc[group] ||= {})[sid] ||= newCtr());
      addRow(c, r);
      splitTotal[sid] = (splitTotal[sid] || 0) + 1;
    }
  }
  const data = {};
  for (const [group, bySplit] of Object.entries(acc)) {
    data[group] = {};
    for (const [sid, c] of Object.entries(bySplit)) data[group][sid] = finalize(c, splitTotal[sid]);
  }
  return { data, splitTotal };
}

// ── stat metadata + coloring ────────────────────────────────────────────────
const fPct = (v) => v.toFixed(1) + "%";
const f3 = (v) => v.toFixed(3).replace(/^0/, "");
const fPlus = (v) => String(Math.round(v));
const PLUS_FIELDS = new Set(["stuffPlus", "locPlus", "pitchPlus"]);
const STAT_META = {
  usagePct:  { label: "Usage%",    fmt: fPct,  scale: 0 },
  barrelPct: { label: "Barrel%",   fmt: fPct,  scale: 4 },
  xwobacon:  { label: "xwOBAcon",  fmt: f3,    scale: 0.05 },
  xslg:      { label: "xSLG",      fmt: f3,    scale: 0.08 },
  whiffPct:  { label: "Whiff%",    fmt: fPct,  scale: 8 },
  chasePct:  { label: "Chase%",    fmt: fPct,  scale: 8 },
  zonePct:   { label: "Zone%",     fmt: fPct,  scale: 7 },
  strikePct: { label: "Strike%",   fmt: fPct,  scale: 7 },
  stuffPlus: { label: "Stuff+",    fmt: fPlus, scale: 8 },
  locPlus:   { label: "Location+", fmt: fPlus, scale: 8 },
  pitchPlus: { label: "Pitch+",    fmt: fPlus, scale: 8 },
};
// +1 green when higher, -1 green when lower, 0 no color.
function statDir(field, isPitcher) {
  if (field === "usagePct") return 0;
  if (field === "barrelPct" || field === "xwobacon" || field === "xslg") return isPitcher ? -1 : 1;
  if (field === "whiffPct" || field === "chasePct") return isPitcher ? 1 : -1;
  if (field === "zonePct" || field === "strikePct" || PLUS_FIELDS.has(field)) return 1;
  return 0;
}
function cellBg(v, mean, dir, scale) {
  if (v == null || mean == null || !dir || !scale) return "transparent";
  let d = ((v - mean) / scale) * dir;
  d = Math.max(-1, Math.min(1, d));
  if (Math.abs(d) < 0.08) return "transparent";
  const a = (0.16 + (Math.abs(d) - 0.08) * 0.55).toFixed(2);
  return d > 0 ? `rgba(34,160,60,${a})` : `rgba(210,55,45,${a})`;
}
// Fixed MLB-average baselines for cell coloring (overall league, not within-table).
const LEAGUE_AVG = {
  barrelPct: 7.5, xwobacon: 0.370, xslg: 0.400,
  whiffPct: 25.0, chasePct: 28.0, zonePct: 49.0, strikePct: 63.0,
  stuffPlus: 100, locPlus: 100, pitchPlus: 100,
};

// ── canvas donut (no center label) ──────────────────────────────────────────
function drawDonut(ctx, cx, cy, list, keyOf, colorOf, rO, rI, t) {
  const counts = {}; let total = 0;
  for (const r of list) { const k = keyOf(r); if (!k) continue; counts[k] = (counts[k] || 0) + 1; total++; }
  const mid = (rO + rI) / 2, lw = rO - rI;
  if (total === 0) {
    ctx.save(); ctx.setLineDash([2, 3]); ctx.globalAlpha = 0.45; ctx.strokeStyle = t.divider; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(cx, cy, mid, 0, 2 * Math.PI); ctx.stroke(); ctx.restore();
    return;
  }
  const slices = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (slices.length === 1) {
    ctx.strokeStyle = colorOf(slices[0][0]) || "#888"; ctx.lineWidth = lw;
    ctx.beginPath(); ctx.arc(cx, cy, mid, 0, 2 * Math.PI); ctx.stroke();
    return;
  }
  let a = -Math.PI / 2;
  for (const [k, n] of slices) {
    const a1 = a + (n / total) * 2 * Math.PI;
    ctx.beginPath();
    ctx.arc(cx, cy, rO, a, a1, false);
    ctx.arc(cx, cy, rI, a1, a, true);
    ctx.closePath();
    ctx.fillStyle = colorOf(k) || "#888";
    ctx.fill();
    a = a1;
  }
}

// ── plinko: vertical count tree drawn on a <canvas> (0-0 on top splitting down
// into 1-pitch, 2-pitch, ... counts). Canvas — not inline SVG — so html2canvas
// (Save-as-PNG) always rasterizes it. ─────────────────────────────────────────
const CT = { VS: 46, HS: 26, BR: 15, PAD: 16, TOP: 18, S: 2 };
const CT_W = CT.PAD * 2 + CT.BR * 2 + 5 * CT.HS;
const CT_H = CT.TOP + CT.BR * 2 + 5 * CT.VS + 12;
function CountTree({ rows, keyOf, colorOf, title }) {
  const { theme: t } = useTheme();
  const ref = useRef(null);
  const byCount = useMemo(() => {
    const m = {};
    for (const r of rows) {
      const b = parseInt(r.balls, 10), s = parseInt(r.strikes, 10);
      if (b >= 0 && b <= 3 && s >= 0 && s <= 2) (m[`${b}-${s}`] ||= []).push(r);
    }
    return m;
  }, [rows]);

  useEffect(() => {
    const cv = ref.current; if (!cv) return;
    const ctx = cv.getContext("2d");
    const { VS, HS, BR, PAD, TOP, S } = CT;
    const cxOf = (b, s) => PAD + BR + ((b - s) + 2) * HS;   // x = balls - strikes
    const cyOf = (b, s) => TOP + BR + (b + s) * VS;         // y = depth (balls + strikes)
    const draw = () => {
      ctx.setTransform(S, 0, 0, S, 0, 0);
      ctx.clearRect(0, 0, CT_W, CT_H);
      ctx.textBaseline = "alphabetic";
      ctx.fillStyle = t.text; ctx.font = "800 11px 'Pliant', sans-serif"; ctx.textAlign = "center";
      ctx.fillText(title.toUpperCase(), CT_W / 2, 12);
      ctx.strokeStyle = t.divider; ctx.lineWidth = 1; ctx.globalAlpha = 0.7;
      for (let b = 0; b <= 3; b++) for (let s = 0; s <= 2; s++) {
        const x = cxOf(b, s), y = cyOf(b, s);
        if (b < 3) { ctx.beginPath(); ctx.moveTo(x, y + BR * 0.5); ctx.lineTo(cxOf(b + 1, s), cyOf(b + 1, s) - BR * 0.5); ctx.stroke(); }
        if (s < 2) { ctx.beginPath(); ctx.moveTo(x, y + BR * 0.5); ctx.lineTo(cxOf(b, s + 1), cyOf(b, s + 1) - BR * 0.5); ctx.stroke(); }
      }
      ctx.globalAlpha = 1;
      ctx.font = "700 8px 'Pliant', sans-serif";
      for (let b = 0; b <= 3; b++) for (let s = 0; s <= 2; s++) {
        const x = cxOf(b, s), y = cyOf(b, s);
        drawDonut(ctx, x, y, byCount[`${b}-${s}`] || [], keyOf, colorOf, BR, BR * 0.52, t);
        ctx.fillStyle = t.textFaint; ctx.textAlign = "left";
        ctx.fillText(`${b}-${s}`, x + BR + 2, y + 3);
      }
    };
    draw();
    let cancelled = false;
    if (document.fonts?.ready) document.fonts.ready.then(() => { if (!cancelled) draw(); });
    return () => { cancelled = true; };
  }, [byCount, title, t]);

  return (
    <div style={{ flex: "0 0 auto" }}>
      <canvas ref={ref} width={CT_W * CT.S} height={CT_H * CT.S} style={{ width: CT_W, height: CT_H, display: "block", margin: "0 auto" }} />
    </div>
  );
}

function Legend({ items }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", justifyContent: "center", margin: "6px 0 4px", fontSize: 10.5, color: t.textMuted, fontFamily: "'Pliant', sans-serif" }}>
      {items.map(it => (
        <span key={it.label} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
          <span style={{ width: 9, height: 9, borderRadius: "50%", background: it.color, display: "inline-block" }} />{it.label}
        </span>
      ))}
    </div>
  );
}

// Shared table styles
function tblStyles(t) {
  return {
    th:  { padding: "4px 6px", borderBottom: `2px solid ${t.divider}`, color: t.textMuted, fontSize: 10.5, fontWeight: 800, textAlign: "center", whiteSpace: "nowrap", fontFamily: "'Pliant', sans-serif" },
    td:  { padding: "4px 6px", borderBottom: `1px solid ${t.tableBorder}`, textAlign: "center", fontSize: 12.5, fontWeight: 700, color: t.textSecondary, fontFamily: "'Pliant', sans-serif" },
    lab: { padding: "4px 8px", borderBottom: `1px solid ${t.tableBorder}`, textAlign: "left", fontWeight: 800, color: t.text, fontSize: 12, whiteSpace: "nowrap", fontFamily: "'Pliant', sans-serif" },
    title: { fontSize: 11.5, fontWeight: 800, color: t.text, textAlign: "center", margin: "10px 0 3px", textTransform: "uppercase", letterSpacing: "0.02em", fontFamily: "'Pliant', sans-serif" },
  };
}

// One table for one split (platoon side / time-through): rows = groups, columns = stats.
function PerSplitTable({ title, groups, stats, valueOf, isPitcher }) {
  const { theme: t } = useTheme();
  const s = tblStyles(t);
  return (
    <div style={{ marginBottom: 10 }}>
      <div style={s.title}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup><col style={{ width: 92 }} />{stats.map(f => <col key={f} />)}</colgroup>
          <thead><tr><th style={{ ...s.th, textAlign: "left" }}></th>{stats.map(f => <th key={f} style={s.th}>{STAT_META[f].label}</th>)}</tr></thead>
          <tbody>
            {groups.map(g => (
              <tr key={g.key}>
                <td style={{ ...s.lab, background: g.color ? g.color + "80" : "transparent" }}>{g.label}</td>
                {stats.map(f => {
                  const v = valueOf(g.key, f);
                  const bg = cellBg(v, LEAGUE_AVG[f], statDir(f, isPitcher), STAT_META[f].scale);
                  return <td key={f} style={{ ...s.td, background: bg }}>{v != null ? STAT_META[f].fmt(v) : "—"}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function pitchTypeGroups(agg) {
  const total = {};
  for (const [g, bySplit] of Object.entries(agg.data)) total[g] = Object.values(bySplit).reduce((a, c) => a + (c.n || 0), 0);
  return Object.keys(total).sort((a, b) => total[b] - total[a])
    .map(pt => ({ key: pt, label: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888" }));
}
const HITTER_GROUP_ROWS = ["Fastball", "Breaking", "Offspeed"].map(g => ({ key: g, label: g, color: GROUP_COLORS[g] }));

// ════════════════════════════════════════════════════════════════════════════
function useFiltered(savRows, playerId, isPitcher, dateFrom, dateTo) {
  return useMemo(() => (savRows || []).filter(r =>
    r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO" &&
    String(isPitcher ? r.pitcher : r.batter) === String(playerId) &&
    inWindow(r.game_date, dateFrom, dateTo)
  ), [savRows, playerId, isPitcher, dateFrom, dateTo]);
}

const PITCHER_PLATOON_STATS = ["usagePct", "barrelPct", "xwobacon", "whiffPct", "stuffPlus", "pitchPlus"];
const PITCHER_COUNT_STATS   = ["usagePct", "zonePct", "whiffPct", "strikePct", "barrelPct", "xwobacon"];
const HITTER_PLATOON_STATS  = ["usagePct", "barrelPct", "xwobacon", "xslg", "chasePct", "whiffPct"];
const HITTER_COUNT_STATS    = HITTER_PLATOON_STATS;

// valueOf for a fixed split: Plus fields come from pitchPlus, the rest from agg.
const splitValueOf = (agg, pitchPlus, split) => (gk, field) =>
  PLUS_FIELDS.has(field) ? (pitchPlus?.[gk]?.[split]?.[field] ?? null) : (agg.data[gk]?.[split]?.[field] ?? null);

function PitcherPlatoon({ savRows, playerId, pitchPlus, dateFrom, dateTo }) {
  const rows = useFiltered(savRows, playerId, true, dateFrom, dateTo);
  const agg = useMemo(() => aggregateCounts(rows, { isPitcher: true, keyOf: r => r.pitch_type, dimension: "platoon" }), [rows]);
  const groups = pitchTypeGroups(agg);
  const kc = r => r.pitch_type, cc = pt => PITCH_COLORS[pt] || "#888";
  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <div style={{ display: "flex", gap: 22, justifyContent: "center", flexWrap: "wrap" }}>
        <CountTree rows={rows.filter(r => r.stand === "L")} keyOf={kc} colorOf={cc} title="vs LHB" />
        <CountTree rows={rows.filter(r => r.stand === "R")} keyOf={kc} colorOf={cc} title="vs RHB" />
      </div>
      <Legend items={groups.map(g => ({ label: g.label, color: g.color }))} />
      <PerSplitTable title="vs LHB" groups={groups} stats={PITCHER_PLATOON_STATS} valueOf={splitValueOf(agg, pitchPlus, "L")} isPitcher />
      <PerSplitTable title="vs RHB" groups={groups} stats={PITCHER_PLATOON_STATS} valueOf={splitValueOf(agg, pitchPlus, "R")} isPitcher />
    </div>
  );
}

function PitcherCountState({ savRows, playerId, dateFrom, dateTo }) {
  const rows = useFiltered(savRows, playerId, true, dateFrom, dateTo);
  const agg = useMemo(() => aggregateCounts(rows, { isPitcher: true, keyOf: r => r.pitch_type, dimension: "count" }), [rows]);
  const groups = pitchTypeGroups(agg);
  const buckets = countBuckets(true);
  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <CountTree rows={rows} keyOf={r => r.pitch_type} colorOf={pt => PITCH_COLORS[pt] || "#888"} title="Usage by count" />
      <Legend items={groups.map(g => ({ label: g.label, color: g.color }))} />
      {buckets.map(b => (
        <PerSplitTable key={b.id} title={b.label} groups={groups} stats={PITCHER_COUNT_STATS}
          valueOf={splitValueOf(agg, null, b.id)} isPitcher />
      ))}
    </div>
  );
}

function PitcherTTO({ rows, present }) {
  const agg = useMemo(() => aggregateCounts(rows, { isPitcher: true, keyOf: r => r.pitch_type, dimension: "tto" }), [rows]);
  const groups = pitchTypeGroups(agg);
  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <div style={{ display: "flex", gap: 14, justifyContent: "center", flexWrap: "wrap" }}>
        {present.map(k => (
          <CountTree key={k} rows={rows.filter(r => r._tto === k)} keyOf={r => r.pitch_type} colorOf={pt => PITCH_COLORS[pt] || "#888"} title={TTO_LABELS[k]} />
        ))}
      </div>
      <Legend items={groups.map(g => ({ label: g.label, color: g.color }))} />
      {present.map(k => (
        <PerSplitTable key={k} title={TTO_LABELS[k]} groups={groups} stats={PITCHER_COUNT_STATS}
          valueOf={(gk, f) => agg.data[gk]?.[k]?.[f] ?? null} isPitcher />
      ))}
    </div>
  );
}

function HitterPlatoon({ savRows, playerId, dateFrom, dateTo }) {
  const rows = useFiltered(savRows, playerId, false, dateFrom, dateTo);
  const agg = useMemo(() => aggregateCounts(rows, { isPitcher: false, keyOf: r => getPitchGroup(r.pitch_type), dimension: "platoon" }), [rows]);
  const groups = HITTER_GROUP_ROWS.filter(g => agg.data[g.key]);
  const kc = r => getPitchGroup(r.pitch_type), cc = g => GROUP_COLORS[g] || "#888";
  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <div style={{ display: "flex", gap: 22, justifyContent: "center", flexWrap: "wrap" }}>
        <CountTree rows={rows.filter(r => r.p_throws === "L")} keyOf={kc} colorOf={cc} title="vs LHP" />
        <CountTree rows={rows.filter(r => r.p_throws === "R")} keyOf={kc} colorOf={cc} title="vs RHP" />
      </div>
      <Legend items={HITTER_GROUP_ROWS.map(g => ({ label: g.label, color: g.color }))} />
      <PerSplitTable title="vs LHP" groups={groups} stats={HITTER_PLATOON_STATS} valueOf={(gk, f) => agg.data[gk]?.L?.[f] ?? null} isPitcher={false} />
      <PerSplitTable title="vs RHP" groups={groups} stats={HITTER_PLATOON_STATS} valueOf={(gk, f) => agg.data[gk]?.R?.[f] ?? null} isPitcher={false} />
    </div>
  );
}

function HitterCountState({ savRows, playerId, dateFrom, dateTo }) {
  const rows = useFiltered(savRows, playerId, false, dateFrom, dateTo);
  const agg = useMemo(() => aggregateCounts(rows, { isPitcher: false, keyOf: r => getPitchGroup(r.pitch_type), dimension: "count" }), [rows]);
  const groups = HITTER_GROUP_ROWS.filter(g => agg.data[g.key]);
  const buckets = countBuckets(false);
  return (
    <div style={{ padding: "4px 16px 12px" }}>
      <CountTree rows={rows} keyOf={r => getPitchGroup(r.pitch_type)} colorOf={g => GROUP_COLORS[g] || "#888"} title="Usage seen by count" />
      <Legend items={HITTER_GROUP_ROWS.map(g => ({ label: g.label, color: g.color }))} />
      {buckets.map(b => (
        <PerSplitTable key={b.id} title={b.label} groups={groups} stats={HITTER_COUNT_STATS}
          valueOf={splitValueOf(agg, null, b.id)} isPitcher={false} />
      ))}
    </div>
  );
}

export default function PlinkoView({ isPitcher, playerId, savRows, pitchPlus, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [subtab, setSubtab] = useState("platoon");
  const tto = usePitcherTTO(isPitcher ? savRows : null, playerId, dateFrom, dateTo);
  const showTTO = isPitcher && tto.present.includes("2");
  useEffect(() => { if (subtab === "tto" && !showTTO) setSubtab("platoon"); }, [subtab, showTTO]);

  const tabBtn = (id, label) => (
    <button onClick={() => setSubtab(id)} style={{
      padding: "5px 16px", fontSize: 12, fontWeight: 700, cursor: "pointer",
      background: subtab === id ? t.accent : t.inputBg,
      color: subtab === id ? "#fff" : t.textMuted,
      border: `1px solid ${subtab === id ? t.accent : t.inputBorder}`,
      borderRadius: 6, fontFamily: "'Pliant', sans-serif",
    }}>{label}</button>
  );
  return (
    <div>
      <div style={{ display: "flex", gap: 8, justifyContent: "center", padding: "10px 0 2px", flexWrap: "wrap" }}>
        {tabBtn("platoon", "Platoon")}
        {tabBtn("count", "Count State")}
        {showTTO && tabBtn("tto", "Times Order")}
      </div>
      {subtab === "tto" && showTTO
        ? <PitcherTTO rows={tto.rows} present={tto.present} />
        : subtab === "platoon"
        ? (isPitcher
            ? <PitcherPlatoon savRows={savRows} playerId={playerId} pitchPlus={pitchPlus} dateFrom={dateFrom} dateTo={dateTo} />
            : <HitterPlatoon savRows={savRows} playerId={playerId} dateFrom={dateFrom} dateTo={dateTo} />)
        : (isPitcher
            ? <PitcherCountState savRows={savRows} playerId={playerId} dateFrom={dateFrom} dateTo={dateTo} />
            : <HitterCountState savRows={savRows} playerId={playerId} dateFrom={dateFrom} dateTo={dateTo} />)}
    </div>
  );
}
