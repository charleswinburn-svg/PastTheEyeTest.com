import { useState, useEffect, useMemo } from "react";
import { useTheme } from "./ThemeContext.jsx";
import KdeCurve from "./KdeCurve.jsx";
import { renderHeatmapCanvas } from "./SummaryComponents.jsx";
import { MLB_TEAM_PRIMARY } from "./SharedComponents.jsx";

// Precomputed hitter files (iswing_update.py):
//   /iswing_dist_{season}.json : batterId -> { curve:[density…], mean, n }
//   /intercept_{season}.json   : batterId -> { L:[[x,y],…], R:[[x,y],…] } (inches),
//                                split by batting hand (switch hitters have both).
const distCache = new Map();
const icptCache = new Map();
function loadJson(cache, url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
}

const HEAT_W = 172, HEAT_H = 172;
const HAND_LABEL = { R: "Bats Right", L: "Bats Left", "?": "" };

// One aerial (top-down) intercept heatmap of where the batter makes contact, built
// from the per-swing intercept x/y (inches). Square aspect so proportions are real.
function makeHeat(pts) {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  let xMin = q(xs, 0.02), xMax = q(xs, 0.98), yMin = q(ys, 0.02), yMax = q(ys, 0.98);
  const padX = (xMax - xMin) * 0.15 + 1, padY = (yMax - yMin) * 0.15 + 1;
  xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
  // Square the window (equal inches-per-pixel) so the aerial view isn't stretched.
  const cx = (xMin + xMax) / 2, cy = (yMin + yMax) / 2, half = Math.max(xMax - xMin, yMax - yMin) / 2;
  xMin = cx - half; xMax = cx + half; yMin = cy - half; yMax = cy + half;
  const P = pts.map(([x, y]) => ({ pX: x, pZ: y }));
  const sigma = Math.max(1.4, (xMax - xMin) * 0.03);
  try {
    const url = renderHeatmapCanvas(P, xMin, xMax, yMin, yMax, HEAT_W, HEAT_H, sigma);
    return url ? { url, n: pts.length } : null;
  } catch { return null; }
}

// Two figures below the hitter card: (1) a large KDE of the hitter's own per-swing
// iSwing+ (team-colored, player-mean solid / league-100 dashed); (2) aerial
// intercept-point heatmap(s) of where they make contact — one panel per batting
// hand, so switch hitters get both. MLB only.
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

  // Build one heatmap per batting hand. Normalize the old flat-array format
  // ([[x,y]…]) to a single unlabeled panel so stale data still renders.
  const heats = useMemo(() => {
    if (!icpt) return [];
    const byStand = Array.isArray(icpt) ? { "?": icpt } : icpt;
    return ["R", "L", "?"]
      .filter(s => Array.isArray(byStand[s]) && byStand[s].length >= 8)
      .map(s => { const h = makeHeat(byStand[s]); return h ? { stand: s, ...h } : null; })
      .filter(Boolean);
  }, [icpt]);

  const hasCurve = dist && Array.isArray(dist.curve);
  const isSwitch = heats.length > 1;
  if (isAAA || (!hasCurve && heats.length === 0)) return null;   // nothing (loading or no data)

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
      {heats.length > 0 && (
        <div style={{ flex: "0 0 auto", textAlign: "center" }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase", color: t.textMuted, marginBottom: 4 }}>
            Contact / Intercept Point{isSwitch ? "  ·  switch hitter" : ""}
          </div>
          <div style={{ display: "flex", gap: 12, justifyContent: "center", flexWrap: "wrap" }}>
            {heats.map(h => (
              <div key={h.stand} style={{ textAlign: "center" }}>
                {HAND_LABEL[h.stand] && (
                  <div style={{ fontSize: 8.5, fontWeight: 700, color: t.textSecondary, marginBottom: 2 }}>{HAND_LABEL[h.stand]}</div>
                )}
                <img src={h.url} width={HEAT_W} height={HEAT_H} alt={`intercept ${h.stand}`}
                     style={{ borderRadius: 8, border: `1px solid ${t.divider}`, background: t.inputBg, display: "block" }} />
                <div style={{ fontSize: 8, color: t.textFaint, marginTop: 3 }}>aerial view · pitcher ↑ · {h.n} contacts</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
