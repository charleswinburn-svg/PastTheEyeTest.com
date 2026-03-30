import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { PlayerHeader, saveCardAsPng } from "./SharedComponents.jsx";
import { DARK as t } from "./ThemeContext.jsx";

// ── Merge 5° pipeline buckets into 10° display buckets ──
// Pipeline has 12 buckets: ≤-10, -10/-5, -5/0, 0/5, 5/10, 10/15, 15/20, 20/25, 25/30, 30/35, 35/40, >40
// Merge into 7:  <-10, -10/0, 0/10, 10/20, 20/30, 30/40, >40
const MERGE_MAP = [
  [0],     // <-10°  ← bucket 0
  [1, 2],  // -10 to 0° ← buckets 1+2
  [3, 4],  // 0 to 10°  ← buckets 3+4
  [5, 6],  // 10 to 20° ← buckets 5+6
  [7, 8],  // 20 to 30° ← buckets 7+8
  [9, 10], // 30 to 40° ← buckets 9+10
  [11],    // >40°  ← bucket 11
];
const DISPLAY_LABELS = ["< -10°", "-10 to 0°", "0 to 10°", "10 to 20°", "20 to 30°", "30 to 40°", "> 40°"];
const SHORT_LABELS = ["<-10°", "-10/0°", "0/10°", "10/20°", "20/30°", "30/40°", ">40°"];
const NUM_DISPLAY = 7;

function mergeBuckets(rawBuckets) {
  if (!rawBuckets || rawBuckets.length < 12) return null;
  return MERGE_MAP.map((indices) => {
    let evSum = 0, count = 0, hard = 0;
    for (const idx of indices) {
      const b = rawBuckets[idx];
      if (!b) continue;
      if (b.avg_ev != null && b.count > 0) {
        evSum += b.avg_ev * b.count;
      }
      count += b.count || 0;
      if (b.hard_hit_pct != null && b.count > 0) {
        hard += Math.round(b.hard_hit_pct / 100 * b.count);
      }
    }
    return {
      avg_ev: count > 0 ? Math.round(evSum / count * 10) / 10 : null,
      hard_hit_pct: count > 0 ? Math.round(hard / count * 1000) / 10 : null,
      count,
    };
  });
}


// ── Summary-style coloring: green (above avg) → neutral → red (below avg) ──
function evDiffColor(avgEv, leagueAvgEv) {
  if (avgEv == null || leagueAvgEv == null) return { bg: "#2a2a2a", text: "#aaa" };
  const diff = avgEv - leagueAvgEv;
  const scale = 5; // ±5 mph = full saturation
  let t = Math.max(-1, Math.min(1, diff / scale));
  if (Math.abs(t) < 0.06) return { bg: "#2a2a2a", text: "#ccc" };
  const s = (Math.abs(t) - 0.06) / 0.94;
  const alpha = (0.35 + s * 0.65).toFixed(2);
  if (t > 0) return { bg: `rgba(30,160,30,${alpha})`, text: "#fff" };
  return { bg: `rgba(200,35,35,${alpha})`, text: "#fff" };
}


// ═══════════════════════════════════════════════════════════
// FAN CHART (Canvas)
// ═══════════════════════════════════════════════════════════

