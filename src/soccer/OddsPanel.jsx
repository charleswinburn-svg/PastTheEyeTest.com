import { useState, useEffect } from "react";
import { fetchOutrightOdds, fetchAllFixtures, fetchEventOdds, eventStart, eventTeam } from "./soccerApi.js";

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

function Flag({ code, size = 18 }) {
  if (!code) return null;
  return (
    <img
      src={`/flag-assets/w80/${code.toLowerCase()}.png`}
      alt={code}
      style={{ width: size, height: Math.round(size * 0.66), objectFit: "contain", flexShrink: 0 }}
      onError={e => { e.target.style.display = "none"; }}
    />
  );
}

function toAmerican(decimal) {
  if (!decimal || decimal <= 1) return "—";
  if (decimal >= 2) return `+${Math.round((decimal - 1) * 100)}`;
  return `${Math.round(-100 / (decimal - 1))}`;
}

function impliedProb(decimal) {
  if (!decimal || decimal <= 1) return null;
  return ((1 / decimal) * 100).toFixed(0) + "%";
}

function OddsChip({ decimal, label }) {
  const american = toAmerican(decimal);
  const prob = impliedProb(decimal);
  return (
    <div style={{
      display: "flex", flexDirection: "column", alignItems: "center",
      background: T.divider, borderRadius: 8, padding: "8px 12px", minWidth: 72,
    }}>
      <span style={{ fontSize: 10, color: T.textFaint, marginBottom: 2, textTransform: "uppercase", letterSpacing: "0.06em" }}>{label}</span>
      <span style={{ fontSize: 15, fontWeight: 800, color: T.text, fontFamily: "'DM Mono', monospace" }}>{american}</span>
      {prob && <span style={{ fontSize: 10, color: T.textMuted, marginTop: 1 }}>{prob}</span>}
    </div>
  );
}

function MatchOddsRow({ match }) {
  const [odds, setOdds] = useState(null);

  useEffect(() => {
    fetchEventOdds(match.id)
      .then(d => setOdds(d))
      .catch(() => {});
  }, [match.id]);

  const home = eventTeam(match, "home");
  const away = eventTeam(match, "away");
  // Match-level odds may already be embedded on the event (odds_home/draw/away)
  const o = odds?.odds ?? odds ?? {};
  const homeOdds = o.home_win ?? o["1"] ?? o.home ?? match.odds_home;
  const drawOdds = o.draw ?? o["X"] ?? match.odds_draw;
  const awayOdds = o.away_win ?? o["2"] ?? o.away ?? match.odds_away;

  return (
    <div style={{
      background: T.card, border: `1px solid ${T.border}`,
      borderRadius: 10, padding: "12px 16px", marginBottom: 8,
    }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <Flag code={home.country_code ?? home.alpha2} />
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{home.name ?? home.shortName ?? ""}</span>
        </div>
        <span style={{ fontSize: 11, color: T.textFaint, fontWeight: 600 }}>vs</span>
        <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
          <span style={{ fontSize: 13, fontWeight: 600, color: T.text }}>{away.name ?? away.shortName ?? ""}</span>
          <Flag code={away.country_code ?? away.alpha2} />
        </div>
      </div>

      {(homeOdds ?? drawOdds ?? awayOdds) != null ? (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
          <OddsChip decimal={homeOdds} label={home.shortName ?? "Home"} />
          {drawOdds != null && <OddsChip decimal={drawOdds} label="Draw" />}
          <OddsChip decimal={awayOdds} label={away.shortName ?? "Away"} />
        </div>
      ) : (
        <div style={{ fontSize: 11, color: T.textFaint }}>
          {odds === null ? "Loading odds…" : "No odds yet for this match"}
        </div>
      )}
    </div>
  );
}

function OutrightOdds({ outrights }) {
  const teams = Array.isArray(outrights)
    ? outrights
    : (outrights.outcomes ?? outrights.selections ?? outrights.teams ?? []);

  const sorted = [...teams].sort((a, b) => {
    const da = a.odds ?? a.decimal ?? Infinity;
    const db = b.odds ?? b.decimal ?? Infinity;
    return da - db;
  });

  return (
    <div>
      <div style={{ fontSize: 11, fontWeight: 700, color: T.accent, letterSpacing: "0.08em", marginBottom: 10, textTransform: "uppercase" }}>
        Tournament Winner Odds
      </div>
      {sorted.map((t, i) => {
        const name = t.name ?? t.team?.name ?? t.team_name ?? "";
        const cc = t.country_code ?? t.alpha2 ?? t.team?.country_code ?? "";
        const decimal = t.odds ?? t.decimal ?? t.price ?? null;
        const american = toAmerican(decimal);
        const prob = impliedProb(decimal);
        const pct = decimal ? (1 / decimal) : 0;
        const maxPct = sorted[0] ? 1 / (sorted[0].odds ?? sorted[0].decimal ?? 1) : 1;
        const barWidth = maxPct > 0 ? Math.round((pct / maxPct) * 100) : 0;

        return (
          <div key={i} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "6px 0", borderBottom: i < sorted.length - 1 ? `1px solid ${T.divider}` : "none",
          }}>
            <span style={{ width: 20, fontSize: 11, color: T.textFaint, fontFamily: "'DM Mono', monospace", flexShrink: 0, textAlign: "right" }}>
              {i + 1}
            </span>
            <Flag code={cc} />
            <span style={{ width: 140, fontSize: 12, color: T.text, fontWeight: 500, flexShrink: 0 }}>{name}</span>
            <div style={{ flex: 1, position: "relative", height: 18, display: "flex", alignItems: "center" }}>
              <div style={{
                position: "absolute", left: 0, right: 0, height: 8,
                background: T.divider, borderRadius: 4,
              }} />
              <div style={{
                position: "absolute", left: 0, width: `${barWidth}%`, height: 8,
                background: `linear-gradient(90deg, #1d4ed8, ${T.accent})`,
                borderRadius: 4, transition: "width 0.5s ease",
              }} />
            </div>
            <span style={{ width: 50, fontSize: 13, fontWeight: 800, color: T.text, fontFamily: "'DM Mono', monospace", textAlign: "right", flexShrink: 0 }}>
              {american}
            </span>
            <span style={{ width: 36, fontSize: 11, color: T.textFaint, fontFamily: "'DM Mono', monospace", textAlign: "right", flexShrink: 0 }}>
              {prob}
            </span>
          </div>
        );
      })}
    </div>
  );
}

