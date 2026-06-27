import { useState, useEffect, useMemo } from "react";
import HitterCard from "./HitterCard.jsx";
import PitcherCard from "./PitcherCard.jsx";
import FielderCard from "./FielderCard.jsx";
import PitchModelingLeaderboard from "./PitchModelingLeaderboard.jsx";
import Summaries from "./Summaries.jsx";
import RaceToTwoStrikes from "./RaceToTwoStrikes.jsx";
import EVLAChart from "./EVLAChart.jsx";
import TeamScatter from "./TeamScatter.jsx";
import { fuzzyLookup, binColor, textOnBin, BIN_COLORS, pctToBin, SearchableSelect } from "./SharedComponents.jsx";
import { ThemeProvider, useTheme, ThemeToggle } from "./ThemeContext.jsx";

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

const TABS = [
  {
    id: "hitter",
    label: "HITTER CARD",
    dropdown: [
      { id: "hitter",     label: "MLB" },
      { id: "hitter_aaa", label: "AAA" },
    ],
  },
  {
    id: "pitcher",
    label: "PITCHER CARD",
    dropdown: [
      { id: "pitcher",     label: "MLB" },
      { id: "pitcher_aaa", label: "AAA" },
    ],
  },
  { id: "fielder",    label: "FIELDER CARD" },
  {
    id: "summaries",
    label: "SUMMARIES",
    dropdown: [
      { id: "pitcher_game", label: "Pitcher Game" },
      { id: "pitcher_season", label: "Pitcher Season" },
      { id: "pitcher_counts", label: "Pitcher Counts" },
      { id: "hitter_game", label: "Hitter Game" },
      { id: "hitter_season", label: "Hitter Season" },
      { id: "hitter_counts", label: "Hitter Counts" },
    ]
  },
  {
    id: "leaderboard",
    label: "LEADERBOARD",
    dropdown: [
      { id: "hitter_lb",  label: "Hitter" },
      { id: "hitter_xrv_lb", label: "Hitter xRV" },
      { id: "pitcher_lb", label: "Pitcher" },
      { id: "pitch_modeling_lb", label: "Pitch Modeling" },
    ]
  },
  { id: "team_plots", label: "TEAM PLOTS" },
  { id: "race2k",     label: "RACE TO 2K" },
  { id: "evla",       label: "EV/LA FAN" },
];

const SEASONS = ["2026", "2025", "2024", "2023"];

// Ordered xRV/600 PA metric labels for the hitter xRV leaderboard (mirrors the
// HitterCard right column / build_hitter_xrv.py). xRV/600 leads so the board
// defaults to sorting by overall expected run value.
const HITTER_XRV_METRICS = [
  "xRV/600", "Contact Quality", "Whiff", "Decision",
  "Fastball", "Breaking", "Offspeed",
  "Inner", "Middle (vertical)", "Outer",
  "Upper", "Middle (horizontal)", "Lower", "Chase",
].map(label => ({ label }));

// ── Wrapped export with ThemeProvider ──
export default function BaseballAppWrapper() {
  return (
    <ThemeProvider>
      <BaseballApp />
    </ThemeProvider>
  );
}

