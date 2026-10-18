import { useState, useEffect, useMemo, useRef } from "react";
import { useTheme } from "./ThemeContext.jsx";
import {
  PlayerHeader, SearchableSelect, useFallbackTeamId,
  saveCardAsPng, teamMarkColor, hexLuminance, mixHex, binColor, textOnBin,
  TEAM_IDS, MLB_TEAM_PRIMARY,
} from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";
import { fetchGameLog, fetchSavantGameData, scorePitchCode } from "./mlbApi.js";

// One-season Stuff+ waterfall per pitch type (SUMMARIES → Pitcher Stuff+), split by
// platoon: vs same-handed hitters | vs opposite-handed hitters, side by side.
// Reads /stuff_waterfall_{season}.json (build_stuff_waterfall.py): pitcherId ->
//   { name, throws, n, types: { FF: { stuff_plus, pct, n, base, c: { group: Stuff+ points },
//                                     same: { stuff_plus, pct, n, base, c }, oppo: {…} } } }
// `base` is the league-average pitch of that type (vs that side); the bars are the Stuff
// model's TreeSHAP contributions vs that average and sum exactly to stuff_plus − base.
// Game view: one game's Statcast pitches go to the API's /stuff_breakdown (same grades as
// /score_aggregate, no minimum pitch count) and are broken down against the season's
// league-average pitches (meta.league) the same way.

const PITCH_NAMES = {
  FF: "Four-Seamer", SI: "Sinker", FC: "Cutter", SL: "Slider", ST: "Sweeper", SV: "Slurve",
  CU: "Curveball", KC: "Knuckle Curve", CS: "Slow Curve", CH: "Changeup", FS: "Splitter",
  FO: "Forkball", SC: "Screwball", KN: "Knuckleball",
};
const pitchName = (pt) => PITCH_NAMES[pt] || pt;

// MLB team id → an abbreviation MLB_TEAM_PRIMARY knows (for the API fallback).
const ABBR_BY_TEAM_ID = Object.entries(TEAM_IDS).reduce((m, [abbr, id]) => {
  if (MLB_TEAM_PRIMARY[abbr] && !(id in m)) m[id] = abbr;
  return m;
}, {});

