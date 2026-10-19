import { useState, useEffect, useMemo, useRef } from "react";
import { useTheme } from "./ThemeContext.jsx";
import {
  PlayerHeader, SearchableSelect, saveCardAsPng, binColor, textOnBin, teamMarkColor, hexLuminance, mixHex,
} from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";

// "{year} RANGES" → Hitter / Pitcher Confidence Intervals.
// Each projected stat carries a 90% band and its 50% core (proj[stat].ci = {lo, lo50,
// hi50, hi, n}) from build_projections.py: learned from the projection's own walk-forward
// misses, tighter for players with a long, full track record, wider for thin histories.
// Everything is drawn on one axis — standard deviations from the 2026 league average,
// better to the right (lower-is-better stats flipped) — so certainty compares across stats
// with different units, and an elite player's range isn't squashed against the 100th
// percentile the way a percentile axis would. Dots keep the cards' percentile colors.
//   Player view: one fan interval per stat (light = 90%, dark = 50%, dot = projection,
//                ring = 2026 actual).
//   Board view:  floors and ceilings for one stat across players.

const FONT = "'Pliant', sans-serif";
const BANNER_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const XRV_LABELS = ["xRV/600", "Contact Quality", "Whiff", "Decision"];
const MIN_REG = { hitters: { field: "pa", n: 300, unit: "PA" }, pitchers: { field: "ip", n: 50, unit: "IP" } };

const _cache = new Map();
function loadJson(path) {
  if (!_cache.has(path)) _cache.set(path, fetch(path).then(r => (r.ok ? r.json() : null)).catch(() => null));
  return _cache.get(path);
}

const num = (s) => {
  const v = parseFloat(String(s ?? "").replace("−", "-").replace(/[^0-9.+-]/g, ""));
  return isFinite(v) ? v : null;
};

// 2026 percentile of a value (higher = better; lower-is-better stats flipped).
function pctOf(pool, v, lowerBetter) {
  if (!pool?.length || v == null || !isFinite(v)) return null;
  let below = 0, tied = 0;
  for (const x of pool) { if (x < v) below++; else if (x === v) tied++; }
  const p = (100 * (below + tied / 2)) / pool.length;
  return Math.max(0, Math.min(100, lowerBetter ? 100 - p : p));
}

// Format a raw value like the stat's own display string (decimals, ×100 for stored decimals,
// leading zero dropped for .xxx stats, explicit sign for xRV).
function formatter(cat, signed) {
  const disp = String(cat.display ?? "");
  const dec = (disp.split(".")[1] || "").replace(/[^0-9]/g, "").length;
  const dv = num(disp);
  const scale = dv != null && cat.value && Math.abs(cat.value) > 1e-9 ? Math.round(dv / cat.value) || 1 : 1;
  return (v) => {
    if (v == null || !isFinite(v)) return "—";
    let s = (v * scale).toFixed(dec);
    if (dec === 3) s = s.replace(/^(-?)0\./, "$1.");
    return signed && v * scale > 0 ? `+${s}` : s.replace("-", "−");
  };
}

// Every stat for one side: { key, label, lowerBetter, get(player) → cat, pool, widened }.
// (iSwing+ and the pitch-modeling grades are model outputs, not stat lines — no ranges.)
function statList(data, xrv, side) {
  if (!data) return [];
  const out = [];
  if (side === "hitters") {
    const pools = data.meta?.pools || {};
    for (const l of XRV_LABELS) {
      out.push({ key: `xrv:${l}`, label: l, lowerBetter: false, signed: true, pool: data.meta?.xrv_pools?.[l],
        get: p => xrv?.[String(p.player_id)]?.metrics?.[l] });
    }
    for (const m of data.hitter_metrics || []) {
      out.push({ key: `cat:${m.label}`, label: m.label, lowerBetter: !!m.lower_better, pool: pools[m.label],
        get: p => p.categories?.[m.label] });
    }
  } else {
    const pools = data.pitcher_meta?.pools || {};
    for (const m of data.pitcher_metrics || []) {
      out.push({ key: `cat:${m.label}`, label: m.label, lowerBetter: !!m.lower_better, pool: pools[m.label],
        get: p => p.categories?.[m.label] });
    }
  }
  const players = (side === "hitters" ? data.hitters : data.pitchers) || [];
  const ciMeta = (side === "hitters" ? data.meta?.ci?.stats : data.pitcher_meta?.ci?.stats) || {};
  for (const st of out) {
    // one usable backtest season (bat tracking / pitch-model xRV): marked * in the tab
    st.oneSeason = (ciMeta[st.label]?.n_seasons ?? 2) < 2;
    st.widen = ciMeta[st.label]?.widened || 1;
    st.hasModel = players.some(pl => Math.abs(st.get(pl)?.parts?.model ?? 0) > 1e-6);
    st.hasCi = players.some(pl => st.get(pl)?.ci);
  }
  return out.filter(st => st.hasCi && st.pool?.length);
}

