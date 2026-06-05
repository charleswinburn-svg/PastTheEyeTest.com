import { useEffect, useMemo } from "react";
import { PITCH_COLORS, PITCH_NAMES, HIT_COLORS } from "./mlbApi.js";
import { useTheme } from "./ThemeContext.jsx";

// ═══════════════════════════════════════════════════════════
// MOVEMENT PLOT (Horizontal Break vs Induced Vertical Break)
// ═══════════════════════════════════════════════════════════
export function MovementPlot({ pitches, width = 500, height = 500, maxPitches = 200, onPitchClick = null,
  expectedMovement = null, showExpected = false, armAngle = null }) {
  const { theme: t, isDark } = useTheme();
  const axisB = 45, axisT = 20;
  const side = height - axisT - axisB;
  const pL = (width - side) / 2;
  const pT = axisT;
  const range = 25;

  const scaleX = (v) => pL + ((v + range) / (range * 2)) * side;
  const scaleY = (v) => pT + ((range - v) / (range * 2)) * side;

  const ticks = [-20, -10, 0, 10, 20];

  let displayPitches = pitches.filter(p => p.hBreak != null && p.vBreak != null);
  if (displayPitches.length > maxPitches) {
    const step = displayPitches.length / maxPitches;
    displayPitches = displayPitches.filter((_, i) => Math.floor(i / step) !== Math.floor((i - 1) / step) || i === 0);
    displayPitches = displayPitches.slice(0, maxPitches);
  }

  // Actual per-pitch-type mean from the FULL data (not the downsampled set) so the
  // expected-vs-actual line and residuals are accurate.
  const actualMeans = useMemo(() => {
    const acc = {};
    for (const p of pitches) {
      if (p.hBreak == null || p.vBreak == null || !p.pitchType) continue;
      (acc[p.pitchType] ??= { h: 0, v: 0, n: 0 });
      acc[p.pitchType].h += p.hBreak; acc[p.pitchType].v += p.vBreak; acc[p.pitchType].n++;
    }
    const out = {};
    for (const [pt, a] of Object.entries(acc)) if (a.n) out[pt] = { h: a.h / a.n, v: a.v / a.n };
    return out;
  }, [pitches]);

  // Pitch types to overlay: present in BOTH the expected data and the actual means,
  // with finite break values (guards against partial/NaN payloads and NaN geometry).
  const expectedRows = (showExpected && expectedMovement && typeof expectedMovement === "object")
    ? Object.keys(actualMeans)
        .map(pt => {
          const e = expectedMovement[pt], m = actualMeans[pt];
          if (!e || !m) return null;
          const eh = Number(e.hBreak), ev = Number(e.vBreak);
          if (!isFinite(eh) || !isFinite(ev) || !isFinite(m.h) || !isFinite(m.v)) return null;
          return { pt, e: { hBreak: eh, vBreak: ev }, m, dH: m.h - eh, dV: m.v - ev };
        })
        .filter(Boolean)
        .sort((a, b) => String(PITCH_NAMES[a.pt] ?? a.pt ?? "").localeCompare(String(PITCH_NAMES[b.pt] ?? b.pt ?? "")))
    : [];

  const expRadiusPx = (2.5 / (range * 2)) * side;   // 2.5" — equal x/y scale → true circle
  const fmtIn = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}"`;

  const plotBg = isDark ? "#1a1a1a" : "#f0f0f0";
  const gridMinor = isDark ? "#2a2a2a" : "#ddd";
  const gridMajor = isDark ? "#555" : "#999";
  const labelFill = isDark ? "#888" : "#666";

  // When reclassify mode is on we make dots interactive: bigger hit target,
  // pointer cursor, ring-on-hover. Reclassified pitches get a thicker border
  // so it's easy to see what's been changed.
  const interactive = !!onPitchClick;

  return (
    <svg width={width} height={height} style={{ display: "block" }}>
      <rect x={pL} y={pT} width={side} height={side} fill={plotBg} rx={4} />

      {ticks.map(tk => (
        <g key={`grid-${tk}`}>
          <line x1={scaleX(tk)} y1={pT} x2={scaleX(tk)} y2={pT + side}
            stroke={tk === 0 ? gridMajor : gridMinor} strokeWidth={tk === 0 ? 1 : 0.5}
            strokeDasharray={tk === 0 ? "4,4" : "none"} />
          <line x1={pL} y1={scaleY(tk)} x2={pL + side} y2={scaleY(tk)}
            stroke={tk === 0 ? gridMajor : gridMinor} strokeWidth={tk === 0 ? 1 : 0.5}
            strokeDasharray={tk === 0 ? "4,4" : "none"} />
          <text x={scaleX(tk)} y={pT + side + 18} textAnchor="middle"
            fill={labelFill} fontSize={10}>{tk}"</text>
          <text x={pL - 8} y={scaleY(tk) + 3} textAnchor="end"
            fill={labelFill} fontSize={10}>{tk}"</text>
        </g>
      ))}

      <text x={pL + side / 2} y={pT + side + 36} textAnchor="middle"
        fill={labelFill} fontSize={11}>Horizontal Break (in)</text>
      <text x={pL - 28} y={pT + side / 2} textAnchor="middle"
        fill={labelFill} fontSize={11} transform={`rotate(-90, ${pL - 28}, ${pT + side / 2})`}>
        Induced Vertical Break (in)
      </text>

      {/* Expected-movement overlay: shaded expected circle + line to the actual mean. Drawn
          under the dots so individual pitches stay readable on top. */}
      {expectedRows.map(({ pt, e, m }) => {
        const col = PITCH_COLORS[pt] || "#888";
        return (
          <g key={`exp-${pt}`}>
            <circle cx={scaleX(e.hBreak)} cy={scaleY(e.vBreak)} r={expRadiusPx}
              fill={col} fillOpacity={0.16} stroke={col} strokeOpacity={0.7}
              strokeWidth={1.25} strokeDasharray="4,3" />
            <line x1={scaleX(m.h)} y1={scaleY(m.v)} x2={scaleX(e.hBreak)} y2={scaleY(e.vBreak)}
              stroke={col} strokeWidth={1.5} strokeOpacity={0.9} />
            <circle cx={scaleX(m.h)} cy={scaleY(m.v)} r={4}
              fill={col} stroke={isDark ? "#fff" : "#000"} strokeOpacity={0.55} strokeWidth={1} />
          </g>
        );
      })}

      {displayPitches.map((p, i) => (
        <circle key={i}
          cx={scaleX(p.hBreak)} cy={scaleY(p.vBreak)} r={5.5}
          fill={PITCH_COLORS[p.pitchType] || "#888"} fillOpacity={0.9}
          stroke={isDark ? "rgba(0,0,0,0.4)" : "rgba(0,0,0,0.15)"} strokeWidth={0.5}
          style={interactive ? { cursor: "crosshair" } : undefined}
          onClick={interactive ? () => onPitchClick(p) : undefined}
        />
      ))}

      {/* Residual box: difference (actual − expected) per pitch type, plus arm angle. */}
      {expectedRows.length > 0 && (() => {
        const rowH = 15, padX = 8, padTop = 18, boxW = 150;
        const boxH = padTop + expectedRows.length * rowH + 6;
        const bx = pL + 6, by = pT + 6;
        return (
          <g>
            <rect x={bx} y={by} width={boxW} height={boxH} rx={5}
              fill={isDark ? "rgba(20,20,20,0.82)" : "rgba(255,255,255,0.88)"}
              stroke={isDark ? "#444" : "#ccc"} strokeWidth={0.75} />
            <text x={bx + padX} y={by + 13} fontSize={9.5} fontWeight={700}
              fill={labelFill} letterSpacing="0.04em">
              ACTUAL − EXPECTED{armAngle != null ? `  ·  SLOT ${Math.round(armAngle)}°` : ""}
            </text>
            {expectedRows.map(({ pt, dH, dV }, i) => {
              const ry = by + padTop + i * rowH + 8;
              return (
                <g key={`res-${pt}`}>
                  <circle cx={bx + padX + 3} cy={ry - 3} r={4} fill={PITCH_COLORS[pt] || "#888"} />
                  <text x={bx + padX + 13} y={ry} fontSize={10} fontWeight={600} fill={t.textSecondary}>
                    {PITCH_NAMES[pt] || pt}
                  </text>
                  <text x={bx + boxW - padX} y={ry} fontSize={9.5} textAnchor="end"
                    fill={t.textMuted} fontFamily="ui-monospace, monospace">
                    {fmtIn(dH)} H  {fmtIn(dV)} V
                  </text>
                </g>
              );
            })}
          </g>
        );
      })()}
    </svg>
  );
}


