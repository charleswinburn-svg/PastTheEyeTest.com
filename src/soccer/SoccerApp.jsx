import { useState, useEffect, useMemo } from "react";
import { findWorldCupLeague, fetchAllTournamentPlayerStats } from "./soccerApi.js";
import { SearchableSelect } from "../baseball/SharedComponents.jsx";
import Scoreboard from "./Scoreboard.jsx";
import OddsPanel from "./OddsPanel.jsx";
import SoccerPlayerCard from "./SoccerPlayerCard.jsx";

const T = {
  bg: "#0a0f1a",
  card: "#0f172a",
  border: "#1e3a5f",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  textFaint: "#475569",
  accent: "#f59e0b",
  divider: "#1e293b",
};

const TABS = [
  { id: "scores",  label: "Scoreboard" },
  { id: "odds",    label: "Odds" },
  { id: "players", label: "Player Cards" },
];

// Player cards stay locked until the Round of 32 — percentile ranks computed
// off 1–3 group games are too noisy to be meaningful
const KO_START = new Date("2026-06-28T00:00:00");
const koUnlocked = () => Date.now() >= KO_START.getTime();

export default function SoccerApp() {
  const [activeTab, setActiveTab] = useState("scores");
  const [leagueId, setLeagueId] = useState(null);
  const [leagueError, setLeagueError] = useState(null);

  const [allPlayers, setAllPlayers] = useState([]);
  const [playersLoading, setPlayersLoading] = useState(false);
  const [selectedPlayer, setSelectedPlayer] = useState(null);
  const [positionFilter, setPositionFilter] = useState("all");

  // Discover the World Cup league ID on mount
  useEffect(() => {
    findWorldCupLeague()
      .then(league => {
        if (league) {
          setLeagueId(league.id ?? league.league_id ?? league.pk);
        } else {
          setLeagueError("World Cup league not found — check back once the tournament is live");
        }
      })
      .catch(e => setLeagueError(e.message));
  }, []);

  // Load player stats when switching to player tab (only once unlocked)
  useEffect(() => {
    if (activeTab !== "players" || !koUnlocked() || !leagueId || allPlayers.length > 0) return;
    setPlayersLoading(true);
    fetchAllTournamentPlayerStats(leagueId)
      .then(players => setAllPlayers(players))
      .catch(() => {})
      .finally(() => setPlayersLoading(false));
  }, [activeTab, leagueId, allPlayers.length]);

  const filteredPlayers = useMemo(() => {
    if (positionFilter === "all") return allPlayers;
    return allPlayers.filter(p => {
      const pos = (p.position ?? "").toLowerCase();
      if (positionFilter === "gk") return /goalkeeper|keeper|gk/i.test(pos);
      if (positionFilter === "def") return /defend|defender|cb|lb|rb|wb|def/i.test(pos);
      if (positionFilter === "mid") return /midfield|midfielder|cm|dm|am|mid/i.test(pos);
      if (positionFilter === "fwd") return /forward|striker|winger|att|fw|st|lw|rw/i.test(pos);
      return true;
    });
  }, [allPlayers, positionFilter]);

  const playerOptions = useMemo(() =>
    filteredPlayers.map(p => ({
      value: p.player_id,
      label: `${p.name} — ${p.team}`,
    })),
    [filteredPlayers]
  );

  const selectedPlayerObj = useMemo(() =>
    allPlayers.find(p => p.player_id === selectedPlayer) ?? null,
    [allPlayers, selectedPlayer]
  );

  const tabStyle = (id) => ({
    padding: "12px 20px", fontSize: 12,
    fontWeight: activeTab === id ? 700 : 600,
    letterSpacing: "0.04em",
    color: activeTab === id ? T.accent : T.textMuted,
    background: activeTab === id ? "rgba(245,158,11,0.1)" : "transparent",
    border: "none",
    borderBottom: `3px solid ${activeTab === id ? T.accent : "transparent"}`,
    cursor: "pointer", transition: "all 0.2s", fontFamily: "inherit",
  });

  return (
    <div style={{ minHeight: "100vh", background: T.bg, paddingBottom: 60 }}>
      {/* World Cup header banner */}
      <div style={{
        background: "linear-gradient(135deg, #1b4332 0%, #0a2e1a 50%, #0a0f1a 100%)",
        borderBottom: `2px solid #2d6a4f`,
        padding: "20px 24px 16px",
        textAlign: "center",
      }}>
        <div style={{ fontSize: 13, color: "#52b788", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 4 }}>
          FIFA World Cup 2026
        </div>
        <div style={{ fontSize: 22, fontWeight: 800, color: T.text, letterSpacing: "-0.02em" }}>
          USA · Canada · Mexico
        </div>
        {leagueError && (
          <div style={{ fontSize: 11, color: "#fca5a5", marginTop: 6 }}>{leagueError}</div>
        )}
      </div>

      {/* Tab nav */}
      <div style={{
        background: T.card, borderBottom: `1px solid ${T.border}`,
        display: "flex", justifyContent: "center", padding: "0 16px",
      }}>
        {TABS.map(tab => (
          <button key={tab.id} style={tabStyle(tab.id)} onClick={() => setActiveTab(tab.id)}>
            {tab.label}
          </button>
        ))}
      </div>

      {/* Content */}
      <div style={{ maxWidth: 700, margin: "0 auto", padding: "20px 16px" }}>
        {activeTab === "scores" && <Scoreboard leagueId={leagueId} />}

        {activeTab === "odds" && <OddsPanel leagueId={leagueId} />}

        {activeTab === "players" && !koUnlocked() && (
          <div style={{ textAlign: "center", padding: "48px 24px" }}>
            <div style={{ fontSize: 36, marginBottom: 12 }}>🔒</div>
            <div style={{ fontSize: 15, fontWeight: 700, color: T.text, marginBottom: 6 }}>
              Player cards unlock at the knockout stage
            </div>
            <div style={{ fontSize: 12, color: T.textMuted, maxWidth: 420, margin: "0 auto", lineHeight: 1.5 }}>
              Percentile ranks need a full group stage of data to be meaningful.
              Cards go live when the Round of 32 kicks off on{" "}
              {KO_START.toLocaleDateString([], { month: "long", day: "numeric" })}.
            </div>
          </div>
        )}

        {activeTab === "players" && koUnlocked() && (
          <div>
            {playersLoading ? (
              <div style={{ color: T.textFaint, textAlign: "center", padding: 32 }}>
                <style>{`@keyframes spin3{to{transform:rotate(360deg)}}`}</style>
                <div style={{
                  width: 24, height: 24, border: "2px solid #1e3a5f",
                  borderTopColor: T.accent, borderRadius: "50%",
                  animation: "spin3 0.8s linear infinite", margin: "0 auto 12px",
                }} />
                Loading tournament stats…
              </div>
            ) : allPlayers.length === 0 ? (
              <div style={{ color: T.textFaint, textAlign: "center", padding: 32, fontSize: 13 }}>
                Player stats will be available once matches have been played
              </div>
            ) : (
              <div>
                {/* Position filter */}
                <div style={{ display: "flex", gap: 8, marginBottom: 14, flexWrap: "wrap" }}>
                  {[["all","All"], ["fwd","Forwards"], ["mid","Midfielders"], ["def","Defenders"], ["gk","GK"]].map(([id, label]) => (
                    <button
                      key={id}
                      onClick={() => { setPositionFilter(id); setSelectedPlayer(null); }}
                      style={{
                        padding: "5px 12px", fontSize: 11, fontWeight: positionFilter === id ? 700 : 500,
                        color: positionFilter === id ? T.accent : T.textMuted,
                        background: positionFilter === id ? "rgba(245,158,11,0.1)" : T.card,
                        border: `1px solid ${positionFilter === id ? T.accent : T.border}`,
                        borderRadius: 20, cursor: "pointer", transition: "all 0.15s", fontFamily: "inherit",
                      }}
                    >
                      {label}
                    </button>
                  ))}
                </div>

                {/* Player search */}
                <div style={{ marginBottom: 20 }}>
                  <SearchableSelect
                    options={playerOptions}
                    value={selectedPlayer}
                    onChange={setSelectedPlayer}
                    placeholder={`Search players (${filteredPlayers.length} available)…`}
                  />
                </div>

                {/* Player card */}
                <SoccerPlayerCard
                  player={selectedPlayerObj}
                  allPlayers={filteredPlayers}
                />
              </div>
            )}
          </div>
        )}
      </div>

      <div style={{ textAlign: "center", padding: "12px 0", fontSize: 10, color: T.textFaint, fontStyle: "italic" }}>
        PastTheEyeTest · Data via bzzoiro
      </div>
    </div>
  );
}
