import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
// binColor / textOnBin removed — Plus cells use plusCellStyle instead
import { PITCH_COLORS, PITCH_NAMES } from "./mlbApi.js";

// ═══════════════════════════════════════════════════════════════════════════
// PITCH MODELING LEADERBOARD
// One table per metric (Stuff+, Loc+, Tun+, Pitch+), columns = Overall +
// each common pitch type. Data lives on the pitch-plus-api server — endpoint
// is GET /leaderboard?season=<year> and returns:
//   {
//     season: 2026,
//     pitchers: [{
//       player_id, overall: { stuff, loc, tun, pitch, n },
//       by_pitch_type: { FF: { stuff, loc, tun, pitch, n }, SL: {...}, ... }
//     }, ...]
//   }
// Names + teams come from baseball_data_<year>.json via the `pitchers` prop.
// ═══════════════════════════════════════════════════════════════════════════

const PITCH_PLUS_API = "https://pitch-plus-api.onrender.com";

const METRICS = [
  { id: "stuff", label: "Stuff+", key: "stuff" },
  { id: "loc",   label: "Loc+",   key: "loc"   },
  { id: "tun",   label: "Tun+",   key: "tun"   },
  { id: "pitch", label: "Pitch+", key: "pitch" },
];

// Display order for pitch-type columns. Anything outside this list is dropped
// from the table to keep it scannable.
const PITCH_COLS = ["FF", "SI", "FC", "SL", "ST", "SV", "CU", "KC", "CH", "FS"];

// Plus-scale cell color: dark green ≥120, dark red ≤80, 5 discrete shades each side.
const plusCellStyle = (v) => {
  if (v == null || !isFinite(v)) return {};
  const z = (v - 100) / 20;                          // ±1 at ±2σ (80–120)
  const t = Math.max(0, Math.min(1, Math.abs(z)));
  if (t < 0.05) return {};                            // neutral zone: ≈ ±1 pt
  const step = Math.min(4, Math.floor(t * 5));        // 5 shades per direction = 10 total
  const alphas = [0.22, 0.38, 0.54, 0.70, 0.86];
  const alpha = alphas[step];
  const isGreen = z > 0;
  const bg = isGreen ? `rgba(30,160,30,${alpha})` : `rgba(200,35,35,${alpha})`;
  const textLight = isGreen ? "rgb(140,235,160)" : "rgb(255,150,160)";
  return { background: bg, color: alpha > 0.55 ? "#ffffff" : textLight };
};