export default function OddsPanel({ leagueId }) {
  const [outrights, setOutrights] = useState(null);
  const [upcomingMatches, setUpcomingMatches] = useState([]);
  const [activeTab, setActiveTab] = useState("outright");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!leagueId) return;
    Promise.all([
      fetchOutrightOdds(leagueId).catch(() => null),
      fetchAllFixtures(leagueId).catch(() => []),
    ]).then(([oRaw, list]) => {
      setOutrights(oRaw);
      // Next 8 matches that haven't finished, soonest first
      const upcoming = list
        .filter(m => !/ft|finished|ended|after/i.test(m.status ?? m.state ?? ""))
        .sort((a, b) => new Date(eventStart(a) ?? 0) - new Date(eventStart(b) ?? 0))
        .slice(0, 8);
      setUpcomingMatches(upcoming);
    }).finally(() => setLoading(false));
  }, [leagueId]);

  const tabStyle = (id) => ({
    padding: "8px 16px", fontSize: 12, fontWeight: activeTab === id ? 700 : 500,
    color: activeTab === id ? T.accent : T.textMuted,
    background: "transparent", border: "none",
    borderBottom: `2px solid ${activeTab === id ? T.accent : "transparent"}`,
    cursor: "pointer", fontFamily: "inherit", transition: "all 0.15s",
  });

  if (!leagueId) return (
    <div style={{ color: T.textFaint, padding: 32, textAlign: "center", fontSize: 13 }}>
      League not identified yet
    </div>
  );

  if (loading) return (
    <div style={{ color: T.textFaint, padding: 32, textAlign: "center" }}>
      <style>{`@keyframes spin2{to{transform:rotate(360deg)}}`}</style>
      <div style={{ width: 24, height: 24, border: "2px solid #1e3a5f", borderTopColor: T.accent, borderRadius: "50%", animation: "spin2 0.8s linear infinite", margin: "0 auto 12px" }} />
      Loading odds…
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", borderBottom: `1px solid ${T.border}`, marginBottom: 16 }}>
        <button style={tabStyle("outright")} onClick={() => setActiveTab("outright")}>Tournament Winner</button>
        <button style={tabStyle("matches")} onClick={() => setActiveTab("matches")}>Match Odds</button>
      </div>

      {activeTab === "outright" && (
        outrights ? (
          <div style={{ background: T.card, border: `1px solid ${T.border}`, borderRadius: 10, padding: "12px 16px" }}>
            <OutrightOdds outrights={outrights} />
          </div>
        ) : (
          <div style={{ color: T.textFaint, textAlign: "center", padding: 32, fontSize: 13 }}>
            Outright odds not available yet
          </div>
        )
      )}

      {activeTab === "matches" && (
        upcomingMatches.length === 0 ? (
          <div style={{ color: T.textFaint, textAlign: "center", padding: 32, fontSize: 13 }}>
            No upcoming match odds available
          </div>
        ) : (
          upcomingMatches.map(m => <MatchOddsRow key={m.id} match={m} />)
        )
      )}

      <div style={{ marginTop: 12, fontSize: 10, color: T.textFaint, textAlign: "right", fontStyle: "italic" }}>
        Odds via bzzoiro · 14 bookmakers
      </div>
    </div>
  );
}
