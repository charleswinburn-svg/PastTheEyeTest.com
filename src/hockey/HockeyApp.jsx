import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { useLocation, navigate, setQuery } from "../router.jsx";
import { Toolbar } from "../nav/Toolbar.jsx";
import { nhlLeafForPath } from "../nav/navConfig.js";
import { seasonSelectStyle, seasonOptionStyle, searchStyle, searchPanelProps, plainSelectStyle } from "../nav/toolbarStyles.js";
import { SearchableSelect, NUM_FONT } from "../baseball/SharedComponents.jsx";
import PlayerCard from "./PlayerCard.jsx";
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


function Hockey() {
  const { theme: t } = useTheme();
  const winW = useWindowWidth();
  const mobile = winW < 700, wide = winW >= 1100;

  // View and skaters/goalies come from the path (sidebar: Skater cards, Goalie cards,
  // Leaderboards › Skaters / Goalies, About); filters and the player from the query, so
  // every card and leaderboard can be linked: /nhl/goalies?id=8478048&season=2025&v=1y
  const loc = useLocation();
  const q = loc.query;
  const leaf = nhlLeafForPath(loc.path);
  const view = leaf?.view || "player";
  const kind = leaf?.kind === "goalies" ? "goalies" : "skaters";
  const season = q.season && /^\d+$/.test(q.season) ? +q.season : null;
  const v = VERSIONS.some(x => x.id === q.v) ? q.v : "3y";
  const team = q.team || "";
  const pickedId = q.id && /^\d+$/.test(q.id) ? +q.id : null;
  const setSeason = n => setQuery({ season: n });
  const setV = x => setQuery({ v: x === "3y" ? null : x });
  const setTeam = x => setQuery({ team: x || null });
  const pick = id => setQuery({ id });

  const meta = useNhl("meta.json");
  const y = season ?? meta.data?.latest_season ?? null;
  const file = useNhl(y == null ? null : `${kind}_${y}.json`);
  const history = useNhl("history.json");

  const seasons = useMemo(() => (meta.data?.seasons || []).map(s => s.season), [meta.data]);
  const inProgressSeason = meta.data?.seasons?.find(s => s.in_progress)?.season ?? null;
  const players = useMemo(() => toObjects(file.data), [file.data]);
  const teams = useMemo(() => [...new Set(players.map(p => p.team).filter(Boolean))].sort(), [players]);
  const pool = useMemo(() => (team ? players.filter(p => p.team === team) : players), [players, team]);
  const current = useMemo(() => pool.find(p => p.player_id === pickedId) || pool[0] || null, [pool, pickedId]);
  const options = useMemo(() => [...pool].sort((a, b) => a.player.localeCompare(b.player)).map(p => ({
    value: p.player_id, label: p.player, sublabel: `${p.team}${p.position ? " · " + p.position : " · G"}`,
    image: headshotUrl(p.player_id, p.team, y), logo: logoUrl(p.team),
  })), [pool, y]);
  useEffect(() => { if (team && teams.length && !teams.includes(team)) setTeam(""); }, [teams, team]);

  const error = meta.error || file.error;

  return (
    <div style={{ background: t.bg, color: t.text, fontFamily: NUM_FONT }}>
      {/* Filters render in the site's top bar (src/nav/Toolbar.jsx); on phones they stay in the page. */}
      {view !== "about" && (() => {
        const filters = (
          <>
            {meta.data && !mobile && <span style={{ fontSize: 10.5, color: t.textFaint, fontWeight: 600, whiteSpace: "nowrap" }}>Updated {meta.data.updated.slice(0, 10)}</span>}
            {/* Season and search look exactly like MLB's (src/nav/toolbarStyles.js). */}
            <select value={y ?? ""} onChange={e => setSeason(+e.target.value)} style={seasonSelectStyle(t)} aria-label="Season">
              {[...(meta.data?.seasons || [])].reverse().map(s => (
                <option key={s.season} value={s.season} style={seasonOptionStyle(t)}>{periodLabel(s.season, v, inProgressSeason)}</option>
              ))}
            </select>
            <select value={v} onChange={e => setV(e.target.value)} style={plainSelectStyle(t)} aria-label="3-year or 1-year">
              {VERSIONS.map(x => <option key={x.id} value={x.id}>{x.label}</option>)}
            </select>
            {view === "player" && (
              <>
                <select value={team} onChange={e => setTeam(e.target.value)} style={plainSelectStyle(t)} aria-label="Team">
                  <option value="">All teams</option>{teams.map(x => <option key={x} value={x}>{x}</option>)}
                </select>
                <SearchableSelect value={current?.player_id ?? ""} options={options}
                  onChange={id => pick(id)}
                  placeholder={`Search ${kind === "goalies" ? "goalie" : "skater"}…`}
                  {...searchPanelProps(mobile)}
                  style={searchStyle(t, mobile)} />
              </>
            )}
          </>
        );
        return mobile
          ? <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: "8px 10px", padding: "10px 12px", borderBottom: `1px solid ${t.divider}` }}>{filters}</div>
          : <Toolbar>{filters}</Toolbar>;
      })()}

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
            history={history.data} seasons={seasons} inProgressSeason={inProgressSeason} wide={wide} />
        </div>
      ) : (
        <div style={{ padding: mobile ? "14px 10px 40px" : "20px 24px 60px", maxWidth: 1560, margin: "0 auto" }}>
          <div style={{ fontSize: 12, color: t.textMuted, fontWeight: 600, marginBottom: 12 }}>
            {team ? `${team} · ` : ""}{periodLabel(y, v, inProgressSeason)} · {VERSIONS.find(x => x.id === v).long}
          </div>
          <Leaderboard key={kind} players={pool} kind={kind} v={v} teams={teams} team={team} onTeam={setTeam}
            onPick={id => {
              const u = new URLSearchParams(loc.search); u.set("id", id);
              navigate(`/nhl/${kind}?${u}`);
            }} />
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

// The ThemeProvider lives in App.jsx (one theme for the whole site).
export default function HockeyApp() {
  return <Hockey />;
}
