import { useState, useEffect, useMemo } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { deltaSpread, projDelta, binColor, textOnBin, NUM_FONT, BIN_COLORS, hexLuminance } from "./SharedComponents.jsx";

// LEADERBOARD → "{year} Movers": who the projection moves, and why.
// Every projected value is split by the build scripts into three parts ("parts"):
//   history — league average + the regressed blend of the player's own seasons
//   age     — the fitted aging adjustment
//   model   — what iSwing+ / Stuff+ (and xRV reconciliation) add on top
// Ranking by the raw change vs last season mostly re-ranks last season's extremes
// (regression to the mean), so the default ranks by age + model: what the projection
// says BEYOND the player's own stat line. A "riser" gets better at the stat (for
// lower-is-better stats a drop counts). Change colors match the cards: red = up, blue = down.
// Reads the projection files directly, so it works whatever season is picked in the menu.

const GRADE_LABELS = { stuff_plus: "Stuff+", loc_plus: "Location+", tun_plus: "Tunnel+", pitch_plus: "Pitch+" };
const XRV_LABELS = ["xRV/600", "Contact Quality", "Whiff", "Decision", "Chase"];
const RANKS = [
  { id: "signal", label: "Age + model (beyond his stats)" },
  { id: "model",  label: "Model only (iSwing+ / Stuff+)" },
  { id: "age",    label: "Aging only" },
  { id: "change", label: "Raw change vs last season" },
];
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

// Same style as the card's own display (".349" for pitchers, "0.423" for hitters).
const fmtVal = (v, dec, like) => {
  const s = v.toFixed(dec);
  return String(like).startsWith(".") ? s.replace(/^(-?)0\./, "$1.") : s;
};

// One player's projected entry for a stat key ("cat:K%", "grade:stuff_plus", "xrv:Whiff").
function catFor(p, key, xrv) {
  const kind = key.split(":")[0], name = key.slice(key.indexOf(":") + 1);
  if (kind === "cat") return p.categories?.[name] || null;
  if (kind === "xrv") return xrv?.[String(p.player_id)]?.metrics?.[name] || null;
  const g = p.grades?.[name];
  if (g?.value == null || g?.last == null) return null;
  return { display: Number(g.value).toFixed(1), value: g.value, last: { display: Number(g.last).toFixed(1) },
           pctile: g.percentile, parts: g.parts };
}

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
  const [rank, setRank] = useState("signal");
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
    // A stat only has a model part where the backtest kept an iSwing+ / Stuff+ layer.
    const players = (side === "hitters" ? data.hitters : data.pitchers) || [];
    for (const st of out) {
      st.hasModel = players.some(pl => Math.abs(catFor(pl, st.key, xrv)?.parts?.model ?? 0) > 1e-6);
    }
    return out;
  }, [data, xrv, side]);

  const active = stats.find(s => s.key === stat) || stats[0];

  // One row per player that has both a projection and last season's value for this stat.
  const rows = useMemo(() => {
    if (!data || !active) return [];
    const players = (side === "hitters" ? data.hitters : data.pitchers) || [];
    const reg = MIN_REG[side];
    const all = [];
    for (const p of players) {
      const cat = catFor(p, active.key, xrv);
      if (!cat?.last || num(cat.display) == null || num(cat.last.display) == null) continue;
      const dec = (String(cat.display).split(".")[1] || "").length;
      const d = +(num(cat.display) - num(cat.last.display)).toFixed(dec);
      // parts are stored in the stat's raw units; the display may be ×100 (K% etc.)
      const raw = Number(cat.value);
      const scale = raw && Math.abs(num(cat.display) / raw) > 50 ? 100 : 1;
      const pt = cat.parts ? {
        history: cat.parts.history * scale, age: cat.parts.age * scale, model: cat.parts.model * scale,
      } : null;
      const score = rank === "change" ? d
        : !pt ? null
        : rank === "model" ? pt.model : rank === "age" ? pt.age : pt.age + pt.model;
      if (score == null) continue;
      const sign = active.lowerBetter ? -1 : 1;
      all.push({ p, cat, d, dec, pt, score, better: sign * score, dBetter: sign * d, sample: p[reg.field] });
    }
    const spread = deltaSpread(all.map(r => r.cat));
    for (const r of all) r.color = projDelta(r.cat, spread)?.color || null;
    // spreads for coloring the age / model columns the same way
    const rms = (xs) => { const v = xs.filter(x => x != null); return v.length ? Math.sqrt(v.reduce((a, x) => a + x * x, 0) / v.length) : null; };
    const sAge = rms(all.map(r => r.pt?.age)), sModel = rms(all.map(r => r.pt?.model));
    const shade = (x, sp) => {
      if (x == null || !sp) return null;
      const pc = Math.max(0, Math.min(100, 50 + 20 * x / sp));
      return pc >= 45 && pc < 55 ? null : binColor(pc);
    };
    for (const r of all) { r.ageColor = shade(r.pt?.age, sAge); r.modelColor = shade(r.pt?.model, sModel); }
    return all;
  }, [data, xrv, active, side, rank]);

  const shown = useMemo(() => {
    const reg = MIN_REG[side];
    return regulars ? rows.filter(r => (r.sample ?? 0) >= reg.n) : rows;
  }, [rows, regulars, side]);
  const risers = useMemo(() => [...shown].sort((a, b) => (b.better - a.better) || (b.dBetter - a.dBetter)).slice(0, 25), [shown]);
  const fallers = useMemo(() => [...shown].sort((a, b) => (a.better - b.better) || (a.dBetter - b.dBetter)).slice(0, 25), [shown]);

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
          {stats.map(s => <option key={s.key} value={s.key}>{s.label}{s.hasModel ? "  ◆ model" : ""}</option>)}
        </select>
        <select value={rank} onChange={e => setRank(e.target.value)} title="What to rank by" style={{
          padding: "6px 10px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`,
          borderRadius: 6, fontSize: 12, fontFamily: "inherit",
        }}>
          {RANKS.map(r => <option key={r.id} value={r.id}>Rank by: {r.label}</option>)}
        </select>
        {pill(regulars, `${reg.n}+ ${reg.unit} in ${lastYear}`, () => setRegulars(v => !v))}
        <span style={{ fontSize: 11, color: t.textFaint }}>
          {shown.length} {side} · {year} projection vs {lastYear}
          {active?.lowerBetter ? " · lower is better, so a drop counts as rising" : ""}
        </span>
      </div>

      {rank === "model" && active && !active.hasModel ? msg(
        `${active.label} has no model layer, so its Model part is 0 for everyone` +
        (active.key === "grade:stuff_plus" || active.key.startsWith("grade:")
          ? " (the grades ARE the pitch model — nothing is layered on them)."
          : " (the backtest found iSwing+ / Stuff+ didn't improve it).") +
        ` Stats with a model layer: ${stats.filter(x => x.hasModel).map(x => x.label).join(", ") || "none"}.` +
        " Or rank by Age + model / Aging only."
      ) : !shown.length ? msg(rank === "change"
        ? "No players with both a projection and a last-season value for this stat."
        : "This stat has no projection breakdown — rebuild the projections with the latest scripts, or rank by raw change.") : (
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <MoverTable title={`Biggest risers — ${active.label}`} rows={risers} lastYear={lastYear} year={year} reg={reg} />
          <MoverTable title={`Biggest fallers — ${active.label}`} rows={fallers} lastYear={lastYear} year={year} reg={reg} />
        </div>
      )}
      <div style={{ marginTop: 10, fontSize: 10, color: t.textFaint, textAlign: "center", lineHeight: 1.5 }}>
        {year}P = History + Age + Model. History = league average plus the regressed blend of his own seasons (this is
        where most of the change vs {lastYear} comes from — regression to the mean). Age = the aging curve. Model = what
        iSwing+ / Stuff+ add. Red = pushes the number up, blue = down, shaded by size vs everyone else's.
        Percentile = the {year} projection's rank against {lastYear} players.
      </div>
    </div>
  );
}

