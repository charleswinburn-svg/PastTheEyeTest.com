import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect, useRef, useCallback } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng } from "./SharedComponents.jsx";
import { LocationZonePanel } from "./SummaryComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";
import { PITCH_COLORS, PITCH_NAMES, fetchSavantPlayerSeason, fetchSavantPlayerDateRange, scorePitchCode } from "./mlbApi.js";

const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

// Six per-pitch-type metrics, all oriented "higher = better" so every slider
// ranks ascending with no per-metric inversion.
const METRICS = [
  { key: "runValue",    label: "Run Value",    kind: "rv"   },  // actual, Savant "Run Value" (runs saved/100)
  { key: "expRunValue", label: "Expected RV",  kind: "rv"   },  // model xRV, shown as runs saved/100
  { key: "stuff",       label: "Stuff+",       kind: "plus" },
  { key: "loc",         label: "Location+",    kind: "plus" },
  { key: "tun",         label: "Tunnel+",      kind: "plus" },
  { key: "pitch",       label: "Pitch+",       kind: "plus" },
];

const num = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };

// ── Season leaderboard cache (all pitchers' by_pitch_type) ───────────────────
const lbCache = new Map();   // season -> Promise<leaderboard json | null>
function loadLeaderboard(season) {
  if (!lbCache.has(season)) {
    lbCache.set(season, fetch(`${PITCH_PLUS_API}/leaderboard?season=${season}`)
      .then(r => (r.ok ? r.json() : null))
      .catch(() => null));
  }
  return lbCache.get(season);
}

// Per-pitch-type league distributions in "higher = better" orientation.
// dist[pt][metricKey] = ascending-sorted array.
function buildDistributions(pitchers) {
  const dist = {};
  for (const p of pitchers || []) {
    const bpt = p.by_pitch_type || {};
    for (const pt in bpt) {
      const e = bpt[pt];
      const d = (dist[pt] ||= { runValue: [], expRunValue: [], stuff: [], loc: [], tun: [], pitch: [] });
      if (e.rv   != null) d.runValue.push(e.rv);       // stored runs-saved/100 (higher = better)
      if (e.xrv  != null) d.expRunValue.push(-e.xrv);  // xRV is runs-allowed/100 → negate to runs-saved
      if (e.stuff != null) d.stuff.push(e.stuff);
      if (e.loc   != null) d.loc.push(e.loc);
      if (e.tun   != null) d.tun.push(e.tun);
      if (e.pitch != null) d.pitch.push(e.pitch);
    }
  }
  for (const pt in dist) for (const k in dist[pt]) dist[pt][k].sort((a, b) => a - b);
  return dist;
}

// Percentile of `value` within an ascending-sorted league distribution (share ≤ value).
function pctWithinType(sortedAsc, value) {
  if (value == null || !sortedAsc || !sortedAsc.length) return null;
  let count = 0;
  for (const v of sortedAsc) { if (v <= value) count++; else break; }
  return Math.round((count / sortedAsc.length) * 100);
}