function drawBatter(ctx, x, y, s, contactX, contactY) {
  // contactX, contactY = the fan vertex in canvas coords
  // Batter drawn at (x, y), bat tip reaches (contactX, contactY)
  ctx.save();
  ctx.translate(x, y);
  ctx.strokeStyle = "#999";
  ctx.fillStyle = "#999";
  ctx.lineWidth = 2.2 * s;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";

  // Head (simple circle, no helmet curve)
  ctx.beginPath(); ctx.arc(0, -36 * s, 6 * s, 0, Math.PI * 2); ctx.fill();

  // Helmet visor (small brim in front)
  ctx.lineWidth = 2 * s;
  ctx.beginPath(); ctx.moveTo(5 * s, -39 * s); ctx.lineTo(9 * s, -40 * s); ctx.stroke();
  ctx.lineWidth = 2.2 * s;

  // Torso
  ctx.beginPath(); ctx.moveTo(0, -29 * s); ctx.lineTo(-1 * s, -8 * s); ctx.stroke();

  // Front leg (weight forward)
  ctx.beginPath(); ctx.moveTo(-1 * s, -8 * s); ctx.lineTo(7 * s, 7 * s); ctx.lineTo(9 * s, 20 * s); ctx.stroke();

  // Back leg
  ctx.beginPath(); ctx.moveTo(-1 * s, -8 * s); ctx.lineTo(-9 * s, 5 * s); ctx.lineTo(-7 * s, 20 * s); ctx.stroke();

  // Hands position (where arms meet bat)
  const handX = 10 * s, handY = -22 * s;

  // Arms to hands
  ctx.beginPath(); ctx.moveTo(0, -25 * s); ctx.lineTo(6 * s, -18 * s); ctx.lineTo(handX, handY); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(0, -25 * s); ctx.lineTo(-2 * s, -17 * s); ctx.lineTo(handX - 2 * s, handY + 2 * s); ctx.stroke();

  ctx.restore();

  // ── Baseball bat from hands to contact point ──
  const hx = x + 10 * s;
  const hy = y - 22 * s;

  const dx = contactX - hx;
  const dy = contactY - hy;
  const len = Math.sqrt(dx * dx + dy * dy);
  const nx = -dy / len;
  const ny = dx / len;

  // Real bat profile: small knob, thin handle, long gradual taper into barrel
  // Many points for a smooth curve
  const profile = [
    [0.00, 2.8],  // knob bulge
    [0.03, 1.2],  // neck right after knob
    [0.06, 1.0],  // thin handle starts
    [0.15, 0.9],  // handle
    [0.30, 0.9],  // handle
    [0.45, 1.1],  // handle starts widening
    [0.55, 1.5],  // taper zone
    [0.65, 2.1],  // taper zone
    [0.72, 2.7],  // entering barrel
    [0.80, 3.2],  // barrel
    [0.87, 3.4],  // widest barrel
    [0.93, 3.3],  // barrel narrows slightly
    [0.97, 3.0],  // approaching end
    [1.00, 2.6],  // end cap (contact point)
  ];

  // Scale widths
  const sc = s * 1.0;
  const top = profile.map(([t, w]) => ({
    x: hx + dx * t + nx * w * sc,
    y: hy + dy * t + ny * w * sc,
  }));
  const bot = profile.map(([t, w]) => ({
    x: hx + dx * t - nx * w * sc,
    y: hy + dy * t - ny * w * sc,
  }));

  ctx.save();
  // Wood color gradient along bat
  const grad = ctx.createLinearGradient(hx, hy, contactX, contactY);
  grad.addColorStop(0, "#a08060");
  grad.addColorStop(0.3, "#c4a47a");
  grad.addColorStop(0.7, "#d4b48a");
  grad.addColorStop(1, "#c8a878");
  ctx.fillStyle = grad;

  // Draw smooth outline using quadratic curves
  ctx.beginPath();
  ctx.moveTo(top[0].x, top[0].y);
  for (let i = 1; i < top.length; i++) {
    const cpx = (top[i - 1].x + top[i].x) / 2;
    const cpy = (top[i - 1].y + top[i].y) / 2;
    ctx.quadraticCurveTo(top[i - 1].x, top[i - 1].y, cpx, cpy);
  }
  ctx.lineTo(top[top.length - 1].x, top[top.length - 1].y);
  for (let i = bot.length - 1; i >= 1; i--) {
    const cpx = (bot[i].x + bot[i - 1].x) / 2;
    const cpy = (bot[i].y + bot[i - 1].y) / 2;
    ctx.quadraticCurveTo(bot[i].x, bot[i].y, cpx, cpy);
  }
  ctx.lineTo(bot[0].x, bot[0].y);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = "#8a7050";
  ctx.lineWidth = 0.5;
  ctx.stroke();

  // Knob
  ctx.beginPath();
  ctx.arc(hx, hy, 2.8 * sc, 0, Math.PI * 2);
  ctx.fillStyle = "#9a7a5a";
  ctx.fill();
  ctx.restore();
}

