import { useMemo, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { NUM_FONT } from "../baseball/SharedComponents.jsx";
import { spectrumRgb, inkOn } from "./nhlColors.js";
import { LB_GROUPS, leaderboardColumns, fixed, whole } from "./rows.js";
import { flagUrl, logoUrl } from "./nhlData.js";
import { Segmented } from "./PlayerCard.jsx";

// ═══════════════════════════════════════════════════════════
// LEADERBOARD
// One sortable table per kind. Filters: team, position, tier, minimum games, name search.
// Column groups switch on and off. "Colour" shades each number by where it ranks among the
// players shown (blue low, grey middle, red high; reversed for columns where lower is better).
// ═══════════════════════════════════════════════════════════

export default function Leaderboard({ players, kind, v, teams, team, onTeam, onPick }) {
  const { theme: t, isDark } = useTheme();
  const skaters = kind === "skaters";
  const gpKey = skaters ? "gp" : "games";
  const [pos, setPos] = useState("All");
  const [tier, setTier] = useState("All");
  const [groups, setGroups] = useState(LB_GROUPS.slice(0, 3));
  const [colored, setColored] = useState(true);
  const [search, setSearch] = useState("");
  const [sort, setSort] = useState({ col: `war_${v}`, dir: -1 });
  const mostGp = useMemo(() => Math.max(0, ...players.map(p => p[gpKey] || 0)), [players, gpKey]);
  const [minGp, setMinGp] = useState(null);
  const least = minGp ?? Math.min(skaters ? 20 : 10, Math.floor(mostGp / 4));

  const tiers = useMemo(() => [...new Set(players.map(p => p.tier_WAR).filter(Boolean))], [players]);
  const specs = useMemo(() => leaderboardColumns(kind, v).filter(c => groups.includes(c.group))
    .filter(c => !(/^war_(setup|reb)_/.test(c.col) && !players.some(p => Math.abs(p[c.col] || 0) > 1e-9))), [kind, v, groups, players]);
  const sortCol = sort.col.replace(/_(3y|1y)(?=_pct$|$)/, `_${v}`);          // keep the sort when the version changes

  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    const rows = players.filter(p =>
      (pos === "All" || p.pos_group === pos || p.position === pos) && (tier === "All" || p.tier_WAR === tier) &&
      (p[gpKey] || 0) >= least && (!q || p.player.toLowerCase().includes(q) || (p.team || "").toLowerCase().includes(q)));
    const text = ["player", "team", "position", "tier_WAR"].includes(sortCol);
    rows.sort((a, b) => {
      const x = a[sortCol], y = b[sortCol];
      if (x == null) return 1;
      if (y == null) return -1;
      return (text ? String(x).localeCompare(String(y)) : x - y) * sort.dir;
    });
    return rows;
  }, [players, pos, tier, least, search, sortCol, sort.dir, gpKey]);

  // percentile of every coloured cell among the players shown
  const rank = useMemo(() => {
    if (!colored) return null;
    const out = {};
    for (const c of specs) {
      if (!c.dir) continue;
      if (c.col.endsWith("_pct")) { out[c.col] = null; continue; }       // already a percentile
      const vals = shown.map(p => p[c.col]).filter(x => x != null).sort((a, b) => a - b);
      if (vals.length < 5) continue;
      const m = new Map();
      vals.forEach((x, i) => { if (!m.has(x)) m.set(x, i); });
      out[c.col] = { m, n: vals.length - 1, dir: c.dir };
    }
    return out;
  }, [colored, specs, shown]);
  const pctOf = (c, x) => {
    if (!rank || x == null || !(c.col in rank)) return null;
    const r = rank[c.col];
    if (r === null) return x;
    const pct = r.n ? r.m.get(x) / r.n * 100 : 50;
    return r.dir < 0 ? 100 - pct : pct;
  };

  const base = skaters
    ? [["Team", "team"], ["Pos", "position"], ["Tier", "tier_WAR"], ["GP", "gp"], ["Min", "min_all_1y"]]
    : [["Team", "team"], ["Tier", "tier_WAR"], ["GP", "games"], ["Shots", "shots"]];
  const click = col => setSort(s => (s.col === col ? { col, dir: -s.dir } : { col, dir: ["player", "team", "position"].includes(col) ? 1 : -1 }));
  const arrow = col => (sortCol === col ? (sort.dir < 0 ? " ▾" : " ▴") : "");

  const input = { padding: "7px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
                  color: t.text, fontSize: 12, outline: "none", fontFamily: "inherit" };
  const th = { padding: "8px 8px", fontSize: 10, fontWeight: 800, color: t.textMuted, borderBottom: `2px solid ${t.tableHeaderBorder}`,
               whiteSpace: "nowrap", cursor: "pointer", userSelect: "none", position: "sticky", top: 0, background: t.tableHeaderBg,
               zIndex: 2, textAlign: "right", letterSpacing: "0.03em" };
  const td = { padding: "5px 8px", fontSize: 12, borderBottom: `1px solid ${t.tableBorder}`, whiteSpace: "nowrap", textAlign: "right" };
  const label = { fontSize: 10, fontWeight: 700, color: t.textFaint, letterSpacing: "0.06em", textTransform: "uppercase", marginRight: 6 };

  return (
    <div style={{ fontFamily: NUM_FONT }}>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "10px 16px", marginBottom: 12 }}>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search player or team…" style={{ ...input, width: 190 }} />
        <span><span style={label}>Team</span>
          <select value={team} onChange={e => onTeam(e.target.value)} style={input}>
            <option value="">All teams</option>{teams.map(x => <option key={x} value={x}>{x}</option>)}
          </select></span>
        {skaters && <span><span style={label}>Position</span>
          <Segmented t={t} value={pos} onChange={setPos} options={["All", "F", "D", "C", "L", "R"].map(x => [x, x === "F" ? "Fwd" : x === "D" ? "Def" : x === "L" ? "LW" : x === "R" ? "RW" : x])} /></span>}
        <span><span style={label}>Tier</span>
          <select value={tier} onChange={e => setTier(e.target.value)} style={input}>
            <option value="All">All tiers</option>{tiers.map(x => <option key={x} value={x}>{x}</option>)}
          </select></span>
        <span style={{ display: "inline-flex", alignItems: "center" }}><span style={label}>Min games</span>
          <input type="range" min={0} max={Math.max(mostGp, 1)} value={least} onChange={e => setMinGp(+e.target.value)} style={{ width: 110, accentColor: t.accent }} />
          <b style={{ marginLeft: 8, fontSize: 12, color: t.text, minWidth: 18 }}>{least}</b></span>
        <span><span style={label}>Colour</span>
          <Segmented t={t} value={colored ? "on" : "off"} onChange={x => setColored(x === "on")} options={[["on", "On"], ["off", "Off"]]} /></span>
      </div>
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6, marginBottom: 12 }}>
        <span style={label}>Columns</span>
        {LB_GROUPS.map(g => {
          const on = groups.includes(g);
          return (
            <button key={g} onClick={() => setGroups(gs => (on ? gs.filter(x => x !== g) : LB_GROUPS.filter(x => x === g || gs.includes(x))))}
              style={{ padding: "5px 12px", fontSize: 11, fontWeight: on ? 800 : 600, fontFamily: "inherit", cursor: "pointer", borderRadius: 999,
                       background: on ? `${t.accent}26` : "transparent", color: on ? t.accent : t.textMuted, border: `1px solid ${on ? t.accent : t.inputBorder}` }}>
              {g}
            </button>
          );
        })}
      </div>

      <div style={{ overflow: "auto", maxHeight: "72vh", borderRadius: 8, border: `1px solid ${t.tableBorder}` }}>
        <table style={{ borderCollapse: "separate", borderSpacing: 0, width: "100%", background: t.tableRowA }}>
          <thead><tr>
            <th style={{ ...th, cursor: "default", left: 0, zIndex: 4, width: 30 }}>#</th>
            <th style={{ ...th, textAlign: "left", left: 38, zIndex: 4 }} onClick={() => click("player")}>Player{arrow("player")}</th>
            {base.map(([h, col]) => <th key={col} style={{ ...th, textAlign: ["team", "position", "tier_WAR"].includes(col) ? "left" : "right" }} onClick={() => click(col)}>{h}{arrow(col)}</th>)}
            {specs.map(c => <th key={c.col} title={c.tip} style={th} onClick={() => click(c.col)}>{c.head}{arrow(c.col)}</th>)}
          </tr></thead>
          <tbody>{shown.map((p, i) => {
            const bg = i % 2 ? t.tableRowB : t.tableRowA;
            return (
              <tr key={p.player_id} style={{ background: bg }}>
                <td style={{ ...td, position: "sticky", left: 0, background: bg, zIndex: 1, color: t.textFaint, width: 30 }}>{i + 1}</td>
                <td style={{ ...td, position: "sticky", left: 38, background: bg, zIndex: 1, textAlign: "left", fontWeight: 700 }}>
                  <button onClick={() => onPick(p.player_id)} title="Open his card"
                    style={{ display: "inline-flex", alignItems: "center", gap: 7, background: "none", border: "none", padding: 0, cursor: "pointer",
                             color: t.text, font: "inherit" }}>
                    <span style={{ width: 20, display: "inline-flex", justifyContent: "center" }}>
                      {p.flag && <img src={flagUrl(p.flag)} alt={p.flag.toUpperCase()} title={p.flag.toUpperCase()} loading="lazy"
                        style={{ height: 11, borderRadius: 1.5, border: `1px solid ${t.tableBorder}` }} onError={e => { e.currentTarget.style.display = "none"; }} />}
                    </span>
                    {p.player}
                  </button>
                </td>
                {base.map(([, col]) => (
                  <td key={col} style={{ ...td, color: t.textMuted, textAlign: ["team", "position", "tier_WAR"].includes(col) ? "left" : "right" }}>
                    {col === "team" ? (
                      <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
                        <img src={logoUrl(p.team)} alt="" loading="lazy" style={{ width: 16, height: 16, objectFit: "contain" }} onError={e => { e.currentTarget.style.display = "none"; }} />{p.team}
                      </span>
                    ) : ["gp", "games", "shots", "min_all_1y"].includes(col) ? whole(p[col]) : (p[col] ?? "–")}
                  </td>
                ))}
                {specs.map(c => {
                  const x = p[c.col], pct = pctOf(c, x);
                  const rgb = pct == null ? null : spectrumRgb(pct, isDark);
                  return (
                    <td key={c.col} style={{ ...td, fontWeight: 600, color: rgb ? inkOn(rgb) : (x == null ? t.textFaintest : t.textSecondary),
                                             background: rgb ? `rgb(${rgb.join(",")})` : undefined,
                                             boxShadow: rgb ? `inset 0 0 0 1px ${bg}` : undefined }}>
                      {x == null ? "–" : c.dec === 0 ? whole(x) : fixed(x, c.dec)}
                    </td>
                  );
                })}
              </tr>
            );
          })}</tbody>
        </table>
      </div>
      <div style={{ fontSize: 11, color: t.textFaint, marginTop: 8 }}>
        {shown.length} {kind}{colored ? " · colour shows where each number ranks among the players listed (blue low, red high)" : ""} · click a name to open his card
      </div>
    </div>
  );
}