// Map raw Savant rows → the flat pitch shape LocationZonePanel/MiniZone expects,
// carrying delta_run_exp for the actual Run Value calc.
function normalize(rows, playerId) {
  return (rows || [])
    .filter(r => String(r.pitcher) === String(playerId) && r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO")
    .map(r => ({
      pitchType: r.pitch_type,
      pX: num(r.plate_x), pZ: num(r.plate_z),
      batSide: r.stand || null,
      dre: num(r.delta_run_exp),
    }));
}

// Build the /score_aggregate payload for a date window (mirrors PitcherCard).
function buildScorePayload(rows, playerId) {
  const sv = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };
  return (rows || [])
    .filter(r => String(r.pitcher) === String(playerId) && r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO")
    .map(r => ({
      pitcher_id: playerId,
      _stand: r.stand || "R",
      _p_throws: r.p_throws || "R",
      _pitchType: r.pitch_type,
      _pfx_direct: true,
      details: { type: { code: scorePitchCode(r.pitch_type) } },
      pitchData: {
        startSpeed: sv(r.release_speed),
        extension: sv(r.release_extension),
        strikeZoneTop: sv(r.sz_top),
        strikeZoneBottom: sv(r.sz_bot),
        coordinates: {
          pfxX: sv(r.pfx_x), pfxZ: sv(r.pfx_z),
          pX: sv(r.plate_x), pZ: sv(r.plate_z),
          x0: sv(r.release_pos_x), z0: sv(r.release_pos_z),
          vX0: sv(r.vx0), vY0: sv(r.vy0), vZ0: sv(r.vz0),
          aX: sv(r.ax), aY: sv(r.ay), aZ: sv(r.az),
        },
        breaks: { spinRate: sv(r.release_spin_rate), spinDirection: sv(r.spin_axis) },
      },
    }));
}

const fmtRV = (v) => (v == null ? "—" : (v >= 0 ? `+${v.toFixed(1)}` : v.toFixed(1)));
const fmtPlus = (v) => (v == null ? "—" : String(Math.round(v)));

export default function PitchModelingCard({ player, season, isAAA = false, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [state, setState] = useState({ loading: true, unavailable: false, types: [], pitches: [], pitchPlus: {} });
  const cardRef = useRef(null);

  useEffect(() => {
    if (!player?.player_id) { setState({ loading: false, unavailable: false, types: [], pitches: [], pitchPlus: {} }); return; }
    if (isAAA) { setState({ loading: false, unavailable: true, types: [], pitches: [], pitchPlus: {} }); return; }
    let cancelled = false;
    setState(s => ({ ...s, loading: true, unavailable: false }));
    const pid = player.player_id;
    const isDateRange = !!(dateFrom || dateTo);

    (async () => {
      try {
        const [lb, savRowsAll] = await Promise.all([
          loadLeaderboard(season),
          (isDateRange
            ? fetchSavantPlayerDateRange(pid, season, "pitcher", dateFrom, dateTo)
            : fetchSavantPlayerSeason(pid, season, "pitcher")).catch(() => []),
        ]);
        if (cancelled) return;

        // Match Baseball Savant's "Run Value" tab: regular season only. The season
        // Savant fetch includes spring/exhibition (hfGT=R|S|E|…), which inflates
        // pitch counts and skews RV/100 away from Savant's numbers. (The date-range
        // fetch is already hfGT=R|, so this filter is a no-op there.) Fall back to
        // all rows if game_type is somehow absent, so the card never blanks.
        const _reg = (savRowsAll || []).filter(r => r.game_type === "R");
        const savRows = _reg.length ? _reg : (savRowsAll || []);

        const dist = buildDistributions(lb?.pitchers);
        const pitches = normalize(savRows, pid);

        // Actual Run Value per pitch type (Savant convention: −mean(delta_run_exp)×100).
        const savByType = {};
        for (const p of pitches) {
          const g = (savByType[p.pitchType] ||= { n: 0, dreSum: 0, dreN: 0 });
          g.n++;
          if (p.dre != null) { g.dreSum += p.dre; g.dreN++; }
        }
        const actualRv = {};   // pt -> runs-saved/100
        for (const pt in savByType) {
          const g = savByType[pt];
          actualRv[pt] = g.dreN ? -(g.dreSum / g.dreN) * 100 : null;
        }

        // This pitcher's Plus + expected-RV per type: season from /leaderboard,
        // date-range live from /score_aggregate.
        let perType = {};   // pt -> { stuff, loc, tun, pitch, xrv }
        if (isDateRange) {
          const payload = buildScorePayload(savRows, pid);
          if (payload.length) {
            const resp = await fetch(`${PITCH_PLUS_API}/score_aggregate`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ pitches: payload }),
            }).then(r => (r.ok ? r.json() : null)).catch(() => null);
            if (cancelled) return;
            perType = resp?.by_pitch_type || {};
          }
        } else {
          const me = (lb?.pitchers || []).find(p => String(p.player_id) === String(pid));
          perType = me?.by_pitch_type || {};
        }

        // Assemble per-type rows, ordered by usage (Savant pitch count). Drop
        // trivial types (e.g. a single misclassified "FA") that are just noise.
        const MIN_SHOW = 10;
        const typeList = Object.keys(savByType)
          .filter(pt => savByType[pt].n >= MIN_SHOW)
          .sort((a, b) => savByType[b].n - savByType[a].n);
        const pitchPlus = {};   // for heatmap tooltips
        const types = typeList.map(pt => {
          const g = perType[pt] || {};
          const d = dist[pt] || {};
          const rvSaved = actualRv[pt];
          const xrvSaved = g.xrv != null ? -g.xrv : null;
          pitchPlus[pt] = { stuff: g.stuff, loc: g.loc, tun: g.tun, pitch: g.pitch };
          const vals = {
            runValue:    rvSaved,
            expRunValue: xrvSaved,
            stuff: g.stuff ?? null, loc: g.loc ?? null, tun: g.tun ?? null, pitch: g.pitch ?? null,
          };
          const rows = METRICS.map(m => ({
            key: m.key, label: m.label,
            display: m.kind === "rv" ? fmtRV(vals[m.key]) : fmtPlus(vals[m.key]),
            pctile: pctWithinType(d[m.key], vals[m.key]),
          }));
          return { pt, name: PITCH_NAMES[pt] || pt, color: PITCH_COLORS[pt] || "#888", n: savByType[pt].n, rows };
        });

        setState({ loading: false, unavailable: false, types, pitches, pitchPlus });
      } catch {
        if (!cancelled) setState({ loading: false, unavailable: false, types: [], pitches: [], pitchPlus: {} });
      }
    })();

    return () => { cancelled = true; };
  }, [player?.player_id, season, isAAA, dateFrom, dateTo]);  // eslint-disable-line react-hooks/exhaustive-deps

  const saveCard = useCallback(async () => {
    if (!player) return;
    const safeName = player.name.replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_pitch_modeling_${season}.png`);
  }, [player, season]);

  if (!player) return null;

  const { loading, unavailable, types, pitches, pitchPlus } = state;
  const isDateRange = !!(dateFrom || dateTo);
  const subtitle = isDateRange
    ? `Pitch Modeling | ${dateFrom || "start"} → ${dateTo || "now"}`
    : `Pitch Modeling | ${season}`;

  return (
    <div>
      <FitToWidth designWidth={1040}>
        <div
          ref={cardRef}
          style={{
            background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
            overflow: "hidden", boxShadow: `0 4px 24px ${t.shadow}`, maxWidth: 1040, margin: "0 auto",
          }}
        >
          <PlayerHeader
            name={player.name} team={player.team} teamId={player.team_id}
            season={season} playerId={player.player_id} subtitle={subtitle}
          />

          {unavailable ? (
            <div style={{ padding: 40, textAlign: "center", color: t.textMuted, fontSize: 12 }}>
              Pitch modeling grades (Run Value / Stuff+ / Location+ / Tunnel+ / Pitch+) are MLB-only —
              not available at AAA.
            </div>
          ) : loading ? (
            <div style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", gap: 10, minHeight: 260, color: t.textMuted, fontSize: 12 }}>
              <style>{`@keyframes ptet-pm{to{transform:rotate(360deg)}}`}</style>
              <div style={{ width: 26, height: 26, border: `2px solid ${t.divider}`, borderTopColor: t.accent, borderRadius: "50%", animation: "ptet-pm 0.8s linear infinite" }} />
              <div>Scoring pitch models…</div>
            </div>
          ) : !types.length ? (
            <div style={{ padding: 40, textAlign: "center", color: t.textFaint, fontSize: 12 }}>
              No pitch data available for this window.
            </div>
          ) : (
            <>
              {/* ── Per-pitch-type modeling sliders (percentiles scaled within each pitch type) ── */}
              <div style={{ padding: "10px 12px 4px", display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(320px, 1fr))", gap: "10px 28px" }}>
                {types.map(ty => (
                  <div key={ty.pt} style={{ padding: "6px 4px 10px", borderBottom: `1px solid ${t.divider}` }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                      <span style={{ width: 10, height: 10, borderRadius: "50%", background: ty.color, flexShrink: 0 }} />
                      <span style={{ fontSize: 12, fontWeight: 800, color: t.text, letterSpacing: "0.02em" }}>{ty.name}</span>
                      <span style={{ fontSize: 10, color: t.textFaint, fontFamily: "'DM Mono', monospace" }}>{ty.n} pitches</span>
                    </div>
                    {ty.rows.map(r => (
                      <BubblePercentileBar key={r.key} label={r.label} pctile={r.pctile} display={r.display} />
                    ))}
                  </div>
                ))}
              </div>

              {/* ── Location heatmaps (one per pitch type, all batters) ── */}
              <div style={{ padding: "6px 12px 4px" }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: t.textMuted, textAlign: "center", margin: "4px 0 8px" }}>
                  Pitch Locations
                </div>
                <div style={{ display: "flex", justifyContent: "center" }}>
                  <LocationZonePanel pitches={pitches} side="ALL" width={640} isGame={false} pitchPlus={pitchPlus} />
                </div>
              </div>

              <div style={{ padding: "8px 16px 10px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
                <span>{isDateRange ? "Date range" : `${season} Season`} | percentiles within pitch type</span>
                <span style={{ fontStyle: "italic" }}>PastTheEyeTest | Pitch Models + Savant</span>
              </div>
            </>
          )}
        </div>
      </FitToWidth>

      {/* ── SAVE BUTTON (outside cardRef / PNG) ── */}
      {!unavailable && (
        <div style={{ textAlign: "center", marginTop: 12 }}>
          <button
            onClick={saveCard}
            style={{
              padding: "6px 16px", fontSize: 11, fontWeight: 600, background: t.inputBg, color: t.textMuted,
              border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer", transition: "all 0.15s",
            }}
            onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
            onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
          >
            📥 Save as PNG
          </button>
        </div>
      )}
    </div>
  );
}