function MoverTable({ title, rows, lastYear, year, reg }) {
  const { theme: t } = useTheme();
  // the deepest blue bin is unreadable as text on a dark card — lift it there (same as the cards)
  const deltaColor = (c) => (!c ? t.textFaint
    : c === BIN_COLORS["0-10"] && hexLuminance(t.cardBg || t.bg) < 0.4 ? "#4F8FD6" : c);
  const th = { padding: "6px 5px", fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase",
               letterSpacing: "0.06em", borderBottom: `1px solid ${t.tableHeaderBorder}`, textAlign: "right", whiteSpace: "nowrap" };
  const td = { padding: "5px 5px", fontSize: 12, color: t.textSecondary, textAlign: "right", fontFamily: NUM_FONT, whiteSpace: "nowrap" };
  return (
    <div style={{ flex: "1 1 560px", minWidth: 0, background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 10, overflow: "hidden" }}>
      <div style={{ padding: "10px 12px 6px", fontSize: 12, fontWeight: 800, color: t.text }}>{title}</div>
      <div style={{ overflowX: "auto" }}>
        <table style={{ width: "100%", borderCollapse: "collapse" }}>
          <thead style={{ background: t.tableHeaderBg }}>
            <tr>
              <th style={{ ...th, textAlign: "center" }}>#</th>
              <th style={{ ...th, textAlign: "left" }}>Player</th>
              <th style={th}>Age</th>
              <th style={th}>{lastYear}</th>
              <th style={th} title="League average + the regressed blend of his own seasons">History</th>
              <th style={th} title="Aging adjustment">Age</th>
              <th style={th} title="What iSwing+ / Stuff+ add">Model</th>
              <th style={th}>{year}P</th>
              <th style={th} title={`${year}P − ${lastYear}`}>Change</th>
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
                <td style={{ ...td, color: t.textMuted }}>{r.pt ? fmtVal(r.pt.history, r.dec, r.cat.display) : "—"}</td>
                <td style={{ ...td, fontStyle: "italic", color: deltaColor(r.ageColor) }}>{r.pt ? fmtDelta(r.pt.age, r.dec) : "—"}</td>
                <td style={{ ...td, fontStyle: "italic", color: deltaColor(r.modelColor) }}>{r.pt ? fmtDelta(r.pt.model, r.dec) : "—"}</td>
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
