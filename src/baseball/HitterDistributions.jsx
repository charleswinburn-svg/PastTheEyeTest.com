import { useState, useEffect, useMemo } from "react";
import { useTheme } from "./ThemeContext.jsx";
import KdeCurve from "./KdeCurve.jsx";
import { renderHeatmapCanvas } from "./SummaryComponents.jsx";
import { MLB_TEAM_PRIMARY } from "./SharedComponents.jsx";

// Precomputed hitter files (iswing_update.py):
//   /iswing_dist_{season}.json : batterId -> { curve:[density…], mean, n }
//   /intercept_{season}.json   : batterId -> { L:{pts:[[x,y]…], plateX}, R:{…} }
//     Balls-in-play contact points relative to the batter's center of mass (inches),
//     split by hand; plateX = derived home-plate center in that same frame.
const distCache = new Map();
const icptCache = new Map();
function loadJson(cache, url) {
  if (!cache.has(url)) cache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return cache.get(url);
}

const HAND_LABEL = { R: "Bats Right", L: "Bats Left", "?": "" };
const PLATE_OFFSET = 30;   // fallback plate-center offset if the derived value is missing

// Aerial (top-down) heatmap of a batter's ball-in-play contact, PLATE-CENTERED using
// EXACT Savant stance geometry: home plate at the origin, its depth from plateFrontDepth
// (plate front = that far in front of the COM); contact shifted into plate coords; the
// batter's feet + COM at their true position (lower-side, deep in the box); a dashed line
// at the average x-intercept. Orientation forced by hand (RHH left / LHH right) so it
// can't mirror wrong. Flat plate edge up (pitcher), point down (catcher); equal in/px.
function makeHeat(entry, stand) {
  const pts = Array.isArray(entry) ? entry : entry?.pts;
  if (!Array.isArray(pts) || pts.length < 8) return null;
  const q = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };
  const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]);
  const dataHand = q(xs, 0.5) >= 0 ? 1 : -1;
  const plateX = (entry && typeof entry.plateX === "number") ? entry.plateX : dataHand * PLATE_OFFSET;
  const pcDepth = (entry && typeof entry.plateFrontDepth === "number") ? entry.plateFrontDepth - 8.5 : 0; // plate CENTER depth in COM frame
  const avgIy = (entry && typeof entry.avgIy === "number") ? entry.avgIy : q(ys, 0.5);

  // Plate-centered + oriented: shift so plate center → origin, force RHH left / LHH right.
  const want = stand === "L" ? 1 : -1;
  const flip = ((-plateX >= 0 ? 1 : -1) === want) ? 1 : -1;
  const dx = ix => flip * (ix - plateX);
  const dy = iy => iy - pcDepth;
  const cxs = xs.map(dx), cys = ys.map(dy);

  const plateV = [[-8.5, 8.5], [8.5, 8.5], [8.5, 0], [0, -8.5], [-8.5, 0]];   // 17" plate at origin
  const comX = dx(0), comY = dy(0);                 // batter COM (true position)
  const dashY = dy(avgIy);                          // average y-intercept (depth) line
  // Feet: two ellipses straddling the COM in depth, toes toward the plate.
  const toeDir = comX >= 0 ? -1 : 1, sh = 10, fl = 5, fw = 2.2;
  const feetC = [[comX + toeDir * 3, comY + sh], [comX + toeDir * 3, comY - sh]];

  // Frame: contact cloud (2–98 pctile + pad) expanded to include plate + feet/COM.
  let xMin = q(cxs, 0.02), xMax = q(cxs, 0.98), yMin = q(cys, 0.02), yMax = q(cys, 0.98);
  const padX = (xMax - xMin) * 0.1 + 1, padY = (yMax - yMin) * 0.1 + 1;
  xMin -= padX; xMax += padX; yMin -= padY; yMax += padY;
  const incl = [[-8.5, 8.5], [8.5, -8.5], [comX + toeDir * 3 - fl, comY + sh + fw], [comX + toeDir * 3 + fl, comY - sh - fw], [comX, dashY]];
  for (const [px, py] of incl) { xMin = Math.min(xMin, px); xMax = Math.max(xMax, px); yMin = Math.min(yMin, py); yMax = Math.max(yMax, py); }
  yMin -= 3;

  let spanX = xMax - xMin, spanY = yMax - yMin;
  const aspect = Math.min(1.35, Math.max(0.6, spanX / spanY));
  if (spanX / spanY < aspect) { const need = spanY * aspect - spanX; xMin -= need / 2; xMax += need / 2; }
  else if (spanX / spanY > aspect) { const need = spanX / aspect - spanY; yMin -= need / 2; yMax += need / 2; }
  spanX = xMax - xMin; spanY = yMax - yMin;
  const H = 200, W = Math.max(120, Math.round(H * spanX / spanY));

  const P = pts.map(([x, y]) => ({ pX: dx(x), pZ: dy(y) }));
  const sigma = Math.max(1.4, spanX * 0.03);
  let url;
  try { url = renderHeatmapCanvas(P, xMin, xMax, yMin, yMax, W, H, sigma); } catch { return null; }
  if (!url) return null;

  const sx = x => ((x - xMin) / spanX) * W, sy = y => ((yMax - y) / spanY) * H;
  const scl = W / spanX;   // equal inches-per-pixel
  const plate = plateV.map(([x, y]) => `${sx(x).toFixed(1)},${sy(y).toFixed(1)}`).join(" ");
  const feet = feetC.map(([x, y]) => ({ cx: sx(x), cy: sy(y), rx: fl * scl, ry: fw * scl }));
  const com = { cx: sx(comX), cy: sy(comY), r: Math.max(2, 1.7 * scl) };
  const dash = { y: sy(dashY), x1: 4, x2: W - 4 };
  return { url, n: pts.length, W, H, plate, feet, com, dash };
}