const _wfCache = new Map();
function loadWaterfall(season) {
  if (!_wfCache.has(season)) {
    _wfCache.set(season, fetch(`/stuff_waterfall_${season}.json`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return _wfCache.get(season);
}

// Keep the team color readable on the card (same rule as the iSwing+ waterfall).
function readableOn(hex, isDark) {
  const lum = hexLuminance(hex);
  if (isDark && lum < 0.05) return mixHex(hex, "#ffffff", 0.35);
  if (!isDark && lum > 0.45) return mixHex(hex, "#000000", 0.35);
  return hex;
}

const FONT = "'Pliant', sans-serif";
// The name banner matches the hitter/pitcher cards (the site font); the rest is Pliant.
const BANNER_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";
const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

// html2canvas draws each inline <svg> as a standalone image, which can't see the page's
// web fonts, so the PNG's chart text fell back to a system font. For the capture only,
// embed Pliant's latin subset into the SVGs as a data-URI @font-face.
const PLIANT_CSS = "https://fonts.googleapis.com/css2?family=Pliant:wght@100..900&display=swap";
let _pliantFace = null;
function pliantFace() {
  if (!_pliantFace) {
    _pliantFace = (async () => {
      const css = await (await fetch(PLIANT_CSS)).text();
      const block = (css.match(/\/\* latin \*\/\s*(@font-face\s*{[^}]*})/) || [])[1];
      const url = block && (block.match(/url\(([^)]+)\)/) || [])[1];
      if (!url) return "";
      const blob = await (await fetch(url)).blob();
      const data = await new Promise((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(fr.result); fr.onerror = rej; fr.readAsDataURL(blob);
      });
      return block.replace(url, data);
    })().catch(() => { _pliantFace = null; return ""; });
  }
  return _pliantFace;
}
async function embedPliant(root) {
  const face = await pliantFace();
  if (!face) return () => {};
  const added = [...root.querySelectorAll("svg")].map(svg => {
    const st = document.createElementNS("http://www.w3.org/2000/svg", "style");
    st.textContent = face;
    svg.insertBefore(st, svg.firstChild);
    return st;
  });
  return () => added.forEach(n => n.remove());
}
const fmtPts = (v) => `${v >= 0 ? "+" : "−"}${Math.abs(v).toFixed(1)}`;
const SIDES = [
  { key: "same", title: "vs. Same-Handed Hitters", short: "same-handed" },
  { key: "oppo", title: "vs. Opposite-Handed Hitters", short: "opposite-handed" },
];
const handedness = (throws, side) => {
  if (throws !== "L" && throws !== "R") return "";
  const bat = side === "same" ? throws : (throws === "L" ? "R" : "L");
  return `${throws}HP vs ${bat}HH`;
};

// Trait bars in Stuff+ points that sum exactly to target − base (build_stuff_waterfall.bars).
function reconcile(pts, shift) {
  const keys = Object.keys(pts);
  const spread = keys.reduce((a, k) => a + Math.abs(pts[k]), 0);
  const sum = keys.reduce((a, k) => a + pts[k], 0);
  const out = {};
  for (const k of keys) {
    const v = spread > 1e-9 ? pts[k] + (shift - sum) * Math.abs(pts[k]) / spread : pts[k];
    out[k] = Math.round(v * 10) / 10;
  }
  const resid = Math.round((shift - Object.values(out).reduce((a, v) => a + v, 0)) * 10) / 10;
  if (resid && keys.length) {
    const big = keys.reduce((m, k) => (Math.abs(out[k]) > Math.abs(out[m]) ? k : m), keys[0]);
    out[big] = Math.round((out[big] + resid) * 10) / 10;
  }
  for (const k of keys) if (out[k] === 0) delete out[k];
  return out;
}

// /stuff_breakdown response → the same row shape the season card uses.
function gameRows(resp, meta) {
  const { norms, rescale } = resp.scale || {};
  const groups = meta?.groups || [];
  const out = {};
  for (const [pt, g] of Object.entries(resp.by_pitch_type || {})) {
    if (g.stuff_plus == null) continue;                    // no norms for this type
    const nm = norms?.[pt];
    const lg = meta?.league?.[pt];
    const grade = (x) => {
      const z = Math.max(-4, Math.min(4, (x - nm.stuff_mean) / nm.stuff_std));
      let raw = 100 - 10 * z;
      if (rescale?.stdev > 0) raw = 100 + (raw - rescale.mean) / rescale.stdev * 10;
      return Math.round(raw * 10) / 10;
    };
    const one = (gs, base) => {
      if (!gs || gs.stuff_plus == null) return null;
      if (!nm || !base) return { stuff_plus: gs.stuff_plus, n: gs.n };
      const slope = -100 / (nm.stuff_std * (rescale?.stdev > 0 ? rescale.stdev : 10));
      const pts = {};
      for (const grp of groups) {
        const gc = grp.features.reduce((a, f) => a + (gs.c?.[f] || 0), 0);
        pts[grp.key] = (gc - (base.c?.[grp.key] || 0)) * slope;
      }
      const b = grade(base.xrv);
      return { stuff_plus: gs.stuff_plus, n: gs.n, base: b, c: reconcile(pts, gs.stuff_plus - b) };
    };
    out[pt] = {
      ...one(g, lg?.overall),
      same: one(g.same, lg?.same || lg?.overall),
      oppo: one(g.oppo, lg?.oppo || lg?.overall),
    };
  }
  return out;
}

// One Savant CSV row → the /score_aggregate payload the Pitcher Game summary sends.
const sv = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };
const savantPitch = (r, pid) => ({
  pitcher_id: Number(pid),
  _stand: r.stand || "R",
  _p_throws: r.p_throws || "R",
  _pitchType: r.pitch_type,
  _pfx_direct: true,
  details: { type: { code: scorePitchCode(r.pitch_type) } },
  pitchData: {
    startSpeed: sv(r.release_speed), extension: sv(r.release_extension),
    strikeZoneTop: sv(r.sz_top), strikeZoneBottom: sv(r.sz_bot),
    coordinates: {
      pfxX: sv(r.pfx_x), pfxZ: sv(r.pfx_z), pX: sv(r.plate_x), pZ: sv(r.plate_z),
      x0: sv(r.release_pos_x), z0: sv(r.release_pos_z),
      vX0: sv(r.vx0), vY0: sv(r.vy0), vZ0: sv(r.vz0), aX: sv(r.ax), aY: sv(r.ay), aZ: sv(r.az),
    },
    breaks: { spinRate: sv(r.release_spin_rate), spinDirection: sv(r.spin_axis) },
  },
});

