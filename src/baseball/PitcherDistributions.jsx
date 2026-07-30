import { useState, useEffect } from "react";
import { useTheme } from "./ThemeContext.jsx";
import KdeCurve from "./KdeCurve.jsx";
import { PitchTypeLegend } from "./SummaryComponents.jsx";
import { PITCH_COLORS, fetchSavantPlayerDateRange, scorePitchCode } from "./mlbApi.js";
import { gaussianKde } from "./kde.js";

const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

// Precomputed per-pitcher grade distributions (build_pitcher_grade_dist.py):
// pitcher id -> { stuff/loc/tun/pitch : { L|R : { pitchType: [density…] } } }
const distCache = new Map(); // season -> Promise<map|null>
function loadDist(season) {
  if (!distCache.has(season)) {
    distCache.set(season, fetch(`/pitcher_grade_dist_${season}.json`)
      .then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return distCache.get(season);
}

const METRICS = [["stuff", "Stuff+"], ["loc", "Loc+"], ["tun", "Tun+"], ["pitch", "Pitch+"]];
const HANDS = [["L", "vs LHH"], ["R", "vs RHH"]];
const GRADE_KEYS = ["stuff", "loc", "tun", "pitch"];
const MIN_WIN_CURVE = 12;   // min pitches for a windowed (metric, hand, type) curve

// Build the season entry's { metric:{L|R:{type:[densities]}} } shape from a date
// window's scored pitches: score the window's pitches (same API + per-pitch grades
// as the pitcher-card bubbles) and re-fit each (metric, hand, type) KDE on the
// 70-130 grid — so windowed curves land on the same scale as the season ones.
async function scoreWindow(playerId, season, dateFrom, dateTo, xLo, xHi, nPts) {
  const rows = await fetchSavantPlayerDateRange(playerId, season, "pitcher", dateFrom, dateTo).catch(() => []);
  const sv = v => { const f = parseFloat(v); return isNaN(f) ? null : f; };
  const pitches = (rows || [])
    .filter(r => r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO")
    .map(r => ({
      pitcher_id: playerId, _stand: r.stand || "R", _p_throws: r.p_throws || "R",
      _pitchType: r.pitch_type, _pfx_direct: true, game_date: r.game_date,
      details: { type: { code: scorePitchCode(r.pitch_type) } },
      pitchData: {
        startSpeed: sv(r.release_speed), extension: sv(r.release_extension),
        strikeZoneTop: sv(r.sz_top), strikeZoneBottom: sv(r.sz_bot),
        coordinates: {
          pfxX: sv(r.pfx_x), pfxZ: sv(r.pfx_z), pX: sv(r.plate_x), pZ: sv(r.plate_z),
          x0: sv(r.release_pos_x), z0: sv(r.release_pos_z),
          vX0: sv(r.vx0), vY0: sv(r.vy0), vZ0: sv(r.vz0),
          aX: sv(r.ax), aY: sv(r.ay), aZ: sv(r.az),
        },
        breaks: { spinRate: sv(r.release_spin_rate), spinDirection: sv(r.spin_axis) },
      },
    }));
  if (!pitches.length) return null;

  const resp = await fetch(`${PITCH_PLUS_API}/score_aggregate`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ pitches, start_date: dateFrom || undefined, end_date: dateTo || undefined }),
  });
  if (!resp.ok) return null;
  const scored = await resp.json();
  const perPitch = scored?.per_pitch || [];

  // Collect grade values by metric -> hand -> pitch type (per_pitch is index-aligned
  // to the input pitches, so hand/type come from our own payload).
  const bucket = {};
  for (const m of GRADE_KEYS) bucket[m] = { L: {}, R: {} };
  perPitch.forEach((g, i) => {
    const p = pitches[i];
    if (!g || !p) return;
    const hand = p._stand === "L" ? "L" : "R";
    const pt = p._pitchType;
    for (const m of GRADE_KEYS) {
      const v = g[m];
      if (v == null) continue;
      (bucket[m][hand][pt] ||= []).push(v);
    }
  });

  const entry = {};
  let anyCurve = false;
  for (const m of GRADE_KEYS) {
    entry[m] = { L: {}, R: {} };
    for (const st of ["L", "R"]) {
      for (const [pt, vals] of Object.entries(bucket[m][st])) {
        if (vals.length < MIN_WIN_CURVE) continue;
        const dens = gaussianKde(vals, xLo, xHi, nPts);
        if (dens) { entry[m][st][pt] = dens; anyCurve = true; }
      }
    }
  }
  return anyCurve ? entry : null;
}

