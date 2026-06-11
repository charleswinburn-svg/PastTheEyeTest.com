import { useState, useEffect, useCallback } from "react";
import { fetchLiveAndToday, fetchEventDetail, fetchStandings } from "./soccerApi.js";

const T = {
  bg: "#0a0f1a",
  card: "#0f172a",
  border: "#1e3a5f",
  text: "#f8fafc",
  textMuted: "#94a3b8",
  textFaint: "#475569",
  accent: "#f59e0b",
  green: "#22c55e",
  red: "#ef4444",
  divider: "#1e293b",
};

function statusColor(status) {
  if (!status) return T.textFaint;
  const s = status.toLowerCase();
  if (s.includes("live") || s === "inprogress" || s === "1h" || s === "2h" || s === "ht") return T.green;
  if (s === "ft" || s.includes("finished")) return T.textFaint;
  if (s.includes("postponed") || s.includes("cancelled")) return T.red;
  return T.textMuted;
}

function statusLabel(status, minute) {
  if (!status) return "";
  const s = status.toLowerCase();
  if (s === "ht") return "HT";
  if (s === "ft" || s.includes("finished")) return "FT";
  if (s === "1h" || s === "2h" || s === "inprogress" || s.includes("live")) {
    return minute ? `${minute}'` : "LIVE";
  }
  if (s === "ns" || s.includes("not started")) return "Upcoming";
  return status.toUpperCase();
}

function Flag({ code, size = 20 }) {
  if (!code) return <span style={{ width: size, height: size, display: "inline-block" }} />;
  return (
    <img
      src={`/flag-assets/w80/${code.toLowerCase()}.png`}
      alt={code}
      style={{ width: size, height: Math.round(size * 0.66), objectFit: "contain", flexShrink: 0 }}
      onError={e => { e.target.style.display = "none"; }}
    />
  );
}

function MatchCard({ match, onSelect, selected }) {
  const home = match.home_team ?? match.homeTeam ?? {};
  const away = match.away_team ?? match.awayTeam ?? {};
  const score = match.score ?? match.result ?? {};
  const homeGoals = score.home ?? score.home_score ?? match.home_score ?? "—";
  const awayGoals = score.away ?? score.away_score ?? match.away_score ?? "—";
  const status = match.status ?? match.state ?? "";
  const minute = match.minute ?? match.elapsed ?? null;
  const isLive = /live|inprogress|1h|2h/i.test(status);
  const isFinished = /ft|finished/i.test(status);

  return (
    <div
      onClick={() => onSelect(match.id)}
      style={{
        background: selected ? "rgba(245,158,11,0.08)" : T.card,
        border: `1px solid ${selected ? T.accent : T.border}`,
        borderRadius: 10,
        padding: "12px 16px",
        cursor: "pointer",
        transition: "all 0.15s",
        marginBottom: 8,
      }}
    >
      {/* Status row */}
      <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8, alignItems: "center" }}>
        <span style={{ fontSize: 10, fontWeight: 700, color: statusColor(status), letterSpacing: "0.06em", textTransform: "uppercase" }}>
          {statusLabel(status, minute)}
          {isLive && (
            <span style={{ display: "inline-block", width: 6, height: 6, borderRadius: "50%", background: T.green, marginLeft: 5, verticalAlign: "middle", animation: "pulse 1.2s infinite" }} />
          )}
        </span>
        <span style={{ fontSize: 10, color: T.textFaint }}>
          {match.group ?? match.stage ?? ""}
        </span>
      </div>

      {/* Teams + score */}
      <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
        {/* Home */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8, justifyContent: "flex-end" }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text, textAlign: "right" }}>
            {home.name ?? home.shortName ?? ""}
          </span>
          <Flag code={home.country_code ?? home.alpha2 ?? home.flag} />
        </div>

        {/* Score */}
        <div style={{
          display: "flex", alignItems: "center", gap: 4,
          background: T.divider, borderRadius: 6, padding: "4px 10px",
          minWidth: 56, justifyContent: "center",
        }}>
          <span style={{ fontSize: 16, fontWeight: 800, color: isLive ? T.green : T.text, fontFamily: "'DM Mono', monospace" }}>
            {isFinished || isLive ? homeGoals : "vs"}
          </span>
          {(isFinished || isLive) && (
            <>
              <span style={{ fontSize: 12, color: T.textFaint, margin: "0 1px" }}>–</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: isLive ? T.green : T.text, fontFamily: "'DM Mono', monospace" }}>
                {awayGoals}
              </span>
            </>
          )}
        </div>

        {/* Away */}
        <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 8 }}>
          <Flag code={away.country_code ?? away.alpha2 ?? away.flag} />
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>
            {away.name ?? away.shortName ?? ""}
          </span>
        </div>
      </div>

      {/* Kick-off time if upcoming */}
      {!isFinished && !isLive && match.start_time && (
        <div style={{ textAlign: "center", marginTop: 6, fontSize: 11, color: T.textFaint }}>
          {new Date(match.start_time).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
      )}
    </div>
  );
}