const _gameCache = new Map();
function loadGame(pid, gamePk) {
  const key = `${pid}_${gamePk}`;
  if (!_gameCache.has(key)) {
    _gameCache.set(key, (async () => {
      const rows = (await fetchSavantGameData(gamePk)) || [];
      const mine = rows.filter(r => String(r.pitcher) === String(pid) && r.pitch_type &&
        r.pitch_type !== "UN" && r.pitch_type !== "PO" && r.release_speed && r.plate_x && r.plate_z);
      if (!mine.length) return { empty: true };
      const r = await fetch(`${PITCH_PLUS_API}/stuff_breakdown`, {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pitches: mine.map(x => savantPitch(x, pid)) }),
      });
      if (!r.ok) throw new Error(`API ${r.status}`);
      return await r.json();
    })().catch(e => { _gameCache.delete(key); return { error: String(e.message || e) }; }));
  }
  return _gameCache.get(key);
}

const fmtGameDate = (d) => {
  const dt = new Date(`${d}T12:00:00`);
  return isNaN(dt) ? d : dt.toLocaleDateString("en-US", { month: "short", day: "numeric" });
};

export default function StuffWaterfall({ season, pitchers }) {
  const { theme: t, isDark } = useTheme();
  const cardRef = useRef(null);
  const [data, setData] = useState(undefined);   // undefined = loading, null = no file
  const [pid, setPid] = useState(null);
  const [pt, setPt] = useState(null);
  const [mode, setMode] = useState("season");    // "season" | "game"
  const [games, setGames] = useState(null);      // game log for pid/season
  const [gamePk, setGamePk] = useState(null);
  const [game, setGame] = useState(null);        // /stuff_breakdown response (or {empty}/{error})

  useEffect(() => {
    let alive = true;
    setData(undefined);
    loadWaterfall(season).then(d => { if (alive) setData(d && typeof d === "object" ? d : null); });
    return () => { alive = false; };
  }, [season]);

  // Season view: drop the selection when the new season doesn't have that pitcher.
  useEffect(() => {
    if (mode === "season" && data && pid && !data[pid]) setPid(null);
  }, [data, pid, mode]);

  const pitcherById = useMemo(() => {
    const m = new Map();
    for (const p of pitchers || []) if (p.player_id != null) m.set(String(p.player_id), p);
    return m;
  }, [pitchers]);

  const options = useMemo(() => {
    if (!data) return [];
    const ids = new Set(Object.keys(data).filter(k => k !== "meta" && data[k]?.types));
    // Any pitcher can have a game breakdown, not just those with a qualified season pitch.
    if (mode === "game") for (const id of pitcherById.keys()) ids.add(id);
    return [...ids]
      .map(id => {
        const p = pitcherById.get(id);
        const r = data[id];
        const name = p?.name || r?.name || id;
        const types = r?.types && mode === "season" ? ` — ${Object.keys(r.types).join(" · ")}` : "";
        return { value: id, name, label: `${name}${p?.team ? ` (${p.team})` : ""}${types}` };
      })
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [data, pitcherById, mode]);

  // Game log for the chosen pitcher (newest first).
  useEffect(() => {
    setGames(null); setGamePk(null);
    if (mode !== "game" || !pid) return;
    let alive = true;
    fetchGameLog(pid, String(season).replace(/\D/g, ""))
      .then(splits => {
        if (!alive) return;
        const list = splits
          .filter(s => s.game?.gamePk)
          .map(s => ({
            gamePk: s.game.gamePk,
            date: s.date,
            opp: ABBR_BY_TEAM_ID[s.opponent?.id] || s.opponent?.name || "",
            home: s.isHome,
            ip: s.stat?.inningsPitched,
            pitches: s.stat?.numberOfPitches,
          }))
          .reverse();
        setGames(list);
        if (list.length) setGamePk(list[0].gamePk);
      })
      .catch(() => alive && setGames([]));
    return () => { alive = false; };
  }, [mode, pid, season]);

  useEffect(() => {
    setGame(null);
    if (mode !== "game" || !pid || !gamePk) return;
    let alive = true;
    loadGame(pid, gamePk).then(r => { if (alive) setGame(r); });
    return () => { alive = false; };
  }, [mode, pid, gamePk]);

  const gameInfo = games?.find(g => g.gamePk === gamePk) || null;
  const rec = data && pid ? data[pid] : null;
  const gameTypes = useMemo(
    () => (mode === "game" && game?.by_pitch_type && data?.meta ? gameRows(game, data.meta) : null),
    [mode, game, data]);
  const view = mode === "game"
    ? (gameTypes ? { throws: game.throws, types: gameTypes,
                     n: Object.values(gameTypes).reduce((a, g) => a + g.n, 0) } : null)
    : rec;

  // Pitch types by usage; keep the chosen type if this pitcher throws it, else his main pitch.
  const types = useMemo(
    () => (view ? Object.entries(view.types).sort((a, b) => b[1].n - a[1].n).map(([k]) => k) : []),
    [view]);
  const activePt = types.includes(pt) ? pt : types[0] || null;
  const row = view && activePt ? view.types[activePt] : null;

  const groupLabels = useMemo(() => {
    const m = {};
    for (const g of data?.meta?.groups || []) m[g.key] = g.label;
    return m;
  }, [data]);

  // Both columns share one trait order (by combined size) and one x-axis range.
  const { order, range } = useMemo(() => {
    if (!row) return { order: [], range: { R: 10, step: 5 } };
    const tot = {};
    for (const s of SIDES) for (const [f, v] of Object.entries(row[s.key]?.c || {})) tot[f] = (tot[f] || 0) + Math.abs(v);
    const order = Object.keys(tot).filter(f => tot[f] > 0).sort((a, b) => tot[b] - tot[a]);
    let maxDev = 1;
    for (const s of SIDES) {
      const r = row[s.key];
      if (!r || r.base == null) continue;
      let run = r.base;
      maxDev = Math.max(maxDev, Math.abs(run - 100), Math.abs(r.stuff_plus - 100));
      for (const f of order) { run += r.c[f] || 0; maxDev = Math.max(maxDev, Math.abs(run - 100)); }
    }
    const needed = maxDev + Math.max(4, maxDev * 0.15);   // headroom for the value labels
    const step = needed <= 20 ? 5 : needed <= 60 ? 10 : 20;
    return { order, range: { R: Math.max(10, Math.ceil(needed / step) * step), step } };
  }, [row]);

  const pitcher = pid ? pitcherById.get(pid) : null;
  const fallbackTeamId = useFallbackTeamId(pid ? Number(pid) : null, !!pid && !pitcher?.team);
  const team = pitcher?.team || ABBR_BY_TEAM_ID[fallbackTeamId] || null;
  const name = pitcher?.name || rec?.name || "";
  const barColor = readableOn(teamMarkColor(team) || t.accentSecondary, isDark);
  const minN = mode === "game" ? 1 : data?.meta?.min_n || 30;
  const gameLabel = gameInfo ? `${fmtGameDate(gameInfo.date)} ${gameInfo.home ? "vs" : "@"} ${gameInfo.opp}` : "";

  const saveCard = async () => {
    if (!cardRef.current) return;
    const undo = await embedPliant(cardRef.current);
    const when = mode === "game" && gameInfo ? gameInfo.date : season;
    try {
      await saveCardAsPng(cardRef, `${name.replace(/\s+/g, "_")}_${activePt}_Stuff_platoon_${when}.png`);
    } finally {
      undo();
    }
  };

  const msg = (text) => <div style={{ color: t.textMuted, textAlign: "center", padding: 40, fontSize: 13 }}>{text}</div>;
  const usage = (k) => (view ? Math.round((100 * view.types[k].n) / view.n) : 0);
  const ctl = { padding: "6px 12px", background: t.inputBg, color: t.textSecondary, border: `1px solid ${t.inputBorder}`, borderRadius: 6, fontSize: 12, fontFamily: FONT };
  const toggle = (id, label) => (
    <button key={id} type="button" onClick={() => setMode(id)} aria-pressed={mode === id}
      style={{ padding: "6px 14px", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: FONT, border: "none",
               background: mode === id ? t.accent : "transparent", color: mode === id ? "#fff" : t.textMuted }}>
      {label}
    </button>
  );

  let status = null;
  if (data === null) status = msg(`No Stuff+ breakdown for ${season} yet.`);
  else if (data && !pid) status = msg("Select a pitcher");
  else if (mode === "game" && pid) {
    if (games === null) status = msg("Loading games…");
    else if (!games.length) status = msg(`No ${season} games for this pitcher.`);
    else if (!game) status = msg("Loading game…");
    else if (game.empty) status = msg("No Statcast pitch data for this game yet.");
    else if (game.error) status = msg(`Couldn't score this game (${game.error}).`);
  } else if (mode === "season" && data && pid && !rec) status = msg("Select a pitcher");

  return (
    <div style={{ padding: "16px 20px", fontFamily: FONT }}>
      <div style={{ display: "flex", gap: 12, marginBottom: 12, alignItems: "center", flexWrap: "wrap" }}>
        <div style={{ display: "inline-flex", border: `1px solid ${t.inputBorder}`, borderRadius: 6, overflow: "hidden" }}>
          {toggle("season", "Season")}
          {toggle("game", "Game")}
        </div>
        <SearchableSelect
          value={pid || ""}
          options={options}
          onChange={(v) => setPid(v || null)}
          placeholder="Search pitcher…"
          style={{ ...ctl, minWidth: 320 }}
        />
        {mode === "game" && games?.length > 0 && (
          <select value={gamePk || ""} onChange={(e) => setGamePk(Number(e.target.value))} style={{ ...ctl, cursor: "pointer" }}>
            {games.map(g => (
              <option key={g.gamePk} value={g.gamePk}>
                {fmtGameDate(g.date)} {g.home ? "vs" : "@"} {g.opp}{g.ip ? ` · ${g.ip} IP` : ""}{g.pitches ? ` · ${g.pitches} P` : ""}
              </option>
            ))}
          </select>
        )}
        {types.map(k => (
          <button
            key={k}
            type="button"
            onClick={() => setPt(k)}
            aria-pressed={k === activePt}
            title={`${pitchName(k)} · ${view.types[k].n} pitches`}
            style={{
              padding: "5px 12px", fontSize: 11, fontWeight: 700, borderRadius: 14, cursor: "pointer",
              fontFamily: FONT,
              background: k === activePt ? `${t.accent}26` : t.inputBg,
              color: k === activePt ? t.text : t.textMuted,
              border: `1px solid ${k === activePt ? t.accent : t.inputBorder}`,
            }}
          >
            {k} <span style={{ fontWeight: 500, opacity: 0.75 }}>{usage(k)}%</span>
          </button>
        ))}
        {data === undefined && <span style={{ fontSize: 11, color: t.textMuted }}>Loading {season} Stuff+…</span>}
      </div>

      {status}

      {!status && row && (
        <>
          <FitToWidth designWidth={1100}>
            <div ref={cardRef} style={{ fontFamily: FONT, background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`, overflow: "hidden", maxWidth: 1100, margin: "0 auto", boxShadow: `0 4px 24px ${t.shadow}` }}>
              <div style={{ fontFamily: BANNER_FONT }}>
                <PlayerHeader
                  name={name}
                  team={team}
                  teamId={pitcher?.team_id ?? fallbackTeamId}
                  season={season}
                  playerId={Number(pid)}
                  subtitle={mode === "game"
                    ? `${gameLabel} · ${pitchName(activePt)} Stuff+ Breakdown`
                    : `${season} ${pitchName(activePt)} Stuff+ Breakdown`}
                />
              </div>
              <SummaryStrip row={row} pt={activePt} usage={usage(activePt)} />
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, padding: "8px 14px 0" }}>
                {SIDES.map(s => (
                  <SidePanel key={s.key} side={s} r={row[s.key]} pt={activePt} throws={view.throws}
                    order={order} range={range} labels={groupLabels} color={barColor} minN={minN} />
                ))}
              </div>
              <div style={{ padding: "8px 24px 6px", fontSize: 10, color: t.textFaint, lineHeight: 1.4, textAlign: "center" }}>
                Same-handed = RHP vs RHH or LHP vs LHH. Each column starts from the {season} league-average {pitchName(activePt).toLowerCase()} thrown
                to that side; each bar after it is how much that trait moved {mode === "game" ? "this game's" : "this pitch's"} Stuff+ versus that average, from the
                Stuff model's own feature contributions. Both columns share one scale and trait order. Solid = helped, striped = hurt.
              </div>
              <div style={{ padding: "6px 16px 8px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
                <span>Created by: @PastTheEyeTest on X</span>
                <span style={{ fontStyle: "italic" }}>Data: Baseball Savant · Stuff+ {data?.meta?.model || ""}</span>
              </div>
            </div>
          </FitToWidth>
          <div style={{ textAlign: "center", marginTop: 12 }}>
            <button onClick={saveCard} style={{ padding: "6px 16px", fontSize: 11, fontWeight: 600, fontFamily: FONT, background: t.inputBg, color: t.textMuted, border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer" }}>📥 Save as PNG</button>
          </div>
        </>
      )}
    </div>
  );
}

const pctPill = (pct, size = 20) => (
  <span style={{ display: "inline-block", minWidth: size * 2.2, padding: "0 8px", borderRadius: 14, background: binColor(pct), color: textOnBin(pct), fontSize: size, textAlign: "center" }}>
    {pct}
  </span>
);

function SummaryStrip({ row, pt, usage }) {
  const { theme: t } = useTheme();
  const stat = (label, value) => (
    <div style={{ textAlign: "center", minWidth: 100 }}>
      <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, textTransform: "uppercase", letterSpacing: "0.08em" }}>{label}</div>
      <div style={{ fontSize: 26, fontWeight: 800, color: t.text, lineHeight: 1.2 }}>{value}</div>
    </div>
  );
  const split = SIDES.map(s => `vs. ${s.short} ${row[s.key] ? row[s.key].stuff_plus.toFixed(1) : "—"}`).join("  ·  ");
  return (
    <div style={{ padding: "14px 16px 4px" }}>
      <div style={{ display: "flex", justifyContent: "center", alignItems: "flex-start", gap: 30 }}>
        {stat(`${pt} Stuff+`, row.stuff_plus.toFixed(1))}
        {row.pct != null && stat(`Pctile (${pt})`, pctPill(row.pct))}
        {stat("Pitches", row.n)}
        {stat("Usage", `${usage}%`)}
      </div>
      <div style={{ textAlign: "center", fontSize: 11, fontWeight: 700, color: t.textMuted, marginTop: 4, whiteSpace: "pre" }}>{split}</div>
    </div>
  );
}

// One platoon column: its own Stuff+, percentile and pitch count over its waterfall.
function SidePanel({ side, r, pt, throws, order, range, labels, color, minN }) {
  const { theme: t } = useTheme();
  const hand = handedness(throws, side.key);
  return (
    <div style={{ border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: "10px 4px 2px" }}>
      <div style={{ textAlign: "center" }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: t.text }}>{side.title}</div>
        {hand && <div style={{ fontSize: 10, fontWeight: 700, color: t.textFaint, letterSpacing: "0.08em" }}>{hand}</div>}
      </div>
      {r ? (
        <>
          <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: 18, padding: "6px 0 0", fontSize: 12, color: t.textMuted, fontWeight: 700 }}>
            <span>Stuff+ <span style={{ fontSize: 20, fontWeight: 800, color: t.text }}>{r.stuff_plus.toFixed(1)}</span></span>
            {r.pct != null && <span>Pctile {pctPill(r.pct, 14)}</span>}
            <span>{r.n} {r.n === 1 ? "pitch" : "pitches"}</span>
          </div>
          {r.base != null ? (
            <Waterfall row={r} pt={pt} order={order} range={range} labels={labels} color={color} idSuffix={side.key} />
          ) : (
            <div style={{ color: t.textMuted, textAlign: "center", padding: "40px 12px", fontSize: 12 }}>
              No league-average {pitchName(pt).toLowerCase()} to compare against this season
            </div>
          )}
        </>
      ) : (
        <div style={{ color: t.textMuted, textAlign: "center", padding: "60px 12px", fontSize: 13 }}>
          {minN > 1 ? `Fewer than ${minN} pitches` : "No pitches"} vs. {side.short} hitters
        </div>
      )}
    </div>
  );
}

// ── The waterfall (SVG): 100 → league-average pitch of this type vs this side → one bar
// per trait (shared order) → this pitch's Stuff+. x-axis is symmetric around 100. ──
function Waterfall({ row, pt, order, range, labels, color, idSuffix }) {
  const { theme: t } = useTheme();
  const rows = useMemo(() => {
    const out = [{ f: "_base", label: `Avg ${pitchName(pt)}`, v: +(row.base - 100).toFixed(1), start: 100, end: row.base }];
    let run = row.base;
    for (const f of order) {
      const v = row.c[f] || 0;
      out.push({ f, label: labels[f] || f, v, start: run, end: run + v });
      run += v;
    }
    return out;
  }, [row, pt, order, labels]);
  const final = row.stuff_plus;

  const W = 520, labelW = 128, padR = 30, rowH = 24, top = 30, bottom = 34;
  const plotL = labelW, plotR = W - padR, plotW = plotR - plotL;
  const H = top + rows.length * rowH + bottom;
  const { R, step } = range;
  const x = (v) => plotL + ((v - (100 - R)) / (2 * R)) * plotW;
  const ticks = [];
  for (let v = 100 - R; v <= 100 + R + 1e-9; v += step) ticks.push(v);

  const patternId = `stuff-neg-${color.slice(1)}-${idSuffix}`;
  const baseNeg = `stuff-base-neg-${idSuffix}`;
  const yBottom = top + rows.length * rowH;
  const finalRight = final >= 100 && x(final) + 96 <= W;
  const halo = { stroke: t.cardBg, strokeWidth: 3, strokeLinejoin: "round", paintOrder: "stroke" };
  const baseColor = t.textMuted;

  return (
    <div style={{ display: "flex", justifyContent: "center", padding: "2px 4px 0" }}>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ maxWidth: "100%", height: "auto", fontFamily: FONT }} role="img"
        aria-label={`${pt} Stuff+ waterfall: ${rows.map(r => `${r.label} ${fmtPts(r.v)}`).join(", ")}; final ${final}`}>
        <defs>
          <pattern id={patternId} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={color} fillOpacity="0.28" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={color} strokeWidth="2.4" />
          </pattern>
          <pattern id={baseNeg} patternUnits="userSpaceOnUse" width="6" height="6" patternTransform="rotate(45)">
            <rect width="6" height="6" fill={baseColor} fillOpacity="0.2" />
            <line x1="0" y1="0" x2="0" y2="6" stroke={baseColor} strokeWidth="2.4" />
          </pattern>
        </defs>

        {ticks.map(v => (
          <g key={v}>
            <line x1={x(v)} x2={x(v)} y1={top - 6} y2={yBottom} stroke={t.divider} strokeWidth="1" />
            <text x={x(v)} y={yBottom + 14} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textFaint}>{v}</text>
          </g>
        ))}
        <text x={(plotL + plotR) / 2} y={H - 4} textAnchor="middle" fontSize="10" fontWeight="700" fill={t.textMuted} letterSpacing="0.06em">STUFF+ POINTS</text>

        <line x1={x(100)} x2={x(100)} y1={top - 6} y2={yBottom} stroke={t.textMuted} strokeWidth="1.2" strokeDasharray="4 3" />
        <text x={x(100)} y={top - 10} textAnchor={finalRight ? "end" : "start"} dx={finalRight ? -4 : 4}
          fontSize="10" fill={t.textMuted}>Avg 100</text>
        <line x1={x(final)} x2={x(final)} y1={top - 6} y2={yBottom} stroke={t.text} strokeWidth="1.6" opacity="0.7" />
        <text x={x(final)} y={top - 10} textAnchor={finalRight ? "start" : "end"} dx={finalRight ? 4 : -4}
          fontSize="11" fontWeight="800" fill={t.text}>Stuff+ = {final.toFixed(1)}</text>

        {rows.map((r, j) => {
          const y = top + j * rowH;
          const x0 = x(Math.min(r.start, r.end)), x1 = x(Math.max(r.start, r.end));
          const pos = r.v >= 0;
          const isBase = r.f === "_base";
          const c = isBase ? baseColor : color;
          return (
            <g key={r.f}>
              <text x={labelW - 8} y={y + rowH / 2 + 4} textAnchor="end" fontSize="11"
                fontWeight={isBase ? 700 : 400} fill={isBase ? t.textSecondary : t.text}>{r.label}</text>
              {r.v !== 0 && (
                <rect x={x0} y={y + 4} width={Math.max(1.5, x1 - x0)} height={rowH - 8} rx="2"
                  fill={pos ? c : `url(#${isBase ? baseNeg : patternId})`}
                  fillOpacity={isBase && pos ? 0.55 : 1}
                  stroke={c} strokeWidth={pos ? 0 : 1} />
              )}
              {j < rows.length - 1 && (
                <line x1={x(r.end)} x2={x(r.end)} y1={y + rowH - 4} y2={y + rowH + 4} stroke={t.textFaint} strokeWidth="1" />
              )}
              <text x={pos ? x1 + 4 : x0 - 4} y={y + rowH / 2 + 3.5} textAnchor={pos ? "start" : "end"}
                fontSize="10" fontWeight="700" fill={r.v === 0 ? t.textFaint : t.textSecondary} {...halo}>{fmtPts(r.v)}</text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
