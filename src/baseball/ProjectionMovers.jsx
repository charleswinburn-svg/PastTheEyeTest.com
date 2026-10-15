import { useState, useEffect, useMemo } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { deltaSpread, projDelta, binColor, textOnBin, NUM_FONT, BIN_COLORS, hexLuminance } from "./SharedComponents.jsx";

// LEADERBOARD → "{year} Movers": biggest projected risers and fallers vs last season.
// Reads the projection files directly (baseball_data_{proj}.json + hitter_xrv_{proj}.json),
// so it works whatever season is picked in the menu. A "riser" is a player projected to
// get BETTER at the stat (lower ERA-type stats going down count as rising); the delta
// itself is colored like the card: red = number goes up, blue = number goes down.

const GRADE_LABELS = { stuff_plus: "Stuff+", loc_plus: "Location+", tun_plus: "Tunnel+", pitch_plus: "Pitch+" };
const XRV_LABELS = ["xRV/600", "Contact Quality", "Whiff", "Decision", "Chase"];
const MIN_REG = { hitters: { field: "pa", n: 300, unit: "PA" }, pitchers: { field: "ip", n: 50, unit: "IP" } };

const num = (s) => {
  const v = parseFloat(String(s ?? "").replace("−", "-").replace(/[^0-9.+-]/g, ""));
  return isFinite(v) ? v : null;
};
const fmtDelta = (d, dec) => {
  let txt = Math.abs(d).toFixed(dec);
  if (dec === 3 && txt.startsWith("0.")) txt = txt.slice(1);
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${txt}`;
};

const _cache = new Map();
function loadJson(path) {
  if (!_cache.has(path)) {
    _cache.set(path, fetch(path).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return _cache.get(path);
}

export default function ProjectionMovers({ projSeason }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(undefined);     // undefined = loading, null = missing
  const [xrv, setXrv] = useState(null);
  const [side, setSide] = useState("hitters");
  const [stat, setStat] = useState(null);
  const [regulars, setRegulars] = useState(true);
  const year = String(projSeason).slice(0, 4);
  const lastYear = Number(year) - 1;

  useEffect(() => {
    let alive = true;
    loadJson(`/baseball_data_${projSeason}.json`).then(d => { if (alive) setData(d || null); });
    loadJson(`/hitter_xrv_${projSeason}.json`).then(d => { if (alive) setXrv(d || null); });
    return () => { alive = false; };
  }, [projSeason]);

  // Every stat this side can be ranked on: card stats, plus grades (pitchers) / xRV (hitters).
  const stats = useMemo(() => {
    if (!data) return [];
    const metrics = side === "hitters" ? data.hitter_metrics : data.pitcher_metrics;
    const out = (metrics || []).map(m => ({ key: `cat:${m.label}`, label: m.label, lowerBetter: !!m.lower_better }));
    if (side === "pitchers") {
      for (const [k, l] of Object.entries(GRADE_LABELS)) out.unshift({ key: `grade:${k}`, label: l, lowerBetter: false });
    } else if (xrv) {
      for (const l of [...XRV_LABELS].reverse()) out.unshift({ key: `xrv:${l}`, label: l, lowerBetter: false });
    }
    return out;
  }, [data, xrv, side]);

  const active = stats.find(s => s.key === stat) || stats[0];

  // One row per player that has both a projection and last season's value for this stat.
  const rows = useMemo(() => {
    if (!data || !active) return [];
    const players = (side === "hitters" ? data.hitters : data.pitchers) || [];
    const [kind, name] = [active.key.split(":")[0], active.key.slice(active.key.indexOf(":") + 1)];
    const reg = MIN_REG[side];
    const all = [];
    for (const p of players) {
      let cat = null;
      if (kind === "cat") cat = p.categories?.[name];
      else if (kind === "grade") {
        const g = p.grades?.[name];
        if (g?.value != null && g?.last != null) {
          cat = { display: Number(g.value).toFixed(1), last: { display: Number(g.last).toFixed(1) }, pctile: g.percentile };
        }
      } else if (kind === "xrv") cat = xrv?.[String(p.player_id)]?.metrics?.[name];
      if (!cat?.last || num(cat.display) == null || num(cat.last.display) == null) continue;
      const dec = (String(cat.display).split(".")[1] || "").length;
      const d = +(num(cat.display) - num(cat.last.display)).toFixed(dec);
      all.push({ p, cat, d, dec, better: active.lowerBetter ? -d : d, sample: p[reg.field] });
    }
    const spread = deltaSpread(all.map(r => r.cat));
    for (const r of all) r.color = projDelta(r.cat, spread)?.color || null;
    return all;
  }, [data, xrv, active, side]);

  const shown = useMemo(() => {
    const reg = MIN_REG[side];
    return regulars ? rows.filter(r => (r.sample ?? 0) >= reg.n) : rows;
  }, [rows, regulars, side]);
  const risers = useMemo(() => [...shown].sort((a, b) => b.better - a.better).slice(0, 25), [shown]);
  const fallers = useMemo(() => [...shown].sort((a, b) => a.better - b.better).slice(0, 25), [shown]);

  const msg = (text) => <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>{text}</div>;
  if (data === undefined) return msg(`Loading ${year} projections…`);
  if (data === null) return msg(`No ${year} projections found (baseball_data_${projSeason}.json).`);

  const pill = (on, label, onClick) => (
    <button type="button" onClick={onClick} aria-pressed={on} style={{
      padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 14, cursor: "pointer", fontFamily: "inherit",
      background: on ? `${t.accent}26` : t.inputBg, color: on ? t.text : t.textMuted,
      border: `1px solid ${on ? t.accent : t.inputBorder}`,
    }}>{label}</button>
  );
  const reg = MIN_REG[side];

  return (
    <div style={{ padding: "16px 20px", maxWidth: 1180, margin: "0 auto", width: "100%", boxSizing: "border-box" }}>
      <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap", marginBottom: 14 }}>
        {pill(side === "hitters", "Hitters", () => { setSide("hitters"); setStat(null); })}
        {pill(side === "pitchers", "Pitchers", () => { setSide("pitchers"); setStat(null); })}
        <select value={active?.key || ""} onChange={e => setStat(e.target.value)} style={{
          padding: "6px 10px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`,
          borderRadius: 6, fontSize: 12, fontFamily: "inherit",
        }}>
          {stats.map(s => <option key={s.key} value={s.key}>{s.label}</option>)}
        </select>
        {pill(regulars, `${reg.n}+ ${reg.unit} in ${lastYear}`, () => setRegulars(v => !v))}
        <span style={{ fontSize: 11, color: t.textFaint }}>
          {shown.length} {side} · {year} projection vs {lastYear}
          {active?.lowerBetter ? " · lower is better, so a drop counts as rising" : ""}
        </span>
      </div>

      {!shown.length ? msg("No players with both a projection and a last-season value for this stat.") : (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <MoverTable title={`Biggest risers — ${active.label}`} rows={risers} lastYear={lastYear} year={year} reg={reg} />
          <MoverTable title={`Biggest fallers — ${active.label}`} rows={fallers} lastYear={lastYear} year={year} reg={reg} />
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 10, color: t.textFaint, textAlign: "center", lineHeight: 1.5 }}>
        Change = {year} projection − {lastYear} actual. Red = the number goes up, blue = it goes down, shaded by how big
        the change is compared with everyone else's. Percentile = the {year} projection's rank against {lastYear} players.
      </div>
    </div>
  );
}