export default function PitchModelingLeaderboard({ season, pitchers }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [metric, setMetric] = useState("stuff");
  const [sortCol, setSortCol] = useState("Overall");
  const [sortDir, setSortDir] = useState("desc");
  const [search, setSearch] = useState("");

  useEffect(() => {
    let cancelled = false;
    setData(null); setErr(null);
    fetch(`${PITCH_PLUS_API}/leaderboard?season=${season}`)
      .then(r => {
        if (!r.ok) throw new Error(`/leaderboard ${r.status}`);
        return r.json();
      })
      .then(j => { if (!cancelled) setData(j); })
      .catch(e => { if (!cancelled) setErr(e.message || String(e)); });
    return () => { cancelled = true; };
  }, [season]);

  // Build a player_id → {name, team} lookup from the existing pitchers list.
  const idLookup = useMemo(() => {
    const m = new Map();
    for (const p of pitchers || []) {
      if (p.player_id != null) m.set(Number(p.player_id), { name: p.displayName || p.name, team: p.team });
    }
    return m;
  }, [pitchers]);

  // Rows for the current metric
  const rows = useMemo(() => {
    if (!data?.pitchers) return [];
    const out = [];
    for (const p of data.pitchers) {
      const info = idLookup.get(Number(p.player_id)) || { name: `#${p.player_id}`, team: "" };
      const overall = p.overall?.[metric] ?? null;
      const types = {};
      for (const pt of PITCH_COLS) {
        types[pt] = p.by_pitch_type?.[pt]?.[metric] ?? null;
      }
      if (overall == null && PITCH_COLS.every(pt => types[pt] == null)) continue;
      out.push({
        player_id: p.player_id,
        name: info.name,
        team: info.team || "—",
        n: p.overall?.n ?? null,
        overall,
        types,
      });
    }
    return out;
  }, [data, metric, idLookup]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    let arr = q
      ? rows.filter(r => (r.name || "").toLowerCase().includes(q) || (r.team || "").toLowerCase().includes(q))
      : rows.slice();
    const cmp = (a, b) => {
      let av, bv;
      if (sortCol === "name") { av = a.name; bv = b.name; }
      else if (sortCol === "team") { av = a.team; bv = b.team; }
      else if (sortCol === "n") { av = a.n; bv = b.n; }
      else if (sortCol === "Overall") { av = a.overall; bv = b.overall; }
      else { av = a.types[sortCol]; bv = b.types[sortCol]; }
      if (av == null) return 1;
      if (bv == null) return -1;
      if (typeof av === "string") return sortDir === "asc" ? av.localeCompare(bv) : bv.localeCompare(av);
      return sortDir === "asc" ? av - bv : bv - av;
    };
    arr.sort(cmp);
    return arr;
  }, [rows, sortCol, sortDir, search]);

  const toggle = (col) => {
    if (sortCol === col) setSortDir(d => d === "asc" ? "desc" : "asc");
    else { setSortCol(col); setSortDir("desc"); }
  };

  const thS = {
    padding: "8px 6px", textAlign: "center", cursor: "pointer", fontSize: 10,
    fontWeight: 700, color: t.textMuted, borderBottom: `2px solid ${t.tableHeaderBorder}`,
    whiteSpace: "nowrap", userSelect: "none", position: "sticky", top: 0,
    background: t.tableHeaderBg, zIndex: 2,
  };
  const tdS = {
    padding: "4px 5px", textAlign: "center", fontSize: 10,
    borderBottom: `1px solid ${t.tableBorder}`, whiteSpace: "nowrap",
  };

  const currentMetricLabel = METRICS.find(m => m.id === metric)?.label || metric;

  return (
    <div>
      {/* Metric sub-tabs */}
      <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 12, flexWrap: "wrap" }}>
        {METRICS.map(m => (
          <button
            key={m.id}
            onClick={() => setMetric(m.id)}
            style={{
              padding: "7px 16px", fontSize: 12, fontWeight: metric === m.id ? 700 : 600,
              letterSpacing: "0.04em",
              color: metric === m.id ? "#fff" : t.textSecondary,
              background: metric === m.id ? t.accent : t.inputBg,
              border: `1px solid ${metric === m.id ? t.accent : t.inputBorder}`,
              borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
            }}
          >
            {m.label}
          </button>
        ))}
      </div>

      <input
        type="text" value={search} onChange={e => setSearch(e.target.value)}
        placeholder="Search pitcher or team…"
        style={{
          width: "100%", maxWidth: 300, padding: "7px 12px",
          background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 6,
          color: t.text, fontSize: 12, marginBottom: 10, outline: "none",
          fontFamily: "inherit",
        }}
      />

      {err && (
        <div style={{ color: t.textMuted, padding: 24, textAlign: "center", fontSize: 12 }}>
          {err}. Deploy the /leaderboard endpoint on pitch-plus-api (see server.py snippet).
        </div>
      )}
      {!err && !data && (
        <div style={{ color: t.textMuted, padding: 24, textAlign: "center", fontSize: 12 }}>
          Loading {currentMetricLabel} leaderboard…
        </div>
      )}
      {!err && data && (
        <div style={{ overflowX: "auto", borderRadius: 8, border: `1px solid ${t.cardBorder}`, maxHeight: "72vh", overflowY: "auto" }}>
          <table style={{ width: "100%", borderCollapse: "collapse", background: t.tableRowA }}>
            <thead>
              <tr>
                <th onClick={() => toggle("name")} style={{ ...thS, textAlign: "left", paddingLeft: 10 }}>
                  Pitcher {sortCol === "name" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
                <th onClick={() => toggle("team")} style={thS}>Tm</th>
                <th onClick={() => toggle("n")}    style={thS}>N</th>
                <th onClick={() => toggle("Overall")} style={thS}>
                  Overall {sortCol === "Overall" ? (sortDir === "desc" ? "▾" : "▴") : ""}
                </th>
                {PITCH_COLS.map(pt => (
                  <th key={pt} onClick={() => toggle(pt)} style={{ ...thS, color: PITCH_COLORS[pt] || t.textMuted }}>
                    {pt} {sortCol === pt ? (sortDir === "desc" ? "▾" : "▴") : ""}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {filtered.map((r, i) => {
                const cell = (key, v) => {
                  if (v == null) return <td key={key} style={{ ...tdS, color: t.textFaintest }}>—</td>;
                  const cs = plusCellStyle(v);
                  return (
                    <td key={key} style={{ ...tdS, ...cs, fontWeight: 600 }}>
                      {Math.round(v)}
                    </td>
                  );
                };
                const nameCell = {
                  ...tdS, textAlign: "left", paddingLeft: 10, fontWeight: 600,
                  color: t.textSecondary, position: "sticky", left: 0,
                  background: i % 2 === 0 ? t.tableRowA : t.tableRowB, zIndex: 1,
                };
                return (
                  <tr key={r.player_id} style={{ background: i % 2 === 0 ? t.tableRowA : t.tableRowB }}>
                    <td style={nameCell}>{r.name}</td>
                    <td style={{ ...tdS, color: t.textMuted }}>{r.team}</td>
                    <td style={{ ...tdS, color: t.textMuted }}>{r.n ?? "—"}</td>
                    {cell("overall", r.overall)}
                    {PITCH_COLS.map(pt => cell(pt, r.types[pt]))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <div style={{ fontSize: 10, color: t.textFaint, marginTop: 6 }}>
        {filtered.length} pitchers · {currentMetricLabel} · 100 = MLB average · ±10 ≈ 1σ
      </div>
    </div>
  );
}
