import { useState, useEffect, useMemo } from "react";
import { useTheme } from "./ThemeContext.jsx";
import KdeCurve from "./KdeCurve.jsx";
import { renderHeatmapCanvas } from "./SummaryComponents.jsx";
import { MLB_TEAM_PRIMARY } from "./SharedComponents.jsx";

// Precomputed hitter files (iswing_update.py):
//   /iswing_dist_{season}.json : batterId -> { curve:[density…], mean, n }
//   /intercept_{season}.json   : batterId -> [[x_side, y_depth], …] (inches)
const distCache = new Map();
const icptCache = new Map();
function loadJson(cache, url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
}

// Two figures below the hitter card: (1) a large KDE of the hitter's own per-swing
// iSwing+ (team-colored, player-mean solid / league-100 dashed); (2) an aerial
// intercept-point heatmap of where they make contact. MLB only.
export default function HitterDistributions({ playerId, team, season, isAAA = false }) {
  const { theme: t } = useTheme();
  const [dist, setDist] = useState(undefined);   // undefined=loading, null=none
  const [distMeta, setDistMeta] = useState(null);
  const [icpt, setIcpt] = useState(undefined);

  useEffect(() => {
    if (isAAA || !playerId) { setDist(null); setIcpt(null); return; }
    let cancelled = false;
    setDist(undefined); setIcpt(undefined);
    loadJson(distCache, `/iswing_dist_${season}.json`).then(m => { if (!cancelled) { setDist((m && m[String(playerId)]) || null); setDistMeta(m?.meta || null); } });
    loadJson(icptCache, `/intercept_${season}.json`).then(m => { if (!cancelled) setIcpt((m && m[String(playerId)]) || null); });
    return () => { cancelled = true; };
  }, [playerId, season, isAAA]);

  const teamColor = MLB_TEAM_PRIMARY[team] || t.accent;

  // Intercept heatmap → canvas data URL (auto-framed to the player's contact cloud).
  const heat = useMemo(() => {
    if (!Array.isArray(icpt) || icpt.length < 5) return null;
    const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
    const xs = icpt.map(p => p[0]), ys = icpt.map(p => p[1]);
    let xMin = q(xs, 0.02), xMax = q(xs, 0.98), yMin = q(ys, 0.02), yMax = q(ys, 0.98);
    const padX = (xMax - xMin) * 0.15 + 1, padY = (yMax - yMin) * 0.15 + 1;
    xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
    const pts = icpt.map(([x, y]) => ({ pX: x, pZ: y }));
    const sigma = Math.max(1.2, (xMax - xMin) * 0.045);
    try {
      const url = renderHeatmapCanvas(pts, xMin, xMax, yMin, yMax, 180, 180, sigma);
      return url ? { url, n: icpt.length } : null;
    } catch { return null; }
  }, [icpt]);

  const hasCurve = dist && Array.isArray(dist.curve);
  if (isAAA || (!hasCurve && !heat)) return null;   // nothing (loading or no data)

  return (
    <div style={{ maxWidth: 1040, margin: "16px auto 0", padding: "0 12px", display: "flex", flexWrap: "wrap", gap: 24, justifyContent: "center", alignItems: "flex-start" }}>
      {hasCurve && (
        <div style={{ flex: "1 1 520px", maxWidth: 640 }}>
          <KdeCurve
            title={`iSwing+ Distribution  ·  avg ${Math.round(dist.mean)}`}
            curves={[{ densities: dist.curve, color: teamColor, label: "iSwing+" }]}
            xLo={distMeta?.xLo ?? 40} xHi={distMeta?.xHi ?? 180}
            width={640} height={200}
            fill
            refLines={[
              { x: dist.mean, color: teamColor, dashed: false },
              { x: 100, color: t.textMuted, dashed: true },
            ]}
          />
          <div style={{ fontSize: 9, color: t.textFaint, marginTop: 2 }}>
            Solid = player avg · dashed = league (100) · {dist.n} swings
          </div>
        </div>
      )}
      {heat && (
        <div style={{ flex: "0 0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: t.textMuted, marginBottom: 4 }}>
            Contact / Intercept Point
          </div>
          <img src={heat.url} width={180} height={180} alt="intercept heatmap"
               style={{ borderRadius: 8, border: `1px solid ${t.divider}`, background: t.inputBg }} />
          <div style={{ fontSize: 8.5, color: t.textFaint, marginTop: 3 }}>aerial view · {heat.n} contacts</div>
        </div>
      )}
    </div>
  );
}
