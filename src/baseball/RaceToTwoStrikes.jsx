import { useState, useEffect, useMemo, useCallback, useRef } from "react";
import { getLogoUrl, getHeadshotUrl } from "./SharedComponents.jsx";
import { useTheme } from "./ThemeContext.jsx";

// ── MLB Team primary colors ──
const TEAM_COLORS = {
  ARI: "#A71930", ATL: "#CE1141", BAL: "#DF4601", BOS: "#BD3039",
  CHC: "#0E3386", CHW: "#27251F", CIN: "#C6011F", CLE: "#00385D",
  COL: "#333366", DET: "#0C2340", HOU: "#EB6E1F", KCR: "#004687",
  KC: "#004687", LAA: "#BA0021", LAD: "#005A9C", MIA: "#00A3E0",
  MIL: "#FFC52F", MIN: "#002B5C", NYM: "#FF5910", NYY: "#003087",
  OAK: "#003831", ATH: "#003831", PHI: "#E81828", PIT: "#FDB827",
  SDP: "#2F241D", SD: "#2F241D", SEA: "#0C2C56", SFG: "#FD5A1E",
  SF: "#FD5A1E", STL: "#C41E3A", TBR: "#092C5C", TB: "#092C5C",
  TEX: "#003278", TOR: "#134A8E", WSH: "#AB0003", WSN: "#AB0003",
};
const teamColor = (abbr) => TEAM_COLORS[abbr?.toUpperCase()] || "#d22d49";


// ═══════════════════════════════════════════════════════════
// LEADERBOARD BAR (horizontal, hockey-style)
// ═══════════════════════════════════════════════════════════