// League mean / SD of the 2026 pool, cached on the stat.
function poolStats(st) {
  if (!st._ms) {
    const xs = st.pool, m = xs.reduce((a, v) => a + v, 0) / xs.length;
    const sd = Math.sqrt(xs.reduce((a, v) => a + (v - m) ** 2, 0) / Math.max(1, xs.length - 1)) || 1;
    st._ms = { m, sd };
  }
  return st._ms;
}
const Z_MAX = 3.5;

// One stat for one player, on the SD axis (better to the right).
function rangeRow(st, p) {
  const cat = st.get(p);
  if (!cat?.ci || cat.value == null) return null;
  const { lo, lo50, hi50, hi, n } = cat.ci;
  const { m, sd } = poolStats(st);
  const Z = (v) => Math.max(-Z_MAX, Math.min(Z_MAX, ((st.lowerBetter ? -1 : 1) * (v - m)) / sd));
  const P = (v) => pctOf(st.pool, v, st.lowerBetter);
  const f = formatter(cat, st.signed);
  // "floor" / "ceiling" in the better direction
  const worst = st.lowerBetter ? hi : lo, best = st.lowerBetter ? lo : hi;
  return {
    st, cat, f, n,
    proj: Z(cat.value), projP: P(cat.value), last: cat.last?.value != null ? Z(cat.last.value) : null,
    a90: Z(worst), b90: Z(best),
    a50: Math.min(Z(lo50), Z(hi50)), b50: Math.max(Z(lo50), Z(hi50)),
    floorV: worst, ceilV: best, floorP: P(worst), ceilP: P(best), width: Math.abs(hi - lo),
  };
}

function readableOn(hex, isDark) {
  const lum = hexLuminance(hex);
  if (isDark && lum < 0.05) return mixHex(hex, "#ffffff", 0.35);
  if (!isDark && lum > 0.45) return mixHex(hex, "#000000", 0.35);
  return hex;
}

