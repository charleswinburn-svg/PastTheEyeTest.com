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

  const fig = (m, mLabel, h, hLabel) => {
    const byType = entry[m]?.[h] || {};
    const curves = Object.entries(byType).map(([pt, densities]) => ({ densities, color: PITCH_COLORS[pt] || "#888", label: pt }));
    return (
      <KdeCurve
        curves={curves}
        xLo={xLo} xHi={xHi}
        width={480} height={128}
        refLines={[{ x: 100, dashed: true, color: t.textFaint }]}
        title={`${mLabel} ${hLabel}`}
      />
    );
  };

  return (
    <div style={{ maxWidth: 1040, margin: "16px auto 0", padding: "0 12px" }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: t.textMuted, textAlign: "center", marginBottom: 6 }}>
        Grade Distributions by Pitch Type
      </div>
      <PitchTypeLegend types={types} />
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: "12px 20px", marginTop: 8, justifyItems: "center" }}>
        {METRICS.map(([m, mLabel]) => HANDS.map(([h, hLabel]) => (
          <div key={m + h} style={{ width: "100%", display: "flex", justifyContent: "center" }}>
            {fig(m, mLabel, h, hLabel)}
          </div>
        )))}
      </div>
    </div>
  );
}