function BaseballApp() {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [trends, setTrends] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [season, setSeason] = useState("2026");
  const [tab, setTab] = useState("pitcher_game");
  const [summarySubTab, setSummarySubTab] = useState("pitcher_game");
  const [openDropdown, setOpenDropdown] = useState(null);
  const [selectedHitter, setSelectedHitter] = useState(null);
  const [selectedPitcher, setSelectedPitcher] = useState(null);
  const [iswingData, setIswingData] = useState(null);
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

  const curHitter = useMemo(() => hittersFull.find(h => h.displayName === selectedHitter), [hittersFull, selectedHitter]);
  const curPitcher = useMemo(() => pitchersFull.find(p => p.displayName === selectedPitcher), [pitchersFull, selectedPitcher]);

  // ── AAA-equivalent derived views, sourced from aaa_data_<season>.json. The
  // shape mirrors baseball_data so HitterCard / PitcherCard render identically.
  const aaaHittersFull = useMemo(() => disambiguate(aaaData?.hitters || []), [aaaData]);
  const aaaPitchersFull = useMemo(() => disambiguate(aaaData?.pitchers || []), [aaaData]);
  const aaaHitterNames = useMemo(() => aaaHittersFull.map(h => h.displayName).sort(), [aaaHittersFull]);
  const aaaPitcherNames = useMemo(() => aaaPitchersFull.map(p => p.displayName).sort(), [aaaPitchersFull]);
  const curAaaHitter  = useMemo(() => aaaHittersFull.find(h => h.displayName === selectedHitter)  || null, [aaaHittersFull, selectedHitter]);
  const curAaaPitcher = useMemo(() => aaaPitchersFull.find(p => p.displayName === selectedPitcher) || null, [aaaPitchersFull, selectedPitcher]);

  const pipelineReady = data && !loading && !error;
  const aaaReady = !!aaaData;

  // Helper to check if tab is active (handles dropdown sub-items)
  const isSummaryTab = (id) => ["pitcher_game", "pitcher_season", "pitcher_counts", "hitter_game", "hitter_season", "hitter_counts"].includes(id);
  const isHitterTab    = (id) => id === "hitter" || id === "hitter_aaa";
  const isPitcherTab   = (id) => id === "pitcher" || id === "pitcher_aaa";
  const isLeaderboardTab = (id) => ["hitter_lb", "hitter_xrv_lb", "pitcher_lb", "pitch_modeling_lb"].includes(id);
  const isTabActive = (tabId) => {
    if (tabId === "summaries") return isSummaryTab(tab);
    if (tabId === "leaderboard") return isLeaderboardTab(tab);
    if (tabId === "hitter") return isHitterTab(tab);
    if (tabId === "pitcher") return isPitcherTab(tab);
    return tab === tabId;
  };

  // Handle tab click with dropdown support
  const handleTabClick = (tb, e) => {
    if (tb.dropdown) {
      e.stopPropagation();
      setOpenDropdown(openDropdown === tb.id ? null : tb.id);
    } else {
      setTab(tb.id);
      setOpenDropdown(null);
    }
  };

  // Handle dropdown item click
  const handleDropdownSelect = (subItem) => {
    setTab(subItem.id);
    setSummarySubTab(subItem.id);
    setOpenDropdown(null);
  };

  // Close dropdown when clicking outside
  const handleBackdropClick = () => {
    setOpenDropdown(null);
  };

  const winWidth = useWindowWidth();
  const isMobile = winWidth < 640;

  return (
    <div style={{ minHeight: "100vh", background: t.bg, transition: "background 0.3s" }} onClick={handleBackdropClick}>
      {/* ── Full-Width Navigation Bar ── */}
      <div style={{
        background: t.headerBgSolid || t.headerBg,
        borderBottom: `2px solid ${t.accent}`,
        padding: isMobile ? "0 8px" : "0 24px",
        display: "flex",
        alignItems: "stretch",
        position: "sticky",
        top: 0,
        zIndex: 100,
        transition: "background 0.3s",
        boxShadow: `0 2px 12px ${t.shadow}`,
        flexWrap: isMobile ? "wrap" : "nowrap",
      }}>
        {/* Tab Navigation */}
        {isMobile ? (
          // On mobile: wrap scroll container + dropdown as siblings so overflowX
          // doesn't clip the dropdown (overflow:auto implicitly clips cross-axis).
          <div style={{ position: "relative", flex: 1, overflow: "visible" }} onClick={e => e.stopPropagation()}>
            <div style={{ display: "flex", alignItems: "stretch", overflowX: "auto", msOverflowStyle: "none", scrollbarWidth: "none" }}>
              {TABS.map(tb => (
                <button
                  key={tb.id}
                  onClick={(e) => handleTabClick(tb, e)}
                  style={{
                    padding: "10px 10px",
                    fontSize: 11,
                    fontWeight: isTabActive(tb.id) ? 700 : 600,
                    letterSpacing: "0.05em",
                    whiteSpace: "nowrap",
                    color: isTabActive(tb.id) ? t.accent : t.textMuted,
                    background: isTabActive(tb.id) ? (t.id === "dark" ? "rgba(245,158,11,0.1)" : "rgba(234,88,12,0.08)") : "transparent",
                    border: "none",
                    borderBottom: isTabActive(tb.id) ? `3px solid ${t.accent}` : "3px solid transparent",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    flexShrink: 0,
                  }}
                >
                  {tb.label}
                  {tb.dropdown && (
                    <span style={{ fontSize: 8, marginLeft: 2, display: "inline-block", transform: openDropdown === tb.id ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▼</span>
                  )}
                </button>
              ))}
            </div>
            {/* Mobile dropdown lives outside the scroll container — not clipped */}
            {openDropdown && (() => {
              const activeTb = TABS.find(tb => tb.id === openDropdown);
              if (!activeTb?.dropdown) return null;
              return (
                <div style={{
                  position: "absolute", top: "100%", left: 0, right: 0,
                  background: t.cardBg,
                  border: `1px solid ${t.accent}`,
                  borderTop: "none",
                  borderRadius: "0 0 10px 10px",
                  boxShadow: `0 12px 32px ${t.shadow}`,
                  overflow: "hidden",
                  zIndex: 300,
                }}>
                  {activeTb.dropdown.map((sub, idx) => (
                    <button
                      key={sub.id}
                      onClick={() => handleDropdownSelect(sub)}
                      style={{
                        width: "100%",
                        padding: "16px 20px",
                        fontSize: 15,
                        fontWeight: tab === sub.id ? 700 : 500,
                        color: tab === sub.id ? t.accent : t.textSecondary,
                        background: tab === sub.id ? (t.id === "dark" ? "rgba(245,158,11,0.15)" : "rgba(234,88,12,0.1)") : "transparent",
                        border: "none",
                        borderBottom: idx < activeTb.dropdown.length - 1 ? `1px solid ${t.tableBorder}` : "none",
                        cursor: "pointer",
                        textAlign: "left",
                        fontFamily: "inherit",
                        display: "block",
                      }}
                    >
                      {sub.label}
                    </button>
                  ))}
                </div>
              );
            })()}
          </div>
        ) : (
          // Desktop: absolutely centered, dropdown inside each tab's relative container
          <div style={{ position: "absolute", left: "50%", transform: "translateX(-50%)", display: "flex", alignItems: "stretch", height: "100%" }}>
            {TABS.map(tb => (
              <div key={tb.id} style={{ position: "relative", display: "flex", alignItems: "stretch" }} onClick={(e) => e.stopPropagation()}>
                <button
                  onClick={(e) => handleTabClick(tb, e)}
                  style={{
                    padding: "16px 18px",
                    fontSize: 12,
                    fontWeight: isTabActive(tb.id) ? 700 : 600,
                    letterSpacing: "0.05em",
                    whiteSpace: "nowrap",
                    color: isTabActive(tb.id) ? t.accent : t.textMuted,
                    background: isTabActive(tb.id) ? (t.id === "dark" ? "rgba(245,158,11,0.1)" : "rgba(234,88,12,0.08)") : "transparent",
                    border: "none",
                    borderBottom: isTabActive(tb.id) ? `3px solid ${t.accent}` : "3px solid transparent",
                    cursor: "pointer",
                    transition: "all 0.2s",
                    fontFamily: "inherit",
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                  }}
                >
                  {tb.label}
                  {tb.dropdown && (
                    <span style={{ fontSize: 8, marginLeft: 2, transform: openDropdown === tb.id ? "rotate(180deg)" : "rotate(0deg)", transition: "transform 0.2s" }}>▼</span>
                  )}
                </button>
                {tb.dropdown && openDropdown === tb.id && (
                  <div style={{
                    position: "absolute", top: "100%", left: 0,
                    background: t.cardBg,
                    border: `1px solid ${t.accent}`,
                    borderRadius: 10,
                    boxShadow: `0 12px 32px ${t.shadow}`,
                    minWidth: 160,
                    overflow: "hidden",
                    zIndex: 200,
                  }}>
                    {tb.dropdown.map((sub, idx) => (
                      <button
                        key={sub.id}
                        onClick={() => handleDropdownSelect(sub)}
                        style={{
                          width: "100%",
                          padding: "12px 18px",
                          fontSize: 13,
                          fontWeight: tab === sub.id ? 700 : 500,
                          color: tab === sub.id ? t.accent : t.textSecondary,
                          background: tab === sub.id ? (t.id === "dark" ? "rgba(245,158,11,0.15)" : "rgba(234,88,12,0.1)") : "transparent",
                          border: "none",
                          borderBottom: idx < tb.dropdown.length - 1 ? `1px solid ${t.tableBorder}` : "none",
                          cursor: "pointer",
                          textAlign: "left",
                          fontFamily: "inherit",
                          transition: "all 0.15s",
                        }}
                        onMouseEnter={(e) => { if (tab !== sub.id) e.target.style.background = t.id === "dark" ? "rgba(59,130,246,0.1)" : "rgba(37,99,235,0.05)"; }}
                        onMouseLeave={(e) => { if (tab !== sub.id) e.target.style.background = "transparent"; }}
                      >
                        {sub.label}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}

        {/* Right: Season selector, player selector, theme toggle, stats */}
        <div style={{
          display: "flex", alignItems: "center", gap: isMobile ? 8 : 16,
          marginLeft: isMobile ? 0 : "auto",
          width: isMobile ? "100%" : "auto",
          padding: isMobile ? "6px 4px" : 0,
          borderTop: isMobile ? `1px solid ${t.divider}` : "none",
          flexWrap: "wrap",
        }}>
          {/* Season Selector */}
          <select
            value={season}
            onChange={e => setSeason(e.target.value)}
            style={{
              padding: "8px 16px", 
              background: `linear-gradient(135deg, ${t.accentSecondary || t.accent} 0%, ${t.accent} 100%)`,
              color: "#fff",
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
              <option key={s} value={s} style={{ background: t.inputBg, color: t.text }}>{s}</option>
            ))}
          </select>

          {/* Player Selector (for card views) */}
          {(isHitterTab(tab) || isPitcherTab(tab) || tab === "fielder") && (
            <SearchableSelect
              value={isPitcherTab(tab) ? (selectedPitcher || "") : tab === "fielder" ? (selectedFielder || "") : (selectedHitter || "")}
              options={(tab === "pitcher" ? pitcherNames
                : tab === "pitcher_aaa" ? aaaPitcherNames
                : tab === "hitter_aaa"  ? aaaHitterNames
                : tab === "fielder"     ? fielderNames
                : hitterNames)}
              onChange={name => {
                if (isPitcherTab(tab)) setSelectedPitcher(name);
                else if (tab === "fielder") setSelectedFielder(name);
                else setSelectedHitter(name);
              }}
              placeholder="Search player…"
              style={{
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

          <ThemeToggle />

          {!isHitterTab(tab) && !isPitcherTab(tab) && tab !== "fielder" && (
            <div style={{
              fontSize: 10,
              color: t.textFaint,
              letterSpacing: "0.03em",
              borderLeft: `1px solid ${t.divider}`,
              paddingLeft: 16,
            }}>
              {season} | {hitters.length} hitters | {pitchers.length} pitchers
            </div>
          )}
        </div>
      </div>

      {/* ── Date-range bar (hitter/pitcher cards) ── */}
      {(isHitterTab(tab) || isPitcherTab(tab)) && (
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
        maxWidth: tab.includes("lb") || tab === "race2k" || tab === "team_plots" ? 1200 : isSummaryTab(tab) ? 1200 : tab === "evla" ? 780 : tab === "hitter" ? 1100 : 640,
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
        {isSummaryTab(tab) && (
          <Summaries season={season} initialSubTab={summarySubTab} />
        )}
        {tab === "hitter_lb" && (
          pipelineReady ? (
            <Leaderboard
              players={hittersFull}
              metrics={iswingData ? [{ label: "iSwing+" }, ...(data?.hitter_metrics || [])] : data?.hitter_metrics}
              type="hitter"
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
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}.`}
            </div>
          )
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


// ── Leaderboard (themed) ──
function Leaderboard({ players, metrics, type, defaultSortCol = null, defaultSortDir = "desc" }) {
  const { theme: t } = useTheme();
  const [sortCol, setSortCol] = useState(defaultSortCol);
  const [sortDir, setSortDir] = useState(defaultSortDir);
  const [search, setSearch] = useState("");

  const columns = useMemo(() => {
    if (!metrics) return [];
    return [
      { key: "name", label: type === "pitcher" ? "Pitcher" : "Player" },
      { key: "team", label: "Tm" },
      ...(type === "pitcher" ? [{ key: "ip", label: "IP" }] : [{ key: "pa", label: "PA" }]),
      ...metrics.map(m => ({ key: m.label, label: m.label, isMetric: true })),
    ];
  }, [metrics, type]);

  const filtered = useMemo(() => {
    let arr = [...players];
    if (search) {
      const q = norm(search);
      arr = arr.filter(p => norm(p.displayName||p.name).includes(q) || norm(p.team || "").includes(q));
    }
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
  }, [players, sortCol, sortDir, search]);

  const toggle = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
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

  return (
    <div>
      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search player or team..."
        style={{
          width: "100%", maxWidth: 300, padding: "7px 12px",
          background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
          color: t.text, fontSize: 12, marginBottom: 10, outline: "none",
          fontFamily: "inherit",
        }}
      />
      <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${t.cardBorder}`, maxHeight: "70vh", overflowY: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: t.tableRowA }}>
          <thead>
            <tr>
              {columns.map(c => (
                <th key={c.key} onClick={() => toggle(c.key)} style={thS}>
                  {c.label} {sortCol === c.key ? (sortDir === "desc" ? "▾" : "▴") : ""}
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
                    if (cat?.pctile != null) {
                      // Red-blue percentile coloring stays the same in both modes
                      st.background = binColor(cat.pctile);
                      st.color = textOnBin(cat.pctile);
                      st.fontWeight = 600;
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