// 8 KDE figures — Stuff+/Loc+/Tun+/Pitch+, each split vs LHH / vs RHH — with one
// curve per pitch type (colored by PITCH_COLORS), all on a shared x-scale. A date
// range recomputes the curves for that window; otherwise the precomputed season
// file is used. MLB only (no AAA grades).
export default function PitcherDistributions({ playerId, season, isAAA = false, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [state, setState] = useState({ loading: true, entry: null, meta: null });
  const [win, setWin] = useState({ loading: false, entry: null });
  const active = !!(dateFrom || dateTo);

  useEffect(() => {
    if (isAAA || !playerId) { setState({ loading: false, entry: null, meta: null }); return; }
    let cancelled = false;
    setState(s => ({ ...s, loading: true }));
    loadDist(season).then(map => {
      if (cancelled) return;
      setState({ loading: false, entry: (map && map[String(playerId)]) || null, meta: map?.meta || null });
    });
    return () => { cancelled = true; };
  }, [playerId, season, isAAA]);

  const meta = state.meta;
  const xLo = meta?.xLo ?? 70, xHi = meta?.xHi ?? 130, nPts = meta?.nPts ?? 64;

  useEffect(() => {
    if (isAAA || !playerId || !active) { setWin({ loading: false, entry: null }); return; }
    let cancelled = false;
    setWin({ loading: true, entry: null });
    scoreWindow(playerId, season, dateFrom, dateTo, xLo, xHi, nPts)
      .then(entry => { if (!cancelled) setWin({ loading: false, entry }); })
      .catch(() => { if (!cancelled) setWin({ loading: false, entry: null }); });
    return () => { cancelled = true; };
  }, [playerId, season, isAAA, active, dateFrom, dateTo, xLo, xHi, nPts]);

  const entry = active ? win.entry : state.entry;
  const windowed = active && !!win.entry;

  if (isAAA) return null;
  if (active && win.loading && !win.entry) {
    return (
      <div style={{ maxWidth: 1040, margin: "12px auto 0", textAlign: "center", fontSize: 11, color: t.textFaint }}>
        Scoring pitches in this date range…
      </div>
    );
  }
  if (state.loading && !active) return null;
  if (!entry) {
    if (active) return (
      <div style={{ maxWidth: 1040, margin: "12px auto 0", textAlign: "center", fontSize: 11, color: t.textFaint }}>
        Not enough pitches in this date range for grade distributions.
      </div>
    );
    return null;
  }

  const typeSet = new Set();
  for (const [m] of METRICS) for (const [h] of HANDS) Object.keys(entry[m]?.[h] || {}).forEach(pt => typeSet.add(pt));
  const types = [...typeSet];

  const fig = (m, mLabel, h) => {
    const byType = entry[m]?.[h] || {};
    const curves = Object.entries(byType).map(([pt, densities]) => ({ densities, color: PITCH_COLORS[pt] || "#888", label: pt }));
    return (
      <KdeCurve
        curves={curves}
        xLo={xLo} xHi={xHi}
        width={240} height={124}
        fill
        refLines={[{ x: 100, dashed: true, color: t.textFaint }]}
        title={mLabel}
      />
    );
  };

  return (
    <div style={{ maxWidth: 1040, margin: "16px auto 0", padding: "0 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: t.textMuted, textAlign: "center", marginBottom: 6 }}>
        Grade Distributions by Pitch Type{windowed ? "  ·  date range" : ""}
      </div>
      <PitchTypeLegend types={types} />
      {/* 4 metrics across × 2 rows: vs LHH on top, vs RHH below */}
      {HANDS.map(([h, hLabel]) => (
        <div key={h} style={{ marginTop: 10 }}>
          <div style={{ fontSize: 10, fontWeight: 700, letterSpacing: "0.04em", color: t.textSecondary, textAlign: "center", margin: "2px 0 4px" }}>
            {hLabel}
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(190px, 1fr))", gap: "8px 14px", justifyItems: "center" }}>
            {METRICS.map(([m, mLabel]) => (
              <div key={m} style={{ width: "100%", display: "flex", justifyContent: "center" }}>
                {fig(m, mLabel, h)}
              </div>
            ))}
          </div>
        </div>
      ))}
    </div>
  );
}