function MatchDetail({ matchId }) {
  const [detail, setDetail] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!matchId) return;
    setLoading(true);
    fetchEventDetail(matchId)
      .then(d => setDetail(d))
      .catch(() => setDetail(null))
      .finally(() => setLoading(false));
  }, [matchId]);

  if (loading) return <div style={{ color: T.textFaint, padding: 20, textAlign: "center" }}>Loading match data…</div>;
  if (!detail) return null;

  const incidents = detail.incidents ?? detail.events ?? [];

  return (
    <div style={{ marginTop: 12, background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.accent, letterSpacing: "0.08em", marginBottom: 10, textTransform: "uppercase" }}>
        Match Events
      </div>
      {incidents.length === 0 && (
        <div style={{ color: T.textFaint, fontSize: 12 }}>No events yet</div>
      )}
      {incidents.map((inc, i) => {
        const type = inc.type ?? inc.incident_type ?? "";
        const isGoal = /goal/i.test(type);
        const isCard = /card/i.test(type);
        const isSub = /sub/i.test(type);
        const icon = isGoal ? "⚽" : isCard ? (inc.card_type === "red" ? "🟥" : "🟨") : isSub ? "🔄" : "•";
        const playerName = inc.player ?? inc.player_name ?? inc.player_in ?? "";
        const side = inc.is_home ? "home" : "away";

        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 8, padding: "4px 0",
            borderBottom: i < incidents.length - 1 ? `1px solid ${T.divider}` : "none",
          }}>
            <span style={{ width: 30, fontSize: 10, color: T.textFaint, fontFamily: "'DM Mono', monospace", flexShrink: 0 }}>
              {inc.minute ?? inc.time ?? ""}'
            </span>
            <span style={{ fontSize: 14 }}>{icon}</span>
            <span style={{ fontSize: 12, color: side === "home" ? "#93c5fd" : "#fca5a5", fontWeight: 500 }}>
              {playerName}
            </span>
            {isSub && inc.player_out && (
              <span style={{ fontSize: 11, color: T.textFaint }}>← {inc.player_out}</span>
            )}
          </div>
        );
      })}
    </div>
  );
}