function FanChart({ player, leagueAvg, seasonLabel }) {
  const canvasRef = useRef(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !player) return;
    const ctx = canvas.getContext("2d");

    const W = 720, H = 540;
    canvas.width = W * 2; canvas.height = H * 2;
    canvas.style.width = W + "px"; canvas.style.height = H + "px";
    ctx.scale(2, 2);

    ctx.fillStyle = "#151515";
    ctx.fillRect(0, 0, W, H);

    const merged = mergeBuckets(player.buckets);
    const lgMerged = leagueAvg ? mergeBuckets(leagueAvg) : null;
    if (!merged) return;

    const cx = 65, cy = H / 2;
    const R = W - 90;

    // ── Exact LA-to-canvas mapping ──
    // Canvas: 0 rad = horizontal right, negative = up, positive = down
    // LA: 0° = horizontal, positive = up → canvas_angle = -LA * π/180
    // So 0° LA sits exactly horizontal.
    //
    // 7 merged buckets each covering 10° of real LA:
    const BUCKET_LA = [
      [-20, -10], [-10, 0], [0, 10], [10, 20], [20, 30], [30, 40], [40, 50],
    ];

    for (let i = 0; i < NUM_DISPLAY; i++) {
      const b = merged[i];
      const lgB = lgMerged?.[i];
      const { bg, text: txtCol } = evDiffColor(b.avg_ev, lgB?.avg_ev);

      const [laLow, laHigh] = BUCKET_LA[i];
      const aTop = -laHigh * Math.PI / 180; // upper edge (more negative canvas angle)
      const aBot = -laLow * Math.PI / 180;  // lower edge

      // Draw wedge clockwise from top edge to bottom edge
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, aTop, aBot);
      ctx.closePath();
      ctx.fillStyle = bg;
      ctx.fill();

      // Separator line between buckets (at the boundary between this and the one below)
      // Skip the outermost edges (top of bucket 6, bottom of bucket 0)
      if (i > 0) {
        const boundaryAngle = -laLow * Math.PI / 180;
        ctx.strokeStyle = "rgba(255,255,255,0.3)";
        ctx.lineWidth = 1;
        ctx.beginPath();
        ctx.moveTo(cx, cy);
        ctx.lineTo(cx + Math.cos(boundaryAngle) * R, cy + Math.sin(boundaryAngle) * R);
        ctx.stroke();
      }

      // ── Labels ──
      const mid = (aTop + aBot) / 2;

      // LA range label (inner)
      const lr = R * 0.17;
      ctx.save();
      ctx.translate(cx + Math.cos(mid) * lr, cy + Math.sin(mid) * lr);
      let ta = mid; if (Math.cos(mid) < 0) ta += Math.PI;
      ctx.rotate(ta);
      ctx.fillStyle = txtCol;
      ctx.font = "bold 9px -apple-system, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(SHORT_LABELS[i], 0, 0);
      ctx.restore();

      // Avg EV + "MPH" (middle of wedge)
      if (b.avg_ev != null) {
        const er = R * 0.33;
        ctx.save();
        ctx.translate(cx + Math.cos(mid) * er, cy + Math.sin(mid) * er);
        let ta2 = mid; if (Math.cos(mid) < 0) ta2 += Math.PI;
        ctx.rotate(ta2);
        ctx.fillStyle = txtCol;
        ctx.font = "bold 13px 'DM Mono', monospace, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText(b.avg_ev.toFixed(1) + " MPH", 0, 0);
        ctx.restore();
      }

      // Hard-Hit% (outer, closer to EV)
      if (b.hard_hit_pct != null) {
        const hr = R * 0.49;
        ctx.save();
        ctx.translate(cx + Math.cos(mid) * hr, cy + Math.sin(mid) * hr);
        let ta3 = mid; if (Math.cos(mid) < 0) ta3 += Math.PI;
        ctx.rotate(ta3);
        ctx.fillStyle = txtCol;
        ctx.globalAlpha = 0.85;
        ctx.font = "600 9px 'DM Mono', monospace, sans-serif";
        ctx.textAlign = "center";
        ctx.textBaseline = "middle";
        ctx.fillText("Hard-Hit%: " + b.hard_hit_pct.toFixed(0) + "%", 0, 0);
        ctx.globalAlpha = 1;
        ctx.restore();
      }
    }

    // 0° LA reference line (faint dashed horizontal)
    ctx.strokeStyle = "rgba(255,255,255,0.08)";
    ctx.lineWidth = 1;
    ctx.setLineDash([4, 4]);
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.lineTo(cx + R, cy);
    ctx.stroke();
    ctx.setLineDash([]);

    // Batter silhouette
    drawBatter(ctx, cx - 18, cy, 0.8, cx, cy);

    // Color legend
    const lgX = W - 240, lgY = H - 28, lgW = 200, lgH = 14;
    const steps = 40;
    for (let j = 0; j < steps; j++) {
      const diff = ((j / (steps - 1)) * 2 - 1) * 5;
      const { bg: c } = evDiffColor(88 + diff, 88);
      ctx.fillStyle = c;
      ctx.fillRect(lgX + j * (lgW / steps), lgY, lgW / steps + 1, lgH);
    }
    ctx.strokeStyle = "#444"; ctx.lineWidth = 0.5;
    ctx.strokeRect(lgX, lgY, lgW, lgH);
    ctx.fillStyle = "#888"; ctx.font = "9px sans-serif"; ctx.textAlign = "center";
    ctx.fillText("Below Avg", lgX + 30, lgY - 4);
    ctx.fillText("Avg", lgX + lgW / 2, lgY - 4);
    ctx.fillText("Above Avg", lgX + lgW - 30, lgY - 4);

    // BBE + season in bottom-left of canvas
    ctx.fillStyle = "#666";
    ctx.font = "600 10px -apple-system, sans-serif";
    ctx.textAlign = "left";
    ctx.fillText(player.total_bbe + " BBE | " + seasonLabel, 12, H - 4);

    // Watermark bottom-right
    ctx.fillStyle = "#444";
    ctx.font = "italic 9px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("PastTheEyeTest | Savant Data", W - 10, H - 4);

    // ── Compact table in bottom-left corner ──
    const tX = 8, tY = cy + 108;
    const rowH = 16;
    //          LA    BBE  BBE%  LgBBE% ΔBBE%  EV    Lg    ΔEV   HH%   Lg    ΔHH
    const colX = [0, 44, 74, 104, 130, 164, 194, 224, 256, 288, 318];
    const headers = ["LA", "BBE", "BBE%", "Lg%", "\u0394%", "EV", "Lg", "\u0394EV", "HH%", "Lg", "\u0394HH"];

    // Compute totals for BBE%
    const playerTotal = merged.reduce((s, b) => s + (b.count || 0), 0);
    const lgTotal = lgMerged ? lgMerged.reduce((s, b) => s + (b.count || 0), 0) : 0;

    // Header row
    ctx.font = "bold 8px 'DM Mono', monospace, sans-serif";
    ctx.textBaseline = "top";
    for (let c = 0; c < headers.length; c++) {
      ctx.fillStyle = "#777";
      ctx.textAlign = c === 0 ? "left" : "right";
      const xOff = c === 0 ? colX[c] : colX[c] + (colX[c + 1] ? colX[c + 1] - colX[c] : 30) - 2;
      ctx.fillText(headers[c], tX + xOff, tY);
    }

    // Separator
    ctx.strokeStyle = "#333";
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    ctx.moveTo(tX, tY + rowH - 2);
    ctx.lineTo(tX + 345, tY + rowH - 2);
    ctx.stroke();

    // Data rows
    for (let i = 0; i < NUM_DISPLAY; i++) {
      const b = merged[i];
      const lg = lgMerged?.[i];
      const ry = tY + rowH + i * rowH;
      const evDiff = (b.avg_ev != null && lg?.avg_ev != null) ? b.avg_ev - lg.avg_ev : null;
      const hhDiff = (b.hard_hit_pct != null && lg?.hard_hit_pct != null) ? b.hard_hit_pct - lg.hard_hit_pct : null;
      const bbePct = playerTotal > 0 ? (b.count || 0) / playerTotal * 100 : 0;
      const lgBbePct = lgTotal > 0 && lg ? (lg.count || 0) / lgTotal * 100 : 0;
      const bbeDiff = (playerTotal > 0 && lgTotal > 0) ? bbePct - lgBbePct : null;

      ctx.font = "600 8px 'DM Mono', monospace, sans-serif";
      ctx.textBaseline = "top";

      // LA
      ctx.fillStyle = "#aaa"; ctx.textAlign = "left";
      ctx.fillText(SHORT_LABELS[i], tX, ry);

      ctx.textAlign = "right";

      // BBE count
      ctx.fillStyle = "#888";
      ctx.fillText(b.count || "0", tX + 66, ry);

      // BBE%
      ctx.fillStyle = "#aaa";
      ctx.fillText(bbePct.toFixed(0) + "%", tX + 96, ry);

      // Lg BBE%
      ctx.fillStyle = "#666";
      ctx.fillText(lgBbePct.toFixed(0) + "%", tX + 124, ry);

      // ΔBBE%
      if (bbeDiff != null) {
        ctx.fillStyle = Math.abs(bbeDiff) < 1.5 ? "#666" : bbeDiff > 0 ? "#1ea01e" : "#c82323";
        ctx.fillText((bbeDiff > 0 ? "+" : "") + bbeDiff.toFixed(0), tX + 152, ry);
      } else {
        ctx.fillStyle = "#555"; ctx.fillText("\u2014", tX + 152, ry);
      }

      // EV
      const { text: evTc } = evDiffColor(b.avg_ev, lg?.avg_ev);
      ctx.fillStyle = b.avg_ev != null ? evTc : "#555";
      ctx.font = "bold 8px 'DM Mono', monospace, sans-serif";
      ctx.fillText(b.avg_ev != null ? b.avg_ev.toFixed(1) : "\u2014", tX + 186, ry);

      // Lg EV
      ctx.fillStyle = "#666";
      ctx.font = "600 8px 'DM Mono', monospace, sans-serif";
      ctx.fillText(lg?.avg_ev != null ? lg.avg_ev.toFixed(1) : "\u2014", tX + 218, ry);

      // ΔEV
      if (evDiff != null) {
        ctx.fillStyle = evDiff > 0.5 ? "#1ea01e" : evDiff < -0.5 ? "#c82323" : "#666";
        ctx.fillText((evDiff > 0 ? "+" : "") + evDiff.toFixed(1), tX + 250, ry);
      } else {
        ctx.fillStyle = "#555"; ctx.fillText("\u2014", tX + 250, ry);
      }

      // HH%
      ctx.fillStyle = "#aaa";
      ctx.fillText(b.hard_hit_pct != null ? b.hard_hit_pct.toFixed(0) + "%" : "\u2014", tX + 282, ry);

      // Lg HH%
      ctx.fillStyle = "#666";
      ctx.fillText(lg?.hard_hit_pct != null ? lg.hard_hit_pct.toFixed(0) + "%" : "\u2014", tX + 314, ry);

      // ΔHH%
      if (hhDiff != null) {
        ctx.fillStyle = hhDiff > 2 ? "#1ea01e" : hhDiff < -2 ? "#c82323" : "#666";
        ctx.fillText((hhDiff > 0 ? "+" : "") + hhDiff.toFixed(0) + "%", tX + 345, ry);
      } else {
        ctx.fillStyle = "#555"; ctx.fillText("\u2014", tX + 345, ry);
      }
    }

  }, [player, leagueAvg, seasonLabel]);

  if (!player) return null;
  return (
    <canvas
      ref={canvasRef}
      style={{ width: 720, maxWidth: "100%", height: "auto", display: "block", margin: "0 auto" }}
    />
  );
}


// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function EVLAChart({ season }) {
  const [rsData, setRsData] = useState(null);
  const [stData, setStData] = useState(null);
  const [aaaData, setAaaData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [mode, setMode] = useState("regular");
  const [league, setLeague] = useState("MLB");
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [search, setSearch] = useState("");
  const cardRef = useRef(null);

  useEffect(() => {
    setLoading(true);
    setError(null);
    setSelectedPlayer(null);
    Promise.all([
      fetch(`/evla_${season}.json`).then(r => r.ok ? r.json() : null),
      fetch(`/evla_st_${season}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
      fetch(`/evla_aaa_${season}.json`).then(r => r.ok ? r.json() : null).catch(() => null),
    ]).then(([rs, st, aaa]) => {
      if (!rs) {
        setError(`evla_${season}.json not found. Run: python3 evla_pipeline.py ./public ${season}`);
        setLoading(false);
        return;
      }
      setRsData(rs);
      setStData(st);
      setAaaData(aaa);
      setLoading(false);
    }).catch(e => { setError(e.message); setLoading(false); });
  }, [season]);

  const activeData = useMemo(() => {
    if (mode === "spring") return stData;
    if (league === "AAA") return aaaData;
    return rsData;
  }, [mode, league, rsData, stData, aaaData]);

  const players = useMemo(() => {
    if (!activeData?.players) return [];
    let list = activeData.players.map(p => ({ ...p, merged: mergeBuckets(p.buckets) }));
    if (search) {
      const q = search.toLowerCase();
      list = list.filter(p => p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q));
    }
    return list;
  }, [activeData, search]);

  const playerNames = useMemo(() => players.map(p => p.name).sort(), [players]);

  useEffect(() => {
    if (playerNames.length > 0 && (!selectedPlayer || !playerNames.includes(selectedPlayer))) {
      setSelectedPlayer(playerNames[0]);
    }
  }, [playerNames]);

  const curPlayer = useMemo(() => players.find(p => p.name === selectedPlayer), [players, selectedPlayer]);
  const lgMerged = useMemo(() => activeData?.league_avg ? mergeBuckets(activeData.league_avg) : null, [activeData]);

  const seasonLabel = useMemo(() => {
    if (mode === "spring") return `${season} Spring Training`;
    if (league === "AAA") return `${season} AAA`;
    return `${season} MLB`;
  }, [season, mode, league]);

  const saveCard = useCallback(async () => {
    if (!curPlayer || !cardRef.current) return;
    await saveCardAsPng(cardRef, `${curPlayer.name.replace(/\s+/g, "_")}_evla_${season}.png`);
  }, [curPlayer, season]);

  if (loading) return <div style={{ color: "#666", textAlign: "center", padding: 60, fontSize: 13 }}>Loading {season} EV/LA data...</div>;
  if (error) return (
    <div style={{ color: "#d22d49", textAlign: "center", padding: 60, fontSize: 13, lineHeight: 1.8 }}>
      {error}<br /><br />
      <span style={{ color: t.textMuted, fontSize: 12 }}>
        Run: <code style={{ background: t.inputBg, padding: "2px 6px", borderRadius: 3 }}>python3 evla_pipeline.py ./public {season}</code>
      </span>
    </div>
  );

  return (
    <div style={{ maxWidth: 720, margin: "0 auto" }}>
      {/* Controls */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: 2, background: t.inputBg, borderRadius: 6, padding: 2 }}>
          {[["regular", "Regular"], ["spring", "Spring"]].map(([v, label]) => (
            <button key={v} onClick={() => { setMode(v); if (v === "spring") setLeague("MLB"); }}
              disabled={v === "spring" && !stData}
              style={{
                padding: "5px 14px", fontSize: 11, fontWeight: mode === v ? 700 : 500,
                background: mode === v ? "#d22d49" : "transparent",
                color: mode === v ? t.text : (v === "spring" && !stData) ? t.textFaintest : t.textMuted,
                border: "none", borderRadius: 4,
                cursor: (v === "spring" && !stData) ? "default" : "pointer",
                transition: "all 0.15s", fontFamily: "inherit",
                opacity: v === "spring" && !stData ? 0.4 : 1,
              }}
            >{label}</button>
          ))}
        </div>

        {mode === "regular" && (
          <div style={{ display: "flex", gap: 2, background: t.inputBg, borderRadius: 6, padding: 2 }}>
            {["MLB", "AAA"].map(l => (
              <button key={l} onClick={() => setLeague(l)}
                disabled={l === "AAA" && !aaaData}
                style={{
                  padding: "5px 14px", fontSize: 11, fontWeight: league === l ? 700 : 500,
                  background: league === l ? "#333" : "transparent",
                  color: league === l ? t.text : (l === "AAA" && !aaaData) ? t.textFaintest : t.textMuted,
                  border: "none", borderRadius: 4,
                  cursor: (l === "AAA" && !aaaData) ? "default" : "pointer",
                  transition: "all 0.15s", fontFamily: "inherit",
                  opacity: l === "AAA" && !aaaData ? 0.4 : 1,
                }}
              >{l}</button>
            ))}
          </div>
        )}

        <select value={selectedPlayer || ""} onChange={e => setSelectedPlayer(e.target.value)}
          style={{
            padding: "5px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
            borderRadius: 6, color: t.textSecondary, fontSize: 12, outline: "none",
            minWidth: 200, maxWidth: 280, fontFamily: "inherit",
          }}
        >
          {playerNames.map(n => <option key={n} value={n}>{n}</option>)}
        </select>

        <input type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Filter..."
          style={{
            padding: "5px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
            borderRadius: 6, color: t.textSecondary, fontSize: 11, outline: "none",
            width: 110, fontFamily: "inherit",
          }}
        />

        <div style={{ fontSize: 10, color: t.textFaint, marginLeft: "auto" }}>
          {players.length} batters | Min {activeData?.meta?.min_bbe || 30} BBE
        </div>
      </div>

      {/* Card */}
      {curPlayer && (
        <div>
          <div ref={cardRef} style={{
            background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
            overflow: "hidden", boxShadow: "0 4px 24px rgba(0,0,0,0.4)",
          }}>
            <PlayerHeader
              name={curPlayer.name}
              team={curPlayer.team}
              season={season}
              playerId={curPlayer.player_id}
              subtitle={`${seasonLabel} | ${curPlayer.total_bbe} BBE`}
            />
            <div style={{ padding: "4px 12px 12px" }}>
              <FanChart player={curPlayer} leagueAvg={activeData?.league_avg} seasonLabel={seasonLabel} />
            </div>
          </div>

          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={saveCard}
              style={{
                padding: "6px 16px", fontSize: 11, fontWeight: 600,
                background: t.inputBg, color: t.textMuted,
                border: `1px solid ${t.inputBorder}`, borderRadius: 6,
                cursor: "pointer", transition: "all 0.15s",
              }}
              onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
              onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
            >📥 Save as PNG</button>
          </div>

          {/* Bucket table */}
          <div style={{
            background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
            marginTop: 16, overflow: "hidden",
          }}>
            <div style={{ padding: "10px 16px 6px", fontSize: 13, fontWeight: 700, color: t.text }}>
              Bucket Breakdown
            </div>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11 }}>
                <thead>
                  <tr style={{ borderBottom: `2px solid ${t.divider}` }}>
                    {["LA Range", "BBE", "Avg EV", "Lg Avg", "Diff", "HH%", "Lg HH%"].map(h => (
                      <th key={h} style={thS}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {(curPlayer.merged || []).map((b, i) => {
                    const lg = lgMerged?.[i];
                    const { bg, text: tc } = evDiffColor(b.avg_ev, lg?.avg_ev);
                    const diff = (b.avg_ev != null && lg?.avg_ev != null) ? b.avg_ev - lg.avg_ev : null;
                    return (
                      <tr key={i} style={{ borderBottom: `1px solid ${t.tableBorder}`, background: i % 2 === 0 ? t.tableRowA : t.tableRowB }}>
                        <td style={{ ...tdS, textAlign: "left", fontWeight: 600, color: t.textSecondary }}>{DISPLAY_LABELS[i]}</td>
                        <td style={{ ...tdS, color: t.textMuted }}>{b.count || 0}</td>
                        <td style={{ ...tdS, fontWeight: 700, background: bg, color: tc }}>
                          {b.avg_ev != null ? b.avg_ev.toFixed(1) : "\u2014"}
                        </td>
                        <td style={{ ...tdS, color: t.textMuted }}>{lg?.avg_ev != null ? lg.avg_ev.toFixed(1) : "\u2014"}</td>
                        <td style={{
                          ...tdS, fontWeight: 700,
                          color: diff != null ? (diff > 0.5 ? "#1ea01e" : diff < -0.5 ? "#c82323" : "#888") : "#555",
                        }}>
                          {diff != null ? (diff > 0 ? "+" : "") + diff.toFixed(1) : "\u2014"}
                        </td>
                        <td style={{ ...tdS, fontWeight: 600, color: t.textSecondary }}>
                          {b.hard_hit_pct != null ? b.hard_hit_pct.toFixed(1) + "%" : "\u2014"}
                        </td>
                        <td style={{ ...tdS, color: t.textMuted }}>
                          {lg?.hard_hit_pct != null ? lg.hard_hit_pct.toFixed(1) + "%" : "\u2014"}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {!curPlayer && !loading && (
        <div style={{ color: "#666", textAlign: "center", padding: 40, fontSize: 13 }}>
          {players.length === 0 ? "No data for this selection." : "Select a player."}
        </div>
      )}
    </div>
  );
}

const thS = { padding: "6px 8px", textAlign: "center", fontSize: 10, fontWeight: 700, color: "#888", whiteSpace: "nowrap" };
const tdS = { padding: "5px 8px", textAlign: "center", fontSize: 11, whiteSpace: "nowrap", fontFamily: "'DM Mono', monospace" };
