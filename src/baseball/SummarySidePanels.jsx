import { useEffect, useId, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";
import { ReleaseDiagram } from "./SimilarityFigures.jsx";
import { loadSimilarityPool } from "./similarity.js";
import { PITCH_COLORS, PITCH_NAMES } from "./mlbApi.js";
import { gaussianKde } from "./kde.js";
import { loadDist } from "./PitcherDistributions.jsx";
import { plusColor, plusPct, readableOnCard } from "../ui/colorScale.js";

// ═══════════════════════════════════════════════════════════
// SUMMARIES SIDE PANELS (left/right panel dropdown options)
// ═══════════════════════════════════════════════════════════
// Both are built from the pitches the Summary has already loaded, so they show that
// game (Pitcher Game) or that season / date range (Pitcher Season).

const isNum = v => typeof v === "number" && Number.isFinite(v);
const mean = a => a.reduce((s, v) => s + v, 0) / a.length;
const median = a => { const s = [...a].sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Same estimate as build_similarity_pitchers.py / score_pitches.py when Savant has no
// arm angle: shoulder at 70% of height, angle of shoulder → release from vertical,
// reported as 90° − that (0° = sidearm, 90° = straight over the top).
function geometricArmAngle(relXArm, relZ, heightIn) {
  if (!isNum(relXArm) || !isNum(relZ) || !isNum(heightIn)) return null;
  const adj = relZ * 12 - heightIn * 0.70;
  const opp = Math.abs(relXArm * 12);
  const fromVertical = Math.atan2(opp, adj) * 180 / Math.PI;
  return 90 - fromVertical;
}

// Pitches → the record shape ReleaseDiagram reads (same as similarity_pitchers_{year}.json):
// release x mirrored to arm side (+ = arm side), means like the builder, per-type points
// for types with ≥ 5 pitches. `base` is the season's similarity record, if any.
// Arm angle: with a season record, Savant's measured season angle shifted by how much the
// geometric estimate moves between the season's release point and these pitches' (the
// height assumption cancels out, and low slots stay right: the geometric estimate alone
// reads a submariner ~25° too high). Without one, the geometric estimate alone.
export function releaseFromPitches(pitches, { hand, team, base = null } = {}) {
  const pts = (pitches || []).filter(p => isNum(p.relX) && isNum(p.relHeight));
  if (pts.length < 3) return null;
  const h = hand === "L" || hand === "R" ? hand : (median(pts.map(p => p.relX)) < 0 ? "R" : "L");
  const sign = h === "L" ? 1 : -1;
  const xs = pts.map(p => p.relX * sign), zs = pts.map(p => p.relHeight);
  const exts = pts.map(p => p.extension).filter(isNum);
  const byType = {};
  for (const p of pts) {
    const k = p.pitchType;
    if (!k || k === "UN") continue;
    (byType[k] ||= []).push(p);
  }
  const arsenal = {};
  for (const [k, list] of Object.entries(byType)) {
    if (list.length < 5) continue;
    arsenal[k] = { n: list.length, rel_x: mean(list.map(p => p.relX * sign)), rel_z: mean(list.map(p => p.relHeight)) };
  }
  const height = isNum(base?.height) ? base.height : 74;   // inches; 6'2" when unknown
  const rx = mean(xs), rz = mean(zs);
  const here = geometricArmAngle(rx, rz, height);
  const bv = base?.v || {};
  const anchored = isNum(bv.arm_angle) && isNum(bv.release_x) && isNum(bv.release_z) && isNum(here)
    ? bv.arm_angle + here - geometricArmAngle(bv.release_x, bv.release_z, height) : null;
  return {
    hand: h, team: team || base?.team || "", height,
    v: { release_x: rx, release_z: rz, extension: exts.length ? mean(exts) : null, arm_angle: anchored ?? here },
    arsenal, n: pts.length, angleSource: anchored != null ? "savant" : "estimate",
  };
}

function Note({ t, children, height }) {
  return (
    <div style={{ height, display: "flex", alignItems: "center", justifyContent: "center", textAlign: "center",
                  padding: "0 18px", fontSize: 11, color: t.textMuted, lineHeight: 1.5 }}>{children}</div>
  );
}

export function SummaryReleasePanel({ pitches, player, season, width = 260, height = 400 }) {
  const { theme: t } = useTheme();
  const [base, setBase] = useState(undefined);
  useEffect(() => {
    let cancelled = false;
    setBase(undefined);
    if (!player?.id) { setBase(null); return; }
    loadSimilarityPool("pitcher", [Number(String(season).slice(0, 4))])
      .then(pools => { if (!cancelled) setBase(pools[0]?.players?.[String(player.id)] || null); })
      .catch(() => { if (!cancelled) setBase(null); });
    return () => { cancelled = true; };
  }, [player?.id, season]);

  const rec = useMemo(
    () => (base === undefined ? null : releaseFromPitches(pitches, { hand: player?.pitchHand?.code || base?.hand, team: player?.team, base })),
    [pitches, base, player?.pitchHand?.code, player?.team],
  );
  if (base === undefined) return <Note t={t} height={height}>Loading release data…</Note>;
  if (!rec) return <Note t={t} height={height}>No release-point data for these pitches.</Note>;
  return (
    <div style={{ height, display: "flex", flexDirection: "column", justifyContent: "center", overflow: "hidden" }}>
      <ReleaseDiagram p={rec} width={width} />
      <div style={{ fontSize: 9, color: t.textFaint, textAlign: "center", marginTop: 2 }}>
        {rec.n} pitches · arm angle {rec.angleSource === "savant" ? "from Savant's season angle, adjusted to these pitches" : "estimated from release"}
      </div>
    </div>
  );
}

// ── Stuff+ violins: one horizontal violin per pitch type, Stuff+ left → right ──
// Every violin shares one axis and one gradient, so a pitch's color is its Stuff+ on the
// site scale: ice below 100, fire above. Rows run most-thrown first. A tick marks each
// type's median and the number on the right is its mean.
// Full regular season: drawn at once from the pipeline's precomputed per-pitcher Stuff+
// distributions (pitcher_grade_dist_{year}.json, the file the pitcher card's
// distributions use), each pitch type's vs-LHH and vs-RHH curves weighted by how often
// this Summary's pitches of that type went to each side. Games and date ranges (and
// pitchers missing from the file) use the per-pitch scores from the Pitch+ API instead.
export function StuffViolinPanel({ pitches, perPitchScores, pitchKey, playerId = null, season = null, isAAA = false,
                                   fullSeason = false, tableGrades = null, seasonGrades = null, width = 260, height = 400 }) {
  const { theme: t, isDark } = useTheme();
  const gid = useId().replace(/[^a-zA-Z0-9_-]/g, "");

  const [dist, setDist] = useState(undefined);   // undefined = loading, null = not available
  useEffect(() => {
    let cancelled = false;
    if (!fullSeason || !playerId || !season) { setDist(null); return; }
    setDist(undefined);
    loadDist(String(season).slice(0, 4), isAAA)
      .then(all => {
        if (cancelled) return;
        const stuff = all?.[String(playerId)]?.stuff;
        setDist(stuff ? { meta: all.meta || {}, stuff } : null);
      })
      .catch(() => { if (!cancelled) setDist(null); });
    return () => { cancelled = true; };
  }, [fullSeason, playerId, season, isAAA]);

  const model = useMemo(() => {
    const counts = {};
    for (const p of pitches || []) {
      const k = p.pitchType;
      if (!k || k === "UN") continue;
      const c = (counts[k] ||= { n: 0, L: 0, R: 0 });
      c.n++;
      if (p.batSide === "L") c.L++; else if (p.batSide === "R") c.R++;
    }
    const byUse = Object.keys(counts).sort((a, b) => counts[b].n - counts[a].n);

    if (dist) {
      const lo = isNum(dist.meta.xLo) ? dist.meta.xLo : 70, hi = isNum(dist.meta.xHi) ? dist.meta.xHi : 130;
      const series = [];
      for (const k of byUse) {
        const L = dist.stuff.L?.[k], R = dist.stuff.R?.[k];
        if (!L && !R) continue;
        let wL = L ? counts[k].L : 0, wR = R ? counts[k].R : 0;
        if (!wL && !wR) { wL = L ? 1 : 0; wR = R ? 1 : 0; }
        const len = (L || R).length;
        const dens = Array.from({ length: len }, (_, j) => (wL * (L?.[j] || 0) + wR * (R?.[j] || 0)) / (wL + wR));
        series.push({ k, n: counts[k].n, dens, ...gridStats(dens, lo, hi) });
      }
      if (series.length) return { lo, hi, series, source: "season" };
    }

    if (!perPitchScores || !pitchKey) return null;   // still scoring
    const by = {};
    for (const p of pitches || []) {
      const k = p.pitchType;
      if (!k || k === "UN") continue;
      const s = perPitchScores.get(pitchKey(p))?.stuff;
      if (isNum(s)) (by[k] ||= []).push(s);
    }
    const ks = Object.keys(by).sort((a, b) => by[b].length - by[a].length);
    if (!ks.length) return { series: [] };
    // Shared axis: 2nd–98th percentile of every pitch, always including 70–130, in steps of 10.
    const all = ks.flatMap(k => by[k]).sort((a, b) => a - b);
    const q = f => all[Math.min(all.length - 1, Math.max(0, Math.round(f * (all.length - 1))))];
    const lo = Math.min(70, Math.floor(q(0.02) / 10) * 10);
    const hi = Math.max(130, Math.ceil(q(0.98) / 10) * 10);
    const series = ks.map(k => {
      const vals = by[k];
      const dens = vals.length >= 3 ? gaussianKde(vals, lo, hi, 72) : null;
      return { k, n: vals.length, dens, dots: dens ? null : vals, mean: mean(vals), median: median(vals) };
    });
    return { lo, hi, series, source: "pitches" };
  }, [pitches, perPitchScores, pitchKey, dist]);

  if (fullSeason && dist === undefined && !model) return <Note t={t} height={height}>Loading season Stuff+…</Note>;
  if (!model) return <Note t={t} height={height}>Scoring pitches for Stuff+…</Note>;
  if (!model.series.length) return <Note t={t} height={height}>No Stuff+ for these pitches.</Note>;

  // Match the pitch table exactly: each violin is centred on the Stuff+ the table shows
  // for that pitch type, and the tick and number are that value. The table grades the
  // pitcher's average on the league-rescaled scale, while these curves are individual
  // pitches on the natural per-pitch scale, so their raw means differ by a few points.
  // The shape is the real spread of individual pitches, moved to sit on the table's value.
  const tableOf = (k) => {
    const v = tableGrades?.[k]?.stuffPlus ?? seasonGrades?.[k]?.stuff;
    return isNum(v) ? v : null;
  };
  const series = model.series.map(s => {
    const c = tableOf(s.k);
    return { ...s, shift: c != null && isNum(s.mean) ? c - s.mean : 0, value: c ?? s.mean, fromTable: c != null };
  });
  const minShift = Math.min(0, ...series.map(s => s.shift)), maxShift = Math.max(0, ...series.map(s => s.shift));
  const lo = Math.min(70, Math.floor((model.lo + minShift) / 10) * 10);
  const hi = Math.max(130, Math.ceil((model.hi + maxShift) / 10) * 10);
  const LABEL_W = 62, VALUE_W = 30, TOP = 30, BOTTOM = 28;
  const x0 = LABEL_W, x1 = width - VALUE_W - 4;
  const X = v => x0 + (Math.max(lo, Math.min(hi, v)) - lo) / (hi - lo) * (x1 - x0);
  const rowH = Math.min(56, (height - TOP - BOTTOM) / series.length);
  const ticks = [];
  const step = hi - lo > 100 ? 40 : 20;
  for (let v = Math.ceil(lo / step) * step; v <= hi; v += step) ticks.push(v);
  const gradStops = Array.from({ length: 13 }, (_, i) => lo + (hi - lo) * i / 12);
  const txt = { fontSize: 9, fill: t.textFaint, fontFamily: "inherit" };
  // Few pitch types: rows keep their max height and the block is centred in the panel.
  const plotTop = TOP + Math.max(0, (height - TOP - BOTTOM - rowH * series.length) / 2);
  const plotBottom = plotTop + rowH * series.length;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} style={{ display: "block" }}>
      <defs>
        <linearGradient id={`vg-${gid}`} gradientUnits="userSpaceOnUse" x1={X(lo)} y1={0} x2={X(hi)} y2={0}>
          {gradStops.map(v => <stop key={v} offset={(v - lo) / (hi - lo)} stopColor={plusColor(v, isDark)} />)}
        </linearGradient>
      </defs>
      <text x={width / 2} y={12} textAnchor="middle" style={{ fontSize: 10, fontWeight: 700, fill: t.accent, fontFamily: "inherit" }}>
        Stuff+ by pitch · every pitch
      </text>
      <text x={width / 2} y={23} textAnchor="middle" style={txt}>← below average · 100 · above average →</text>

      {/* gridlines + league-average line */}
      {ticks.map(v => (
        <line key={v} x1={X(v)} x2={X(v)} y1={plotTop} y2={plotBottom} stroke={v === 100 ? t.textMuted : t.divider}
              strokeWidth={v === 100 ? 1 : 0.6} strokeDasharray={v === 100 ? "3 3" : undefined} />
      ))}

      {series.map(({ k, n, dens, dots, shift, value: m }, i) => {
        const cy = plotTop + rowH * (i + 0.5);
        const half = rowH * 0.42;
        let path = null;
        if (dens) {
          const peak = Math.max(...dens) || 1;
          const xs = dens.map((_, j) => X(model.lo + (model.hi - model.lo) * j / (dens.length - 1) + shift));
          const up = dens.map((d, j) => `${xs[j].toFixed(1)},${(cy - (d / peak) * half).toFixed(1)}`);
          const dn = dens.map((d, j) => `${xs[j].toFixed(1)},${(cy + (d / peak) * half).toFixed(1)}`).reverse();
          path = `M ${up.join(" L ")} L ${dn.join(" L ")} Z`;
        }
        const name = PITCH_NAMES[k] || k;
        return (
          <g key={k}>
            <circle cx={8} cy={cy} r={3.5} fill={PITCH_COLORS[k] || "#888"} />
            <text x={15} y={cy - 1} style={{ fontSize: 10, fontWeight: 700, fill: t.text, fontFamily: "inherit" }}>
              {name.length > 9 ? k : name}
            </text>
            <text x={15} y={cy + 10} style={{ ...txt, fontFamily: NUM_FONT }}>{n} pitch{n === 1 ? "" : "es"}</text>
            {path ? (
              <path d={path} fill={`url(#vg-${gid})`} stroke={isDark ? "rgba(255,255,255,0.25)" : "rgba(15,23,42,0.25)"} strokeWidth={0.6} />
            ) : (
              (dots || []).map((v, j) => <circle key={j} cx={X(v + shift)} cy={cy} r={3} fill={plusColor(v + shift, isDark)} />)
            )}
            {isNum(m) && <line x1={X(m)} x2={X(m)} y1={cy - half * 0.7} y2={cy + half * 0.7} stroke={isDark ? "#0b1220" : "#0f172a"} strokeWidth={2} />}
            {isNum(m) && (
              <text x={width - 2} y={cy + 4} textAnchor="end"
                    style={{ fontSize: 12, fontWeight: NUM_WEIGHT, fontFamily: NUM_FONT, fill: plusPct(m) > 45 && plusPct(m) < 55 ? t.textSecondary : readableOnCard(plusColor(m, isDark), t) }}>
                {m.toFixed(0)}
              </text>
            )}
          </g>
        );
      })}

      {ticks.map(v => (
        <text key={v} x={X(v)} y={plotBottom + 12} textAnchor="middle" style={{ ...txt, fontFamily: NUM_FONT }}>{v}</text>
      ))}
      <text x={(x0 + x1) / 2} y={plotBottom + 23} textAnchor="middle" style={txt}>
        {series.some(s => s.fromTable) ? "Tick & number = table Stuff+ · shape = each pitch" : "Per-pitch Stuff+ · tick & number = mean"}
      </text>
    </svg>
  );
}

// Mean and median of a density sampled on an even grid over [lo, hi].
function gridStats(dens, lo, hi) {
  const n = dens.length, xs = dens.map((_, j) => lo + (hi - lo) * j / (n - 1));
  const tot = dens.reduce((s, d) => s + d, 0);
  if (!(tot > 0)) return { mean: null, median: null };
  const m = dens.reduce((s, d, j) => s + d * xs[j], 0) / tot;
  let acc = 0, med = xs[n - 1];
  for (let j = 0; j < n; j++) {
    const next = acc + dens[j];
    if (next >= tot / 2) { med = j ? xs[j - 1] + (xs[j] - xs[j - 1]) * ((tot / 2 - acc) / dens[j]) : xs[0]; break; }
    acc = next;
  }
  return { mean: m, median: med };
}
