import { useEffect, useMemo, useState } from "react";
import { ThemeProvider, useTheme, ThemeToggle } from "../baseball/ThemeContext.jsx";
import { SearchableSelect, NUM_FONT } from "../baseball/SharedComponents.jsx";
import PlayerCard, { Segmented } from "./PlayerCard.jsx";
import Leaderboard from "./Leaderboard.jsx";
import { useNhl, toObjects, seasonLabel, periodLabel, logoUrl, headshotUrl } from "./nhlData.js";
import { VERSIONS } from "./rows.js";

// ═══════════════════════════════════════════════════════════
// NHL TAB
// Player cards and leaderboards built on PastTheEyeTest's own expected-goals model and
// player ratings. The data is the set of JSON files the droplet's nightly run writes to
// public/nhl/ (nhl/README.md). Everything below the card header is set in Pliant.
// ═══════════════════════════════════════════════════════════

function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1200));
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

const VIEWS = [["player", "Player card"], ["leaderboard", "Leaderboard"], ["about", "About the numbers"]];

function Hockey() {
  const { theme: t } = useTheme();
  const winW = useWindowWidth();
  const mobile = winW < 700, wide = winW >= 1100;

  const [view, setView] = useState("player");
  const [kind, setKind] = useState("skaters");
  const [season, setSeason] = useState(null);
  const [v, setV] = useState("3y");
  const [team, setTeam] = useState("");
  const [picked, setPicked] = useState({ skaters: null, goalies: null });
  const [pctStyle, setPctStyle] = useState("boxes");

  const meta = useNhl("meta.json");
  const y = season ?? meta.data?.latest_season ?? null;
  const file = useNhl(y == null ? null : `${kind}_${y}.json`);
  const history = useNhl("history.json");

  const seasons = useMemo(() => (meta.data?.seasons || []).map(s => s.season), [meta.data]);
  const inProgressSeason = meta.data?.seasons?.find(s => s.in_progress)?.season ?? null;
  const players = useMemo(() => toObjects(file.data), [file.data]);
  const teams = useMemo(() => [...new Set(players.map(p => p.team).filter(Boolean))].sort(), [players]);
  const pool = useMemo(() => (team ? players.filter(p => p.team === team) : players), [players, team]);
  const current = useMemo(() => pool.find(p => p.player_id === picked[kind]) || pool[0] || null, [pool, picked, kind]);
  const options = useMemo(() => [...pool].sort((a, b) => a.player.localeCompare(b.player)).map(p => ({
    value: p.player_id, label: p.player, sublabel: `${p.team}${p.position ? " · " + p.position : " · G"}`,
    image: headshotUrl(p.player_id, p.team, y), logo: logoUrl(p.team),
  })), [pool, y]);
  useEffect(() => { if (team && teams.length && !teams.includes(team)) setTeam(""); }, [teams, team]);

  const error = meta.error || file.error;
  const input = { padding: "7px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
                  color: t.text, fontSize: 12, outline: "none", fontFamily: "inherit", fontWeight: 600 };

  return (
    <div style={{ minHeight: "100vh", background: t.bg, color: t.text, fontFamily: NUM_FONT }}>
      {/* ── views ── */}
      <div style={{ background: t.cardBg, borderBottom: `2px solid ${t.accent}`, padding: mobile ? "0 8px" : "0 20px",
                    display: "flex", alignItems: "stretch", justifyContent: "space-between", gap: 8, flexWrap: "wrap" }}>
        <div style={{ display: "flex", alignItems: "stretch", overflowX: "auto" }}>
          {!mobile && (
            <div style={{ display: "flex", alignItems: "center", padding: "12px 20px 12px 0", borderRight: `1px solid ${t.divider}`, marginRight: 8,
                          fontSize: 16, fontWeight: 800, fontStyle: "italic", letterSpacing: "-0.01em", whiteSpace: "nowrap" }}>
              <span style={{ color: t.accentSecondary }}>NHL</span>&nbsp;<span style={{ color: t.accent }}>Player Ratings</span>
            </div>
          )}
          {VIEWS.map(([id, label]) => (
            <button key={id} onClick={() => setView(id)}
              style={{ padding: mobile ? "11px 10px" : "15px 18px", fontSize: mobile ? 11 : 12, fontWeight: view === id ? 800 : 600, letterSpacing: "0.04em",
                       textTransform: "uppercase", whiteSpace: "nowrap", fontFamily: "inherit", cursor: "pointer", border: "none",
                       background: view === id ? `${t.accent}1a` : "transparent", color: view === id ? t.accent : t.textMuted,
                       borderBottom: view === id ? `3px solid ${t.accent}` : "3px solid transparent" }}>
              {label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 0" }}>
          {meta.data && !mobile && <span style={{ fontSize: 10, color: t.textFaint, fontWeight: 600 }}>Updated {meta.data.updated.slice(0, 10)}</span>}
          <ThemeToggle />
        </div>
      </div>

      {/* ── what to show ── */}
      {view !== "about" && (
        <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 12px", padding: mobile ? "10px 12px" : "12px 24px",
                      borderBottom: `1px solid ${t.divider}` }}>
          <Segmented t={t} value={kind} onChange={setKind} options={[["skaters", "Skaters"], ["goalies", "Goalies"]]} />
          <select value={y ?? ""} onChange={e => setSeason(+e.target.value)} style={input} aria-label="Season">
            {[...(meta.data?.seasons || [])].reverse().map(s => (
              <option key={s.season} value={s.season}>{periodLabel(s.season, v, inProgressSeason)}</option>
            ))}
          </select>
          <Segmented t={t} value={v} onChange={setV} options={VERSIONS.map(x => [x.id, x.label])} />
          {view === "player" && (
            <>
              <select value={team} onChange={e => setTeam(e.target.value)} style={input} aria-label="Team">
                <option value="">All teams</option>{teams.map(x => <option key={x} value={x}>{x}</option>)}
              </select>
              <SearchableSelect value={current?.player_id ?? ""} options={options}
                onChange={id => setPicked(s => ({ ...s, [kind]: id }))}
                placeholder={`Search ${kind === "goalies" ? "goalie" : "skater"}…`}
                style={{ ...input, flex: mobile ? "1 1 100%" : "1 1 240px", minWidth: mobile ? 0 : 220, maxWidth: mobile ? "100%" : 380 }} />
              <Segmented t={t} value={pctStyle} onChange={setPctStyle} options={[["boxes", "Boxes"], ["bars", "Bars"]]} />
            </>
          )}
        </div>
      )}

      {/* ── content ── */}
      {error ? (
        <div style={{ color: t.accent, padding: 60, textAlign: "center", fontSize: 14, lineHeight: 1.8 }}>
          Could not load the NHL data ({error}).<br />
          <span style={{ color: t.textMuted, fontSize: 12 }}>The files in public/nhl/ are written by the nightly run: see nhl/README.md.</span>
        </div>
      ) : view === "about" ? (
        <About t={t} />
      ) : !file.data || !meta.data ? (
        <div style={{ color: t.textFaint, padding: 60, textAlign: "center", fontSize: 14 }}>Loading{y != null ? ` ${seasonLabel(y)}` : ""}…</div>
      ) : view === "player" ? (
        <div style={{ padding: mobile ? "14px 10px 40px" : "24px 24px 60px" }}>
          <PlayerCard p={current} kind={kind} v={v} season={y} seasonDone={file.data.season_done} zRef={file.data.z_ref}
            history={history.data} seasons={seasons} inProgressSeason={inProgressSeason} wide={wide} pctStyle={pctStyle} />
        </div>
      ) : (
        <div style={{ padding: mobile ? "14px 10px 40px" : "20px 24px 60px", maxWidth: 1560, margin: "0 auto" }}>
          <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 600, marginBottom: 12 }}>
            {team ? `${team} · ` : ""}{periodLabel(y, v, inProgressSeason)} · {VERSIONS.find(x => x.id === v).long}
          </div>
          <Leaderboard key={kind} players={pool} kind={kind} v={v} teams={teams} team={team} onTeam={setTeam}
            onPick={id => { setPicked(s => ({ ...s, [kind]: id })); setView("player"); window.scrollTo({ top: 0 }); }} />
        </div>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ABOUT THE NUMBERS
// ═══════════════════════════════════════════════════════════
const GLOSSARY = [
  ["WAR", "Wins Above Replacement: How many extra wins a player gives his team compared to a depth player (13th forward, 7th D-Man, etc.)."],
  ["GAR and GAA", "WAR, but with individualized goals."],
  ["EV Offense, EV Defense", "Offensive contribution at even strength, accounting for play driving (xGF%), teammates, competition, and where the skater's shift starts."],
  ["Power Play, Penalty Kill", "Similar to EV Offense/Defense, but weighing differently based on special teams."],
  ["Finishing", "How much a player outperforms his expected goals on his own shots."],
  ["Playmaking", "Assists weighted by game state and separated between primary and secondary."],
  ["Shooting results", "The goals a player scores minus his expected goals."],
  ["Setup results", "Inferred results of linemate/on-ice shooting%."],
  ["Penalties", "Penalty differential, between how many they draw vs. how many they take."],
  ["Competition, Teammates", "Based on quality of opposing teammates or quality of competition while the skater is on the ice."],
  ["Goalies", "Everything is based on GSAx/GSAA, or how many goals were saved above average. Scaled by game state, danger (low = <0.05 xG, med = 0.05-0.15 xG, high = >0.15 xG), and team."],
];

function About({ t }) {
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 60px", fontSize: 14, lineHeight: 1.65, color: t.textSecondary }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: t.text, marginBottom: 18 }}>About the numbers</div>
      <div style={{ display: "grid", rowGap: 14 }}>
        {GLOSSARY.map(([term, text]) => (
          <div key={term}>
            <div style={{ fontSize: 13, fontWeight: 800, color: t.text, letterSpacing: "0.03em" }}>{term}</div>
            <div>{text}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function HockeyApp() {
  return <ThemeProvider><Hockey /></ThemeProvider>;
}
