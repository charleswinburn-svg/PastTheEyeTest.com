import { useState, useEffect, useMemo } from "react";
import HitterCard from "./HitterCard.jsx";
import PitcherCard from "./PitcherCard.jsx";
import Summaries from "./Summaries.jsx";
import RaceToTwoStrikes from "./RaceToTwoStrikes.jsx";
import EVLAChart from "./EVLAChart.jsx";
import { fuzzyLookup, binColor, textOnBin, BIN_COLORS, pctToBin } from "./SharedComponents.jsx";
import { ThemeProvider, useTheme, ThemeToggle } from "./ThemeContext.jsx";

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
  { id: "hitter",     label: "Hitter Card" },
  { id: "pitcher",    label: "Pitcher Card" },
  { id: "summaries",  label: "Summaries" },
  { id: "hitter_lb",  label: "Hitter LB" },
  { id: "pitcher_lb", label: "Pitcher LB" },
  { id: "race2k",     label: "Race to 2K" },
  { id: "evla",       label: "EV/LA Fan" },
];

const SEASONS = ["2026", "2025", "2024", "2023"];

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
  const [tab, setTab] = useState("summaries");
  const [selectedHitter, setSelectedHitter] = useState(null);
  const [selectedPitcher, setSelectedPitcher] = useState(null);
  const [iswingData, setIswingData] = useState(null);

  useEffect(() => {
    fetch("/iswing.json").then(r => r.json()).then(setIswingData).catch(() => {});
  }, []);

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
    if (!iswingData) return base;
    const yr = String(season);
    return base.map(h => {
      const iswing = fuzzyLookup(iswingData, h.name);
      const val = iswing?.[yr];
      const pct = iswing?.[yr + "_pct"];
      if (val == null || pct == null) return h;
      return {
        ...h,
        categories: { "iSwing+": { display: String(val), pctile: pct }, ...h.categories },
      };
    });
  }, [hitters, iswingData, season]);
  const pitchersFull = useMemo(() => disambiguate(pitchers), [pitchers]);
  const hitterNames = useMemo(() => hittersFull.map(h => h.displayName).sort(), [hittersFull]);
  const pitcherNames = useMemo(() => pitchersFull.map(p => p.displayName).sort(), [pitchersFull]);

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

  const pipelineReady = data && !loading && !error;

  return (
    <div style={{ minHeight: "100vh", background: t.bg, transition: "background 0.3s" }}>
      {/* ── Header Bar ── */}
      <div style={{
        background: t.headerBg, borderBottom: `1px solid ${t.headerBorder}`,
        padding: "10px 20px",
        display: "flex", alignItems: "center", justifyContent: "space-between",
        flexWrap: "wrap", gap: 10, transition: "background 0.3s",
      }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <div style={{ fontSize: 16, fontWeight: 800, color: t.text, letterSpacing: "-0.03em" }}>
            <span style={{ color: t.accent }}>MLB</span> Player Cards
          </div>
          <div style={{ width: 1, height: 22, background: t.divider }} />
          <select
            value={season}
            onChange={e => setSeason(e.target.value)}
            style={{
              padding: "5px 10px", background: t.accent, color: "#fff",
              border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700,
              cursor: "pointer", outline: "none", fontFamily: "inherit",
            }}
          >
            {SEASONS.map(s => (
              <option key={s} value={s} style={{ background: t.inputBg, color: t.text }}>{s}</option>
            ))}
          </select>
          <div style={{ width: 1, height: 22, background: t.divider }} />
          <div style={{ display: "flex", gap: 2, flexWrap: "wrap" }}>
            {TABS.map(tb => (
              <button
                key={tb.id}
                onClick={() => setTab(tb.id)}
                style={{
                  padding: "5px 12px", fontSize: 11,
                  fontWeight: tab === tb.id ? 700 : 500,
                  background: tab === tb.id ? (t.id === "dark" ? "#333" : "#e0e0e0") : "transparent",
                  color: tab === tb.id ? t.text : t.textMuted,
                  border: "none", borderRadius: 6, cursor: "pointer",
                  transition: "all 0.15s", fontFamily: "inherit",
                }}
              >{tb.label}</button>
            ))}
          </div>
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          {(tab === "hitter" || tab === "pitcher") && (
            <select
              value={tab === "pitcher" ? selectedPitcher || "" : selectedHitter || ""}
              onChange={e => tab === "pitcher" ? setSelectedPitcher(e.target.value) : setSelectedHitter(e.target.value)}
              style={{
                padding: "5px 10px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
                borderRadius: 6, color: t.text, fontSize: 12, outline: "none",
                minWidth: 200, maxWidth: 280, fontFamily: "inherit",
              }}
            >
              {(tab === "pitcher" ? pitcherNames : hitterNames).map(n => (
                <option key={n} value={n}>{n}</option>
              ))}
            </select>
          )}
          <ThemeToggle />
          <div style={{ fontSize: 9, color: t.textFaint, letterSpacing: "0.04em" }}>
            {season} | {hitters.length} hitters | {pitchers.length} pitchers
          </div>
        </div>
      </div>

      {/* ── Content ── */}
      <div style={{
        padding: tab === "summaries" ? 0 : 24,
        maxWidth: tab.includes("lb") || tab === "race2k" ? 1200 : tab === "summaries" ? 1200 : tab === "evla" ? 780 : 640,
        margin: "0 auto",
      }}>
        {tab === "hitter" && (
          pipelineReady ? (
            <HitterCard
              player={curHitter}
              season={season}
              trends={trends?.hitter_trends}
              allHitters={hitters}
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
              allPitchers={pitchers}
            />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: 60, fontSize: 13 }}>
              {loading ? `Loading ${season} data...` : `No pipeline data for ${season}. Run: python3 baseball_pipeline.py ./public ${season}`}
            </div>
          )
        )}
        {tab === "summaries" && (
          <Summaries season={season} />
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
function Leaderboard({ players, metrics, type }) {
  const { theme: t } = useTheme();
  const [sortCol, setSortCol] = useState(null);
  const [sortDir, setSortDir] = useState("desc");
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