function GroupTable({ standing }) {
  const rows = standing.table ?? standing.rows ?? standing.entries ?? [];
  const groupName = standing.group ?? standing.name ?? "";

  return (
    <div style={{ marginBottom: 16 }}>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.accent, letterSpacing: "0.08em", marginBottom: 6, textTransform: "uppercase" }}>
        {groupName}
      </div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr style={{ color: T.textFaint }}>
            {["#", "Team", "P", "W", "D", "L", "GD", "Pts"].map(h => (
              <th key={h} style={{ padding: "3px 6px", textAlign: h === "Team" ? "left" : "center", fontWeight: 600 }}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => {
            const team = row.team ?? {};
            const isQualified = row.position <= 2;
            return (
              <tr key={i} style={{
                borderTop: `1px solid ${T.divider}`,
                background: isQualified ? "rgba(34,197,94,0.05)" : "transparent",
              }}>
                <td style={{ padding: "4px 6px", color: isQualified ? T.green : T.textFaint, textAlign: "center", fontWeight: 700 }}>
                  {row.position ?? i + 1}
                </td>
                <td style={{ padding: "4px 6px" }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                    <Flag code={team.country_code ?? team.alpha2} size={16} />
                    <span style={{ color: T.text, fontWeight: 500 }}>
                      {team.shortName ?? team.name ?? row.team_name ?? ""}
                    </span>
                  </div>
                </td>
                {[row.played ?? row.gamesPlayed, row.won, row.drawn, row.lost,
                  (row.goals_for ?? 0) - (row.goals_against ?? 0),
                  row.points].map((v, j) => (
                  <td key={j} style={{
                    padding: "4px 6px", textAlign: "center",
                    color: j === 5 ? T.text : T.textMuted,
                    fontWeight: j === 5 ? 700 : 400,
                    fontFamily: "'DM Mono', monospace",
                  }}>
                    {v ?? 0}
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export default function Scoreboard({ leagueId }) {
  const [matches, setMatches] = useState([]);
  const [standings, setStandings] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activeTab, setActiveTab] = useState("matches");

  const load = useCallback(async () => {
    if (!leagueId) return;
    try {
      const [rawMatches, rawStandings] = await Promise.all([
        fetchLiveAndToday(leagueId).catch(() => []),
        fetchStandings(leagueId).catch(() => []),
      ]);
      const matchList = Array.isArray(rawMatches)
        ? rawMatches
        : (rawMatches.results ?? rawMatches.data ?? rawMatches.events ?? []);
      const standList = Array.isArray(rawStandings)
        ? rawStandings
        : (rawStandings.results ?? rawStandings.data ?? rawStandings.standings ?? []);
      setMatches(matchList);
      setStandings(standList);
    } catch (e) {
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [leagueId]);

  useEffect(() => {
    load();
    // Poll every 60s for live score updates
    const id = setInterval(load, 60_000);
    return () => clearInterval(id);
  }, [load]);

  const tabStyle = (id) => ({
    padding: "8px 16px", fontSize: 12, fontWeight: activeTab === id ? 700 : 500,
    color: activeTab === id ? T.accent : T.textMuted,
    background: "transparent", border: "none",
    borderBottom: `2px solid ${activeTab === id ? T.accent : "transparent"}`,
    cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
  });

  if (!leagueId) return (
    <div style={{ color: T.textFaint, padding: 32, textAlign: "center", fontSize: 13 }}>
      League not found yet — check back once the tournament begins or verify the league ID.
    </div>
  );

  if (loading) return (
    <div style={{ color: T.textFaint, padding: 32, textAlign: "center" }}>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 24, height: 24, border: "2px solid #1e3a5f", borderTopColor: T.accent, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 12px" }} />
      Loading…
    </div>
  );

  if (error) return (
    <div style={{ color: T.red, padding: 32, textAlign: "center", fontSize: 13 }}>
      {error}
    </div>
  );

  return (
    <div>
      <style>{`@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.4}}`}</style>

      {/* Tabs */}
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginBottom: 16 }}>
        <button style={tabStyle("matches")} onClick={() => setActiveTab("matches")}>Today's Matches</button>
        <button style={tabStyle("groups")} onClick={() => setActiveTab("groups")}>Group Standings</button>
      </div>

      {activeTab === "matches" && (
        <div>
          {matches.length === 0 ? (
            <div style={{ color: T.textFaint, textAlign: "center", padding: 32, fontSize: 13 }}>
              No matches today
            </div>
          ) : (
            matches.map(m => (
              <div key={m.id}>
                <MatchCard
                  match={m}
                  selected={selectedId === m.id}
                  onSelect={id => setSelectedId(id === selectedId ? null : id)}
                />
                {selectedId === m.id && <MatchDetail matchId={m.id} />}
              </div>
            ))
          )}
        </div>
      )}

      {activeTab === "groups" && (
        <div>
          {standings.length === 0 ? (
            <div style={{ color: T.textFaint, textAlign: "center", padding: 32, fontSize: 13 }}>
              Standings not yet available
            </div>
          ) : (
            standings.map((s, i) => <GroupTable key={i} standing={s} />)
          )}
        </div>
      )}
    </div>
  );
}