function LeaderboardBar({ rank, name, team, value, minValue, maxValue, isSelected, onClick }) {
  const { theme: t } = useTheme();
  // Invert: lower avg = longer bar (better/faster)
  const range = maxValue - minValue;
  const barPct = range > 0 ? ((maxValue - value) / range) * 85 + 15 : 50;
  const color = teamColor(team);
  const logo = getLogoUrl(team);

  return (
    <div
      onClick={onClick}
      style={{
        display: "flex", alignItems: "center", gap: 10, padding: "6px 12px",
        cursor: "pointer",
        background: isSelected ? "rgba(210,45,73,0.12)" : "transparent",
        borderLeft: isSelected ? "3px solid #d22d49" : "3px solid transparent",
        transition: "all 0.15s",
      }}
      onMouseEnter={e => { if (!isSelected) e.currentTarget.style.background = "rgba(255,255,255,0.03)"; }}
      onMouseLeave={e => { if (!isSelected) e.currentTarget.style.background = "transparent"; }}
    >
      <div style={{ width: 22, fontSize: 11, fontWeight: 700, color: t.textFaint, textAlign: "right", fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
        {rank}
      </div>
      <div style={{ width: 28, height: 28, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {logo ? (
          <img src={logo} alt={team} style={{ width: 28, height: 28, objectFit: "contain" }}
            onError={e => { e.target.style.display = "none"; }} />
        ) : (
          <div style={{ fontSize: 9, color: t.textMuted, fontWeight: 700 }}>{team}</div>
        )}
      </div>
      <div style={{ width: 160, fontSize: 13, fontWeight: 600, color: t.text, flexShrink: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
        {name}
      </div>
      <div style={{ flex: 1, position: "relative", height: 26, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ position: "absolute", inset: 0, background: t.inputBg, borderRadius: 3 }} />
        <div style={{
          position: "absolute", left: 0, top: 0, bottom: 0,
          width: `${barPct}%`,
          background: `linear-gradient(90deg, ${color}cc, ${color})`,
          borderRadius: 3,
          transition: "width 0.8s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
        }} />
      </div>
      <div style={{ width: 44, textAlign: "right", fontSize: 14, fontWeight: 800, color: t.text, fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
        {value.toFixed(2)}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// CANVAS RACE RECORDER
// ═══════════════════════════════════════════════════════════

const W = 1920, H = 540; // video dimensions
const RACE_MS = 3000;     // race duration
const HOLD_MS = 1500;     // hold on winner frame
const FPS = 60;

async function loadImg(src) {
  return new Promise((resolve) => {
    if (!src) return resolve(null);
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => resolve(null);
    img.src = src;
  });
}

function drawRaceFrame(ctx, p1, p2, p1Prog, p2Prog, logo1, logo2, finished) {
  const winner = finished ? (p1.avg_pitches_to_2k < p2.avg_pitches_to_2k ? 1 : p2.avg_pitches_to_2k < p1.avg_pitches_to_2k ? 2 : 0) : 0;

  // Background
  ctx.fillStyle = "#0d0d0d";
  ctx.fillRect(0, 0, W, H);

  // Title
  ctx.fillStyle = "#fff";
  ctx.font = "bold 32px -apple-system, BlinkMacSystemFont, sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("Race to 2 Strikes", W / 2, 50);

  // Draw each lane
  const lanes = [
    { player: p1, prog: p1Prog, logo: logo1, y: 120, isWinner: winner === 1 },
    { player: p2, prog: p2Prog, logo: logo2, y: 320, isWinner: winner === 2 },
  ];

  const trackL = 240, trackR = W - 80;
  const trackW = trackR - trackL;

  for (const lane of lanes) {
    const { player, prog, logo, y, isWinner } = lane;
    const color = teamColor(player.team);

    // Logo
    if (logo) {
      ctx.drawImage(logo, 30, y - 5, 64, 64);
    }

    // Name
    ctx.textAlign = "left";
    ctx.fillStyle = isWinner ? "#4ade80" : "#eee";
    ctx.font = "bold 26px -apple-system, BlinkMacSystemFont, sans-serif";
    ctx.fillText(player.name, 110, y + 22);

    // Stat
    ctx.fillStyle = "#888";
    ctx.font = "600 18px 'DM Mono', monospace, sans-serif";
    ctx.fillText(player.avg_pitches_to_2k.toFixed(2) + " avg pitches", 110, y + 50);

    // Winner badge
    if (isWinner) {
      ctx.fillStyle = "#4ade80";
      ctx.font = "bold 18px sans-serif";
      ctx.fillText("⚡ FASTER", 380, y + 50);
    }

    // Track background
    const ty = y + 75;
    ctx.fillStyle = "#1a1a1a";
    roundRect(ctx, trackL, ty, trackW, 56, 10);
    ctx.fill();

    // Track border
    ctx.strokeStyle = "#2a2a2a";
    ctx.lineWidth = 1;
    roundRect(ctx, trackL, ty, trackW, 56, 10);
    ctx.stroke();

    // Finish line
    ctx.fillStyle = "#d22d49";
    ctx.fillRect(trackR - 4, ty, 4, 56);

    // 2K label
    ctx.fillStyle = "#d22d49";
    ctx.font = "bold 14px sans-serif";
    ctx.textAlign = "right";
    ctx.fillText("2K", trackR - 10, ty + 34);

    // Trail
    const ballX = trackL + prog * trackW;
    const gradient = ctx.createLinearGradient(trackL, 0, ballX, 0);
    gradient.addColorStop(0, "transparent");
    gradient.addColorStop(1, color + "88");
    ctx.fillStyle = gradient;
    roundRect(ctx, trackL + 4, ty + 23, Math.max(0, ballX - trackL - 4), 10, 5);
    ctx.fill();

    // Ball
    ctx.beginPath();
    ctx.arc(Math.min(ballX, trackR - 24), ty + 28, 22, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.strokeStyle = isWinner ? "#4ade80" : "#333";
    ctx.lineWidth = 3;
    ctx.stroke();

    // Baseball emoji text
    ctx.fillStyle = "#fff";
    ctx.font = "22px sans-serif";
    ctx.textAlign = "center";
    ctx.fillText("⚾", Math.min(ballX, trackR - 24), ty + 36);
  }

  // Watermark
  ctx.fillStyle = "#333";
  ctx.font = "14px sans-serif";
  ctx.textAlign = "center";
  ctx.fillText("PastTheEyeTest | Savant Pitch Data", W / 2, H - 20);
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

async function recordRace(p1, p2, onProgress, onDone) {
  const canvas = document.createElement("canvas");
  canvas.width = W;
  canvas.height = H;
  const ctx = canvas.getContext("2d");

  // Preload logos
  const [logo1, logo2] = await Promise.all([
    loadImg(getLogoUrl(p1.team)),
    loadImg(getLogoUrl(p2.team)),
  ]);

  // Setup recorder
  const stream = canvas.captureStream(FPS);
  const mimeType = MediaRecorder.isTypeSupported("video/webm;codecs=vp9")
    ? "video/webm;codecs=vp9"
    : "video/webm";
  const recorder = new MediaRecorder(stream, { mimeType, videoBitsPerSecond: 8_000_000 });
  const chunks = [];
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data); };
  recorder.onstop = () => {
    const blob = new Blob(chunks, { type: mimeType });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    const safeName = (p1.name + "_vs_" + p2.name).replace(/\s+/g, "_");
    a.download = `race2k_${safeName}.webm`;
    a.href = url;
    a.click();
    URL.revokeObjectURL(url);
    onDone();
  };

  recorder.start();

  // Speeds
  const maxVal = Math.max(p1.avg_pitches_to_2k, p2.avg_pitches_to_2k);
  const s1 = maxVal / p1.avg_pitches_to_2k;
  const s2 = maxVal / p2.avg_pitches_to_2k;

  const totalFrames = Math.ceil((RACE_MS + HOLD_MS) / (1000 / FPS));

  return new Promise((resolve) => {
    let frame = 0;
    const renderFrame = () => {
      const elapsed = (frame / FPS) * 1000;
      const p1Prog = Math.min(1, (elapsed / RACE_MS) * s1);
      const p2Prog = Math.min(1, (elapsed / RACE_MS) * s2);
      const finished = elapsed >= RACE_MS;

      drawRaceFrame(ctx, p1, p2, p1Prog, p2Prog, logo1, logo2, finished);

      frame++;
      if (onProgress) onProgress(frame / totalFrames);

      if (frame <= totalFrames) {
        requestAnimationFrame(renderFrame);
      } else {
        recorder.stop();
        resolve();
      }
    };
    renderFrame();
  });
}


// ═══════════════════════════════════════════════════════════
// RACE COMPONENT (DOM animation + record button)
// ═══════════════════════════════════════════════════════════

function RaceComparison({ player1, player2, players }) {
  const { theme: t } = useTheme();
  const [racing, setRacing] = useState(false);
  const [finished, setFinished] = useState(false);
  const [p1Pos, setP1Pos] = useState(0);
  const [p2Pos, setP2Pos] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recProgress, setRecProgress] = useState(0);
  const animRef = useRef(null);
  const startRef = useRef(null);

  const p1 = player1 != null ? players.find(p => p.player_id === player1) : null;
  const p2 = player2 != null ? players.find(p => p.player_id === player2) : null;

  const startRace = useCallback(() => {
    if (!p1 || !p2) return;
    setRacing(true);
    setFinished(false);
    setP1Pos(0);
    setP2Pos(0);
    startRef.current = null;

    const maxVal = Math.max(p1.avg_pitches_to_2k, p2.avg_pitches_to_2k);
    const p1Speed = maxVal / p1.avg_pitches_to_2k;
    const p2Speed = maxVal / p2.avg_pitches_to_2k;
    const raceDuration = 2500;

    const animate = (ts) => {
      if (!startRef.current) startRef.current = ts;
      const elapsed = ts - startRef.current;
      const p1Prog = Math.min(1, (elapsed / raceDuration) * p1Speed);
      const p2Prog = Math.min(1, (elapsed / raceDuration) * p2Speed);
      setP1Pos(p1Prog * 100);
      setP2Pos(p2Prog * 100);
      if (p1Prog < 1 || p2Prog < 1) {
        animRef.current = requestAnimationFrame(animate);
      } else {
        setRacing(false);
        setFinished(true);
      }
    };
    animRef.current = requestAnimationFrame(animate);
  }, [p1, p2]);

  const resetRace = useCallback(() => {
    if (animRef.current) cancelAnimationFrame(animRef.current);
    setRacing(false);
    setFinished(false);
    setP1Pos(0);
    setP2Pos(0);
  }, []);

  const doRecord = useCallback(async () => {
    if (!p1 || !p2 || recording) return;
    setRecording(true);
    setRecProgress(0);
    // Also run the DOM animation for visual feedback
    startRace();
    await recordRace(p1, p2, setRecProgress, () => setRecording(false));
  }, [p1, p2, recording, startRace]);

  useEffect(() => { resetRace(); }, [player1, player2]);
  useEffect(() => () => { if (animRef.current) cancelAnimationFrame(animRef.current); }, []);

  if (!p1 || !p2) return null;
  const winner = finished ? (p1.avg_pitches_to_2k < p2.avg_pitches_to_2k ? 1 : p2.avg_pitches_to_2k < p1.avg_pitches_to_2k ? 2 : 0) : 0;

  const RunnerLane = ({ player, pos, isWinner }) => {
    const logo = getLogoUrl(player.team);
    const color = teamColor(player.team);
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
          {logo && <img src={logo} alt="" style={{ width: 20, height: 20, objectFit: "contain" }} onError={e => e.target.style.display = "none"} />}
          <span style={{ fontSize: 13, fontWeight: 700, color: isWinner ? "#4ade80" : "#ddd" }}>{player.name}</span>
          <span style={{ fontSize: 11, color: t.textMuted, fontFamily: "'DM Mono', monospace" }}>{player.avg_pitches_to_2k.toFixed(2)} pitches</span>
          {isWinner && <span style={{ fontSize: 11, fontWeight: 700, color: "#4ade80" }}>⚡ FASTER</span>}
        </div>
        <div style={{ position: "relative", height: 44, borderRadius: 8, background: t.inputBg, border: `1px solid ${t.cardBorder}`, overflow: "hidden" }}>
          <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 3, background: "#d22d49", zIndex: 1 }} />
          <div style={{ position: "absolute", right: 0, top: 0, bottom: 0, width: 24, background: "rgba(210,45,73,0.08)" }} />
          <div style={{
            position: "absolute", left: 0, top: "50%", transform: "translateY(-50%)",
            width: `${pos}%`, height: 6, borderRadius: 3,
            background: `linear-gradient(90deg, transparent, ${color}88)`,
            transition: racing ? "none" : "width 0.3s",
          }} />
          <div style={{
            position: "absolute", left: `${Math.min(pos, 96)}%`, top: "50%",
            transform: "translate(-50%, -50%)",
            width: 34, height: 34, borderRadius: "50%",
            background: color, border: `2px solid ${isWinner ? "#4ade80" : "#333"}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: `0 0 ${racing ? 12 : 4}px ${color}66`,
            transition: racing ? "none" : "left 0.3s", zIndex: 2,
          }}>
            <span style={{ fontSize: 16 }}>⚾</span>
          </div>
          <div style={{ position: "absolute", right: 6, top: "50%", transform: "translateY(-50%)", fontSize: 8, fontWeight: 800, color: "#d22d49", letterSpacing: "0.1em", zIndex: 3 }}>
            2K
          </div>
        </div>
      </div>
    );
  };

  return (
    <div style={{ background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`, padding: 20, marginTop: 20 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: t.text, letterSpacing: "-0.02em" }}>
          🏃 Race to 2 Strikes
        </div>
        <div style={{ display: "flex", gap: 8 }}>
          <button
            onClick={racing ? resetRace : startRace}
            disabled={recording}
            style={{
              padding: "6px 20px", fontSize: 12, fontWeight: 700,
              background: racing ? "#333" : "#d22d49", color: t.text,
              border: "none", borderRadius: 6, cursor: "pointer", transition: "all 0.15s",
              opacity: recording ? 0.4 : 1,
            }}
          >
            {racing ? "⏹ Stop" : finished ? "🔄 Race Again" : "🏁 Go!"}
          </button>
          <button
            onClick={doRecord}
            disabled={recording || racing}
            style={{
              padding: "6px 16px", fontSize: 11, fontWeight: 600,
              background: recording ? t.inputBg : t.inputBg, color: recording ? "#d22d49" : t.textMuted,
              border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: recording ? "default" : "pointer",
              transition: "all 0.15s",
            }}
          >
            {recording ? `🔴 ${Math.round(recProgress * 100)}%` : "🎬 Save Video"}
          </button>
        </div>
      </div>
      <RunnerLane player={p1} pos={p1Pos} isWinner={winner === 1} />
      <RunnerLane player={p2} pos={p2Pos} isWinner={winner === 2} />
      {finished && winner === 0 && (
        <div style={{ textAlign: "center", fontSize: 12, color: t.textMuted, marginTop: 8 }}>It's a tie!</div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// MAIN COMPONENT
// ═══════════════════════════════════════════════════════════

export default function RaceToTwoStrikes({ season }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [aaaData, setAaaData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [league, setLeague] = useState("MLB");
  const [role, setRole] = useState("SP");
  const [raceP1, setRaceP1] = useState(null);
  const [raceP2, setRaceP2] = useState(null);
  const [search, setSearch] = useState("");

  // Load pre-computed JSON
  useEffect(() => {
    setLoading(true);
    setError(null);
    setRaceP1(null);
    setRaceP2(null);
    fetch(`/race2k_${season}.json`)
      .then(r => {
        if (!r.ok) throw new Error(`race2k_${season}.json not found. Run: python3 race2k_pipeline.py ./public ${season}`);
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });

    // Try AAA (optional, won't error if missing)
    fetch(`/race2k_aaa_${season}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setAaaData(d))
      .catch(() => setAaaData(null));
  }, [season]);

  const activeData = league === "AAA" ? aaaData : data;

  const leaderboard = useMemo(() => {
    if (!activeData) return [];
    const list = role === "SP" ? (activeData.starters || []) : (activeData.relievers || []);
    if (!search) return list;
    const q = search.toLowerCase();
    return list.filter(p =>
      p.name.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q)
    );
  }, [activeData, role, search]);

  const maxVal = useMemo(() => {
    if (leaderboard.length === 0) return 4;
    return Math.max(...leaderboard.map(p => p.avg_pitches_to_2k));
  }, [leaderboard]);

  const minVal = useMemo(() => {
    if (leaderboard.length === 0) return 2;
    return Math.min(...leaderboard.map(p => p.avg_pitches_to_2k));
  }, [leaderboard]);

  // Auto-select top 2 for race on data/role change
  useEffect(() => {
    if (leaderboard.length >= 2) {
      setRaceP1(leaderboard[0].player_id);
      setRaceP2(leaderboard[1].player_id);
    } else {
      setRaceP1(null);
      setRaceP2(null);
    }
  }, [activeData, role]);

  const raceOptions = leaderboard;

  if (loading) {
    return <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>Loading {season} Race to 2K data...</div>;
  }
  if (error) {
    return (
      <div style={{ color: "#d22d49", textAlign: "center", padding: 60, fontSize: 13, lineHeight: 1.8 }}>
        {error}<br /><br />
        <span style={{ color: t.textMuted, fontSize: 12 }}>
          Run: <code style={{ background: t.inputBg, padding: "2px 6px", borderRadius: 3 }}>python3 race2k_pipeline.py ./public {season}</code>
        </span>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 760, margin: "0 auto" }}>
      {/* ── Controls ── */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        {/* League toggle */}
        <div style={{ display: "flex", gap: 2, background: t.inputBg, borderRadius: 6, padding: 2 }}>
          {["MLB", "AAA"].map(l => (
            <button key={l} onClick={() => setLeague(l)}
              style={{
                padding: "5px 14px", fontSize: 11, fontWeight: league === l ? 700 : 500,
                background: league === l ? "#d22d49" : "transparent",
                color: league === l ? "#fff" : aaaData || l === "MLB" ? "#888" : "#444",
                border: "none", borderRadius: 4, cursor: aaaData || l === "MLB" ? "pointer" : "default",
                transition: "all 0.15s", fontFamily: "inherit",
                opacity: l === "AAA" && !aaaData ? 0.4 : 1,
              }}
              disabled={l === "AAA" && !aaaData}
            >{l}</button>
          ))}
        </div>

        {/* Role toggle */}
        <div style={{ display: "flex", gap: 2, background: t.inputBg, borderRadius: 6, padding: 2 }}>
          {[["SP", "Starters"], ["RP", "Relievers"]].map(([v, label]) => (
            <button key={v} onClick={() => setRole(v)}
              style={{
                padding: "5px 14px", fontSize: 11, fontWeight: role === v ? 700 : 500,
                background: role === v ? "#333" : "transparent",
                color: role === v ? "#fff" : "#888",
                border: "none", borderRadius: 4, cursor: "pointer",
                transition: "all 0.15s", fontFamily: "inherit",
              }}
            >{label}</button>
          ))}
        </div>

        {/* Search */}
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search..."
          style={{
            padding: "5px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
            borderRadius: 6, color: t.textSecondary, fontSize: 11, outline: "none",
            width: 140, fontFamily: "inherit",
          }}
        />

        {/* Stats */}
        <div style={{ fontSize: 10, color: t.textFaint, marginLeft: "auto" }}>
          {leaderboard.length} {role === "SP" ? "starters" : "relievers"} | Min {activeData?.meta?.min_ip || 20} IP | {season}
        </div>
      </div>

      {/* ── Leaderboard ── */}
      {leaderboard.length > 0 && (
        <div style={{ background: t.headerBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`, overflow: "hidden" }}>
          <div style={{
            padding: "12px 16px 8px", display: "flex", alignItems: "center",
            justifyContent: "space-between", borderBottom: "1px solid #222",
          }}>
            <div style={{ fontSize: 14, fontWeight: 800, color: t.text }}>
              Avg Pitches to 2 Strikes
            </div>
            <div style={{ fontSize: 10, color: t.textMuted }}>
              Click to add to race • Lower = faster ahead in counts
            </div>
          </div>

          <div style={{ maxHeight: 600, overflowY: "auto", padding: "4px 0" }}>
            {leaderboard.map((p, i) => (
              <LeaderboardBar
                key={p.player_id}
                rank={i + 1}
                name={p.name}
                team={p.team}
                value={p.avg_pitches_to_2k}
                minValue={minVal}
                maxValue={maxVal}
                isSelected={p.player_id === raceP1 || p.player_id === raceP2}
                onClick={() => {
                  if (p.player_id === raceP1) { setRaceP1(null); return; }
                  if (p.player_id === raceP2) { setRaceP2(null); return; }
                  if (!raceP1) setRaceP1(p.player_id);
                  else if (!raceP2) setRaceP2(p.player_id);
                  else setRaceP2(p.player_id);
                }}
              />
            ))}
          </div>

          <div style={{
            padding: "6px 16px", fontSize: 10, color: t.textFaint,
            borderTop: "1px solid #222", display: "flex", justifyContent: "space-between",
          }}>
            <span>{season} Regular Season | Min {activeData?.meta?.min_ip || 20} IP | {role === "SP" ? (activeData?.meta?.gs_threshold || 10) + "+ GS" : "< " + (activeData?.meta?.gs_threshold || 10) + " GS"}</span>
            <span style={{ fontStyle: "italic" }}>PastTheEyeTest | Savant Pitch Data</span>
          </div>
        </div>
      )}

      {leaderboard.length === 0 && !loading && (
        <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>
          No qualifying {role === "SP" ? "starters" : "relievers"} found.
          {league === "AAA" && " Run: python3 race2k_pipeline.py ./public " + season + " --aaa"}
        </div>
      )}

      {/* ── Race section ── */}
      {leaderboard.length >= 2 && (
        <div>
          <div style={{ display: "flex", gap: 12, marginTop: 16, flexWrap: "wrap" }}>
            {[
              { label: "Runner 1", value: raceP1, setter: setRaceP1 },
              { label: "Runner 2", value: raceP2, setter: setRaceP2 },
            ].map(({ label, value, setter }) => (
              <div key={label} style={{ flex: 1, minWidth: 200 }}>
                <div style={{ fontSize: 10, color: t.textMuted, marginBottom: 4 }}>{label}</div>
                <select value={value || ""} onChange={e => setter(e.target.value ? parseInt(e.target.value) : null)}
                  style={{
                    width: "100%", padding: "6px 10px", background: t.inputBg,
                    border: `1px solid ${t.inputBorder}`, borderRadius: 6, color: t.textSecondary,
                    fontSize: 12, outline: "none", fontFamily: "inherit",
                  }}
                >
                  <option value="">Select...</option>
                  {raceOptions.map(p => (
                    <option key={p.player_id} value={p.player_id}>
                      {p.name} ({p.team}) — {p.avg_pitches_to_2k.toFixed(2)}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <RaceComparison player1={raceP1} player2={raceP2} players={leaderboard} />
        </div>
      )}
    </div>
  );
}