export default function RangeView({ projSeason, side }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(undefined);
  const [xrv, setXrv] = useState(null);
  const [mode, setMode] = useState("player");
  const year = String(projSeason).slice(0, 4);
  const lastYear = Number(year) - 1;

  useEffect(() => {
    let alive = true;
    loadJson(`/baseball_data_${projSeason}.json`).then(d => { if (alive) setData(d || null); });
    loadJson(`/hitter_xrv_${projSeason}.json`).then(d => { if (alive) setXrv(d || null); });
    return () => { alive = false; };
  }, [projSeason]);

  const stats = useMemo(() => statList(data, xrv, side), [data, xrv, side]);
  const players = useMemo(() => ((side === "hitters" ? data?.hitters : data?.pitchers) || []), [data, side]);

  const msg = (text) => <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13, fontFamily: FONT }}>{text}</div>;
  if (data === undefined) return msg(`Loading ${year} projections…`);
  if (data === null) return msg(`No ${year} projections found (baseball_data_${projSeason}.json).`);
  if (!stats.length) return msg(`The ${year} projections have no confidence intervals yet — rebuild them with the latest build scripts.`);

  const toggle = (id, label) => (
    <button key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id}
      style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT, border: "none",
               background: mode === id ? t.accent : "transparent", color: mode === id ? "#fff" : t.textMuted }}>
      {label}
    </button>
  );

  return (
    <div style={{ padding: "16px 20px", fontFamily: FONT, maxWidth: 1180, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "inline-flex", border: `1px solid ${t.inputBorder}`, borderRadius: 6, overflow: "hidden", marginBottom: 12 }}>
        {toggle("player", "Player")}
        {toggle("board", "Floors & Ceilings")}
      </div>
      {mode === "player"
        ? <PlayerRanges stats={stats} players={players} side={side} year={year} lastYear={lastYear} />
        : <RangeBoard stats={stats} players={players} side={side} year={year} lastYear={lastYear} />}
      <div style={{ marginTop: 12, fontSize: 10, color: t.textFaint, textAlign: "center", lineHeight: 1.5 }}>
        90% ranges: where the {year} stat should land 9 times in 10, learned from how far past projections missed
        (each season projected only from the seasons before it). A long, full-time track record narrows the range; a thin
        history widens it. Playing time is assumed at his recent level, up to a full season. Axis = standard deviations
        from the {lastYear} league average, better to the right; dot colors are {lastYear} percentiles, like the cards.
      </div>
    </div>
  );
}

