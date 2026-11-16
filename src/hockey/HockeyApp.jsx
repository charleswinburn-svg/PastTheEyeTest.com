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
  ["WAR", "Wins Above Replacement. It's the one-number answer to \"how much did this guy help his team win?\" We add up everything he does, turn it into goals, and compare that with what you'd get from the kind of player any team can call up or sign for nothing. Then we convert goals to wins; it takes roughly six goals to buy one. WAR is a running total, so someone who plays every night piles up more of it than an equally good player who misses half the year."],
  ["GAR and GAA", "The same value as WAR, left in goals. GAR (goals above replacement) measures him against that freely available player. GAA (goals above average) measures him against an average NHLer, which is a tougher bar, so it's usually the smaller number."],
  ["Individual Impact", "WAR rewards showing up. Impact asks a different question: how good is he per minute? It's goals above average per 60 minutes for skaters, and per game's worth of shots for goalies. A star who has been hurt can have a modest WAR and a huge Impact."],
  ["3-year and 1-year", "1-year is this season and nothing else: what actually happened. 3-year blends in the two seasons before it, counting the older ones less, and is our best read on how good a player is right now. Early in a season the new games are mixed in a little at a time, which is why the current 3-year view carries both seasons in its name."],
  ["EV Offense, EV Defense", "Hockey's hardest question: was he good, or were his linemates? For every stretch of 5-on-5 play we know all ten skaters on the ice, so we can make the math untangle it. What's left is each player's own push on scoring chances, for his team (offense) and against it (defense), after allowing for who he played with, who he played against, where his shifts started, the score, and home ice."],
  ["Power Play, Penalty Kill", "The same untangling on special teams. Did the power play hum because of him, or was he along for the ride on a loaded first unit?"],
  ["Finishing", "Does the puck go in more often than it should when he shoots? This looks at goals above expected alongside plain old goal scoring. Fair warning: over a single season, finishing is the streakiest thing we measure."],
  ["Playmaking", "Primary and secondary assists, weighted by game situation. It gets a row on the card but isn't added into WAR. That's not a snub. The chances a passer creates already show up in his on-ice numbers, and counting them twice would be cheating."],
  ["Shooting results", "The goals a player actually scored beyond what his shots were worth. This is how real pucks in the net get into WAR, and not only chances."],
  ["Setup results", "The passer's version of the same thing. Our shot model can see where a shot came from, but it can't see the pass that set it up. So we ask: when he's on the ice, do his teammates' shots go in more than they should? If they do, year after year, he's probably the reason. The shooter is part of the same calculation, so nobody gets double credit for one goal."],
  ["Penalties", "Drawing a penalty hands your team a power play. Taking one hands it to the other guys. This is minors drawn minus minors taken, priced at what a power play is really worth in goals."],
  ["Competition, Teammates", "Context, not skill. How good are the players he usually lines up against, and the ones he usually lines up with? A high Competition number means the coach sends him out against top lines. A high Teammates number means he's had help."],
  ["Goalies", "For every shot a goalie faces, we know roughly how often a shot like it goes in. Stop more than expected and you've saved goals; that's GSAx. We split it by situation and by how dangerous the shot was, then adjust for the team in front of him and the shooters he faced, because not every 30-shot night is the same. Rebound control and win probability added (the saves that swung games) get their own rows."],
  ["Impact tiers", "A plain-English label for where a season ranks. Every team dresses three forwards to a line and two defensemen to a pair, so the league's top 96 or so forwards by WAR are \"first-liners\", the next 96 are \"second-liners\", and so on down. Goalies get Starter, 1B and Backup. It describes value, not where the coach played him: a third-line center can absolutely have a first-line season."],
  ["Percentiles and z-scores", "A percentile ranks a player out of 100 against others at his position: 90 means better than 90% of them. Players who haven't played enough to judge aren't ranked. A z-score says how far from average a number is: 0 is dead average, 1 is clearly good, 2 is rare, 3 is almost nobody, and anything below zero is below average."],
];

function About({ meta, t }) {
  const s = meta?.settings || {};
  return (
    <div style={{ maxWidth: 820, margin: "0 auto", padding: "28px 20px 60px", fontSize: 14, lineHeight: 1.65, color: t.textSecondary }}>
      <div style={{ fontSize: 20, fontWeight: 800, color: t.text, marginBottom: 6 }}>About the numbers</div>
      <p style={{ margin: "0 0 18px", color: t.textMuted }}>
        Every number here starts from two things the NHL publishes for each game: the play-by-play (every shot, where it came
        from, and what happened right before it) and the shift charts (who was on the ice, second by second). From the shots
        we built an expected-goals model, which answers a simple question: how often does a shot like that go in? From the
        shifts we work out who was really driving those chances. Regular season only, back to 2019-20.
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
      <p style={{ margin: "22px 0 0", color: t.textMuted }}>
        None of this replaces watching the games. It's here to help you get past the eye test, not to retire it.
      </p>
      {meta && (
        <p style={{ margin: "14px 0 0", fontSize: 12, color: t.textFaint }}>
          Under the hood right now{s.GPW ? `: a win costs ${Number(s.GPW).toFixed(2)} goals` : ""}{s.PEN_VALUE ? `, and a minor penalty is worth ${Number(s.PEN_VALUE).toFixed(3)} goals` : ""}.
          {s.USE_SETUP === false ? " Setup results are switched off in this run, because they did not help predict next season." : ""}
        </p>
      )}
    </div>
  );
}

export default function HockeyApp() {
  return <ThemeProvider><Hockey /></ThemeProvider>;
}
