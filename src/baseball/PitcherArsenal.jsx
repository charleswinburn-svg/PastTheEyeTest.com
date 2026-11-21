import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect } from "react";
import { NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";
import {
  PITCH_COLORS, PITCH_NAMES,
  fetchSavantPlayerSeason, fetchSavantPlayerDateRange,
  fetchGameLog, fetchPlayByPlay, extractPitcherData, fetchSchedule,
} from "./mlbApi.js";

// ── Pitch-outcome classifiers ───────────────────────────────────────────────
// Savant `description` values that count as swings / whiffs.
const SAVANT_WHIFF = new Set(["swinging_strike", "swinging_strike_blocked", "foul_tip", "swinging_pitchout"]);
const SAVANT_SWING = new Set([
  "swinging_strike", "swinging_strike_blocked", "foul", "foul_tip", "hit_into_play",
  "foul_bunt", "missed_bunt", "bunt_foul_tip", "swinging_pitchout",
]);
const inZone = (pX, pZ, szTop, szBot) =>
  pX != null && pZ != null && Math.abs(pX) <= 0.83 &&
  pZ <= (szTop ?? 3.5) && pZ >= (szBot ?? 1.5);

const num = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };

// ── Normalize both sources to one pitch shape ───────────────────────────────
// Movement uses pfx × 12 (inches) for BOTH levels so MLB (Savant pfx_x/pfx_z)
// and AAA (StatsAPI pfx from extractPitcherData) share one convention.
function normalizeSavant(rows) {
  return (rows || [])
    .filter(r => r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO")
    .map(r => {
      const pfxX = num(r.pfx_x), pfxZ = num(r.pfx_z);
      const desc = r.description || "";
      return {
        pitchType: r.pitch_type,
        // negate pfx_x → pitcher's-perspective horizontal break (arm-side right for RHP)
        hBreak: pfxX != null ? -pfxX * 12 : null,
        vBreak: pfxZ != null ? pfxZ * 12 : null,
        pX: num(r.plate_x), pZ: num(r.plate_z),
        szTop: num(r.sz_top), szBot: num(r.sz_bot),
        batHand: r.stand || null,
        isSwing: SAVANT_SWING.has(desc),
        isWhiff: SAVANT_WHIFF.has(desc),
        ev: num(r.launch_speed),
        inPlay: desc === "hit_into_play",                  // ball in play (excludes fouls)
        zone: num(r.zone),                                 // Savant zone 1-9 = strike zone
        terminalEvent: (r.events || "").trim() || null,   // set only on the PA-ending pitch
        xwoba: num(r.estimated_woba_using_speedangle),
        xba: num(r.estimated_ba_using_speedangle),
        wobaValue: num(r.woba_value),                     // actual wOBA weight (K=0, BB≈.69, …)
        wobaDenom: num(r.woba_denom),                     // 1 for PA that count toward wOBA
      };
    });
}

// AAA: raw extractPitcherData pitches, already tagged with `_gameKey`. Mark the
// last pitch of each plate appearance as terminal so K% keys to the put-away pitch.
function normalizePbp(raw) {
  const lastByPa = new Map();   // `${gameKey}|${atBatIndex}` -> pitch with max pitchNumber
  for (const p of raw) {
    const key = `${p._gameKey}|${p.atBatIndex}`;
    const prev = lastByPa.get(key);
    if (!prev || (p.pitchNumber ?? 0) >= (prev.pitchNumber ?? 0)) lastByPa.set(key, p);
  }
  const terminals = new Set([...lastByPa.values()]);
  return raw
    .filter(p => p.pitchType && p.pitchType !== "UN" && p.pitchType !== "PO")
    .map(p => ({
      pitchType: p.pitchType,
      hBreak: p.pfxX_raw != null ? -p.pfxX_raw * 12 : null,   // pitcher's perspective
      vBreak: p.pfxZ_raw != null ? p.pfxZ_raw * 12 : null,
      pX: p.pX, pZ: p.pZ, szTop: p.szTop, szBot: p.szBot,
      batHand: p.batSide || null,
      isSwing: !!p.isSwing,
      isWhiff: !!p.isWhiff,
      ev: p.hitData?.launchSpeed ?? null,
      inPlay: !!p.isInPlay,                                  // ball in play (excludes fouls)
      terminalEvent: terminals.has(p) ? (p.result || null) : null,
      xwoba: null, xba: null,   // no expected stats at AAA
    }));
}

const K_EVENTS = new Set(["strikeout", "strikeout_double_play", "Strikeout", "Strikeout Double Play"]);
const mean = (arr) => arr.length ? arr.reduce((a, b) => a + b, 0) / arr.length : null;

// ── Aggregate per pitch type + usage-by-hand ────────────────────────────────
function aggregate(pitches) {
  // Expected stats (xwOBA/xBA) only exist for MLB (Savant); AAA leaves them null.
  const hasExpected = pitches.some(p => p.xwoba != null || p.xba != null || p.wobaValue != null);
  const byType = {};
  const usage = { L: {}, R: {} };
  for (const p of pitches) {
    const g = (byType[p.pitchType] ||= {
      type: p.pitchType, n: 0, swings: 0, whiffs: 0, zone: 0,
      ev: [], wobaSum: 0, wobaN: 0, baSum: 0, baN: 0, pa: 0, k: 0,
    });
    g.n++;
    if (p.isSwing) g.swings++;
    if (p.isWhiff) g.whiffs++;
    // Zone%: use Savant's `zone` field (1-9 = strike zone) when present (MLB), else
    // a geometric check (AAA play-by-play carries no zone field).
    const isInZone = p.zone != null ? (p.zone >= 1 && p.zone <= 9) : inZone(p.pX, p.pZ, p.szTop, p.szBot);
    if (isInZone) g.zone++;
    if (p.inPlay && p.ev != null) g.ev.push(p.ev);   // Avg EV over balls in play only
    if (p.terminalEvent) {
      g.pa++;
      const isK = K_EVENTS.has(p.terminalEvent);
      if (isK) g.k++;
      if (hasExpected) {
        // xwOBA over ALL plate-appearance outcomes (not just balls in play):
        // estimated_woba for batted balls, actual woba_value for K/BB/HBP.
        if (p.wobaDenom != null && p.wobaDenom >= 1) {
          const w = p.xwoba != null ? p.xwoba : p.wobaValue;
          if (w != null) { g.wobaSum += w; g.wobaN += 1; }
        }
        // xBA over at-bats: estimated_ba for batted balls, 0 for strikeouts.
        // (walks / HBP / sacs aren't at-bats, so they're excluded.)
        if (p.xba != null) { g.baSum += p.xba; g.baN += 1; }
        else if (isK) { g.baN += 1; }
      }
    }
    if (p.batHand === "L" || p.batHand === "R") {
      usage[p.batHand][p.pitchType] = (usage[p.batHand][p.pitchType] || 0) + 1;
    }
  }
  const pct = (a, b) => (b > 0 ? Math.round((a / b) * 1000) / 10 : null);
  const rows = Object.values(byType).map(g => ({
    type: g.type,
    name: PITCH_NAMES[g.type] || g.type,
    color: PITCH_COLORS[g.type] || "#888",
    n: g.n,
    xwoba: g.wobaN ? g.wobaSum / g.wobaN : null,
    ev: g.ev.length ? Math.round(mean(g.ev) * 10) / 10 : null,
    xba: g.baN ? g.baSum / g.baN : null,
    whiffPct: pct(g.whiffs, g.swings),
    zonePct: pct(g.zone, g.n),
    kPct: pct(g.k, g.pa),
  })).sort((a, b) => b.n - a.n);
  return { rows, usage };
}

// ── Fetch a pitcher's season pitches (Savant for MLB, PBP for AAA) ───────────
async function loadPitches({ playerId, season, isAAA, dateFrom, dateTo, onProgress, cancelled }) {
  if (!isAAA) {
    const rows = (dateFrom || dateTo)
      ? await fetchSavantPlayerDateRange(playerId, season, "pitcher", dateFrom, dateTo)
      : await fetchSavantPlayerSeason(playerId, season, "pitcher");
    return normalizeSavant(rows);
  }
  // AAA: find the pitcher's games — the game log first (their exact games), else
  // fall back to the team's schedule (the game log is empty for many minor
  // leaguers — same reason the live Summaries view keeps a team-based fallback).
  const splits = await fetchGameLog(playerId, season, "pitching", 11).catch(() => []);
  let gamePks = [...new Set((splits || []).map(s => s.game?.gamePk).filter(Boolean))];
  if (!gamePks.length) {
    onProgress("Finding games…");
    const teamId = await fetch(`/mlb-api/api/v1/people/${playerId}?hydrate=currentTeam`)
      .then(r => (r.ok ? r.json() : null))
      .then(d => d?.people?.[0]?.currentTeam?.id ?? null)
      .catch(() => null);
    if (teamId) {
      const games = await fetchSchedule(season, "R", 11).catch(() => []);
      gamePks = [...new Set(games
        .filter(g => g.home?.id === teamId || g.away?.id === teamId)
        .map(g => g.gamePk).filter(Boolean))];
    }
  }
  const all = [];
  const BATCH = 6;
  for (let i = 0; i < gamePks.length; i += BATCH) {
    if (cancelled()) return [];
    onProgress(`Loading games ${Math.min(i + BATCH, gamePks.length)}/${gamePks.length}…`);
    const pbps = await Promise.all(gamePks.slice(i, i + BATCH).map(pk => fetchPlayByPlay(pk).catch(() => null)));
    pbps.forEach((pbp, j) => {
      if (!pbp) return;
      const ps = extractPitcherData(pbp, Number(playerId));
      const gk = gamePks[i + j];
      ps.forEach(p => { p._gameKey = gk; });
      all.push(...ps);
    });
  }
  console.log(`[AAA arsenal] player ${playerId}: ${gamePks.length} games, ${all.length} pitches extracted`);
  return normalizePbp(all);
}

// ── Precomputed season arsenal (public/pitcher_arsenal_{season}.json, AAA:
// public/pitcher_arsenal_aaa_{season}.json) ──────────────────────────────────
// Built daily by build_pitcher_arsenal.py from the season Statcast parquet (AAA:
// its own AAA parquet), so full-season cards render instantly instead of
// live-fetching. The aggregation there mirrors aggregate() below, so the shapes
// are interchangeable.
const arsenalCache = new Map();   // "mlb-2026" / "aaa-2026" -> Promise<{[pid]: entry} | null>
function loadPrecomputed(season, isAAA) {
  const key = `${isAAA ? "aaa" : "mlb"}-${season}`;
  if (!arsenalCache.has(key)) {
    arsenalCache.set(key, fetch(`/pitcher_arsenal${isAAA ? "_aaa" : ""}_${season}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return arsenalCache.get(key);
}

// Expand a precomputed entry into the same {rows, usage, movement} state the live
// path produces (re-attaching pitch names/colors and the MovementPlot shape).
function fromPrecomputed(entry) {
  const rows = (entry.arsenal || []).map(a => ({
    type: a.type,
    name: PITCH_NAMES[a.type] || a.type,
    color: PITCH_COLORS[a.type] || "#888",
    n: a.n,
    xwoba: a.xwoba ?? null,
    ev: a.ev ?? null,
    xba: a.xba ?? null,
    whiffPct: a.whiffPct ?? null,
    zonePct: a.zonePct ?? null,
    kPct: a.kPct ?? null,
  })).sort((a, b) => b.n - a.n);
  const movement = (entry.movement || []).map(([pitchType, hBreak, vBreak]) => ({ pitchType, hBreak, vBreak }));
  const usage = entry.usage || { L: {}, R: {} };
  return { rows, usage, movement };
}

// ════════════════════════════════════════════════════════════════════════════
export default function PitcherArsenal({ playerId, season, isAAA = false, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [state, setState] = useState({ loading: true, progress: "", rows: [], usage: null, movement: [] });

  useEffect(() => {
    if (!playerId) { setState({ loading: false, progress: "", rows: [], usage: null, movement: [] }); return; }
    let cancelled = false;
    setState(s => ({ ...s, loading: true, progress: "" }));
    (async () => {
      try {
        // Full season → try the daily precompute first (instant); fall back to the
        // live fetch (Savant for MLB, play-by-play for AAA) on a miss. Date ranges
        // always live-fetch.
        if (!dateFrom && !dateTo) {
          const map = await loadPrecomputed(season, isAAA);
          if (cancelled) return;
          const entry = map && map[String(playerId)];
          if (entry) {
            setState({ loading: false, progress: "", ...fromPrecomputed(entry) });
            return;
          }
        }
        const pitches = await loadPitches({
          playerId, season, isAAA, dateFrom, dateTo,
          onProgress: (p) => { if (!cancelled) setState(s => ({ ...s, progress: p })); },
          cancelled: () => cancelled,
        });
        if (cancelled) return;
        const { rows, usage } = aggregate(pitches);
        const movement = pitches.filter(p => p.hBreak != null && p.vBreak != null);
        setState({ loading: false, progress: "", rows, usage, movement });
      } catch {
        if (!cancelled) setState({ loading: false, progress: "", rows: [], usage: null, movement: [] });
      }
    })();
    return () => { cancelled = true; };
  }, [playerId, season, isAAA, dateFrom, dateTo]);

  const { loading, progress, rows, usage, movement } = state;
  // Pitch types present, ordered by usage (from the arsenal rows).
  const types = rows.map(r => r.type);

  const box = { padding: "0 2px 4px" };
  const heading = { fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: t.textMuted, marginBottom: 6, textAlign: "center" };

  if (loading) {
    return (
      <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 300, color: t.textMuted, fontSize: 11 }}>
        <style>{`@keyframes ptet-arsenal{to{transform:rotate(360deg)}}`}</style>
        <div style={{ width: 26, height: 26, border: `2px solid ${t.divider}`, borderTopColor: t.accent, borderRadius: "50%", animation: "ptet-arsenal 0.8s linear infinite" }} />
        <div>{progress || "Loading arsenal…"}</div>
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: 300, color: t.textFaint, fontSize: 11, textAlign: "center", padding: 16 }}>
        No pitch data available{isAAA ? " (no tracked AAA games found)" : ""}.
      </div>
    );
  }

  return (
    // Fills the right column top to bottom (the card's columns are equal height), so the
    // three blocks spread out instead of leaving empty space under the table.
    <div style={{ display: "flex", flexDirection: "column", justifyContent: "space-between", gap: 10, height: "100%", flex: 1 }}>
      {/* ── Top: movement, one dot per pitch type (centered in the panel) ── */}
      <div style={box}>
        <div style={heading}>Pitch Movement</div>
        <ArsenalMovement movement={movement} rows={rows} theme={t} />
      </div>

      {/* ── Middle: usage pies vs LHB / RHB ── */}
      <div style={box}>
        <div style={heading}>Pitch Usage</div>
        <div style={{ display: "flex", justifyContent: "space-around", gap: 8 }}>
          <UsagePie label="vs LHB" counts={usage?.L} theme={t} size={92} />
          <UsagePie label="vs RHB" counts={usage?.R} theme={t} size={92} />
        </div>
      </div>

      {/* ── Bottom: arsenal metrics table ── */}
      <div style={box}>
        <div style={heading}>Arsenal by Pitch Type</div>
        <ArsenalTable rows={rows} theme={t} isAAA={isAAA} />
      </div>
    </div>
  );
}

// ── Movement: one dot per pitch type ─────────────────────────────────────────
// Each pitch type sits at its average horizontal / induced vertical break (inches, the
// same convention as the summaries' MovementPlot), with the dot's AREA proportional to
// how many of that pitch he threw. Equal scale on both axes; labelled with name + usage.
function ArsenalMovement({ movement, rows, theme: t }) {
  const acc = {};
  for (const m of movement || []) {
    if (!m.pitchType || !isFinite(m.hBreak) || !isFinite(m.vBreak)) continue;
    const a = (acc[m.pitchType] ||= { h: 0, v: 0, k: 0 });
    a.h += m.hBreak; a.v += m.vBreak; a.k++;
  }
  const total = rows.reduce((s, r) => s + (r.n || 0), 0) || 1;
  const dots = rows
    .filter(r => acc[r.type]?.k)
    .map(r => ({ ...r, h: acc[r.type].h / acc[r.type].k, v: acc[r.type].v / acc[r.type].k, share: (r.n || 0) / total }));
  if (!dots.length) return <div style={{ color: t.textFaint, fontSize: 11, textAlign: "center", padding: 30 }}>No movement data.</div>;

  // Square plot, ±25 in by default, widened in steps of 5 if a pitch sits outside.
  const reach = Math.max(25, ...dots.map(d => Math.ceil((Math.max(Math.abs(d.h), Math.abs(d.v)) + 6) / 5) * 5));
  const W = 440, H = 340, padL = 40, padB = 34, padT = 8, padR = 12;
  const side = Math.min(W - padL - padR, H - padT - padB);
  const x0 = padL + (W - padL - padR - side) / 2, y0 = padT;
  const X = h => x0 + ((h + reach) / (2 * reach)) * side;
  const Y = v => y0 + ((reach - v) / (2 * reach)) * side;
  const maxN = Math.max(...dots.map(d => d.n || 0)) || 1;
  const R = n => 6 + 22 * Math.sqrt((n || 0) / maxN);   // area ∝ count
  const ticks = [];
  for (let g = -Math.floor(reach / 10) * 10; g <= reach; g += 10) ticks.push(g);

  // Labels (name + usage) go below the dot, else above / right / left: the first spot
  // that doesn't cover another dot or label and stays inside the plot.
  const LH = 25, cw = 6.4;
  const placed = [];
  const hits = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  const circleHits = (rect, c) => {
    const nx = Math.max(rect.x, Math.min(c.cx, rect.x + rect.w)), ny = Math.max(rect.y, Math.min(c.cy, rect.y + rect.h));
    return (nx - c.cx) ** 2 + (ny - c.cy) ** 2 < (c.r + 1) ** 2;
  };
  const circles = dots.map(d => ({ type: d.type, cx: X(d.h), cy: Y(d.v), r: R(d.n) }));
  const labelPos = {};
  for (const d of [...dots].sort((a, b) => b.n - a.n)) {
    const c = circles.find(k => k.type === d.type);
    const w = Math.max(d.name.length, 4) * cw + 6;
    const cands = [
      { x: c.cx - w / 2, y: c.cy + c.r + 2 }, { x: c.cx - w / 2, y: c.cy - c.r - 2 - LH },
      { x: c.cx + c.r + 4, y: c.cy - LH / 2 }, { x: c.cx - c.r - 4 - w, y: c.cy - LH / 2 },
    ].map(o => ({ ...o, w, h: LH }));
    const ok = r => r.x >= x0 && r.x + r.w <= x0 + side && r.y >= y0 && r.y + r.h <= y0 + side
      && !placed.some(q => hits(r, q)) && !circles.some(k => k.type !== d.type && circleHits(r, k));
    const pick = cands.find(ok) || cands[0];
    placed.push(pick);
    labelPos[d.type] = pick;
  }
  const tick = { fontSize: 10, fill: t.textFaint, fontFamily: NUM_FONT };
  const dark = t.id === "dark";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} width="100%" style={{ display: "block", maxWidth: W, margin: "0 auto" }}>
      <rect x={x0} y={y0} width={side} height={side} fill={dark ? "rgba(255,255,255,0.025)" : "rgba(15,23,42,0.03)"} rx={4} />
      {ticks.map(g => (
        <g key={g}>
          <line x1={X(g)} x2={X(g)} y1={y0} y2={y0 + side} stroke={g === 0 ? t.textFaint : t.divider} strokeWidth={g === 0 ? 1 : 0.6} strokeDasharray={g === 0 ? "4 4" : undefined} />
          <line x1={x0} x2={x0 + side} y1={Y(g)} y2={Y(g)} stroke={g === 0 ? t.textFaint : t.divider} strokeWidth={g === 0 ? 1 : 0.6} strokeDasharray={g === 0 ? "4 4" : undefined} />
          <text x={X(g)} y={y0 + side + 14} textAnchor="middle" style={tick}>{g}"</text>
          <text x={x0 - 6} y={Y(g) + 3.5} textAnchor="end" style={tick}>{g}"</text>
        </g>
      ))}
      <text x={x0 + side / 2} y={H - 4} textAnchor="middle" style={{ fontSize: 11, fill: t.textMuted }}>Horizontal break (in)</text>
      <text x={11} y={y0 + side / 2} textAnchor="middle" transform={`rotate(-90 11 ${y0 + side / 2})`} style={{ fontSize: 11, fill: t.textMuted }}>Induced vertical break (in)</text>
      {/* biggest first, so smaller pitches sit on top */}
      {[...dots].sort((a, b) => b.n - a.n).map(d => {
        const r = R(d.n), cx = X(d.h), cy = Y(d.v);
        const L = labelPos[d.type], lx = L.x + L.w / 2;
        return (
          <g key={d.type}>
            <circle cx={cx} cy={cy} r={r} fill={d.color} fillOpacity={0.88} stroke={t.cardBg} strokeWidth={2} />
            <text x={lx} y={L.y + 11} textAnchor="middle"
                  style={{ fontSize: 11.5, fontWeight: 700, fill: t.text, paintOrder: "stroke", stroke: t.cardBg, strokeWidth: 3 }}>
              {d.name}
            </text>
            <text x={lx} y={L.y + 23} textAnchor="middle"
                  style={{ fontSize: 10.5, fontWeight: NUM_WEIGHT, fontFamily: NUM_FONT, fill: t.textMuted, paintOrder: "stroke", stroke: t.cardBg, strokeWidth: 3 }}>
              {Math.round(d.share * 100)}%
            </text>
          </g>
        );
      })}
    </svg>
  );
}

// ── Donut pie of pitch usage ─────────────────────────────────────────────────
function UsagePie({ label, counts, theme, size = 70 }) {
  const t = theme;
  const entries = Object.entries(counts || {}).sort((a, b) => b[1] - a[1]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const r = size / 2, cx = r, cy = r, inner = r * 0.55;
  let a0 = -Math.PI / 2;
  const arc = (frac) => {
    const a1 = a0 + frac * Math.PI * 2;
    const large = frac > 0.5 ? 1 : 0;
    const x0 = cx + r * Math.cos(a0), y0 = cy + r * Math.sin(a0);
    const x1 = cx + r * Math.cos(a1), y1 = cy + r * Math.sin(a1);
    const ix1 = cx + inner * Math.cos(a1), iy1 = cy + inner * Math.sin(a1);
    const ix0 = cx + inner * Math.cos(a0), iy0 = cy + inner * Math.sin(a0);
    a0 = a1;
    return `M ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} L ${ix1} ${iy1} A ${inner} ${inner} 0 ${large} 0 ${ix0} ${iy0} Z`;
  };
  return (
    <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 2 }}>
      <div style={{ fontSize: 11.5, fontWeight: 700, color: t.textMuted }}>{label}</div>
      {total > 0 ? (
        <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
          {entries.length === 1 ? (
            // Single pitch type → a full-circle arc path is degenerate; draw a ring.
            <>
              <circle cx={cx} cy={cy} r={r} fill={PITCH_COLORS[entries[0][0]] || "#888"} />
              <circle cx={cx} cy={cy} r={inner} fill={t.cardBg} />
            </>
          ) : (
            entries.map(([type, n]) => (
              <path key={type} d={arc(n / total)} fill={PITCH_COLORS[type] || "#888"} stroke={t.cardBg} strokeWidth={1} />
            ))
          )}
        </svg>
      ) : (
        <div style={{ width: size, height: size, display: "flex", alignItems: "center", justifyContent: "center", color: t.textFaint, fontSize: 10 }}>—</div>
      )}
    </div>
  );
}

// ── Arsenal metrics table ────────────────────────────────────────────────────
function ArsenalTable({ rows, theme, isAAA }) {
  const t = theme;
  const cols = [
    { key: "xwoba",   label: "xwOBA", fmt: v => v == null ? "—" : v.toFixed(3).replace(/^0/, "") },
    { key: "ev",      label: "EV",    fmt: v => v == null ? "—" : v.toFixed(1) },
    { key: "xba",     label: "xBA",   fmt: v => v == null ? "—" : v.toFixed(3).replace(/^0/, "") },
    { key: "whiffPct",label: "Whiff", fmt: v => v == null ? "—" : `${Math.round(v)}%` },
    { key: "zonePct", label: "Zone",  fmt: v => v == null ? "—" : `${Math.round(v)}%` },
    { key: "kPct",    label: "K",     fmt: v => v == null ? "—" : `${Math.round(v)}%` },
  ];
  const th = { fontSize: 9.5, fontWeight: 700, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.03em", padding: "2px 4px 4px", textAlign: "right" };
  // Mirror the percentile-bar fonts: pitch name in the sans label font, numbers in bold Pliant.
  const nameTd = { fontSize: 12.5, fontWeight: 500, color: t.text, padding: "3px 4px", textAlign: "left", whiteSpace: "nowrap", width: "1%" };
  const td = { fontSize: 12.5, fontWeight: NUM_WEIGHT, color: t.textSecondary, padding: "3px 4px", textAlign: "right", fontFamily: NUM_FONT, whiteSpace: "nowrap" };
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", minWidth: 300 }}>
        <thead>
          <tr>
            <th style={{ ...th, textAlign: "left", width: "1%" }}>Pitch</th>
            <th style={{ ...th, textAlign: "right" }}>%</th>
            {cols.map(c => <th key={c.key} style={th}>{c.label}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => {
            const totalN = rows.reduce((s, x) => s + x.n, 0);
            return (
              <tr key={r.type} style={{ borderTop: i ? `1px solid ${t.divider}` : "none" }}>
                <td style={nameTd}>
                  <span style={{ display: "inline-block", width: 7, height: 7, borderRadius: "50%", background: r.color, marginRight: 5 }} />
                  {r.name}
                </td>
                <td style={td}>{totalN ? Math.round((r.n / totalN) * 100) : 0}%</td>
                {cols.map(c => <td key={c.key} style={td}>{c.fmt(r[c.key])}</td>)}
              </tr>
            );
          })}
        </tbody>
      </table>
      {isAAA && rows.every(r => r.xwoba == null && r.xba == null) && (
        <div style={{ fontSize: 8.5, color: t.textFaint, marginTop: 4, fontStyle: "italic", textAlign: "center" }}>
          xwOBA / xBA unavailable at AAA (no Statcast expected stats)
        </div>
      )}
    </div>
  );
}