// ── Player view: one fan interval per stat on the shared percentile axis ──
function PlayerRanges({ stats, players, side, year, lastYear }) {
  const { theme: t, isDark } = useTheme();
  const cardRef = useRef(null);
  const [pid, setPid] = useState(null);
  const options = useMemo(() => players
    .map(p => ({ value: String(p.player_id), name: p.name || String(p.player_id),
                 label: `${p.name}${p.team ? ` (${p.team})` : ""}` }))
    .sort((a, b) => a.name.localeCompare(b.name)), [players]);
  const p = players.find(x => String(x.player_id) === pid) || null;
  const rows = useMemo(() => (p ? stats.map(st => rangeRow(st, p)).filter(Boolean) : []), [p, stats]);

  const color = readableOn(teamMarkColor(p?.team) || t.accentSecondary, isDark);
  const reg = MIN_REG[side];
  const ptRow = rows.find(r => r.n && (side === "hitters" ? r.st.key === "cat:K%" : r.st.key === "cat:K%")) || rows.find(r => r.n);
  const tight = rows.filter(r => r.b90 - r.a90 <= 1).length;

  const save = () => saveCardAsPng(cardRef, `${(p?.name || "player").replace(/\s+/g, "_")}_${year}_ranges.png`);

  return (
    <>
      <div style={{ marginBottom: 12 }}>
        <SearchableSelect value={pid || ""} options={options} onChange={(v) => setPid(v || null)}
          placeholder={`Search ${side === "hitters" ? "hitter" : "pitcher"}…`}
          style={{ padding: "6px 12px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`,
                   borderRadius: 6, fontSize: 12, minWidth: 320, fontFamily: FONT }} />
      </div>
      {!p ? (
        <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>Select a {side === "hitters" ? "hitter" : "pitcher"}</div>
      ) : (
        <>
          <FitToWidth designWidth={860}>
            <div ref={cardRef} style={{ fontFamily: FONT, background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
                                        overflow: "hidden", maxWidth: 860, margin: "0 auto", boxShadow: `0 4px 24px ${t.shadow}` }}>
              <div style={{ fontFamily: BANNER_FONT }}>
                <PlayerHeader name={p.name} team={p.team} teamId={p.team_id} season={year} playerId={Number(p.player_id)}
                  subtitle={`${year} Projection · 90% Confidence Intervals`} />
              </div>
              <div style={{ textAlign: "center", padding: "12px 16px 2px", fontSize: 12, color: t.textMuted, fontWeight: 700 }}>
                {p.proj?.age != null && <>Age {p.proj.age} · </>}
                {p[reg.field] != null && <>{p[reg.field]} {reg.unit} in {lastYear} · </>}
                {ptRow?.n != null && <>ranges assume ~{ptRow.n} {side === "hitters" ? "PA" : reg.unit} · </>}
                {tight} of {rows.length} ranges within 1 league SD
              </div>
              <RangeChart rows={rows} color={color} lastYear={lastYear} year={year} />
              {rows.some(r => r.st.oneSeason) && (() => {
                const w = Math.max(...rows.filter(r => r.st.oneSeason).map(r => r.st.widen));
                return (
                  <div style={{ padding: "0 20px 4px", fontSize: 10, color: t.textFaint, textAlign: "center" }}>
                    * Short history (bat tracking / pitch-model xRV): range estimated from a single backtest season
                    {w >= 1.02 ? `, widened ×${w.toFixed(2)} for season-to-season drift` : ""}.
                  </div>
                );
              })()}
              <div style={{ padding: "6px 16px 8px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
                <span>Created by: @PastTheEyeTest on X</span>
                <span style={{ fontStyle: "italic" }}>{year} projection · 90% / 50% ranges from walk-forward backtests</span>
              </div>
            </div>
          </FitToWidth>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={save} style={{ padding: "6px 16px", fontSize: 11, fontWeight: 600, fontFamily: FONT, background: t.inputBg,
              color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer" }}>📥 Save as PNG</button>
          </div>
        </>
      )}
    </>
  );
}

function RangeChart({ rows, color, lastYear, year }) {
  const { theme: t } = useTheme();
  const W = 840, labelW = 168, valW = 150, rowH = 30, top = 34, bottom = 40;
  const plotL = labelW, plotR = W - valW - 12, plotW = plotR - plotL;
  const H = top + rows.length * rowH + bottom;
  const x = (z) => plotL + ((z + Z_MAX) / (2 * Z_MAX)) * plotW;
  const yBottom = top + rows.length * rowH;
  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "4px 10px 0" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: "100%", height: "auto", fontFamily: FONT }} role="img"
        aria-label={rows.map(r => `${r.st.label}: projected ${r.cat.display}, 90% range ${r.f(r.floorV)} to ${r.f(r.ceilV)}`).join("; ")}>
        {/* ±1 SD of the league (about its middle two-thirds) */}
        <rect x={x(-1)} y={top - 6} width={x(1) - x(-1)} height={yBottom - top + 6} fill={t.text} fillOpacity="0.035" />
        {[-3, -2, -1, 0, 1, 2, 3].map(v => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={top - 6} y2={yBottom} stroke={v === 0 ? t.textMuted : t.divider}
              strokeWidth={v === 0 ? 1.1 : 1} strokeDasharray={v === 0 ? "4 3" : undefined} />
            <text x={x(v)} y={yBottom + 14} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textFaint}>
              {v === 0 ? "Avg" : `${v > 0 ? "+" : "−"}${Math.abs(v)}`}
            </text>
          </g>
        ))}
        <text x={plotL} y={H - 6} fontSize="10" fontWeight="700" fill={t.textMuted}>← WORSE</text>
        <text x={(plotL + plotR) / 2} y={H - 6} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textMuted} letterSpacing="0.06em">
          SD FROM {lastYear} LEAGUE AVERAGE
        </text>
        <text x={plotR} y={H - 6} textAnchor="end" fontSize="10" fontWeight="700" fill={t.textMuted}>BETTER →</text>
        <text x={W - valW / 2 - 6} y={top - 12} textAnchor="middle" fontSize="9.5" fontWeight="800" fill={t.textFaint} letterSpacing="0.06em">
          {year} · FLOOR – CEILING
        </text>
        {/* legend */}
        <g transform={`translate(${plotL}, ${top - 18})`} fontSize="9.5" fill={t.textMuted}>
          <rect x="0" y="-7" width="22" height="8" rx="2" fill={color} fillOpacity="0.28" />
          <text x="27" y="0">90%</text>
          <rect x="56" y="-7" width="22" height="8" rx="2" fill={color} fillOpacity="0.7" />
          <text x="83" y="0">50%</text>
          <circle cx="118" cy="-3" r="4.5" fill={t.text} />
          <text x="127" y="0">{year} projection</text>
          <circle cx="212" cy="-3" r="4" fill="none" stroke={t.textMuted} strokeWidth="1.6" />
          <text x="221" y="0">{lastYear} actual</text>
        </g>
        {rows.map((r, i) => {
          const y = top + i * rowH, cy = y + rowH / 2;
          const model = r.st.hasModel;
          return (
            <g key={r.st.key}>
              {i > 0 && <line x1={12} x2={W - 12} y1={y} y2={y} stroke={t.divider} strokeOpacity="0.5" />}
              <text x={labelW - 10} y={cy + 4} textAnchor="end" fontSize="12" fontWeight="700"
                fill={model ? t.accent : t.text} fontStyle={model ? "italic" : "normal"}>{r.st.label}{r.st.oneSeason ? "*" : ""}</text>
              <rect x={x(r.a90)} y={cy - 7} width={Math.max(2, x(r.b90) - x(r.a90))} height={14} rx="3" fill={color} fillOpacity="0.28" />
              <rect x={x(r.a50)} y={cy - 7} width={Math.max(2, x(r.b50) - x(r.a50))} height={14} rx="3" fill={color} fillOpacity="0.7" />
              {r.last != null && <circle cx={x(r.last)} cy={cy} r="5" fill="none" stroke={t.textMuted} strokeWidth="1.8" />}
              <circle cx={x(r.proj)} cy={cy} r="6.5" fill={binColor(r.projP)} stroke={t.cardBg} strokeWidth="2" />
              <text x={W - valW - 2} y={cy + 4} fontSize="13" fontWeight="800" fill={t.text}>{r.cat.display}</text>
              <text x={W - 14} y={cy + 4} textAnchor="end" fontSize="11" fontWeight="600" fill={t.textMuted}>
                {r.f(r.floorV)} – {r.f(r.ceilV)}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}

// ── Board view: floors and ceilings for one stat ──
const SORTS = [
  { id: "ceiling", label: "Highest ceiling", key: r => (r.st.lowerBetter ? r.ceilV : -r.ceilV) },
  { id: "floor", label: "Safest floor", key: r => (r.st.lowerBetter ? r.floorV : -r.floorV) },
  { id: "wide", label: "Widest range", key: r => -r.width },
  { id: "tight", label: "Tightest range", key: r => r.width },
];

function RangeBoard({ stats, players, side, year, lastYear }) {
  const { theme: t } = useTheme();
  const [statKey, setStatKey] = useState(null);
  const [sort, setSort] = useState("ceiling");
  const [regulars, setRegulars] = useState(true);
  const st = stats.find(s => s.key === statKey) || stats[0];
  const reg = MIN_REG[side];
  const rows = useMemo(() => {
    const all = players
      .filter(p => !regulars || (p[reg.field] ?? 0) >= reg.n)
      .map(p => { const r = rangeRow(st, p); return r && { ...r, p }; })
      .filter(Boolean);
    const k = SORTS.find(s => s.id === sort).key;
    return all.sort((a, b) => k(a) - k(b)).slice(0, 50);
  }, [players, st, sort, regulars, reg]);

  const pill = (on, label, onClick, key) => (
    <button key={key || label} type="button" onClick={onClick} aria-pressed={on} style={{
      padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 14, cursor: "pointer", fontFamily: FONT,
      background: on ? `${t.accent}26` : t.inputBg, color: on ? t.text : t.textMuted,
      border: `1px solid ${on ? t.accent : t.inputBorder}`,
    }}>{label}</button>
  );
  const th = { padding: "6px 6px", fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase",
               letterSpacing: "0.06em", borderBottom: `1px solid ${t.tableHeaderBorder}`, textAlign: "right", whiteSpace: "nowrap" };
  const td = { padding: "5px 6px", fontSize: 12, color: t.textSecondary, textAlign: "right", whiteSpace: "nowrap", fontFamily: FONT };
  const pctPill = (v) => (v == null ? "—" : (
    <span style={{ display: "inline-block", minWidth: 26, padding: "1px 5px", borderRadius: 10, fontSize: 10.5, fontWeight: 800,
                   background: binColor(v), color: textOnBin(v), textAlign: "center", marginLeft: 6 }}>{Math.round(v)}</span>
  ));

  return (
    <>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 12 }}>
        <select value={st.key} onChange={e => setStatKey(e.target.value)} title="Orange italic = stat has an iSwing+ / Stuff+ model layer"
          style={{ padding: "6px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6, fontSize: 12,
                   fontFamily: FONT, color: st.hasModel ? t.accent : t.textSecondary, fontStyle: st.hasModel ? "italic" : "normal" }}>
          {stats.map(s => (
            <option key={s.key} value={s.key} style={{ background: t.inputBg, color: s.hasModel ? t.accent : t.textSecondary,
              fontStyle: s.hasModel ? "italic" : "normal" }}>{s.label}{s.oneSeason ? "*" : ""}</option>
          ))}
        </select>
        {SORTS.map(s => pill(sort === s.id, s.label, () => setSort(s.id), s.id))}
        {pill(regulars, `${reg.n}+ ${reg.unit} in ${lastYear}`, () => setRegulars(v => !v), "reg")}
        <span style={{ fontSize: 11, color: t.textFaint }}>
          {st.lowerBetter ? "lower is better: floor = high end, ceiling = low end" : ""}
        </span>
      </div>
      <div style={{ background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 10, overflow: "hidden" }}>
        <div style={{ overflowX: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse" }}>
            <thead style={{ background: t.tableHeaderBg }}>
              <tr>
                <th style={{ ...th, textAlign: "center" }}>#</th>
                <th style={{ ...th, textAlign: "left" }}>Player</th>
                <th style={th}>Age</th>
                <th style={th}>{year} Proj</th>
                <th style={th}>Floor (5th)</th>
                <th style={th}>Ceiling (95th)</th>
                <th style={th}>Range</th>
                <th style={{ ...th, textAlign: "center" }}>vs {lastYear} league · 90% / 50%</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => (
                <tr key={r.p.player_id} style={{ background: i % 2 ? t.tableRowB : t.tableRowA }}>
                  <td style={{ ...td, textAlign: "center", color: t.textFaint }}>{i + 1}</td>
                  <td style={{ ...td, textAlign: "left", color: t.text, maxWidth: 200, overflow: "hidden", textOverflow: "ellipsis" }}>
                    {r.p.name}{r.p.team ? <span style={{ color: t.textFaint, fontSize: 10 }}> {r.p.team}</span> : null}
                  </td>
                  <td style={td}>{r.p.proj?.age ?? "—"}</td>
                  <td style={{ ...td, color: t.text, fontWeight: 800 }}>{r.cat.display}</td>
                  <td style={td}>{r.f(r.floorV)}{pctPill(r.floorP)}</td>
                  <td style={td}>{r.f(r.ceilV)}{pctPill(r.ceilP)}</td>
                  <td style={td}>{r.f(r.width).replace(/^\+/, "")}</td>
                  <td style={{ ...td, textAlign: "center", padding: "3px 10px" }}><MiniFan r={r} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </>
  );
}

function MiniFan({ r }) {
  const { theme: t } = useTheme();
  const W = 190, H = 18, x = (z) => 4 + ((z + Z_MAX) / (2 * Z_MAX)) * (W - 8);
  return (
    <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ display: "block", margin: "0 auto" }}>
      <line x1={x(0)} x2={x(0)} y1={1} y2={H - 1} stroke={t.textFaint} strokeDasharray="2 2" />
      <rect x={x(r.a90)} y={5} width={Math.max(2, x(r.b90) - x(r.a90))} height={8} rx="2" fill={t.accent} fillOpacity="0.25" />
      <rect x={x(r.a50)} y={5} width={Math.max(2, x(r.b50) - x(r.a50))} height={8} rx="2" fill={t.accent} fillOpacity="0.65" />
      <circle cx={x(r.proj)} cy={9} r="4" fill={binColor(r.projP)} stroke={t.cardBg} strokeWidth="1.5" />
    </svg>
  );
}
