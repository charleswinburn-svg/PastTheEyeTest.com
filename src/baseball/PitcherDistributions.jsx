import { useState, useEffect } from "react";
import { useTheme } from "./ThemeContext.jsx";
import KdeCurve from "./KdeCurve.jsx";
import { PitchTypeLegend } from "./SummaryComponents.jsx";
import { PITCH_COLORS } from "./mlbApi.js";

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

// 8 KDE figures — Stuff+/Loc+/Tun+/Pitch+, each split vs LHH / vs RHH — with one
// curve per pitch type (colored by PITCH_COLORS), all on a shared x-scale. Renders
// below the pitcher card, stacking vertically. MLB only (no AAA grades).
export default function PitcherDistributions({ playerId, season, isAAA = false }) {
  const { theme: t } = useTheme();
  const [state, setState] = useState({ loading: true, entry: null, meta: null });

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

  const { loading, entry, meta } = state;
  if (isAAA || loading || !entry) return null;   // quiet if AAA / loading / no data

  const xLo = meta?.xLo ?? 40, xHi = meta?.xHi ?? 160;
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
        Grade Distributions by Pitch Type
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
