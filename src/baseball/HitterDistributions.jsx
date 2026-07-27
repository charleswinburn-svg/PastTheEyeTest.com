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

const HAND_LABEL = { R: "Bats Right", L: "Bats Left", "?": "" };
const PLATE_HALF = 8.5;    // home plate is 17" wide
const PLATE_OFFSET = 30;   // approx. batter-center → plate-center lateral distance (inches)

// One aerial (top-down) intercept heatmap of where the batter makes contact, built
// from the per-swing intercept x/y (inches, relative to the batter). A home-plate
// reference is drawn to true 17" scale on the correct side (from the data's x-sign),
// flat edge toward the pitcher (up), point toward the catcher (down). The canvas keeps
// equal inches-per-pixel so proportions — and the plate — aren't stretched.
function makeHeat(pts) {
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);

  // Home plate, batter-relative: centered laterally toward the contact side, depth
  // centered on the batter (front edge +8.5 → point −8.5). Vertices clockwise.
  const hand = q(xs, 0.5) >= 0 ? 1 : -1;
  const pcx = hand * PLATE_OFFSET;
  const plateV = [
    [pcx - PLATE_HALF, 8.5], [pcx + PLATE_HALF, 8.5],
    [pcx + PLATE_HALF, 0], [pcx, -8.5], [pcx - PLATE_HALF, 0],
  ];

  // Frame = contact cloud (2–98 pctile + pad) expanded to include the plate.
  let xMin = q(xs, 0.02), xMax = q(xs, 0.98), yMin = q(ys, 0.02), yMax = q(ys, 0.98);
  const padX = (xMax - xMin) * 0.12 + 1, padY = (yMax - yMin) * 0.12 + 1;
  xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
  for (const [px, py] of plateV) { xMin = Math.min(xMin, px); xMax = Math.max(xMax, px); yMin = Math.min(yMin, py); yMax = Math.max(yMax, py); }
  yMin -= 3;   // small margin below the plate point

  // Clamp aspect (pad the shorter axis) so the canvas isn't absurdly narrow/wide,
  // then size W/H = spanX/spanY exactly → equal inches-per-pixel (undistorted plate).
  let spanX = xMax - xMin, spanY = yMax - yMin;
  const aspect = Math.min(1.3, Math.max(0.62, spanX / spanY));
  if (spanX / spanY < aspect) { const need = spanY * aspect - spanX; xMin -= need / 2; xMax += need / 2; }
  else if (spanX / spanY > aspect) { const need = spanX / aspect - spanY; yMin -= need / 2; yMax += need / 2; }
  spanX = xMax - xMin; spanY = yMax - yMin;
  const H = 192, W = Math.max(96, Math.round(H * spanX / spanY));

  const P = pts.map(([x, y]) => ({ pX: x, pZ: y }));
  const sigma = Math.max(1.4, spanX * 0.03);
  let url;
  try { url = renderHeatmapCanvas(P, xMin, xMax, yMin, yMax, W, H, sigma); } catch { return null; }
  if (!url) return null;

  const sx = x => ((x - xMin) / spanX) * W, sy = y => ((yMax - y) / spanY) * H;   // matches canvas cy
  const plate = plateV.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  return { url, n: pts.length, W, H, plate };
}

// Two figures below the hitter card: (1) a large KDE of the hitter's own per-swing
// iSwing+ (team-colored, player-mean solid / league-100 dashed); (2) aerial
// intercept-point heatmap(s) with a home-plate reference — one panel per batting
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
                <div style={{ position: "relative", width: h.W, height: h.H, margin: "0 auto" }}>
                  <img src={h.url} width={h.W} height={h.H} alt={`intercept ${h.stand}`}
                       style={{ borderRadius: 8, border: `1px solid ${t.divider}`, background: t.inputBg, display: "block" }} />
                  <svg width={h.W} height={h.H} viewBox={`0 0 ${h.W} ${h.H}`}
                       style={{ position: "absolute", inset: 0, pointerEvents: "none" }}>
                    {/* white halo + dark line so the plate reads on any heatmap color */}
                    <polygon points={h.plate} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.75)" strokeWidth={2.6} strokeLinejoin="round" />
                    <polygon points={h.plate} fill="none" stroke="rgba(15,15,15,0.8)" strokeWidth={1.2} strokeLinejoin="round" />
                  </svg>
                </div>
                <div style={{ fontSize: 8, color: t.textFaint, marginTop: 3 }}>{h.n} contacts</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 8, color: t.textFaint, marginTop: 4 }}>outline = home plate (17″) · aerial view · pitcher ↑</div>
        </div>
      )}
    </div>
  );
}
