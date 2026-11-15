import { useEffect, useMemo, useState } from "react";
import { ThemeProvider, useTheme, ThemeToggle } from "../baseball/ThemeContext.jsx";
import { SearchableSelect, NUM_FONT } from "../baseball/SharedComponents.jsx";
import PlayerCard, { Segmented } from "./PlayerCard.jsx";
import Leaderboard from "./Leaderboard.jsx";
import { useNhl, toObjects, seasonLabel, logoUrl, headshotUrl } from "./nhlData.js";
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
              <option key={s.season} value={s.season}>{s.label}{s.in_progress ? " (in progress)" : ""}</option>
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
        <About meta={meta.data} t={t} />
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
            {team ? `${team} · ` : ""}{seasonLabel(y)}{file.data.season_done < 1 ? " (in progress)" : ""} · {VERSIONS.find(x => x.id === v).long}
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
  ["WAR", "Wins above replacement. Every part of a player's game is converted to goals, compared with what a replacement-level player would give in the same minutes, and divided by the number of goals a win costs. It is a total, so playing more adds to it."],
  ["Individual Impact", "The same value as a rate: goals above average per 60 minutes (skaters) or per game's worth of shots (goalies)."],
  ["3-year and 1-year", "The 1-year version uses that season alone. The 3-year version adds the two seasons before it, weighted less, and reads as a typical season at the player's current level. A season in progress is blended in as it fills up."],
  ["EV Offense, EV Defense", "A player's own effect on expected goals for and against at 5v5, after accounting for his linemates, his opponents, where his shifts start, the score and home ice."],
  ["Power Play, Penalty Kill", "The same kind of isolated effect with the man advantage and while shorthanded."],
  ["Finishing", "Goals scored above what his shots were expected to produce, together with his goal scoring."],
  ["Playmaking", "Primary and secondary assists, weighted by situation. A card row; it is not added into WAR, because assists are already inside the on-ice ratings."],
  ["Shooting results", "Goals above expected on a player's own shots."],
  ["Setup results", "How much more often his teammates' shots go in than expected while he is on the ice. The expected-goals model sees the shot but not the pass, so this is where a passer's value shows up. The shooter is in the same model, so a goal above expected is credited once and shared."],
  ["Penalties", "Minor penalties drawn minus taken, valued at what a power play is worth in goals."],
  ["Competition, Teammates", "Context, not skill: the average quality of the opponents he faces and the linemates he plays with at 5v5."],
  ["Goalies", "Goals saved above expected (GSAx) on every unblocked shot faced, split by situation and by shot danger, with an adjustment for the team in front of him and the shooters he faced; rebound control; and win probability added."],
  ["Impact tiers", "Each season, players are ranked within their position and the ranks are cut by roster spots per team: three forwards to a line, two defensemen to a pair, one starter, and a 1B for every other team. Everyone below is Depth or Backup."],
  ["Percentiles and z-scores", "Percentiles are within forwards, within defensemen, or among goalies, for players above the minutes or shots cutoff. A z-score is how many standard deviations a number sits from the league average among ranked players."],
];

function About({ meta, t }) {
  const s = meta?.settings || {};
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 60px", fontSize: 14, lineHeight: 1.65, color: t.textSecondary }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: t.text, marginBottom: 6 }}>About the numbers</div>
      <p style={{ margin: "0 0 18px", color: t.textMuted }}>
        Everything here is built from the NHL's play-by-play and shift charts: an expected-goals model for every unblocked shot,
        then player ratings fitted on every stint of ice time. Regular season only, 2019-20 onward.
        {meta ? ` Last updated ${meta.updated.slice(0, 10)}.` : ""}
      </p>
      <div style={{ display: "grid", rowGap: 14 }}>
        {GLOSSARY.map(([term, text]) => (
          <div key={term}>
            <div style={{ fontSize: 13, fontWeight: 800, color: t.text, letterSpacing: "0.03em" }}>{term}</div>
            <div>{text}</div>
          </div>
        ))}
      </div>
      {meta && (
        <p style={{ margin: "22px 0 0", fontSize: 12, color: t.textFaint }}>
          In this build: {s.GPW ? `${Number(s.GPW).toFixed(2)} goals per win` : ""}{s.PEN_VALUE ? `; a minor penalty is worth ${Number(s.PEN_VALUE).toFixed(3)} goals` : ""}
          {s.RESULTS_USED ? `; results component: ${s.RESULTS_USED}` : ""}{s.USE_SETUP === false ? "; setup results are switched off" : ""}.
        </p>
      )}
    </div>
  );
}

export default function HockeyApp() {
  return <ThemeProvider><Hockey /></ThemeProvider>;
}
