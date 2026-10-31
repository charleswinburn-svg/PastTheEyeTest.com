import { useEffect, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";

// ═══════════════════════════════════════════════════════════
// COUNTING STATS TABLE
// ═══════════════════════════════════════════════════════════
// One row per season (2023 → current) of FanGraphs season totals for the card's
// player, read from public/counting_stats_{season}.json (baseball_pipeline.py).
// Sits above Similar Players on both cards. No heading on the site; scrolls
// horizontally rather than squeezing its columns.

export const COUNTING_SEASONS = [2023, 2024, 2025, 2026];

const HITTER_COLS = [
  ["team", "Team", "s"], ["g", "G", "i"], ["pa", "PA", "i"], ["hr", "HR", "i"], ["rbi", "RBI", "i"],
  ["sb", "SB", "i"], ["r", "R", "i"], ["bb_pct", "BB%", "p"], ["k_pct", "K%", "p"],
  ["off", "Off", "1"], ["def", "Def", "1"], ["wpa", "WPA", "2"], ["war", "fWAR", "1"],
];
const PITCHER_COLS = [
  ["team", "Team", "s"], ["g", "G", "i"], ["gs", "GS", "i"], ["ip", "IP", "ip"], ["w", "W", "i"], ["l", "L", "i"],
  ["sv", "SV", "i"], ["k_pct", "K%", "p"], ["bb_pct", "BB%", "p"], ["k_bb_pct", "K-BB%", "p"], ["gb_pct", "GB%", "p"],
  ["hr_fb", "HR/FB%", "p"], ["siera", "SIERA", "2"], ["fip", "FIP", "2"], ["era", "ERA", "2"], ["xera", "xERA", "2"],
  ["war", "fWAR", "1"],
];

const _cache = new Map();   // season → Promise<file|null>
function loadCounting(season) {
  if (!_cache.has(season)) {
    _cache.set(season, fetch(`/counting_stats_${season}.json`).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return _cache.get(season);
}

function fmt(v, kind) {
  if (v == null || v === "") return "—";
  if (kind === "s") return String(v);
  const n = Number(v);
  if (!Number.isFinite(n)) return String(v);
  switch (kind) {
    case "i": return String(Math.round(n));
    case "ip": return n.toFixed(1);
    case "p": return n.toFixed(1);
    case "1": return n.toFixed(1);
    case "2": return n.toFixed(2);
    default: return String(n);
  }
}

export default function CountingStatsTable({ playerId, type = "hitter", season }) {
  const { theme: t } = useTheme();
  const [rows, setRows] = useState(undefined);
  const cols = type === "pitcher" ? PITCHER_COLS : HITTER_COLS;
  const group = type === "pitcher" ? "pitchers" : "hitters";

  useEffect(() => {
    let cancelled = false;
    setRows(undefined);
    if (!playerId) { setRows([]); return; }
    const cur = Number(season);
    const seasons = [...new Set([...COUNTING_SEASONS, ...(Number.isFinite(cur) ? [cur] : [])])].sort();
    Promise.all(seasons.map(s => loadCounting(s).then(f => [s, f?.[group]?.[String(playerId)] || null])))
      .then(out => { if (!cancelled) setRows(out.filter(([, r]) => r)); });
    return () => { cancelled = true; };
  }, [playerId, type, season]);

  const th = { padding: "6px 10px", fontSize: 10, fontWeight: 700, color: t.textFaint, textAlign: "right", whiteSpace: "nowrap", borderBottom: `1px solid ${t.divider}`, letterSpacing: "0.03em" };
  const td = { padding: "5px 10px", fontSize: 12, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT, textAlign: "right", whiteSpace: "nowrap", color: t.text };

  return (
    <div style={{ marginTop: 16 }}>
    <FitToWidth designWidth={1040}>
    <div style={{
      background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 12,
      boxShadow: `0 4px 24px ${t.shadow}`, width: 1040, margin: "0 auto", overflow: "hidden",
    }}>
      {rows === undefined ? (
        <div style={{ padding: "14px 16px", fontSize: 12, color: t.textMuted, textAlign: "center" }}>Loading season totals…</div>
      ) : !rows.length ? (
        <div style={{ padding: "14px 16px", fontSize: 12, color: t.textMuted, textAlign: "center" }}>No FanGraphs season line yet.</div>
      ) : (
        <div style={{ overflowX: "auto", WebkitOverflowScrolling: "touch" }}>
          <table style={{ borderCollapse: "collapse", minWidth: type === "pitcher" ? 900 : 760, width: "100%" }}>
            <thead>
              <tr>
                <th style={{ ...th, textAlign: "left" }}>Season</th>
                {cols.map(([k, label, kind]) => <th key={k} style={{ ...th, textAlign: kind === "s" ? "left" : "right" }}>{label}</th>)}
              </tr>
            </thead>
            <tbody>
              {rows.map(([s, r], i) => {
                const current = String(s) === String(season);
                return (
                  <tr key={s} style={{ background: current ? (t.id === "dark" ? "rgba(245,158,11,0.10)" : "rgba(234,88,12,0.08)") : i % 2 ? t.tableRowB : "transparent" }}>
                    <td style={{ ...td, textAlign: "left", color: current ? t.accent : t.textSecondary, borderLeft: `3px solid ${current ? t.accent : "transparent"}` }}>{s}</td>
                    {cols.map(([k, , kind]) => (
                      <td key={k} style={{ ...td, textAlign: kind === "s" ? "left" : "right", fontFamily: kind === "s" ? "inherit" : NUM_FONT, fontWeight: kind === "s" ? 600 : NUM_WEIGHT, color: kind === "s" ? t.textMuted : t.text }}>
                        {fmt(r[k], kind)}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
    </FitToWidth>
    </div>
  );
}
