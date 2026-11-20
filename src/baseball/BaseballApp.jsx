import { useState, useEffect, useMemo, useRef, useLayoutEffect } from "react";
import HitterCard from "./HitterCard.jsx";
import PitcherCard from "./PitcherCard.jsx";
import FielderCard from "./FielderCard.jsx";
import PitchModelingLeaderboard from "./PitchModelingLeaderboard.jsx";
import Summaries from "./Summaries.jsx";
import RaceToTwoStrikes from "./RaceToTwoStrikes.jsx";
import EVLAChart from "./EVLAChart.jsx";
import TeamScatter from "./TeamScatter.jsx";
import ISwingWaterfall from "./ISwingWaterfall.jsx";
import StuffWaterfall from "./StuffWaterfall.jsx";
import ProjectionMovers from "./ProjectionMovers.jsx";
import RangeView from "./RangeView.jsx";
import { fuzzyLookup, binColor, textOnBin, BIN_COLORS, pctToBin, SearchableSelect, exportRowsAsCsv, NewBadge, useISwingNew, getHeadshotUrl, getLogoUrl } from "./SharedComponents.jsx";
import { useTheme } from "./ThemeContext.jsx";
import { useLocation, navigate, setQuery } from "../router.jsx";
import { Toolbar } from "../nav/Toolbar.jsx";
import {
  MLB_SEASONS, PROJ_SEASON, PROJ_TABS, DEFAULT_MLB_SEASON, LATEST_MLB_SEASON, mlbLeafForPath, mlbLeafForTab, mlbSeasonFrom,
} from "../nav/navConfig.js";
import { inkOnColor } from "../ui/colorScale.js";

// ── Mobile breakpoint ──
function useWindowWidth() {
  const [w, setW] = useState(() => (typeof window !== "undefined" ? window.innerWidth : 1024));
  useEffect(() => {
    const h = () => setW(window.innerWidth);
    window.addEventListener("resize", h);
    return () => window.removeEventListener("resize", h);
  }, []);
  return w;
}

