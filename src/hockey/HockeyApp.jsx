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
  ["WAR", "Short for Wins Above Replacement. It tells you how many extra wins a player gave his team compared to a guy you could call up from the minors. It adds up all season, so playing more games gets you a higher number. About six goals is worth one win."],
  ["GAR and GAA", "These are WAR but in goals. GAR compares a player to that call-up guy. GAA compares him to an average NHL player. Average is harder to beat, so GAA is usually lower."],
  ["Individual Impact", "This is how good a player is per minute. WAR goes up the more you play, and this one doesn't. A player who missed a lot of games can still score high here."],
  ["3-year and 1-year", "1-year only counts this season. 3-year also counts the two seasons before, but the older ones count less. We think 3-year is the better guess at how good someone is right now. When a new season is just getting started we mix it in with last season, which is why you see a label like 2025-27."],
  ["EV Offense, EV Defense", "At 5-on-5 there are ten skaters on the ice, and we know who all of them are. That lets us separate what one player did from what his linemates did. Offense is how much he helps his team get chances. Defense is how much he keeps the other team from getting them. We also account for who he played against and where his shifts started."],
  ["Power Play, Penalty Kill", "Same thing as above but for the power play and the penalty kill."],
  ["Finishing", "This shows if a player scores more than you'd expect from the shots he takes. It jumps around a lot from year to year."],
  ["Playmaking", "This is based on assists. It shows up on the card but we don't add it to WAR, because the chances a passer creates are already counted in his other numbers."],
  ["Shooting results", "The goals a player scored minus the goals his shots were expected to produce."],
  ["Setup results", "Our model knows where a shot came from but it doesn't know about the pass before it. So we check if a player's teammates score more than expected when he is on the ice. If that keeps happening, he's probably setting them up well."],
  ["Penalties", "Penalties drawn minus penalties taken. We turn that into goals based on how often power plays score."],
  ["Competition, Teammates", "These two aren't about skill. Competition is how good his opponents usually are. Teammates is how good his linemates usually are."],
  ["Goalies", "We know about how often each kind of shot goes in. If a goalie lets in fewer goals than that, he saved goals, and we call it GSAx. We split it up by how dangerous the shots were. We also adjust for the team in front of him."],
  ["Impact tiers", "This is a label for how good a season was. The top group of forwards by WAR gets called first line, the next group second line, and it keeps going like that. Defensemen get pairs and goalies get starter, 1B or backup. It's based on value, so a guy who plays on the third line can still have a first line season."],
  ["Percentiles and z-scores", "A percentile of 90 means a player was better than 90 percent of the players at his position. Players without enough games don't get ranked. A z-score shows how far a number is from average. Zero is average, 2 is really good, and negative means below average."],
];

function About({ meta, t }) {
  const s = meta?.settings || {};
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 60px", fontSize: 14, lineHeight: 1.65, color: t.textSecondary }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: t.text, marginBottom: 6 }}>About the numbers</div>
      <p style={{ margin: "0 0 18px", color: t.textMuted }}>
        All of this comes from two things the NHL posts after every game. One is the play-by-play, which lists every shot and
        where it was taken from. The other is the shift charts, which show who was on the ice. We use the shots to figure out
        how likely each one was to go in. Then we use the shifts to see which players were out there when the good chances
        happened. It only covers the regular season and it goes back to 2019-20.
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
          {s.GPW ? `Right now one win is worth ${Number(s.GPW).toFixed(2)} goals` : ""}{s.GPW && s.PEN_VALUE ? ` and a minor penalty is worth ${Number(s.PEN_VALUE).toFixed(3)} goals.` : s.GPW ? "." : ""}
          {s.USE_SETUP === false ? " Setup results are turned off for now because they didn't help predict next season." : ""}
        </p>
      )}
    </div>
  );
}

export default function HockeyApp() {
  return <ThemeProvider><Hockey /></ThemeProvider>;
}