// ═══════════════════════════════════════════════════════════
// RECLASSIFY MODAL
// ═══════════════════════════════════════════════════════════
// Supports two modes via the `target` prop:
//   - { kind: "single", pitch }  → reclassify just this pitch
//   - { kind: "bulk", type, count } → reclassify every pitch of `type`
// The caller decides what to do with the picked pitch type via onPick.
export function ReclassifyModal({ target, onPick, onClose }) {
  const { theme: t, isDark } = useTheme();
  const PITCH_OPTIONS = ["FF", "SI", "FC", "SL", "ST", "SV", "CU", "KC", "CH", "FS"];

  useEffect(() => {
    function onKey(e) { if (e.key === "Escape") onClose(); }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  if (!target) return null;

  const isBulk = target.kind === "bulk";
  const pitch = !isBulk ? target.pitch : null;
  const currentType = isBulk ? target.type : pitch?.pitchType;

  const title = isBulk ? "Reclassify pitch type" : "Reclassify pitch";
  const subtitle = isBulk
    ? `All ${PITCH_NAMES[target.type] || target.type}${target.count != null ? ` (${target.count} pitches)` : ""} → choose a new type`
    : `${pitch?.velo != null ? `${pitch.velo.toFixed(1)} mph · ` : ""}${
        pitch?.hBreak != null && pitch?.vBreak != null
          ? `${pitch.hBreak.toFixed(1)}\u2033 / ${pitch.vBreak.toFixed(1)}\u2033`
          : ""
      }${pitch?.pitchType ? ` · currently ${PITCH_NAMES[pitch.pitchType] || pitch.pitchType}` : ""}`;

  return (
    <div
      onClick={onClose}
      style={{
        position: "fixed", inset: 0,
        background: "rgba(0, 0, 0, 0.55)",
        zIndex: 1000,
        display: "flex", alignItems: "center", justifyContent: "center",
        backdropFilter: "blur(2px)",
      }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{
          background: t.cardBg,
          border: `1px solid ${t.cardBorder}`,
          borderRadius: 12,
          padding: "20px 24px",
          minWidth: 380,
          boxShadow: `0 12px 40px ${t.shadow}`,
        }}
      >
        <div style={{
          fontSize: 13, fontWeight: 700,
          color: t.text,
          marginBottom: 4, letterSpacing: "0.04em", textTransform: "uppercase",
        }}>
          {title}
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, marginBottom: 14 }}>
          {subtitle}
        </div>
        <div style={{
          display: "grid",
          gridTemplateColumns: "repeat(5, 1fr)",
          gap: 8,
        }}>
          {PITCH_OPTIONS.map(pt => {
            const isCurrent = pt === currentType;
            return (
              <button
                key={pt}
                onClick={() => onPick(pt)}
                style={{
                  padding: "10px 6px",
                  background: PITCH_COLORS[pt] || "#888",
                  color: "#fff",
                  border: isCurrent ? `2px solid ${t.text}` : "2px solid transparent",
                  borderRadius: 6,
                  fontWeight: 800,
                  fontSize: 13,
                  cursor: "pointer",
                  letterSpacing: "0.04em",
                  opacity: isCurrent ? 0.55 : 1,
                  outline: "none",
                }}
                title={PITCH_NAMES[pt] || pt}
              >
                {pt}
              </button>
            );
          })}
        </div>
        <div style={{
          marginTop: 14, display: "flex", justifyContent: "space-between",
          alignItems: "center", fontSize: 11, color: t.textFaint,
        }}>
          <span>Esc to cancel</span>
          <button
            onClick={onClose}
            style={{
              padding: "5px 12px", background: "transparent",
              color: t.textSecondary, border: `1px solid ${t.divider}`,
              borderRadius: 5, cursor: "pointer", fontSize: 11, fontWeight: 600,
            }}
          >
            Close
          </button>
        </div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// SPRAY CHART (Baseball Diamond)
// ═══════════════════════════════════════════════════════════
export function SprayChart({ battedBalls, width = 580, height = 400 }) {
  const { theme: t, isDark } = useTheme();
  const cx = width / 2;
  const base = height * 0.925;

  // Realistic fence: 400ft center, 330ft corners
  // Scaled so 510ft (490+20 buffer) reaches y≈10
  const centerR = height * 0.706;
  const cornerR = centerR * (330 / 400);

  // Fence angles
  const arcStart = Math.PI * 1.22;
  const arcEnd = Math.PI * 1.78;
  const arcCenter = Math.PI * 1.5;

  // Fence radius at angle: corner→center smooth blend
  const fenceRadius = (angle) => {
    const t = Math.abs(angle - arcCenter) / (arcEnd - arcCenter);
    return centerR + (cornerR - centerR) * (t * t);
  };

  // Build fence path
  const fencePoints = [];
  const steps = 32;
  for (let i = 0; i <= steps; i++) {
    const angle = arcStart + (arcEnd - arcStart) * (i / steps);
    const r = fenceRadius(angle);
    fencePoints.push([cx + r * Math.cos(angle), base + r * Math.sin(angle)]);
  }
  const fencePath = "M " + fencePoints.map(([x, y]) => `${x.toFixed(1)} ${y.toFixed(1)}`).join(" L ");

  // Infield arc
  const infR = cornerR * 0.42;

  // Foul lines — stop at fence corners, not beyond
  const foulAngle = 0.78;
  const foulLF = [cx - cornerR * Math.sin(foulAngle), base - cornerR * Math.cos(foulAngle)];
  const foulRF = [cx + cornerR * Math.sin(foulAngle), base - cornerR * Math.cos(foulAngle)];

  // MLB coords → SVG: 160 units = 400ft = centerR
  const scale = centerR / 160;
  const mapHit = (hd) => {
    if (!hd?.coordinates?.coordX || !hd?.coordinates?.coordY) return null;
    const dx = hd.coordinates.coordX - 125;
    const dy = 200 - hd.coordinates.coordY;
    const px = cx + dx * scale;
    const py = base - dy * scale;
    if (px < -20 || px > width + 20 || py < -20 || py > height + 20) return null;
    return [Math.max(2, Math.min(width - 2, px)), Math.max(2, Math.min(height - 2, py))];
  };

  // Infield arc path
  const infArcPath = () => {
    const sx = cx + infR * Math.cos(arcStart);
    const sy = base + infR * Math.sin(arcStart);
    const ex = cx + infR * Math.cos(arcEnd);
    const ey = base + infR * Math.sin(arcEnd);
    return `M ${sx} ${sy} A ${infR} ${infR} 0 0 1 ${ex} ${ey}`;
  };

  const lineFaint = isDark ? "rgba(255,255,255,0.12)" : "rgba(0,0,0,0.12)";
  const lineLight = isDark ? "rgba(255,255,255,0.1)" : "rgba(0,0,0,0.08)";
  const fenceStroke = isDark ? "rgba(255,255,255,0.2)" : "rgba(0,0,0,0.2)";
  const dotStroke = isDark ? "rgba(255,255,255,0.3)" : "rgba(0,0,0,0.2)";

  return (
    <div style={{ background: isDark ? "#1a1a1a" : "#f0f0f0", borderRadius: 8, padding: "4px 0" }}>
      <div style={{ display: "flex", justifyContent: "center", gap: 14, marginBottom: 4, padding: "0 8px" }}>
        {[["HR", "#D22D49"], ["3B", "#FE9D00"], ["2B", "#EDE252"], ["1B", "#3BACAC"], ["Out", "#888"]].map(([label, color]) => (
          <div key={label} style={{ display: "flex", alignItems: "center", gap: 4, fontSize: 10, color: t.textMuted }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: color }} />
            {label}
          </div>
        ))}
        <span style={{ fontSize: 10, color: t.textMuted, marginLeft: 8 }}>Dot size = Exit Velo</span>
      </div>

      <svg width={width} height={height} style={{ display: "block" }}>
        {/* Outfield fence */}
        <path d={fencePath}
          fill="none" stroke={fenceStroke} strokeWidth={1.5} strokeDasharray="6,3" />

        {/* Infield arc */}
        <path d={infArcPath()}
          fill="none" stroke={lineLight} strokeWidth={1} />

        {/* Foul lines — to fence corners only */}
        <line x1={cx} y1={base} x2={foulLF[0]} y2={foulLF[1]}
          stroke={lineFaint} strokeWidth={1} />
        <line x1={cx} y1={base} x2={foulRF[0]} y2={foulRF[1]}
          stroke={lineFaint} strokeWidth={1} />

        {/* Diamond */}
        {(() => {
          const dR = cornerR * 0.195;
          return <polygon
            points={`${cx},${base} ${cx - dR * 0.7},${base - dR * 0.7} ${cx},${base - dR * 1.4} ${cx + dR * 0.7},${base - dR * 0.7}`}
            fill="none" stroke={lineFaint} strokeWidth={1} />;
        })()}

        {/* Hit dots — outs first, then hits on top */}
        {battedBalls
          .map((bb, i) => ({ bb, i, isHit: ["Single","Double","Triple","Home Run"].includes(bb.result || "") }))
          .sort((a, b) => a.isHit - b.isHit)
          .map(({ bb, i }) => {
          const pos = mapHit(bb.hitData);
          if (!pos) return null;
          const ev = bb.hitData?.launchSpeed || 80;
          const r = Math.max(3, Math.min(12, (ev - 60) / 5));
          let resultType = "out";
          const res = bb.result || "";
          if (res.includes("Home Run")) resultType = "home_run";
          else if (res.includes("Triple")) resultType = "triple";
          else if (res.includes("Double")) resultType = "double";
          else if (res.includes("Single")) resultType = "single";
          return (
            <circle key={i} cx={pos[0]} cy={pos[1]} r={r}
              fill={HIT_COLORS[resultType] || "#666"} fillOpacity={0.85}
              stroke={dotStroke} strokeWidth={0.5} />
          );
        })}
      </svg>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// ZONE PLOT (Strike Zone with pitch dots)
// ═══════════════════════════════════════════════════════════
export function ZonePlot({ pitches, title, width = 260, height = 300 }) {
  const { theme: t, isDark } = useTheme();
  const pad = { top: 25, right: 20, bottom: 30, left: 20 };
  const zoneW = width - pad.left - pad.right;
  const zoneH = height - pad.top - pad.bottom;

  const xRange = [-1.5, 1.5];
  const yRange = [1.0, 4.0];

  const scaleX = (v) => pad.left + ((v - xRange[0]) / (xRange[1] - xRange[0])) * zoneW;
  const scaleY = (v) => pad.top + ((yRange[1] - v) / (yRange[1] - yRange[0])) * zoneH;

  const szLeft = scaleX(-0.88);
  const szRight = scaleX(0.88);
  const szTop = scaleY(3.5);
  const szBot = scaleY(1.5);

  const count = pitches.filter(p => p.pX != null && p.pZ != null).length;
  const zoneStroke = isDark ? "#666" : "#333";
  const plateStroke = isDark ? "#555" : "#333";

  return (
    <div style={{ background: isDark ? "#1a1a1a" : "#f0f0f0", borderRadius: 8, textAlign: "center" }}>
      <div style={{ fontSize: 12, fontWeight: 600, color: t.textMuted, padding: "8px 0 2px" }}>{title}</div>
      <svg width={width} height={height} style={{ display: "block" }}>
        {/* Strike zone box */}
        <rect x={szLeft} y={szTop} width={szRight - szLeft} height={szBot - szTop}
          fill="none" stroke={zoneStroke} strokeWidth={1.5} />

        {/* Home plate */}
        <polygon
          points={`${scaleX(-0.35)},${scaleY(1.0)} ${scaleX(0.35)},${scaleY(1.0)} ${scaleX(0.5)},${scaleY(0.85)} ${scaleX(0)},${scaleY(0.7)} ${scaleX(-0.5)},${scaleY(0.85)}`}
          fill="none" stroke={plateStroke} strokeWidth={1}
        />

        {/* Pitch dots */}
        {pitches.filter(p => p.pX != null && p.pZ != null).map((p, i) => (
          <circle key={i}
            cx={scaleX(p.pX)} cy={scaleY(p.pZ)} r={6}
            fill={PITCH_COLORS[p.pitchType] || "#888"} fillOpacity={0.85}
            stroke={isDark ? "rgba(0,0,0,0.3)" : "rgba(0,0,0,0.15)"} strokeWidth={0.5}
          />
        ))}

        {/* Count */}
        <text x={width - 8} y={height - 6} textAnchor="end"
          fill={t.textMuted} fontSize={10}>n={count}</text>
      </svg>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STAT BAR (colored stat cells)

// ═══════════════════════════════════════════════════════════
// PER-PITCH-TYPE LEAGUE AVERAGES + EFFECTIVENESS COLORING
// ═══════════════════════════════════════════════════════════
// 2025 MLB league averages per pitch type (from Savant pitch-level data)
const LEAGUE_AVG_MLB = {
  velo: { higher_better: true, scale: 2.0, FF: 94.5, SI: 93.9, FC: 89.7, SL: 86.3, CU: 79.8, CH: 86.0, FS: 86.2, ST: 82.5, KC: 82.9, CS: 78.0, SV: 82.0, KN: 83.0, FA: 94.0, DEFAULT: 88.0 },
  spin: { higher_better: true, scale: 200, FF: 2300, SI: 2100, FC: 2350, SL: 2500, CU: 2750, CH: 1800, FS: 1400, ST: 2600, KC: 2650, CS: 2600, DEFAULT: 2200 },
  whiffPct: { higher_better: true, scale: 8.0, FF: 22.0, SI: 14.0, FC: 21.0, SL: 33.0, CU: 30.0, CH: 30.0, FS: 33.0, ST: 33.0, KC: 31.0, CS: 28.0, SV: 31.0, KN: 25.0, FA: 22.0, DEFAULT: 25.0 },
  zonePct: { higher_better: true, scale: 6.0, FF: 55.0, SI: 57.0, FC: 52.0, SL: 42.0, CU: 44.0, CH: 46.0, FS: 40.0, ST: 38.0, KC: 43.0, CS: 42.0, SV: 40.0, KN: 52.0, FA: 55.0, DEFAULT: 48.0 },
  extension: { higher_better: true, scale: 0.35, FF: 6.4, SI: 6.3, FC: 6.3, SL: 6.2, CU: 6.0, CH: 6.3, FS: 6.2, ST: 6.2, KC: 6.0, CS: 5.9, DEFAULT: 6.3 },
};

// AAA league averages — lower velo, spin, whiff; similar zone
const LEAGUE_AVG_AAA = {
  velo: { higher_better: true, scale: 2.0, FF: 92.5, SI: 92.0, FC: 87.5, SL: 84.0, CU: 78.0, CH: 84.0, FS: 84.0, ST: 80.5, KC: 81.0, CS: 76.5, SV: 80.0, KN: 81.0, FA: 92.0, DEFAULT: 86.0 },
  spin: { higher_better: true, scale: 200, FF: 2200, SI: 2000, FC: 2250, SL: 2400, CU: 2650, CH: 1700, FS: 1350, ST: 2500, KC: 2550, CS: 2500, DEFAULT: 2100 },
  whiffPct: { higher_better: true, scale: 8.0, FF: 20.0, SI: 12.0, FC: 19.0, SL: 30.0, CU: 27.0, CH: 27.0, FS: 30.0, ST: 30.0, KC: 28.0, CS: 25.0, SV: 28.0, KN: 23.0, FA: 20.0, DEFAULT: 23.0 },
  zonePct: { higher_better: true, scale: 6.0, FF: 56.0, SI: 58.0, FC: 53.0, SL: 43.0, CU: 45.0, CH: 47.0, FS: 41.0, ST: 39.0, KC: 44.0, CS: 43.0, SV: 41.0, KN: 53.0, FA: 56.0, DEFAULT: 49.0 },
  extension: { higher_better: true, scale: 0.35, FF: 6.2, SI: 6.1, FC: 6.1, SL: 6.0, CU: 5.8, CH: 6.1, FS: 6.0, ST: 6.0, KC: 5.8, CS: 5.7, DEFAULT: 6.1 },
};

// Default to MLB
const LEAGUE_AVG = LEAGUE_AVG_MLB;

function getLeagueAvg(isAAA) {
  return isAAA ? LEAGUE_AVG_AAA : LEAGUE_AVG_MLB;
}

function effColor(val, metricKey, pitchType, avgSet) {
  const avgs = avgSet || LEAGUE_AVG;
  if (val == null || isNaN(val) || !avgs[metricKey]) return null;
  const info = avgs[metricKey];
  const avg = info[pitchType] != null ? info[pitchType] : info.DEFAULT;
  if (avg == null) return null;
  let diff = (val - avg) / info.scale;
  if (!info.higher_better) diff = -diff;
  diff = Math.max(-1, Math.min(1, diff));
  if (Math.abs(diff) < 0.08) return null;
  const t = (Math.abs(diff) - 0.08) / 0.92;
  const alpha = (0.25 + t * 0.65).toFixed(2);
  return diff > 0
    ? `rgba(30,160,30,${alpha})`
    : `rgba(200,35,35,${alpha})`;
}

// Uniform coloring: all pitch types graded relative to global mean=100.
// Stuff+ stdev=10 (global distribution). Pitch+/Loc+/Tun+ use empirical global stdevs.
const PLUS_STATS_BY_PT = {
  stuffPlus:  { mean: { DEFAULT: 100 }, stdev: { DEFAULT: 10  } },
  locPlus:    { mean: { DEFAULT: 100 }, stdev: { DEFAULT: 1.7 } },
  tunnelPlus: { mean: { DEFAULT: 100 }, stdev: { DEFAULT: 2.0 } },
  pitchPlus:  { mean: { DEFAULT: 100 }, stdev: { DEFAULT: 2.2 } },
};

// Plus-scale color: dark green at ≥mean+2σ, dark red at ≤mean-2σ, 5 discrete shades each side.
function plusColorRaw(v, mean, stdev) {
  if (v == null || !isFinite(v) || !stdev) return null;
  const z = (v - mean) / (2 * stdev);   // ±1 at ±2σ from pitch-type mean
  const t = Math.max(0, Math.min(1, Math.abs(z)));
  if (t < 0.05) return null;
  const step = Math.min(4, Math.floor(t * 5));   // 5 shades per direction = 10 total
  const alphas = [0.22, 0.38, 0.54, 0.70, 0.86];
  return z > 0
    ? `rgba(30,160,30,${alphas[step]})`
    : `rgba(200,35,35,${alphas[step]})`;
}

function statBarColor(val, avg, scale, higherBetter) {
  if (val == null || avg == null) return { bg: "#2a2a2a", border: "#444" };
  let diff = (val - avg) / scale;
  if (!higherBetter) diff = -diff;
  diff = Math.max(-1, Math.min(1, diff));
  if (Math.abs(diff) < 0.05) return { bg: "#2a2a2a", border: "#444" };
  const t = (Math.abs(diff) - 0.05) / 0.95;
  const alpha = (0.3 + t * 0.7).toFixed(2);
  const bAlpha = (0.4 + t * 0.6).toFixed(2);
  if (diff > 0) return { bg: `rgba(30,160,30,${alpha})`, border: `rgba(30,160,30,${bAlpha})` };
  return { bg: `rgba(200,35,35,${alpha})`, border: `rgba(200,35,35,${bAlpha})` };
}

// ═══════════════════════════════════════════════════════════
export function StatBar({ stats }) {
  const { theme: t, isDark } = useTheme();
  const getColor = (stat) => {
    if (!stat.good || stat.value == null || !stat.thresholds) return { bg: t.inputBg, border: t.inputBorder, text: t.text };
    const v = stat.value;
    const th = stat.thresholds;
    const avg = (th[0] + th[2]) / 2;
    const scale = (th[2] - th[0]) / 2;
    const raw = statBarColor(v, avg, scale, stat.good === "high");
    if (isDark) return { ...raw, text: "#fff" };
    // Light mode: colored text, white bg
    const isGood = (stat.good === "high" ? v > avg : v < avg);
    if (raw.bg === "#2a2a2a") return { bg: t.inputBg, border: t.inputBorder, text: t.text };
    const alpha = raw.bg.match(/[\d.]+(?=\))/)?.[0] || "0.5";
    const boosted = Math.min(1, parseFloat(alpha) + 0.3).toFixed(2);
    return {
      bg: t.cardBg, border: t.inputBorder,
      text: isGood ? `rgba(5,120,40,${boosted})` : `rgba(180,15,15,${boosted})`,
    };
  };

  return (
    <div style={{
      display: "flex", justifyContent: "center", gap: 2, padding: "8px 10px",
    }}>
      {stats.map((s, i) => {
        const { bg, border, text } = getColor(s);
        const formatted = s.value != null
          ? (s.format === ".3f" ? s.value.toFixed(3) : s.format === ".2f" ? s.value.toFixed(2) : s.format === ".1f" ? s.value.toFixed(1) : String(s.value))
          : "—";
        return (
          <div key={i} style={{
            background: bg, border: `1px solid ${border}`,
            borderRadius: 4, padding: "6px 4px", textAlign: "center",
            flex: 1, minWidth: 0,
          }}>
            <div style={{ fontSize: 14, fontWeight: 700, color: text, fontFamily: "'DM Mono', monospace" }}>
              {formatted}
            </div>
            <div style={{ fontSize: 9, color: t.text, marginTop: 2, fontWeight: 600, letterSpacing: "0.02em", opacity: 0.7 }}>{s.label}</div>
          </div>
        );
      })}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PITCH TABLE (per-pitch-type stats)
// ═══════════════════════════════════════════════════════════
export function PitchTable({ rows, leagueAvgs, isAAA, pitchPlus, onTypeClick = null }) {
  const { theme: t, isDark } = useTheme();
  if (!rows || rows.length === 0) return null;

  const avgSet = getLeagueAvg(isAAA);

  const cols = [
    { key: "name", label: "Pitch", align: "left" },
    { key: "n", label: "#", align: "center" },
    { key: "usagePct", label: "Usage%", align: "center" },
    { key: "velo", label: "Velo", align: "center" },
    { key: "spin", label: "Spin", align: "center" },
    { key: "hBreak", label: "H Brk", align: "center", fmt: v => v != null ? `${v.toFixed(1)}"` : "—" },
    { key: "vBreak", label: "V Brk", align: "center", fmt: v => v != null ? `${v.toFixed(1)}"` : "—" },
    { key: "vaa", label: "VAA", align: "center", fmt: v => v != null ? `${v.toFixed(1)}°` : "—" },
    { key: "relHeight", label: "Rel Ht", align: "center", fmt: v => v != null ? v.toFixed(2) + "'" : "—" },
    { key: "extension", label: "Ext", align: "center", fmt: v => v != null ? v.toFixed(1) + "'" : "—" },
    { key: "zonePct", label: "Zone%", align: "center", fmt: v => v != null ? v.toFixed(1) + "%" : "—" },
    { key: "whiffPct", label: "Whiff%", align: "center", fmt: v => v != null ? v.toFixed(1) + "%" : "—" },
    ...(pitchPlus ? [
      { key: "stuffPlus", label: "Stuff+", align: "center", fmt: v => v != null ? v.toFixed(0) : "—" },
      { key: "locPlus", label: "Loc+", align: "center", fmt: v => v != null ? v.toFixed(0) : "—" },
      { key: "tunnelPlus", label: "Tun+", align: "center", fmt: v => v != null ? v.toFixed(0) : "—" },
      { key: "pitchPlus", label: "Pitch+", align: "center", fmt: v => v != null ? v.toFixed(0) : "—" },
    ] : []),
  ];

  const EFF_KEYS = { velo: "velo", spin: "spin", whiffPct: "whiffPct", zonePct: "zonePct", extension: "extension", pitchPlus: "pitchPlus", stuffPlus: "stuffPlus", locPlus: "locPlus", tunnelPlus: "tunnelPlus" };

  // Convert raw rgba bg (green = good, red = bad) into a rendered pill style.
  // plusColorRaw produces alphas [0.22,0.38,0.54,0.70,0.86] for 5 intensity steps.
  // Dark mode: subtle tint + light text. Light mode: boosted solid fill + white text so
  // pills are clearly readable on a white/light background (original +0.10 boost was too faint).
  const presentBg = (rawBg) => {
    if (!rawBg) return {};
    const isGreen = rawBg.includes("30,160,30");
    const alpha = parseFloat(rawBg.match(/[\d.]+(?=\))/)?.[0] || "0.5");

    if (isDark) {
      const bgAlpha = Math.min(0.92, alpha + 0.10).toFixed(2);
      const useWhite = parseFloat(bgAlpha) > 0.52;
      const tint = isGreen
        ? `rgba(40,185,65,${bgAlpha})`
        : `rgba(225,55,60,${bgAlpha})`;
      const textColor = useWhite
        ? "#ffffff"
        : (isGreen ? "rgb(130,245,155)" : "rgb(255,145,155)");
      return { background: tint, color: textColor, isPill: true };
    }

    // Light mode: add 0.30 so even the weakest step is clearly visible on white.
    // White text above alpha 0.58 (steps 2-4); deep-colored text for the two lightest steps.
    const bgAlpha = Math.min(0.96, alpha + 0.30).toFixed(2);
    const useWhite = parseFloat(bgAlpha) > 0.58;
    const tint = isGreen
      ? `rgba(22,163,74,${bgAlpha})`
      : `rgba(220,38,38,${bgAlpha})`;
    const textColor = useWhite
      ? "#ffffff"
      : (isGreen ? "rgb(5,80,35)" : "rgb(130,10,10)");
    return { background: tint, color: textColor, isPill: true };
  };

  const getCellStyle = (key, value, pitchType) => {
    if (value == null || !EFF_KEYS[key]) return {};
    let rawBg = null;

    // Pitch+/Stuff+/Location+/Tunnel+: color relative to each pitch type's own mean/stdev
    if (key === "pitchPlus" || key === "stuffPlus" || key === "locPlus" || key === "tunnelPlus") {
      const s = PLUS_STATS_BY_PT[key] || {};
      const mean  = (s.mean?.[pitchType]  ?? s.mean?.DEFAULT  ?? 100);
      const stdev = (s.stdev?.[pitchType] ?? s.stdev?.DEFAULT ?? 5);
      return presentBg(plusColorRaw(value, mean, stdev));
    }

    // Use live league avgs when available
    if (leagueAvgs?.byPitchType?.[pitchType]?.all && (key === "zonePct" || key === "whiffPct")) {
      const lgPt = leagueAvgs.byPitchType[pitchType].all;
      const lgVal = key === "zonePct" ? lgPt.zone : lgPt.whiff;
      if (lgVal != null) {
        const scale = key === "zonePct" ? 6.0 : 8.0;
        let diff = (value - lgVal) / scale;
        diff = Math.max(-1, Math.min(1, diff));
        if (Math.abs(diff) >= 0.08) {
          const s = (Math.abs(diff) - 0.08) / 0.92;
          const alpha = (0.25 + s * 0.65).toFixed(2);
          rawBg = diff > 0 ? `rgba(30,160,30,${alpha})` : `rgba(200,35,35,${alpha})`;
        }
      }
    }
    if (!rawBg) rawBg = effColor(value, EFF_KEYS[key], pitchType, avgSet);
    return presentBg(rawBg);
  };

  return (
    <div style={{ overflowX: "auto", padding: "0 8px 12px" }}>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            {cols.map(c => (
              <th key={c.key} style={{
                padding: "10px 6px", textAlign: c.align || "center",
                borderBottom: `2px solid ${t.divider}`, color: t.textMuted, fontSize: 11,
                fontWeight: 800, letterSpacing: "0.06em", textTransform: "uppercase",
                whiteSpace: "nowrap",
              }}>{c.label}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const ppData = pitchPlus?.[row.type] || {};
            const rowExt = pitchPlus ? { ...row, ...ppData } : row;
            return (
            <tr key={i}>
              {cols.map(c => {
                const val = rowExt[c.key];
                const formatted = c.fmt ? c.fmt(val) : (val != null ? val : "—");
                const effStyle = c.key === "name" ? {} : getCellStyle(c.key, val, row.type);

                // Pitch name cell — colored chip. When onTypeClick is set
                // (parent is in reclassify mode), make it clickable as a
                // shortcut for bulk reclassification of all pitches of this type.
                if (c.key === "name") {
                  const clickable = !!onTypeClick;
                  return (
                    <td key={c.key}
                      onClick={clickable ? () => onTypeClick(row.type, row.n) : undefined}
                      style={{
                        padding: "7px 6px", textAlign: "center",
                        borderBottom: `1px solid ${t.tableBorder}`,
                        color: "#fff", fontWeight: 800,
                        background: row.color, borderRadius: 4, minWidth: 90,
                        letterSpacing: "0.02em",
                        cursor: clickable ? "pointer" : "default",
                      }}
                      title={clickable ? `Reclassify all ${formatted} (${row.n})` : undefined}
                    >
                      {formatted}
                    </td>
                  );
                }

                // Pill cell (both modes): tinted span inside transparent cell
                if (effStyle.isPill) {
                  return (
                    <td key={c.key} style={{
                      padding: "6px 4px", textAlign: c.align || "center",
                      borderBottom: `1px solid ${t.tableBorder}`,
                      fontFamily: "'DM Mono', monospace",
                      whiteSpace: "nowrap",
                    }}>
                      <span style={{
                        display: "inline-block",
                        background: effStyle.background,
                        color: effStyle.color,
                        padding: "3px 10px",
                        borderRadius: 6,
                        fontWeight: 800,
                        minWidth: 32,
                        letterSpacing: "0.01em",
                      }}>
                        {formatted}
                      </span>
                    </td>
                  );
                }

                // Neutral cell (no scoring tint applied)
                return (
                  <td key={c.key} style={{
                    padding: "7px 6px",
                    textAlign: c.align || "center",
                    borderBottom: `1px solid ${t.tableBorder}`,
                    color: t.textSecondary,
                    fontWeight: 600,
                    fontFamily: "'DM Mono', monospace",
                    whiteSpace: "nowrap",
                  }}>
                    {formatted}
                  </td>
                );
              })}
            </tr>
            );
          })}

          {/* TOTAL row — usage-weighted Stuff+/Loc+/Tun+/Pitch+ across all
              pitch types. Only renders when modeling values are loaded.
              All non-modeling columns are blank by design. */}
          {pitchPlus && (() => {
            const totalsKeys = ["stuffPlus", "locPlus", "tunnelPlus", "pitchPlus"];
            const wsum = { stuffPlus: 0, locPlus: 0, tunnelPlus: 0, pitchPlus: 0 };
            const wn   = { stuffPlus: 0, locPlus: 0, tunnelPlus: 0, pitchPlus: 0 };
            for (const row of rows) {
              const pp = pitchPlus[row.type] || {};
              const n = row.n || 0;
              if (!n) continue;
              for (const k of totalsKeys) {
                const v = pp[k];
                if (v != null) { wsum[k] += v * n; wn[k] += n; }
              }
            }
            const totals = {};
            for (const k of totalsKeys) totals[k] = wn[k] > 0 ? wsum[k] / wn[k] : null;
            const hasAny = totalsKeys.some(k => totals[k] != null);
            if (!hasAny) return null;

            return (
              <tr>
                {cols.map(c => {
                  // 'Total' label in the pitch-name column.
                  if (c.key === "name") {
                    return (
                      <td key={c.key} style={{
                        padding: "8px 6px",
                        textAlign: "center",
                        borderTop: `2px solid ${t.divider}`,
                        color: t.text,
                        fontWeight: 800,
                        fontSize: 11,
                        textTransform: "uppercase",
                        letterSpacing: "0.06em",
                      }}>Total</td>
                    );
                  }
                  // Plus column → render as pill so it matches the per-type rows.
                  if (totalsKeys.includes(c.key)) {
                    const val = totals[c.key];
                    const fmtted = c.fmt ? c.fmt(val) : (val != null ? val : "—");
                    const effStyle = getCellStyle(c.key, val, null);
                    if (effStyle.isPill) {
                      return (
                        <td key={c.key} style={{
                          padding: "8px 4px",
                          textAlign: "center",
                          borderTop: `2px solid ${t.divider}`,
                          fontFamily: "'DM Mono', monospace",
                          whiteSpace: "nowrap",
                        }}>
                          <span style={{
                            display: "inline-block",
                            background: effStyle.background,
                            color: effStyle.color,
                            padding: "3px 10px",
                            borderRadius: 6,
                            fontWeight: 800,
                            minWidth: 32,
                            letterSpacing: "0.01em",
                          }}>{fmtted}</span>
                        </td>
                      );
                    }
                    // Neutral (no tint) plus value — keep weight bold.
                    return (
                      <td key={c.key} style={{
                        padding: "8px 6px",
                        textAlign: "center",
                        borderTop: `2px solid ${t.divider}`,
                        color: t.text,
                        fontWeight: 800,
                        fontFamily: "'DM Mono', monospace",
                        whiteSpace: "nowrap",
                      }}>{fmtted}</td>
                    );
                  }
                  // Every other column stays blank — only modeling combination shown.
                  return (
                    <td key={c.key} style={{
                      padding: "8px 6px",
                      borderTop: `2px solid ${t.divider}`,
                    }} />
                  );
                })}
              </tr>
            );
          })()}
        </tbody>
      </table>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PITCH TYPE LEGEND
// ═══════════════════════════════════════════════════════════
export function PitchTypeLegend({ types }) {
  const { theme: t } = useTheme();
  const all = types || Object.keys(PITCH_COLORS);
  return (
    <div style={{
      display: "flex", justifyContent: "center", flexWrap: "wrap",
      gap: 12, padding: "8px 16px", fontSize: 10, color: t.textMuted,
    }}>
      {all.map(pt => (
        <div key={pt} style={{ display: "flex", alignItems: "center", gap: 4 }}>
          <div style={{ width: 8, height: 8, borderRadius: "50%", background: PITCH_COLORS[pt] || "#888" }} />
          {PITCH_NAMES[pt] || pt}
        </div>
      ))}
    </div>
  );
}




// ═══════════════════════════════════════════════════════════
// COUNT TOOL — shared helpers
// ═══════════════════════════════════════════════════════════

const COUNT_BUCKETS = [
  { id: "first",  label: "First Pitch", test: (b, s) => b === 0 && s === 0 },
  { id: "ahead",  label: "Ahead",       test: (b, s) => (b === 0 && s === 1) || (b === 0 && s === 2) || (b === 1 && s === 2) },  // more strikes
  { id: "even",   label: "Even",        test: (b, s) => (b === 1 && s === 1) || (b === 2 && s === 2) },
  { id: "behind", label: "Behind",      test: (b, s) => (b === 1 && s === 0) || (b === 2 && s === 0) || (b === 2 && s === 1) || (b === 3 && s === 1) || (b === 3 && s === 0) },  // more balls
  { id: "full",   label: "Full",        test: (b, s) => b === 3 && s === 2 },
];

// Both cards show columns in this visual order: Overall | First Pitch | Ahead | Even | Behind | Full
// The difference is WHAT "Ahead" and "Behind" mean:

// PITCHER card columns: "Ahead" = pitcher has more strikes (0-1, 0-2, 1-2)
const PITCHER_COL_KEYS   = ["all", "first", "ahead",  "even", "behind", "full"];
const PITCHER_COL_LABELS = { all: "Overall", first: "First Pitch", ahead: "Ahead", even: "Even", behind: "Behind", full: "Full" };

// HITTER card columns: "Ahead" = hitter has more balls (1-0, 2-0, 2-1, 3-0, 3-1)
// Key order is swapped so "Ahead" column pulls from "behind" bucket (more balls = hitter ahead)
const HITTER_COL_KEYS   = ["all", "first", "behind", "even", "ahead",  "full"];
const HITTER_COL_LABELS = { all: "Overall", first: "First Pitch", behind: "Ahead", even: "Even", ahead: "Behind", full: "Full" };

// Generic BUCKET_KEYS for data computation (pitcher perspective IDs)
const BUCKET_KEYS = PITCHER_COL_KEYS;

function bucketPitches(pitches) {
  const known = pitches.filter(p => p.pitchType !== "UN");
  const result = {};
  for (const bucket of COUNT_BUCKETS) {
    result[bucket.id] = known.filter(p => p.balls != null && p.strikes != null && bucket.test(p.balls, p.strikes));
  }
  result.all = known.filter(p => p.balls != null && p.strikes != null);
  return result;
}

function inZone(p) {
  if (p.pX == null || p.pZ == null) return false;
  return Math.abs(p.pX) <= 0.88 && p.pZ >= (p.szBot || 1.5) && p.pZ <= (p.szTop || 3.5);
}

const PITCH_GROUPS = {
  Fastball: ["FF", "SI", "FC", "FA"],
  Breaking: ["SL", "CU", "KC", "CS", "SV", "ST", "KN"],
  Offspeed: ["CH", "FS", "SC", "FO"],
};
const GROUP_COLORS = { Fastball: "#dd4444", Breaking: "#4488dd", Offspeed: "#33aa33" };

function getPitchGroup(code) {
  for (const [group, codes] of Object.entries(PITCH_GROUPS)) {
    if (codes.includes(code)) return group;
  }
  return "Other";
}

function pctVal(n, d) { return d > 0 ? n / d * 100 : null; }
function pctFmt(v) { return v != null ? v.toFixed(1) + "%" : "—"; }
function evCalc(pitches) {
  const evs = pitches.filter(p => p.isInPlay && p.hitData?.launchSpeed).map(p => p.hitData.launchSpeed);
  return evs.length > 0 ? evs.reduce((a, b) => a + b, 0) / evs.length : null;
}

// League averages by count bucket (2023-2024 MLB approximate)
// Build per-bucket baseline from the row's own Overall value
// Each count bucket is colored relative to that pitch type's overall performance
function ownBaseline(overallVal) {
  if (overallVal == null) return null;
  const b = {};
  for (const k of BUCKET_KEYS) b[k] = overallVal;
  return b;
}

// Green-to-red cell coloring against baseline per bucket
function cellBg(val, avg, higherGood, scale = 5) {
  if (val == null || avg == null) return null;
  let diff = (val - avg) / scale;
  if (!higherGood) diff = -diff;
  diff = Math.max(-1, Math.min(1, diff));
  if (Math.abs(diff) < 0.05) return null;
  const intensity = (Math.abs(diff) - 0.05) / 0.95;
  const alpha = 0.25 + intensity * 0.6;
  return diff > 0 ? `rgba(30,160,30,${alpha})` : `rgba(200,35,35,${alpha})`;
}

// Common table styles — dynamic sizing
function countStyles(sz, t) {
  return {
    tblWrap: { overflowX: "auto", marginBottom: sz > 14 ? 4 : 2 },
    secTitle: { fontSize: sz - 1, fontWeight: 700, color: t.text, margin: `${sz > 14 ? 10 : 6}px 0 ${sz > 14 ? 4 : 2}px`, textAlign: "center", letterSpacing: "-0.01em", textTransform: "uppercase" },
    thS: { padding: `${Math.max(3, sz - 10)}px 4px`, borderBottom: `2px solid ${t.divider}`, color: t.textMuted, fontSize: sz - 3, fontWeight: 700, textAlign: "center", whiteSpace: "nowrap" },
    tdS: { padding: `${Math.max(3, sz - 10)}px 4px`, borderBottom: `1px solid ${t.tableBorder}`, textAlign: "center", fontSize: sz, fontFamily: "'DM Mono', monospace", color: t.textSecondary, fontWeight: 500 },
    labelS: { padding: `${Math.max(3, sz - 10)}px 6px`, borderBottom: `1px solid ${t.tableBorder}`, textAlign: "left", fontFamily: "inherit", fontWeight: 700, color: t.text, fontSize: sz - 1, whiteSpace: "nowrap" },
    labelW: Math.max(70, 85 + (sz - 14) * 3),
  };
}

// rows: [{ label, color?, values: {all,first,...}, lgAvg?: {all,first,...}, higherGood?, scale?, fmt? }]
function CountTable({ title, rows, showColor, labels, keys, size = 14 }) {
  const { theme: t } = useTheme();
  const bucketLabels = labels || PITCHER_COL_LABELS;
  const bucketKeys = keys || PITCHER_COL_KEYS;
  const s = countStyles(size, t);
  return (
    <div>
      <div style={s.secTitle}>{title}</div>
      <div style={s.tblWrap}>
        <table style={{ width: "100%", borderCollapse: "collapse", tableLayout: "fixed" }}>
          <colgroup>
            <col style={{ width: s.labelW }} />
            {bucketKeys.map(k => <col key={k} />)}
          </colgroup>
          <thead>
            <tr>
              <th style={{ ...s.thS, textAlign: "left", width: s.labelW }}></th>
              {bucketKeys.map(k => <th key={k} style={s.thS}>{bucketLabels[k]}</th>)}
            </tr>
          </thead>
          <tbody>
            {rows.map((row, i) => (
              <tr key={i}>
                <td style={{
                  ...s.labelS,
                  background: row.color ? row.color + "80" : "transparent",
                }}>
                  {row.label}
                </td>
                {bucketKeys.map(k => {
                  const v = row.values[k];
                  const avg = row.lgAvg ? row.lgAvg[k] : null;
                  const bg = showColor && avg != null ? cellBg(v, avg, row.higherGood ?? true, row.scale ?? 5) : null;
                  return (
                    <td key={k} style={{ ...s.tdS, background: bg || "transparent", fontWeight: bg ? 700 : 500 }}>
                      {v != null ? (row.fmt === "ev" ? v.toFixed(1) : v.toFixed(1) + "%") : "—"}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PITCHER COUNT TOOL
// ═══════════════════════════════════════════════════════════
// Helper: build lgAvg object from league data for a pitch type + metric
function lgAvgByPT(leagueAvgs, pt, metric) {
  if (!leagueAvgs?.byPitchType?.[pt]) return null;
  const result = {};
  for (const k of BUCKET_KEYS) {
    result[k] = leagueAvgs.byPitchType[pt][k]?.[metric] ?? null;
  }
  return result;
}

// Helper: build lgAvg object from league data for a pitch group + metric
function lgAvgByGroup(leagueAvgs, group, metric) {
  if (!leagueAvgs?.byGroup?.[group]) return null;
  const result = {};
  for (const k of BUCKET_KEYS) {
    result[k] = leagueAvgs.byGroup[group][k]?.[metric] ?? null;
  }
  return result;
}

export function PitcherCountTool({ pitches, leagueAvgs, isAAA }) {
  const { theme: t } = useTheme();
  const avgSet = getLeagueAvg(isAAA);
  const bucketed = bucketPitches(pitches);
  const pitchTypes = [...new Set(pitches.map(p => p.pitchType))].filter(pt => pt !== "UN");
  pitchTypes.sort((a, b) => pitches.filter(p => p.pitchType === b).length - pitches.filter(p => p.pitchType === a).length);

  // Fallback baseline: use AAA or MLB hardcoded values
  const fallbackZone = (pt) => avgSet.zonePct[pt] ?? avgSet.zonePct.DEFAULT;
  const fallbackWhiff = (pt) => avgSet.whiffPct[pt] ?? avgSet.whiffPct.DEFAULT;

  // --- Pitch Usage ---
  const usageRows = pitchTypes.map(pt => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const pool = bucketed[k];
      values[k] = pctVal(pool.filter(p => p.pitchType === pt).length, pool.length);
    }
    return { label: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888888", values };
  });

  // --- Zone% per pitch type ---
  const zoneRows = pitchTypes.map(pt => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofType = bucketed[k].filter(p => p.pitchType === pt);
      values[k] = pctVal(ofType.filter(inZone).length, ofType.length);
    }
    return { label: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888888", values, lgAvg: lgAvgByPT(leagueAvgs, pt, "zone") || fallbackZone(pt), scale: 10 };
  });

  // --- Whiff% per pitch type ---
  const whiffRows = pitchTypes.map(pt => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofType = bucketed[k].filter(p => p.pitchType === pt);
      values[k] = pctVal(ofType.filter(p => p.isWhiff).length, ofType.filter(p => p.isSwing).length);
    }
    return { label: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888888", values, lgAvg: lgAvgByPT(leagueAvgs, pt, "whiff") || fallbackWhiff(pt), higherGood: true, scale: 6 };
  });

  // --- Avg EV per pitch type ---
  const evRows = pitchTypes.map(pt => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofType = bucketed[k].filter(p => p.pitchType === pt);
      values[k] = evCalc(ofType);
    }
    return { label: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888888", values, lgAvg: lgAvgByPT(leagueAvgs, pt, "ev") || ownBaseline(values.all), higherGood: false, scale: 3, fmt: "ev" };
  });

  // Dynamic font size: fewer pitches = bigger text
  // 3 pitches → 18px, 4 → 16px, 5 → 14px, 6 → 13px, 7+ → 12px
  const sz = Math.max(12, Math.min(18, 22 - pitchTypes.length * 1.5));

  return (
    <div style={{ padding: "4px 16px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      <CountTable title="Pitch Usage by Count" rows={usageRows} size={sz} />
      <CountTable title="Zone% by Count" rows={zoneRows} showColor size={sz} />
      <CountTable title="Whiff% by Count" rows={whiffRows} showColor size={sz} />
      <CountTable title="Avg EV Against by Count" rows={evRows} showColor size={sz} />
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// HITTER COUNT TOOL
// ═══════════════════════════════════════════════════════════
export function HitterCountTool({ pitches, leagueAvgs, isAAA }) {
  const { theme: t } = useTheme();
  const bucketed = bucketPitches(pitches);
  const groups = ["Fastball", "Breaking", "Offspeed"];

  // AAA has more variance — use wider scales
  const swingScale = isAAA ? 10 : 8;
  const whiffScale = isAAA ? 8 : 6;
  const evScale = isAAA ? 4 : 3;

  // --- Pitch Mix Seen ---
  const mixRows = groups.map(g => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const pool = bucketed[k];
      values[k] = pctVal(pool.filter(p => getPitchGroup(p.pitchType) === g).length, pool.length);
    }
    return { label: g, color: GROUP_COLORS[g], values };
  });

  // --- Swing% by pitch group ---
  const swingRows = groups.map(g => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofGroup = bucketed[k].filter(p => getPitchGroup(p.pitchType) === g);
      values[k] = pctVal(ofGroup.filter(p => p.isSwing).length, ofGroup.length);
    }
    return { label: g, color: GROUP_COLORS[g], values, lgAvg: lgAvgByGroup(leagueAvgs, g, "swing") || ownBaseline(values.all), scale: swingScale };
  });

  // --- Whiff% by pitch group ---
  const whiffRows = groups.map(g => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofGroup = bucketed[k].filter(p => getPitchGroup(p.pitchType) === g);
      values[k] = pctVal(ofGroup.filter(p => p.isWhiff).length, ofGroup.filter(p => p.isSwing).length);
    }
    return { label: g, color: GROUP_COLORS[g], values, lgAvg: lgAvgByGroup(leagueAvgs, g, "whiff") || ownBaseline(values.all), higherGood: false, scale: whiffScale };
  });

  // --- Avg EV by pitch group ---
  const evRows = groups.map(g => {
    const values = {};
    for (const k of BUCKET_KEYS) {
      const ofGroup = bucketed[k].filter(p => getPitchGroup(p.pitchType) === g);
      values[k] = evCalc(ofGroup);
    }
    return { label: g, color: GROUP_COLORS[g], values, lgAvg: lgAvgByGroup(leagueAvgs, g, "ev") || ownBaseline(values.all), higherGood: true, scale: evScale, fmt: "ev" };
  });

  return (
    <div style={{ padding: "4px 16px 8px", display: "flex", flexDirection: "column", gap: 2 }}>
      <CountTable title="Pitch Mix Seen by Count" rows={mixRows} labels={HITTER_COL_LABELS} keys={HITTER_COL_KEYS} size={18} />
      <CountTable title="Swing% by Count" rows={swingRows} showColor labels={HITTER_COL_LABELS} keys={HITTER_COL_KEYS} size={18} />
      <CountTable title="Whiff% by Count" rows={whiffRows} showColor labels={HITTER_COL_LABELS} keys={HITTER_COL_KEYS} size={18} />
      <CountTable title="Avg EV by Count" rows={evRows} showColor labels={HITTER_COL_LABELS} keys={HITTER_COL_KEYS} size={18} />
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PITCH LOCATION GRID (per pitch type, split LHB/RHB)
// Game = colored dots, Season = heatmap
// ═══════════════════════════════════════════════════════════

// Render smooth KDE heatmap to canvas, return data URL
function renderHeatmapCanvas(pitches, xMin, xMax, zMin, zMax, canvasW, canvasH) {
  const cols = canvasW, rows = canvasH;
  const grid = Array.from({ length: rows }, () => new Array(cols).fill(0));
  const cw = (xMax - xMin) / cols, ch = (zMax - zMin) / rows;

  // KDE with wide Gaussian kernel for smooth blobs
  const sigmaFt = 0.35; // sigma in feet — controls blob size
  const sigmaC = sigmaFt / cw, sigmaR = sigmaFt / ch;
  const radiusC = Math.ceil(sigmaC * 3), radiusR = Math.ceil(sigmaR * 3);
  const invSigC2 = 1 / (2 * sigmaC * sigmaC);
  const invSigR2 = 1 / (2 * sigmaR * sigmaR);

  for (const p of pitches) {
    if (p.pX == null || p.pZ == null) continue;
    const cx = (p.pX - xMin) / cw;
    const cy = (zMax - p.pZ) / ch;
    const cxi = Math.round(cx), cyi = Math.round(cy);
    for (let dr = -radiusR; dr <= radiusR; dr++) {
      const r = cyi + dr;
      if (r < 0 || r >= rows) continue;
      const dy = r - cy;
      const ey = dy * dy * invSigR2;
      for (let dc = -radiusC; dc <= radiusC; dc++) {
        const c = cxi + dc;
        if (c < 0 || c >= cols) continue;
        const dx = c - cx;
        grid[r][c] += Math.exp(-(dx * dx * invSigC2 + ey));
      }
    }
  }

  const flat = grid.flat();
  const maxVal = Math.max(...flat);
  if (maxVal <= 0) return null;

  const canvas = document.createElement("canvas");
  canvas.width = cols;
  canvas.height = rows;
  const ctx = canvas.getContext("2d");
  const imgData = ctx.createImageData(cols, rows);

  // blue → white → red (Savant style)
  const stops = [
    [0.0,  [30, 80, 180]],
    [0.15, [60, 140, 210]],
    [0.3,  [120, 190, 220]],
    [0.5,  [200, 210, 220]],
    [0.65, [220, 180, 140]],
    [0.8,  [220, 120, 80]],
    [1.0,  [200, 40, 40]],
  ];

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const val = grid[r][c];
      if (val <= maxVal * 0.02) continue; // skip near-zero for perf
      const t = Math.min(val / maxVal, 1);
      let lo = stops[0], hi = stops[stops.length - 1];
      for (let i = 0; i < stops.length - 1; i++) {
        if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
      }
      const f = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
      const idx = (r * cols + c) * 4;
      imgData.data[idx]     = Math.round(lo[1][0] + f * (hi[1][0] - lo[1][0]));
      imgData.data[idx + 1] = Math.round(lo[1][1] + f * (hi[1][1] - lo[1][1]));
      imgData.data[idx + 2] = Math.round(lo[1][2] + f * (hi[1][2] - lo[1][2]));
      imgData.data[idx + 3] = Math.round(Math.min(t * 3, 1) * 200); // fade edges
    }
  }
  ctx.putImageData(imgData, 0, 0);
  return canvas.toDataURL();
}

function heatColor(val, max) {
  if (val <= 0 || max <= 0) return "transparent";
  const t = Math.min(val / max, 1);
  const stops = [
    [0.0, [40, 60, 180]],
    [0.15, [40, 170, 200]],
    [0.35, [50, 180, 80]],
    [0.6, [240, 200, 40]],
    [1.0, [220, 45, 45]],
  ];
  let lo = stops[0], hi = stops[stops.length - 1];
  for (let i = 0; i < stops.length - 1; i++) {
    if (t >= stops[i][0] && t <= stops[i + 1][0]) { lo = stops[i]; hi = stops[i + 1]; break; }
  }
  const f = hi[0] === lo[0] ? 0 : (t - lo[0]) / (hi[0] - lo[0]);
  const rgb = lo[1].map((v, i) => Math.round(v + f * (hi[1][i] - v)));
  const alpha = 0.35 + t * 0.6;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${alpha.toFixed(2)})`;
}

// ═══════════════════════════════════════════════════════════
// MINI ZONE GRID (per pitch type, per batter side)
// Up to 9 mini strike zones in a 3×3 grid
// ═══════════════════════════════════════════════════════════

function MiniZone({ pitches, pitchType, color, size, isGame }) {
  const { isDark } = useTheme();
  const w = size, h = Math.round(size * 1.15);
  const labelH = 15;
  const pad = 2;
  const plotW = w - pad * 2, plotH = h - labelH - pad;
  const xMin = -1.6, xMax = 1.6, zMin = 0.8, zMax = 4.0;
  const xRange = xMax - xMin, zRange = zMax - zMin;
  const toX = x => pad + (x - xMin) / xRange * plotW;
  const toY = z => labelH + (zMax - z) / zRange * plotH;

  const zoneL = toX(-0.88), zoneR = toX(0.88);
  const zoneT = toY(3.5), zoneB = toY(1.5);
  const zoneW = zoneR - zoneL, zoneH = zoneB - zoneT;

  // Home plate
  const hpCx = toX(0), hpTop = zoneB + 2;
  const hpW = zoneW * 0.5, hpH = hpW * 0.3;
  const hpPts = `${hpCx-hpW/2},${hpTop} ${hpCx-hpW/2},${hpTop+hpH*0.5} ${hpCx},${hpTop+hpH} ${hpCx+hpW/2},${hpTop+hpH*0.5} ${hpCx+hpW/2},${hpTop}`;

  const filtered = pitches.filter(p => p.pX != null && p.pZ != null);
  const dotR = Math.max(2, Math.min(4.5, 50 / Math.max(filtered.length, 1)));

  const useDots = isGame || filtered.length < 10;
  let heatDataUrl = null;
  if (!useDots && filtered.length > 0) {
    heatDataUrl = renderHeatmapCanvas(filtered, xMin, xMax, zMin, zMax, plotW * 3, plotH * 3);
  }

  const abbr = pitchType;
  const bgFill = isDark ? "#1a1a1a" : "#e8e8e8";
  const zoneStroke = isDark ? "rgba(255,255,255,0.7)" : "rgba(0,0,0,0.5)";
  const countFill = isDark ? "#555" : "#999";

  return (
    <svg width={w} height={h} style={{ display: "block" }}>
      <rect x={0} y={0} width={w} height={h} fill={bgFill} rx={3} />
      <rect x={0} y={0} width={w} height={labelH} fill={color + "70"} rx={3} />
      <text x={w / 2} y={11} textAnchor="middle" fill="#fff" fontSize={10} fontWeight={700}>{abbr}</text>
      <rect x={zoneL} y={zoneT} width={zoneW} height={zoneH}
        fill="none" stroke={zoneStroke} strokeWidth={1} />
      <polygon points={hpPts} fill="none" stroke={zoneStroke} strokeWidth={0.8} />
      {useDots ? filtered.map((p, i) => (
        <circle key={i} cx={toX(p.pX)} cy={toY(p.pZ)} r={dotR}
          fill={color} fillOpacity={0.85} stroke="rgba(0,0,0,0.3)" strokeWidth={0.4} />
      )) : heatDataUrl && (
        <image href={heatDataUrl} x={pad} y={labelH} width={plotW} height={plotH}
          style={{ imageRendering: "auto" }} />
      )}
      <text x={w - 3} y={h - 2} textAnchor="end" fill={countFill} fontSize={7}>{filtered.length}</text>
    </svg>
  );
}

export function LocationZonePanel({ pitches, side, width = 260, isGame }) {
  const { theme: th } = useTheme();
  const filtered = pitches.filter(p => p.pX != null && p.pZ != null);
  const types = [...new Set(filtered.map(p => p.pitchType))].filter(pt => pt !== "UN");
  types.sort((a, b) => filtered.filter(p => p.pitchType === b).length - filtered.filter(p => p.pitchType === a).length);

  const n = types.length;
  // Dynamic columns: 1-2 pitches → 2 cols (bigger), 3-6 → 3 cols, 7-9 → 3 cols
  const cols = n <= 2 ? 2 : 3;
  const gap = n <= 2 ? 8 : 5;
  const zoneSize = Math.floor((width - gap * (cols + 1)) / cols);

  return (
    <div style={{ width, display: "flex", flexDirection: "column", alignItems: "center" }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: th.textMuted, marginBottom: 5, textTransform: "uppercase", letterSpacing: "0.04em" }}>
        {side === "ALL" ? `All Batters (${filtered.length})` : `vs ${side === "L" ? "LHB" : "RHB"} (${filtered.length})`}
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", gap, justifyContent: "center", width }}>
        {types.slice(0, 9).map(pt => (
          <MiniZone
            key={pt}
            pitches={filtered.filter(p => p.pitchType === pt)}
            pitchType={pt}
            color={PITCH_COLORS[pt] || "#888888"}
            size={zoneSize}
            isGame={isGame}
          />
        ))}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// ROLLING VELO CHART
// ═══════════════════════════════════════════════════════════
// Game mode: x = pitch # within pitch-type, y = velo. One line per pitch type.
//            Pitches are already in chronological order from extractPitcherData.
// Season mode: x = outing date, y = avg velo per pitch type per outing.
//              Requires pitches tagged with gamePk + gameDate.
export function RollingVeloChart({ pitches, mode = "game", width = 260, height = 400 }) {
  const { theme: t, isDark } = useTheme();
  if (!pitches || pitches.length === 0) return null;

  const pad = { top: 22, right: 14, bottom: 38, left: 36 };
  const plotW = width - pad.left - pad.right;
  const plotH = height - pad.top - pad.bottom;

  // ── Build series: { [pitchType]: [{x, y}, ...] }
  const series = {};
  let xLabels = [];

  if (mode === "game") {
    // Walk pitches in order, assign per-type ordinal
    const counts = {};
    for (const p of pitches) {
      if (!p.pitchType || p.pitchType === "UN" || p.velo == null) continue;
      counts[p.pitchType] = (counts[p.pitchType] || 0) + 1;
      if (!series[p.pitchType]) series[p.pitchType] = [];
      series[p.pitchType].push({ x: counts[p.pitchType], y: p.velo });
    }
  } else {
    // Group by gamePk, then per-type avg velo
    const byGame = new Map();
    for (const p of pitches) {
      if (!p.gamePk || !p.pitchType || p.pitchType === "UN" || p.velo == null) continue;
      if (!byGame.has(p.gamePk)) byGame.set(p.gamePk, { date: p.gameDate || "", types: {} });
      const g = byGame.get(p.gamePk);
      if (!g.types[p.pitchType]) g.types[p.pitchType] = [];
      g.types[p.pitchType].push(p.velo);
    }
    const entries = [...byGame.entries()].sort((a, b) =>
      (a[1].date || "").localeCompare(b[1].date || "")
    );
    xLabels = entries.map(([, g]) => formatShortDate(g.date));
    entries.forEach(([, g], i) => {
      for (const [pt, vs] of Object.entries(g.types)) {
        if (!series[pt]) series[pt] = [];
        const avg = vs.reduce((a, b) => a + b, 0) / vs.length;
        series[pt].push({ x: i + 1, y: Math.round(avg * 10) / 10 });
      }
    });
  }

  const types = Object.keys(series);
  if (types.length === 0) return null;

  // ── Scales
  const allY = types.flatMap(pt => series[pt].map(p => p.y));
  const allX = types.flatMap(pt => series[pt].map(p => p.x));
  const yMin = Math.floor(Math.min(...allY) - 1);
  const yMax = Math.ceil(Math.max(...allY) + 1);
  const xMax = Math.max(...allX);
  const xMin = mode === "game" ? 1 : 1;
  const xRange = Math.max(1, xMax - xMin);
  const yRange = Math.max(1, yMax - yMin);

  const xPos = (x) => pad.left + ((x - xMin) / xRange) * plotW;
  const yPos = (y) => pad.top + (1 - (y - yMin) / yRange) * plotH;

  // ── Y ticks (5 evenly spaced)
  const yTicks = [];
  const step = Math.max(1, Math.round(yRange / 4));
  for (let v = yMin; v <= yMax; v += step) yTicks.push(v);

  // ── X ticks
  const xTicks = [];
  if (mode === "game") {
    const xStep = Math.max(1, Math.ceil(xMax / 6));
    for (let v = 1; v <= xMax; v += xStep) xTicks.push({ x: v, label: String(v) });
    if (xTicks[xTicks.length - 1]?.x !== xMax) xTicks.push({ x: xMax, label: String(xMax) });
  } else {
    // Sparser if many outings to avoid overlap
    const everyN = Math.max(1, Math.ceil(xLabels.length / 6));
    for (let i = 0; i < xLabels.length; i++) {
      if (i % everyN === 0 || i === xLabels.length - 1) {
        xTicks.push({ x: i + 1, label: xLabels[i] });
      }
    }
  }

  return (
    <div style={{ width, padding: "4px 6px" }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: t.textMuted, marginBottom: 4,
        textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center",
      }}>
        Velocity {mode === "game" ? "by Pitch #" : "by Outing"}
      </div>
      <svg width={width} height={height} style={{ display: "block" }}>
        {/* Y grid + labels */}
        {yTicks.map(v => (
          <g key={`y${v}`}>
            <line
              x1={pad.left} x2={width - pad.right}
              y1={yPos(v)} y2={yPos(v)}
              stroke={t.cardBorder} strokeDasharray="3 3" strokeWidth={0.5}
            />
            <text
              x={pad.left - 4} y={yPos(v) + 3}
              textAnchor="end" fontSize={9} fill={t.textFaint}
              fontFamily="'DM Mono', monospace"
            >{v}</text>
          </g>
        ))}
        {/* Y axis label */}
        <text
          x={10} y={pad.top + plotH / 2}
          fontSize={9} fill={t.textFaint}
          textAnchor="middle"
          transform={`rotate(-90 10 ${pad.top + plotH / 2})`}
        >mph</text>

        {/* X axis line */}
        <line
          x1={pad.left} x2={width - pad.right}
          y1={pad.top + plotH} y2={pad.top + plotH}
          stroke={t.divider} strokeWidth={1}
        />

        {/* X labels */}
        {xTicks.map((tk, i) => (
          <text
            key={`x${i}`}
            x={xPos(tk.x)} y={pad.top + plotH + 14}
            textAnchor={mode === "season" ? "end" : "middle"}
            fontSize={9} fill={t.textFaint}
            fontFamily={mode === "game" ? "'DM Mono', monospace" : "inherit"}
            transform={mode === "season" ? `rotate(-35 ${xPos(tk.x)} ${pad.top + plotH + 14})` : ""}
          >{tk.label}</text>
        ))}

        {/* Lines + dots */}
        {types.map(pt => {
          const color = PITCH_COLORS[pt] || "#888";
          const pts = series[pt];
          const path = pts.map((p, i) =>
            `${i === 0 ? "M" : "L"} ${xPos(p.x)} ${yPos(p.y)}`
          ).join(" ");
          return (
            <g key={pt}>
              {pts.length > 1 && (
                <path
                  d={path} fill="none"
                  stroke={color} strokeWidth={1.8}
                  strokeOpacity={0.85} strokeLinecap="round"
                />
              )}
              {pts.map((p, i) => (
                <circle
                  key={i}
                  cx={xPos(p.x)} cy={yPos(p.y)}
                  r={2.5} fill={color}
                  stroke={isDark ? "#0d0d0d" : "#fff"} strokeWidth={0.8}
                />
              ))}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

function formatShortDate(iso) {
  if (!iso) return "";
  // Accepts "YYYY-MM-DD" or full ISO; returns "M/D"
  const m = iso.match(/(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${parseInt(m[2])}/${parseInt(m[3])}`;
}


// ═══════════════════════════════════════════════════════════
// PLATOON USAGE BARS (double-sided by handedness)
// ═══════════════════════════════════════════════════════════
// PLATOON USAGE BARS (double-sided by handedness)
// ═══════════════════════════════════════════════════════════
// Bars sized by max count on each side (so the most-thrown pitch fills the
// bar; others scale relative to it). Outer labels show count + per-handedness
// Pitch+. Matches the back-to-back bar style of Pitch Profiler / FanGraphs.

export function PlatoonUsageBars({ pitches, pitchPlus, width = 260, height = 400 }) {
  const { theme: t } = useTheme();
  if (!pitches || pitches.length === 0) return null;

  const byType = {};
  for (const p of pitches) {
    if (!p.pitchType || p.pitchType === "UN") continue;
    if (!byType[p.pitchType]) byType[p.pitchType] = { L: 0, R: 0 };
    if (p.batSide === "L") byType[p.pitchType].L++;
    else if (p.batSide === "R") byType[p.pitchType].R++;
  }

  const types = Object.keys(byType).sort((a, b) =>
    (byType[b].L + byType[b].R) - (byType[a].L + byType[a].R)
  );
  if (types.length === 0) return null;

  const totalL = types.reduce((s, pt) => s + byType[pt].L, 0) || 0;
  const totalR = types.reduce((s, pt) => s + byType[pt].R, 0) || 0;

  // Scale by max count on each side (not by total) — matches Williams reference,
  // makes the most-thrown pitch fill the bar and others scale relative to it.
  // This visibly widens bars vs. the previous percentage-of-total scaling.
  const maxL = Math.max(1, ...types.map(pt => byType[pt].L));
  const maxR = Math.max(1, ...types.map(pt => byType[pt].R));

  const headerH = 30;
  const rowH = Math.max(38, Math.floor((height - headerH - 12) / Math.max(types.length, 1)));
  const centerW = 2;
  const sideW = (width - centerW) / 2;
  const labelW = 54; // outer reserve for "Count: NN" + "{pp} Pitch+" stacked
  const maxBarW = sideW - labelW - 4;

  return (
    <div style={{ width, padding: "4px 4px" }}>
      <div style={{
        fontSize: 10, fontWeight: 800, color: t.textMuted, marginBottom: 4,
        textTransform: "uppercase", letterSpacing: "0.06em", textAlign: "center",
      }}>
        Usage by Platoon
      </div>
      <svg width={width} height={height} style={{ display: "block" }}>
        {/* Headers */}
        <text
          x={sideW / 2} y={14}
          textAnchor="middle" fontSize={11} fontWeight={800} fill={t.text}
          letterSpacing="0.08em"
        >LHH</text>
        <text
          x={sideW + centerW + sideW / 2} y={14}
          textAnchor="middle" fontSize={11} fontWeight={800} fill={t.text}
          letterSpacing="0.08em"
        >RHH</text>
        <text
          x={sideW / 2} y={26}
          textAnchor="middle" fontSize={9} fill={t.textFaint}
          fontFamily="'DM Mono', monospace"
        >{totalL} pitches</text>
        <text
          x={sideW + centerW + sideW / 2} y={26}
          textAnchor="middle" fontSize={9} fill={t.textFaint}
          fontFamily="'DM Mono', monospace"
        >{totalR} pitches</text>

        {/* Center divider */}
        <line
          x1={sideW + centerW / 2} x2={sideW + centerW / 2}
          y1={headerH + 4} y2={height - 4}
          stroke={t.textMuted} strokeWidth={2}
        />

        {/* Rows */}
        {types.map((pt, i) => {
          const color = PITCH_COLORS[pt] || "#888";
          const lCount = byType[pt].L;
          const rCount = byType[pt].R;
          const lW = (lCount / maxL) * maxBarW;
          const rW = (rCount / maxR) * maxBarW;
          const cx = sideW + centerW / 2;
          const y = headerH + 6 + i * rowH;
          const barH = rowH - 10;
          const midY = y + barH / 2;

          // Per-handedness Stuff+
          const lPp = pitchPlus?.[pt]?.L?.stuffPlus;
          const rPp = pitchPlus?.[pt]?.R?.stuffPlus;

          return (
            <g key={pt}>
              {/* LHH bar (anchored at center, extends leftward) */}
              {lCount > 0 && (
                <>
                  <rect
                    x={cx - lW} y={y}
                    width={lW} height={barH}
                    fill={color} fillOpacity={0.92}
                    rx={2}
                  />
                  {/* Outer labels: % on top, Pitch+ below (same color) */}
                  <text
                    x={4} y={midY - 1}
                    fontSize={9} fontWeight={800}
                    fill={t.textSecondary}
                    fontFamily="'DM Mono', monospace"
                  >{totalL > 0 ? Math.round(lCount / totalL * 100) : 0}%</text>
                  {lPp != null && (
                    <text
                      x={4} y={midY + 9}
                      fontSize={8} fontWeight={700}
                      fill={t.textSecondary}
                      fontFamily="'DM Mono', monospace"
                    >{Math.round(lPp)} Stuff+</text>
                  )}
                </>
              )}
              {/* RHH bar (anchored at center, extends rightward) */}
              {rCount > 0 && (
                <>
                  <rect
                    x={cx} y={y}
                    width={rW} height={barH}
                    fill={color} fillOpacity={0.92}
                    rx={2}
                  />
                  <text
                    x={width - 4} y={midY - 1}
                    textAnchor="end"
                    fontSize={9} fontWeight={800}
                    fill={t.textSecondary}
                    fontFamily="'DM Mono', monospace"
                  >{totalR > 0 ? Math.round(rCount / totalR * 100) : 0}%</text>
                  {rPp != null && (
                    <text
                      x={width - 4} y={midY + 9}
                      textAnchor="end"
                      fontSize={8} fontWeight={700}
                      fill={t.textSecondary}
                      fontFamily="'DM Mono', monospace"
                    >{Math.round(rPp)} Stuff+</text>
                  )}
                </>
              )}
            </g>
          );
        })}
      </svg>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// SIDE PANEL SELECTOR (small toggle bar)
// ═══════════════════════════════════════════════════════════
export function PanelToggle({ value, onChange, options }) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      display: "flex", justifyContent: "center", gap: 4,
      padding: "4px 0 6px",
    }}>
      {options.map(opt => {
        const active = value === opt.value;
        return (
          <button
            key={opt.value}
            onClick={() => onChange(opt.value)}
            style={{
              padding: "3px 10px",
              fontSize: 10, fontWeight: 700,
              letterSpacing: "0.04em", textTransform: "uppercase",
              background: active ? t.text : "transparent",
              color: active ? t.cardBg : t.textMuted,
              border: `1px solid ${active ? t.text : t.inputBorder}`,
              borderRadius: 4, cursor: "pointer",
              fontFamily: "inherit",
            }}
          >{opt.label}</button>
        );
      })}
    </div>
  );
}