// ── Shared constants ──
const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
const nameKey = s => norm(s).replace(/[.\-,]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

function deduplicatePlayers(players) {
  const byKey = new Map();
  for (const p of players) {
    const key = nameKey(p.name);
    if (byKey.has(key)) {
      const existing = byKey.get(key);
      for (const [cat, data] of Object.entries(p.categories || {})) {
        if (!existing.categories[cat] || existing.categories[cat].pctile == null) {
          existing.categories[cat] = data;
        }
      }
      if (p.name.length > existing.name.length || p.name !== norm(p.name)) {
        existing.name = p.name;
      }
      if (!existing.player_id && p.player_id) existing.player_id = p.player_id;
      if (!existing.team && p.team) existing.team = p.team;
      if (!existing.pa && p.pa) existing.pa = p.pa;
      if (!existing.ip && p.ip) existing.ip = p.ip;
    } else {
      byKey.set(key, { ...p, categories: { ...(p.categories || {}) } });
    }
  }
  return [...byKey.values()];
}

// Seasons, the projection rules and the section list live in src/nav/navConfig.js
// (shared with the sidebar). The section, season and player are in the URL.
const SEASONS = MLB_SEASONS;
// The site opens on this player's projected card.
const DEFAULT_PLAYER = "Shohei Ohtani";


// Ordered xRV/600 PA metric labels for the hitter xRV leaderboard (mirrors the
// HitterCard right column / build_hitter_xrv.py). xRV/600 leads so the board
// defaults to sorting by overall expected run value.
const HITTER_XRV_METRICS = [
  "xRV/600", "Contact Quality", "Whiff", "Decision",
  "Fastball", "Breaking", "Offspeed",
  "Inner", "Middle (vertical)", "Outer",
  "Upper", "Middle (horizontal)", "Lower", "Chase",
].map(label => ({ label }));

// Team abbreviation → league, including the abbreviation variants the pipeline
// can emit (FanGraphs/MLB/Savant don't all agree on every code).
const TEAM_LEAGUE = {
  BAL:"AL", BOS:"AL", NYY:"AL", TB:"AL", TBR:"AL", TOR:"AL",
  CWS:"AL", CHW:"AL", CLE:"AL", DET:"AL", KC:"AL", KCR:"AL", MIN:"AL",
  HOU:"AL", LAA:"AL", ANA:"AL", OAK:"AL", ATH:"AL", SEA:"AL", TEX:"AL",
  ATL:"NL", MIA:"NL", FLA:"NL", NYM:"NL", PHI:"NL", WSH:"NL", WSN:"NL", WAS:"NL",
  CHC:"NL", CIN:"NL", MIL:"NL", PIT:"NL", STL:"NL",
  ARI:"NL", AZ:"NL", COL:"NL", LAD:"NL", SD:"NL", SDP:"NL", SF:"NL", SFG:"NL",
};
// Display order for the primary-position filter.
const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF", "OF", "DH", "P", "—"];

// The ThemeProvider lives in App.jsx (one theme for the whole site).
export default function BaseballAppWrapper() {
  return <BaseballApp />;
}

function BaseballApp() {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [trends, setTrends] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  // Section (path), season (?season=) and card player (?player=) come from the URL.
  const loc = useLocation();
  const tab = mlbLeafForPath(loc.path)?.id || "hitter";
  const season = mlbSeasonFrom(loc.query);
  // Changing section keeps the season and drops the old section's own query (player…).
  const setTab = (id, { replace = false } = {}) => {
    const leaf = mlbLeafForTab(id);
    if (leaf) navigate(leaf.path + (season !== DEFAULT_MLB_SEASON ? `?season=${season}` : ""), { replace });
  };
  const seasonPicked = useRef(false);   // the last season change came from the season dropdown
  const setSeason = (s) => { seasonPicked.current = true; setQuery({ season: s === DEFAULT_MLB_SEASON ? null : s }); };
  const [selectedHitter, setSelectedHitter] = useState(DEFAULT_PLAYER);
  const [selectedPitcher, setSelectedPitcher] = useState(DEFAULT_PLAYER);
  const [iswingData, setIswingData] = useState(null);
  const iswingNew = useISwingNew(season);
  const [xrvData, setXrvData] = useState(null);
  const [xrvGamesData, setXrvGamesData] = useState(null);
  const [xrvGamesLoading, setXrvGamesLoading] = useState(false);
  const [fieldingData, setFieldingData] = useState(null);
  const [selectedFielder, setSelectedFielder] = useState(null);
  const [aaaData, setAaaData] = useState(null);
  const [cardDateFrom, setCardDateFrom] = useState("");
  const [cardDateTo, setCardDateTo] = useState("");

  useEffect(() => {
    setFieldingData(null);
    fetch(`/fielding_data_${season}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setFieldingData(d))
      .catch(() => setFieldingData(null));
  }, [season]);

  useEffect(() => {
    setAaaData(null);
    fetch(`/aaa_data_${season}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setAaaData(d))
      .catch(() => setAaaData(null));
  }, [season]);

  useEffect(() => {
    fetch("/iswing.json").then(r => r.json()).then(setIswingData).catch(() => {});
  }, []);

  // Hitter xRV/600 PA (season-precomputed, keyed by player_id). Optional —
  // the card degrades gracefully (right column shows N/A) when absent.
  useEffect(() => {
    setXrvData(null);
    fetch(`/hitter_xrv_${season}.json`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setXrvData(d))
      .catch(() => setXrvData(null));
  }, [season]);

  useEffect(() => {
    setCardDateFrom("");
    setCardDateTo("");
  }, [season]);

  // Per-game xRV sums for date-range aggregation. Lazy-loaded only when a date
  // range is active on the hitter card (the file is large; most sessions never
  // need it) and reset on season change so the next range refetches.
  useEffect(() => { setXrvGamesData(null); }, [season]);
  useEffect(() => {
    const need = tab === "hitter" && !!(cardDateFrom || cardDateTo);
    if (!need || xrvGamesData) return;
    setXrvGamesLoading(true);
    fetch(`/hitter_xrv_games_${season}.json`)
      .then(r => r.ok ? r.json() : {})
      .then(d => setXrvGamesData(d || {}))
      .catch(() => setXrvGamesData({}))
      .finally(() => setXrvGamesLoading(false));
  }, [tab, cardDateFrom, cardDateTo, season, xrvGamesData]);

  useEffect(() => {
    setLoading(true);
    setError(null);
    fetch(`/baseball_data_${season}.json`)
      .then(r => {
        if (!r.ok) throw new Error(`HTTP ${r.status} — baseball_data_${season}.json not found. Run: python3 baseball_pipeline.py ./public`);
        return r.json();
      })
      .then(d => { setData(d); setLoading(false); })
      .catch(e => { setError(e.message); setLoading(false); });
  }, [season]);

  useEffect(() => {
    fetch("/baseball_trends.json")
      .then(r => r.ok ? r.json() : null)
      .then(d => setTrends(d))
      .catch(() => {});
  }, []);

  const hitters = useMemo(() => deduplicatePlayers(data?.hitters || []), [data]);
  const pitchers = useMemo(() => deduplicatePlayers(data?.pitchers || []), [data]);

  const disambiguate = (players) => {
    const nameCounts = {};
    players.forEach(p => { nameCounts[p.name] = (nameCounts[p.name] || 0) + 1; });
    return players.map(p => ({
      ...p,
      displayName: nameCounts[p.name] > 1 ? `${p.name} (${p.team || '?'})` : p.name,
    }));
  };

  const hittersFull = useMemo(() => {
    const base = disambiguate(hitters);
    return base.map(h => {
      let out = h;
      // iSwing+ (merged by name into categories, like before)
      if (iswingData) {
        const yr = String(season);
        const iswing = fuzzyLookup(iswingData, h.name);
        const val = iswing?.[yr];
        const pct = iswing?.[yr + "_pct"];
        if (val != null && pct != null) {
          out = { ...out, categories: { "iSwing+": { display: String(val), pctile: pct }, ...out.categories } };
        }
      }
      // xRV/600 PA (merged by player_id onto a separate `xrv` field → right column)
      const xrv = h.player_id != null ? xrvData?.[String(h.player_id)] : null;
      if (xrv?.metrics) out = { ...out, xrv: xrv.metrics };
      return out;
    });
  }, [hitters, iswingData, xrvData, season]);
  const pitchersFull = useMemo(() => disambiguate(pitchers), [pitchers]);
  // Hitter xRV leaderboard rows: hitters carrying merged xRV metrics, reshaped so
  // the generic Leaderboard reads the xRV components through its `categories` path.
  const hitterXrvPlayers = useMemo(
    () => hittersFull.filter(h => h.xrv && Object.keys(h.xrv).length).map(h => ({ ...h, categories: h.xrv })),
    [hittersFull],
  );
  const hitterNames = useMemo(() => hittersFull.map(h => h.displayName).sort(), [hittersFull]);
  const pitcherNames = useMemo(() => pitchersFull.map(p => p.displayName).sort(), [pitchersFull]);

  const fielders = useMemo(() => fieldingData?.fielders || [], [fieldingData]);
  // player_id → primary fielding position (the position with the most innings).
  // Sourced from fielding data (already loaded) so the leaderboard position
  // filter needs no pipeline change.
  const positionByPid = useMemo(() => {
    const m = {};
    for (const f of (fieldingData?.fielders || [])) {
      let best = null, bestInn = -Infinity;
      for (const [pos, info] of Object.entries(f.positions || {})) {
        const inn = info?.innings ?? 0;
        if (inn > bestInn) { bestInn = inn; best = pos; }
      }
      if (best && f.player_id != null) m[String(f.player_id)] = best;
    }
    return m;
  }, [fieldingData]);
  const fielderNames = useMemo(() => fielders.map(f => f.name).filter(Boolean).sort(), [fielders]);
  const curFielder = useMemo(
    () => fielders.find(f => f.name === selectedFielder) || null,
    [fielders, selectedFielder],
  );
  useEffect(() => {
    if (fielderNames.length && (!selectedFielder || !fielderNames.includes(selectedFielder))) {
      setSelectedFielder(fielderNames[0]);
    }
  }, [fielderNames]);  // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (hitterNames.length > 0 && (!selectedHitter || !hitterNames.includes(selectedHitter)))
      setSelectedHitter(hitterNames[0]);
  }, [hitterNames]);
  useEffect(() => {
    if (pitcherNames.length > 0 && (!selectedPitcher || !pitcherNames.includes(selectedPitcher)))
      setSelectedPitcher(pitcherNames[0]);
  }, [pitcherNames]);

  // Jump to a comp from the Similar Players panel: switch season if needed, then
  // select the player by id once that season's list is loaded (declared after the
  // default-selection effects above so it wins when both fire on the same load).
  const pendingSelect = useRef(null);
  const applyPendingSelect = (list, setter) => {
    const p = pendingSelect.current;
    if (!p) return;
    const found = list.find(x => Number(x.player_id) === Number(p.playerId));
    if (found) { setter(found.displayName); pendingSelect.current = null; }
  };
  const selectPlayerFromComp = ({ playerId, season: targetSeason }) => {
    const type = isPitcherTab(tab) ? "pitcher" : "hitter";
    pendingSelect.current = { playerId, type };
    if (String(targetSeason) !== String(season)) setSeason(String(targetSeason));
    else applyPendingSelect(type === "pitcher" ? pitchersFull : hittersFull, type === "pitcher" ? setSelectedPitcher : setSelectedHitter);
    if (typeof window !== "undefined") window.scrollTo({ top: 0, behavior: "smooth" });
  };
  useEffect(() => {
    if (pendingSelect.current?.type === "hitter") applyPendingSelect(hittersFull, setSelectedHitter);
  }, [hittersFull]);  // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (pendingSelect.current?.type === "pitcher") applyPendingSelect(pitchersFull, setSelectedPitcher);
  }, [pitchersFull]);  // eslint-disable-line react-hooks/exhaustive-deps

  const curHitter = useMemo(() => hittersFull.find(h => h.displayName === selectedHitter), [hittersFull, selectedHitter]);
  const curPitcher = useMemo(() => pitchersFull.find(p => p.displayName === selectedPitcher), [pitchersFull, selectedPitcher]);

  // ── AAA-equivalent derived views, sourced from aaa_data_<season>.json. The
  // shape mirrors baseball_data so HitterCard / PitcherCard render identically.
  const aaaHittersFull = useMemo(() => disambiguate(aaaData?.hitters || []), [aaaData]);
  const aaaPitchersFull = useMemo(() => disambiguate(aaaData?.pitchers || []), [aaaData]);
  const aaaHitterNames = useMemo(() => aaaHittersFull.map(h => h.displayName).sort(), [aaaHittersFull]);
  const aaaPitcherNames = useMemo(() => aaaPitchersFull.map(p => p.displayName).sort(), [aaaPitchersFull]);

  // Card search options: same names as before (value = display name), plus headshot + logo.
  const searchOpts = (list, nameOf = p => p.displayName) => {
    const seen = new Set(), out = [];
    for (const p of list) {
      const name = nameOf(p);
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push({ value: name, label: name, sublabel: p.team || "",
                 image: getHeadshotUrl(p.player_id), logo: getLogoUrl(p.team, p.team_id) });
    }
    return out.sort((a, b) => a.label.localeCompare(b.label));
  };
  const hitterOpts = useMemo(() => searchOpts(hittersFull), [hittersFull]);
  const pitcherOpts = useMemo(() => searchOpts(pitchersFull), [pitchersFull]);
  const aaaHitterOpts = useMemo(() => searchOpts(aaaHittersFull), [aaaHittersFull]);
  const aaaPitcherOpts = useMemo(() => searchOpts(aaaPitchersFull), [aaaPitchersFull]);
  const fielderOpts = useMemo(() => searchOpts(fielders, f => f.name), [fielders]);
  const curAaaHitter  = useMemo(() => aaaHittersFull.find(h => h.displayName === selectedHitter)  || null, [aaaHittersFull, selectedHitter]);
  const curAaaPitcher = useMemo(() => aaaPitchersFull.find(p => p.displayName === selectedPitcher) || null, [aaaPitchersFull, selectedPitcher]);

  // ── Card player ⇄ URL (?player=<MLBAM id>) on the hitter / pitcher / fielder sections ──
  const cardKind = (tab === "pitcher" || tab === "pitcher_aaa") ? "pitcher"
    : (tab === "hitter" || tab === "hitter_aaa") ? "hitter" : tab === "fielder" ? "fielder" : null;
  const isAaaTab = tab.endsWith("_aaa");
  const cardList = cardKind === "pitcher" ? (isAaaTab ? aaaPitchersFull : pitchersFull)
    : cardKind === "hitter" ? (isAaaTab ? aaaHittersFull : hittersFull)
    : cardKind === "fielder" ? fielders : null;
  const cardName = cardKind === "pitcher" ? selectedPitcher : cardKind === "hitter" ? selectedHitter : cardKind === "fielder" ? selectedFielder : null;
  const cardNameOf = p => (cardKind === "fielder" ? p.name : p.displayName);
  const urlPlayer = cardKind ? (loc.query.player || null) : null;
  const urlApplied = useRef(null);   // "<tab>:<season>:<id>" already reflected in the selection
  // URL → selection (on load, back/forward, a pasted link), once that list has loaded.
  useEffect(() => {
    if (!cardKind || !urlPlayer || !cardList?.length) return;
    const key = `${tab}:${season}:${urlPlayer}`;
    if (urlApplied.current === key) return;
    urlApplied.current = key;
    const found = cardList.find(p => String(p.player_id) === String(urlPlayer));
    if (!found || cardNameOf(found) === cardName) return;
    (cardKind === "pitcher" ? setSelectedPitcher : cardKind === "hitter" ? setSelectedHitter : setSelectedFielder)(cardNameOf(found));
  }, [cardKind, urlPlayer, cardList, tab, season]);  // eslint-disable-line react-hooks/exhaustive-deps
  // Selection → URL (replace, so picking players doesn't flood the back button).
  useEffect(() => {
    if (!cardKind || !cardList?.length || !cardName) return;
    if (urlPlayer && urlApplied.current !== `${tab}:${season}:${urlPlayer}`) return;   // a linked player is still being applied
    const cur = cardList.find(p => cardNameOf(p) === cardName);
    if (cur?.player_id == null || String(cur.player_id) === String(urlPlayer || "")) return;
    urlApplied.current = `${tab}:${season}:${cur.player_id}`;
    setQuery({ player: cur.player_id });
  }, [cardKind, cardList, cardName, tab, season]);  // eslint-disable-line react-hooks/exhaustive-deps

  const pipelineReady = data && !loading && !error;
  const aaaReady = !!aaaData;

  // Helper to check if tab is active (handles dropdown sub-items)
  // (Hitter Game / Hitter Season summaries were folded into the hitter card's batted-ball panel.)
  const isSummaryTab = (id) => ["pitcher_game", "pitcher_season", "pitcher_plinko", "hitter_plinko", "hitter_iswing", "pitcher_stuff_wf"].includes(id);
  const isHitterTab    = (id) => id === "hitter" || id === "hitter_aaa";
  const isPitcherTab   = (id) => id === "pitcher" || id === "pitcher_aaa";
  const isLeaderboardTab = (id) => ["hitter_lb", "hitter_xrv_lb", "pitcher_lb", "pitch_modeling_lb", "proj_movers"].includes(id);
  // Projection season: sections with no projection version are off (dimmed in the sidebar).
  const isProjSeason = season === PROJ_SEASON;
  // A section with no projection version under the projection season: picking the
  // projection season in the dropdown → the hitter card (as before); arriving at the
  // section otherwise (a link, the sidebar) → open it in the latest real season.
  useEffect(() => {
    const picked = seasonPicked.current;
    seasonPicked.current = false;
    if (!isProjSeason || PROJ_TABS.has(tab)) return;
    if (picked) setTab("hitter", { replace: true });
    else setQuery({ season: LATEST_MLB_SEASON });
  }, [season, tab]);  // eslint-disable-line react-hooks/exhaustive-deps

  const winWidth = useWindowWidth();
  const isMobile = winWidth < 700;

  return (
    <div style={{ background: t.bg, transition: "background 0.3s" }}>
      {/* Season + player search render in the site's top bar (src/nav/Toolbar.jsx). */}
      <Toolbar>
          {/* Season Selector */}
          <select
            value={season}
            onChange={e => setSeason(e.target.value)}
            style={{
              padding: "8px 16px", 
              background: `linear-gradient(135deg, ${t.accentSecondary || t.accent} 0%, ${t.accent} 100%)`,
              color: inkOnColor(t.accent),
              border: "none", 
              borderRadius: 8, 
              fontSize: 13, 
              fontWeight: 700,
              cursor: "pointer", 
              outline: "none", 
              fontFamily: "inherit",
              boxShadow: "0 2px 8px rgba(0,0,0,0.2)",
            }}
          >
            {SEASONS.map(s => (
              <option key={s} value={s} style={{ background: t.inputBg, color: t.text }}>
                {String(s).endsWith("P") ? `${String(s).slice(0, 4)} Projected` : s}
              </option>
            ))}
          </select>

          {/* Player Selector (for card views) */}
          {(isHitterTab(tab) || isPitcherTab(tab) || tab === "fielder") && (
            <SearchableSelect
              value={isPitcherTab(tab) ? (selectedPitcher || "") : tab === "fielder" ? (selectedFielder || "") : (selectedHitter || "")}
              options={(tab === "pitcher" ? pitcherOpts
                : tab === "pitcher_aaa" ? aaaPitcherOpts
                : tab === "hitter_aaa"  ? aaaHitterOpts
                : tab === "fielder"     ? fielderOpts
                : hitterOpts)}
              onChange={name => {
                if (isPitcherTab(tab)) setSelectedPitcher(name);
                else if (tab === "fielder") setSelectedFielder(name);
                else setSelectedHitter(name);
              }}
              placeholder="Search player…"
              panelMinWidth={isMobile ? 0 : 340}
              panelAlign="right"
              style={{
                flex: isMobile ? "1 1 100%" : "0 1 280px",
                padding: "6px 12px",
                background: t.inputBg,
                border: `1px solid ${t.inputBorder}`,
                borderRadius: 6,
                color: t.text,
                fontSize: 12,
                minWidth: isMobile ? 0 : 200,
                maxWidth: isMobile ? "100%" : 280,
                width: isMobile ? "100%" : "auto",
                flexShrink: 1,
              }}
            />
          )}
      </Toolbar>

      {/* ── Date-range bar (hitter/pitcher cards) ── */}
      {(isHitterTab(tab) || isPitcherTab(tab)) && !isProjSeason && (
        <div style={{
          display: "flex", alignItems: "center", gap: 8,
          padding: isMobile ? "8px 16px" : "8px 24px",
          borderBottom: `1px solid ${t.divider}`,
          background: t.id === "dark" ? "rgba(255,255,255,0.025)" : "rgba(0,0,0,0.02)",
          flexWrap: "wrap",
        }}>
          <span style={{
            fontSize: 11, fontWeight: 700, color: t.textMuted,
            letterSpacing: "0.05em", textTransform: "uppercase",
          }}>Date range</span>
          <input
            type="date"
            value={cardDateFrom}
            onChange={e => setCardDateFrom(e.target.value)}
            style={{
              padding: "4px 8px", fontSize: 12,
              background: t.inputBg, color: t.text,
              border: `1px solid ${t.inputBorder}`, borderRadius: 6,
              outline: "none", fontFamily: "inherit",
              colorScheme: t.id === "dark" ? "dark" : "light",
            }}
          />
          <span style={{ fontSize: 12, color: t.textFaint }}>–</span>
          <input
            type="date"
            value={cardDateTo}
            onChange={e => setCardDateTo(e.target.value)}
            style={{
              padding: "4px 8px", fontSize: 12,
              background: t.inputBg, color: t.text,
              border: `1px solid ${t.inputBorder}`, borderRadius: 6,
              outline: "none", fontFamily: "inherit",
              colorScheme: t.id === "dark" ? "dark" : "light",
            }}
          />
          {(cardDateFrom || cardDateTo) && (
            <button
              onClick={() => { setCardDateFrom(""); setCardDateTo(""); }}
              style={{
                padding: "4px 10px", fontSize: 11, fontWeight: 600,
                background: "transparent", color: t.textMuted,
                border: `1px solid ${t.inputBorder}`, borderRadius: 6,
                cursor: "pointer", fontFamily: "inherit",
              }}
            >✕ Clear</button>
          )}
          <span style={{ fontSize: 10, color: t.textFaint, marginLeft: 2 }}>
            {(cardDateFrom || cardDateTo)
              ? "date-range stats ranked vs the full-season distribution"
              : "full season — pick a window to filter"}
          </span>
        </div>
      )}

      {/* ── Content ── */}
      <div style={{
        padding: isSummaryTab(tab) ? 0 : isMobile ? "12px 24px" : 24,
        // The MLB pitcher card gets room for its side panels (release diagram + distributions) beside the card.
        maxWidth: tab.includes("lb") || tab.startsWith("proj_") || tab === "race2k" || tab === "team_plots" ? 1200 : isSummaryTab(tab) ? 1200 : tab === "evla" ? 780 : tab === "pitcher" ? 1540 : (tab === "hitter" || tab === "pitcher_aaa") ? 1100 : 640,
        margin: "0 auto",
      }}>
        {tab === "hitter" && (
          pipelineReady ? (
            <HitterCard
              player={curHitter}
              season={season}
              trends={trends?.hitter_trends}
              allHitters={hittersFull}
              dateFrom={cardDateFrom}
              dateTo={cardDateTo}
              xrvAll={xrvData}
              xrvGames={curHitter?.player_id != null ? xrvGamesData?.[String(curHitter.player_id)] : null}
              xrvGamesLoading={xrvGamesLoading}
              onSelectPlayer={selectPlayerFromComp}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}. Run: python3 baseball_pipeline.py ./public ${season}`}
            </div>
          )
        )}
        {tab === "pitcher" && (
          pipelineReady ? (
            <PitcherCard
              player={curPitcher}
              season={season}
              trends={trends?.pitcher_trends}
              allPitchers={pitchersFull}
              dateFrom={cardDateFrom}
              dateTo={cardDateTo}
              onSelectPlayer={selectPlayerFromComp}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}. Run: python3 baseball_pipeline.py ./public ${season}`}
            </div>
          )
        )}
        {tab === "hitter_aaa" && (
          aaaReady ? (
            <HitterCard
              player={curAaaHitter}
              season={season}
              allHitters={aaaHittersFull}
              isAAA
              dateFrom={cardDateFrom}
              dateTo={cardDateTo}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              No AAA data for {season}. Run: python3 baseball_pipeline.py ./public {season}
            </div>
          )
        )}
        {tab === "pitcher_aaa" && (
          aaaReady ? (
            <PitcherCard
              player={curAaaPitcher}
              season={season}
              allPitchers={aaaPitchersFull}
              isAAA
              dateFrom={cardDateFrom}
              dateTo={cardDateTo}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              No AAA data for {season}. Run: python3 baseball_pipeline.py ./public {season}
            </div>
          )
        )}
        {tab === "fielder" && (
          fieldingData ? (
            <FielderCard
              player={curFielder}
              season={season}
              fieldingData={fieldingData}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              No fielding data for {season}. Run: python3 baseball_pipeline.py ./public {season}
            </div>
          )
        )}
        {isSummaryTab(tab) && tab !== "hitter_iswing" && tab !== "pitcher_stuff_wf" && (
          <Summaries season={season} initialSubTab={tab} urlState={loc.query}
            onUrlState={u => setQuery({ type: u.type === "S" ? null : u.type, player: u.player, game: u.game, from: u.from, to: u.to })} />
        )}
        {tab === "hitter_iswing" && (
          <ISwingWaterfall season={season} hitters={hittersFull} />
        )}
        {tab === "pitcher_stuff_wf" && (
          <StuffWaterfall season={season} pitchers={pitchersFull} />
        )}
        {tab === "hitter_lb" && (
          pipelineReady ? (
            <Leaderboard
              players={hittersFull}
              metrics={iswingData ? [{ label: "iSwing+", isNew: iswingNew }, ...(data?.hitter_metrics || [])] : data?.hitter_metrics}
              type="hitter"
              positionByPid={positionByPid}
              csvFilename={`hitters_${season}.csv`}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}.`}
            </div>
          )
        )}
        {tab === "hitter_xrv_lb" && (
          pipelineReady ? (
            hitterXrvPlayers.length ? (
              <Leaderboard
                players={hitterXrvPlayers}
                metrics={HITTER_XRV_METRICS}
                type="hitter"
                defaultSortCol="xRV/600"
                positionByPid={positionByPid}
                csvFilename={`hitter_xrv_${season}.csv`}
              />
            ) : (
              <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
                No hitter xRV for {season}. Run: python3 build_hitter_xrv.py --season {season}
              </div>
            )
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}.`}
            </div>
          )
        )}
        {tab === "pitcher_lb" && (
          pipelineReady ? (
            <Leaderboard
              players={pitchersFull}
              metrics={data?.pitcher_metrics}
              type="pitcher"
              csvFilename={`pitchers_${season}.csv`}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}.`}
            </div>
          )
        )}
        {tab === "proj_movers" && PROJ_SEASON && (
          <ProjectionMovers projSeason={PROJ_SEASON} />
        )}
        {(tab === "proj_ci_hitters" || tab === "proj_ci_pitchers") && PROJ_SEASON && (
          <RangeView key={tab} projSeason={PROJ_SEASON} side={tab === "proj_ci_hitters" ? "hitters" : "pitchers"} />
        )}
        {tab === "pitch_modeling_lb" && (
          <PitchModelingLeaderboard season={season} pitchers={pitchersFull} />
        )}
        {tab === "team_plots" && (
          <TeamScatter season={season} hitters={hittersFull} iswingData={iswingData} />
        )}
        {tab === "race2k" && (
          <RaceToTwoStrikes season={season} />
        )}
        {tab === "evla" && (
          <EVLAChart season={season} />
        )}
      </div>
    </div>
  );
}


// Multi-select dropdown (button + checkbox panel) for the leaderboard filters.
function MultiSelect({ label, options, selected, onChange }) {
  const { theme: t } = useTheme();
  const [open, setOpen] = useState(false);
  const n = selected.size;
  const mini = {
    flex: 1, padding: "3px 6px", fontSize: 10, fontWeight: 600, fontFamily: "inherit",
    background: t.inputBg, color: t.textMuted, border: `1px solid ${t.inputBorder}`,
    borderRadius: 4, cursor: "pointer",
  };
  return (
    <div style={{ position: "relative" }} onClick={e => e.stopPropagation()}>
      <button
        onClick={() => setOpen(o => !o)}
        style={{
          padding: "7px 10px", fontSize: 11, fontWeight: 600, fontFamily: "inherit",
          background: t.inputBg, color: n ? t.accent : t.textMuted,
          border: `1px solid ${n ? t.accent : t.inputBorder}`, borderRadius: 6,
          cursor: "pointer", whiteSpace: "nowrap", display: "flex", alignItems: "center", gap: 5,
        }}
      >
        {label}{n ? ` · ${n}` : ""}<span style={{ fontSize: 8 }}>▾</span>
      </button>
      {open && (
        <>
          <div style={{ position: "fixed", inset: 0, zIndex: 40 }} onClick={() => setOpen(false)} />
          <div style={{
            position: "absolute", top: "calc(100% + 4px)", left: 0, zIndex: 50,
            background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 8,
            boxShadow: `0 8px 24px ${t.shadow}`, minWidth: 150, maxHeight: 280,
            overflowY: "auto", padding: 4,
          }}>
            <div style={{ display: "flex", gap: 4, padding: "2px 4px 6px" }}>
              <button onClick={() => onChange(new Set(options))} style={mini}>All</button>
              <button onClick={() => onChange(new Set())} style={mini}>Clear</button>
            </div>
            {options.length === 0 && (
              <div style={{ padding: 6, fontSize: 11, color: t.textFaint }}>none</div>
            )}
            {options.map(opt => (
              <label key={opt} style={{
                display: "flex", alignItems: "center", gap: 6, padding: "5px 6px",
                fontSize: 12, color: t.textSecondary, cursor: "pointer", borderRadius: 4,
              }}>
                <input
                  type="checkbox" checked={selected.has(opt)}
                  onChange={() => {
                    const next = new Set(selected);
                    next.has(opt) ? next.delete(opt) : next.add(opt);
                    onChange(next);
                  }}
                />
                {opt}
              </label>
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ── Leaderboard (themed) ──
function Leaderboard({ players, metrics, type, defaultSortCol = null, defaultSortDir = "desc", positionByPid = null, csvFilename = "leaderboard.csv" }) {
  const { theme: t } = useTheme();
  const [sortCol, setSortCol] = useState(defaultSortCol);
  const [sortDir, setSortDir] = useState(defaultSortDir);
  const [search, setSearch] = useState("");
  const [league, setLeague] = useState("All");           // All | AL | NL
  const [selTeams, setSelTeams] = useState(() => new Set());
  const [selPos, setSelPos] = useState(() => new Set());
  const [colorOn, setColorOn] = useState(true);

  const showPos = type !== "pitcher" && !!positionByPid;
  const posOf = (p) => (positionByPid && positionByPid[String(p.player_id)]) || "—";

  // Team options scoped to the chosen league; position options from the fielding map.
  const teamOptions = useMemo(() => {
    const s = new Set();
    for (const p of players) {
      if (!p.team) continue;
      if (league !== "All" && TEAM_LEAGUE[p.team] !== league) continue;
      s.add(p.team);
    }
    return [...s].sort();
  }, [players, league]);

  const posOptions = useMemo(() => {
    if (!showPos) return [];
    const s = new Set();
    for (const p of players) s.add(posOf(p));
    return [...s].sort((a, b) => {
      const ia = POS_ORDER.indexOf(a), ib = POS_ORDER.indexOf(b);
      return (ia < 0 ? 99 : ia) - (ib < 0 ? 99 : ib);
    });
  }, [players, showPos, positionByPid]);  // eslint-disable-line react-hooks/exhaustive-deps

  const columns = useMemo(() => {
    if (!metrics) return [];
    return [
      { key: "name", label: type === "pitcher" ? "Pitcher" : "Player" },
      { key: "team", label: "Tm" },
      ...(type === "pitcher" ? [{ key: "ip", label: "IP" }] : [{ key: "pa", label: "PA" }]),
      ...metrics.map(m => ({ key: m.label, label: m.label, isMetric: true, isNew: !!m.isNew })),
    ];
  }, [metrics, type]);

  const filtered = useMemo(() => {
    const q = search ? norm(search) : null;
    let arr = players.filter(p => {
      if (league !== "All" && TEAM_LEAGUE[p.team] !== league) return false;
      if (selTeams.size && !selTeams.has(p.team)) return false;
      if (showPos && selPos.size && !selPos.has(posOf(p))) return false;
      if (q && !(norm(p.displayName || p.name).includes(q) || norm(p.team || "").includes(q))) return false;
      return true;
    });
    if (sortCol) {
      arr.sort((a, b) => {
        let av, bv;
        if (sortCol === "name") { av = a.name; bv = b.name; }
        else if (sortCol === "team") { av = a.team || ""; bv = b.team || ""; }
        else if (sortCol === "pa") { av = a.pa; bv = b.pa; }
        else if (sortCol === "ip") { av = a.ip; bv = b.ip; }
        else { av = a.categories[sortCol]?.pctile; bv = b.categories[sortCol]?.pctile; }
        if (av == null) return 1; if (bv == null) return -1;
        if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
        return sortDir === "asc" ? av - bv : bv - av;
      });
    }
    return arr;
  }, [players, league, selTeams, selPos, search, sortCol, sortDir, showPos, positionByPid]);  // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  // Export the leaderboard exactly as displayed (current filters + sort order).
  const exportCsv = () => {
    const header = columns.map(c => c.label);
    const body = filtered.map(p => columns.map(c => {
      if (c.key === "name") return p.displayName || p.name;
      if (c.key === "team") return p.team || "";
      if (c.key === "pa") return p.pa ?? "";
      if (c.key === "ip") return p.ip ?? "";
      if (c.isMetric) return p.categories?.[c.key]?.display ?? "";
      return "";
    }));
    exportRowsAsCsv([header, ...body], csvFilename);
  };

  const thS = {
    padding: "7px 5px", textAlign: "center", cursor: "pointer", fontSize: 9,
    fontWeight: 700, color: t.textMuted, borderBottom: `2px solid ${t.tableHeaderBorder}`,
    whiteSpace: "nowrap", userSelect: "none", position: "sticky", top: 0,
    background: t.tableHeaderBg, zIndex: 2,
  };
  const tdS = {
    padding: "4px 5px", textAlign: "center", fontSize: 10,
    borderBottom: `1px solid ${t.tableBorder}`, whiteSpace: "nowrap",
  };

  const filtersActive = selTeams.size || selPos.size || league !== "All";

  return (
    <div>
      {/* ── Filter bar (above the full leaderboard) ── */}
      <div style={{ display: "flex", flexWrap: "wrap", alignItems: "center", gap: 8, marginBottom: 10 }}>
        <input
          type="text" value={search} onChange={e => setSearch(e.target.value)}
          placeholder="Search player or team..."
          style={{
            flex: "1 1 180px", maxWidth: 240, padding: "7px 12px",
            background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
            color: t.text, fontSize: 12, outline: "none", fontFamily: "inherit",
          }}
        />
        {/* League segmented control (also resets the team picks) */}
        <div style={{ display: "flex", border: `1px solid ${t.inputBorder}`, borderRadius: 6, overflow: "hidden" }}>
          {["All", "AL", "NL"].map(lg => (
            <button
              key={lg}
              onClick={() => { setLeague(lg); setSelTeams(new Set()); }}
              style={{
                padding: "7px 12px", fontSize: 11, fontWeight: 700, fontFamily: "inherit",
                cursor: "pointer", border: "none",
                background: league === lg ? t.accent : t.inputBg,
                color: league === lg ? "#fff" : t.textMuted,
              }}
            >{lg}</button>
          ))}
        </div>
        <MultiSelect label="Teams" options={teamOptions} selected={selTeams} onChange={setSelTeams} />
        {showPos && (
          <MultiSelect label="Position" options={posOptions} selected={selPos} onChange={setSelPos} />
        )}
        <label style={{
          display: "flex", alignItems: "center", gap: 6, fontSize: 11, fontWeight: 600,
          color: t.textMuted, cursor: "pointer", marginLeft: "auto", whiteSpace: "nowrap",
        }}>
          <input type="checkbox" checked={colorOn} onChange={e => setColorOn(e.target.checked)} />
          Color cells
        </label>
        {filtersActive ? (
          <button
            onClick={() => { setLeague("All"); setSelTeams(new Set()); setSelPos(new Set()); }}
            style={{
              padding: "6px 10px", fontSize: 11, fontWeight: 600, background: "transparent",
              color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
              cursor: "pointer", fontFamily: "inherit",
            }}
          >✕ Reset</button>
        ) : null}
        <button
          onClick={exportCsv}
          title="Download the leaderboard as a CSV"
          style={{
            padding: "6px 10px", fontSize: 11, fontWeight: 600, background: t.inputBg,
            color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
            cursor: "pointer", fontFamily: "inherit", whiteSpace: "nowrap",
          }}
        >⬇ CSV</button>
      </div>

      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${t.cardBorder}`, maxHeight: "70vh", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: t.tableRowA }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} onClick={() => toggle(c.key)} style={thS}>
                  {c.label} {sortCol === c.key ? (sortDir === "desc" ? "▾" : "▴") : ""}
                  {c.isNew && <NewBadge />}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {filtered.map((p, i) => (
              <tr key={i} style={{ background: i % 2 === 0 ? t.tableRowA : t.tableRowB }}>
                {columns.map(c => {
                  let val, st = { ...tdS };
                  if (c.key === "name") {
                    val = p.displayName || p.name; st.textAlign = "left"; st.fontWeight = 600;
                    st.color = t.textSecondary; st.position = "sticky"; st.left = 0;
                    st.background = i % 2 === 0 ? t.tableRowA : t.tableRowB; st.zIndex = 1;
                  } else if (c.key === "team") {
                    val = p.team || "—"; st.color = t.textMuted;
                  } else if (c.key === "pa") {
                    val = p.pa || "—"; st.color = t.textMuted;
                  } else if (c.key === "ip") {
                    val = p.ip || "—"; st.color = t.textMuted;
                  } else {
                    const cat = p.categories[c.key];
                    val = cat?.display || "—";
                    if (cat?.pctile != null && colorOn) {
                      st.background = binColor(cat.pctile);
                      st.color = textOnBin(cat.pctile);
                      st.fontWeight = 600;
                    } else if (cat?.pctile != null) {
                      st.color = t.textSecondary; st.fontWeight = 600;
                    } else {
                      st.color = t.textFaint;
                    }
                  }
                  return <td key={c.key} style={st}>{val}</td>;
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div style={{ fontSize: 10, color: t.textFaint, marginTop: 6 }}>{filtered.length} players</div>
    </div>
  );
}