// Two figures below the hitter card: (1) a large KDE of the hitter's own per-swing
// iSwing+; (2) aerial intercept heatmap(s) with the batter's feet + a derived home
// plate — one panel per batting hand, so switch hitters get both. MLB only.
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

  // Build one heatmap per batting hand. Normalize the old flat-array format to a
  // single unlabeled panel so stale data still renders.
  const heats = useMemo(() => {
    if (!icpt) return [];
    const byStand = Array.isArray(icpt) ? { "?": icpt } : icpt;
    return ["R", "L", "?"]
      .filter(s => byStand[s] && (Array.isArray(byStand[s]) ? byStand[s].length : byStand[s].pts?.length) >= 8)
      .map(s => { const h = makeHeat(byStand[s], s); return h ? { stand: s, ...h } : null; })
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
                    {/* dashed line: average y-intercept (contact depth) */}
                    <line x1={h.dash.x1} y1={h.dash.y} x2={h.dash.x2} y2={h.dash.y}
                          stroke={teamColor} strokeWidth={1.3} strokeDasharray="4 3" opacity={0.9} />
                    {/* home plate (white halo + dark line so it reads on any color) */}
                    <polygon points={h.plate} fill="rgba(255,255,255,0.10)" stroke="rgba(255,255,255,0.75)" strokeWidth={2.6} strokeLinejoin="round" />
                    <polygon points={h.plate} fill="none" stroke="rgba(15,15,15,0.82)" strokeWidth={1.2} strokeLinejoin="round" />
                    {/* batter's feet */}
                    {h.feet.map((f, i) => (
                      <ellipse key={i} cx={f.cx} cy={f.cy} rx={f.rx} ry={f.ry}
                               fill="rgba(30,30,30,0.5)" stroke="rgba(255,255,255,0.6)" strokeWidth={0.8} />
                    ))}
                    {/* batter center of mass */}
                    <circle cx={h.com.cx} cy={h.com.cy} r={h.com.r + 1.6} fill="none" stroke="rgba(255,255,255,0.85)" strokeWidth={1.4} />
                    <circle cx={h.com.cx} cy={h.com.cy} r={h.com.r} fill={teamColor} />
                  </svg>
                </div>
                <div style={{ fontSize: 8, color: t.textFaint, marginTop: 3 }}>{h.n} in play</div>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 8, color: t.textFaint, marginTop: 4 }}>
            ● = batter (feet) · plate = 17″ · dashed = avg contact depth · aerial · pitcher ↑
          </div>
        </div>
      )}
    </div>
  );
}