function MoverTable({ title, rows, lastYear, year, reg }) {
  const { theme: t } = useTheme();
  // the deepest blue bin is unreadable as text on a dark card — lift it there (same as the cards)
  const deltaColor = (c) => (!c ? t.textFaint
    : c === BIN_COLORS["0-10"] && hexLuminance(t.cardBg || t.bg) < 0.4 ? "#4F8FD6" : c);
  const th = { padding: "6px 8px", fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase",
               letterSpacing: "0.06em", borderBottom: `1px solid ${t.tableHeaderBorder}`, textAlign: "right", whiteSpace: "nowrap" };
  const td = { padding: "5px 8px", fontSize: 12, color: t.textSecondary, textAlign: "right", fontFamily: NUM_FONT, whiteSpace: "nowrap" };
  return (
    <div style={{ flex: "1 1 420px", minWidth: 0, background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px 6px", fontSize: 12, fontWeight: 800, color: t.text }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: t.tableHeaderBg }}>
            <tr>
              <th style={{ ...th, textAlign: "center" }}>#</th>
              <th style={{ ...th, textAlign: "left" }}>Player</th>
              <th style={th}>Age</th>
              <th style={th}>{lastYear}</th>
              <th style={th}>{year}P</th>
              <th style={th}>Change</th>
              <th style={th}>Pctile</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.p.player_id} style={{ background: i % 2 ? t.tableRowB : t.tableRowA }}>
                <td style={{ ...td, textAlign: "center", color: t.textFaint }}>{i + 1}</td>
                <td style={{ ...td, textAlign: "left", fontFamily: "inherit", color: t.text, maxWidth: 190, overflow: "hidden", textOverflow: "ellipsis" }}
                  title={`${r.p.name}${r.sample != null ? ` · ${r.sample} ${reg.unit} in ${lastYear}` : ""}`}>
                  {r.p.name}{r.p.team ? <span style={{ color: t.textFaint, fontSize: 10 }}> {r.p.team}</span> : null}
                </td>
                <td style={td}>{r.p.proj?.age ?? "—"}</td>
                <td style={td}>{r.cat.last.display}</td>
                <td style={{ ...td, color: t.text, fontWeight: 700 }}>{r.cat.display}</td>
                <td style={{ ...td, fontStyle: "italic", fontWeight: 700, color: deltaColor(r.color) }}>{fmtDelta(r.d, r.dec)}</td>
                <td style={td}>
                  {r.cat.pctile != null ? (
                    <span style={{ display: "inline-block", minWidth: 28, padding: "0 6px", borderRadius: 10, fontSize: 11,
                      background: binColor(r.cat.pctile), color: textOnBin(r.cat.pctile), textAlign: "center" }}>
                      {Math.round(r.cat.pctile)}
                    </span>
                  ) : "—"}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
