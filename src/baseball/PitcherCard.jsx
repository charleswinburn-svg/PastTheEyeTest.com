import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BubblePercentileBar, PlayerHeader, TrendChart, MetricSelector, saveCardAsPng, fuzzyLookup, binColor, textOnBin, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import { fetchPlayByPlay, extractPitcherData } from "./mlbApi.js";

const PITCH_PLUS_API = "https://pitch-plus-api.onrender.com";

// ── Helpers ────────────────────────────────────────────────────────────────
// Run promises in batches so we don't fire 30+ MLB Stats API requests at once
// (which gets us throttled). 6 in flight is a good balance: ~5x faster than
// serial, no 429s observed.
async function batchedAll(items, fn, concurrency = 6) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) {
      const idx = i++;
      try { out[idx] = await fn(items[idx], idx); }
      catch { out[idx] = null; }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return out;
}

// Linear-interpolation percentile of `value` within a sorted ascending array.
function percentileRank(value, sorted) {
  if (value == null || !sorted?.length) return null;
  let lo = 0, hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) lo = mid + 1;
    else hi = mid;
  }
  let countEq = 0;
  while (lo + countEq < sorted.length && sorted[lo + countEq] === value) countEq++;
  const rank = (lo + countEq / 2) / sorted.length;
  return Math.round(rank * 1000) / 10; // one decimal
}

export default function PitcherCard({ player, season, trends, allPitchers }) {
  const { theme: t } = useTheme();
  const [trendMetric, setTrendMetric] = useState("Stuff+ (FG)");
  const [pitchPlusData, setPitchPlusData] = useState(null);
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  // Compute Stuff+/Loc+/Tun+/Pitch+ live from MLB Stats API to guarantee an
  // exact match with the Summary card. Same data path: game log → per-game
  // PBP → extractPitcherData → POST /score → average per pitch type → weight-
  // average by usage. Then rank against the cached pitcher_grades distribution,
  // filtered to percentile-card-eligible pitchers (allPitchers prop).
  //
  // This is slow (~30-60s) because we're fetching every game's PBP. The user
  // explicitly preferred accuracy over speed, so we just show a spinner.
  useEffect(() => {
    setPitchPlusData(null);
    if (!player?.player_id) return;
    let cancelled = false;

    async function compute() {
      try {
        console.log("[Pitch+] effect fired", { player_id: player.player_id, name: player.name, season, type: typeof season });

        // ── 1. Game log for the season — REGULAR SEASON ONLY ──
        // We fetch directly (rather than reusing fetchGameLog from mlbApi.js)
        // because that helper hardcodes gameType=S,E,R,P,W which would mix
        // spring training and exhibition pitches into the modeling values.
        // Modeling vals should only reflect regular-season pitches.
        console.log("[Pitch+] fetching regular-season game log...");
        const gameLogUrl = `/mlb-api/api/v1/people/${player.player_id}/stats?stats=gameLog&group=pitching&season=${season}&gameType=R&sportId=1`;
        const gameLogResp = await fetch(gameLogUrl);
        if (!gameLogResp.ok) {
          console.warn("[Pitch+] gameLog fetch failed:", gameLogResp.status);
          return;
        }
        const gameLogJson = await gameLogResp.json();
        const games = gameLogJson.stats?.[0]?.splits || [];
        console.log("[Pitch+] got games:", games.length, "first:", games[0]);
        if (cancelled || !games.length) {
          console.warn("[Pitch+] No regular-season games for", player.name);
          return;
        }

        // ── 2. Pull PBP for every game in parallel batches ──
        // splits from fetchGameLog have shape { game: { gamePk, ... }, stat: {...} }
        // — the gamePk lives one level deeper, not on the split itself.
        const gamePks = games.map(g => g.game?.gamePk).filter(Boolean);
        console.log("[Pitch+] gamePks:", gamePks.length);
        if (cancelled || !gamePks.length) return;
        const pbps = await batchedAll(
          gamePks,
          pk => fetchPlayByPlay(pk).catch(() => null),
          6,
        );
        console.log("[Pitch+] pbps fetched:", pbps.filter(Boolean).length);
        if (cancelled) return;

        // ── 3. Extract pitches for this pitcher across every game ──
        // Also capture pitcher hand from matchup info (needed for /score and
        // not available on the baseball_data player object).
        const allPitches = [];
        let pitcherHand = "R";
        for (const pbp of pbps) {
          if (!pbp) continue;
          const data = extractPitcherData(pbp, player.player_id);
          if (data?.pitches?.length) allPitches.push(...data.pitches);
          // Pull pitcher hand from any play that matches this pitcher.
          for (const pl of (pbp.allPlays || [])) {
            if (pl.matchup?.pitcher?.id === player.player_id) {
              const code = pl.matchup?.pitchHand?.code;
              if (code === "L" || code === "R") { pitcherHand = code; break; }
            }
          }
        }
        console.log("[Pitch+] total pitches extracted:", allPitches.length, "throws:", pitcherHand);
        if (!allPitches.length) {
          console.warn("[Pitch+] No pitches found for", player.name);
          return;
        }

        // ── 4. Build the /score payload — same nested MLB Stats API shape that
        // server.py's map_pitch() expects. Critical bits:
        //   * pitch_type goes inside details.type.code (NOT a top-level field)
        //   * release/movement/location lives under pitchData.coordinates.* with
        //     camelCase keys (pX, pZ, vX0, aX, …)
        //   * pfxX/pfxZ are in INCHES from MLB Stats API; the model trains in
        //     FEET, so divide by 12 here (matches what Summaries does)
        //   * spin lives under pitchData.breaks
        const scorePayload = allPitches
          .filter(p =>
            p.pitchType && p.pitchType !== "UN" &&
            p.velo != null && p.pX != null && p.pZ != null,
          )
          .map(p => ({
            pitcher_id: player.player_id,
            _stand: p.batSide || "R",
            _p_throws: pitcherHand,
            details: { type: { code: p.pitchType } },
            pitchData: {
              startSpeed: p.velo,
              extension: p.extension,
              strikeZoneTop: p.szTop,
              strikeZoneBottom: p.szBot,
              coordinates: {
                pfxX: p.pfxX_raw != null ? p.pfxX_raw / 12 : null,
                pfxZ: p.pfxZ_raw != null ? p.pfxZ_raw / 12 : null,
                pX: p.pX, pZ: p.pZ,
                x0: p.relX, z0: p.relHeight,
                vX0: p.vX0, vY0: p.vY0, vZ0: p.vZ0,
                aX: p.aX, aY: p.aY, aZ: p.aZ,
              },
              breaks: { spinRate: p.spin, spinDirection: p.spinDirection },
            },
          }));

        if (!scorePayload.length) {
          console.warn("[Pitch+] empty score payload after filtering");
          return;
        }
        console.log("[Pitch+] POST /score with", scorePayload.length, "pitches");

        // ── 5. Score every pitch ──
        const r = await fetch(`${PITCH_PLUS_API}/score`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pitches: scorePayload }),
        });
        console.log("[Pitch+] /score response:", r.status);
        if (cancelled || !r.ok) {
          console.warn("[Pitch+] /score failed:", r.status, await r.text().catch(() => ""));
          return;
        }
        const { scores } = await r.json();
        console.log("[Pitch+] got scores:", scores?.length);
        if (!scores?.length) return;

        // ── 6. Aggregate ──
        // For each pitch type: average the per-pitch Plus values.
        // For pitcher overall: weight-average those per-type means by usage.
        // Algebraically equivalent to averaging directly across all pitches.
        const overallSums = { stuff: 0, loc: 0, tun: 0, pitch: 0 };
        const overallCounts = { stuff: 0, loc: 0, tun: 0, pitch: 0 };
        for (const s of scores) {
          if (s.stuff_plus  != null) { overallSums.stuff += s.stuff_plus;  overallCounts.stuff++; }
          if (s.loc_plus    != null) { overallSums.loc   += s.loc_plus;    overallCounts.loc++;   }
          if (s.tunnel_plus != null) { overallSums.tun   += s.tunnel_plus; overallCounts.tun++;   }
          if (s.pitch_plus  != null) { overallSums.pitch += s.pitch_plus;  overallCounts.pitch++; }
        }
        const live = {
          stuff_plus: overallCounts.stuff ? overallSums.stuff / overallCounts.stuff : null,
          loc_plus:   overallCounts.loc   ? overallSums.loc   / overallCounts.loc   : null,
          tun_plus:   overallCounts.tun   ? overallSums.tun   / overallCounts.tun   : null,
          pitch_plus: overallCounts.pitch ? overallSums.pitch / overallCounts.pitch : null,
        };

        // ── 7. Pull cached distribution and rank against eligible set ──
        // We only need population values to rank; the live value is what we display.
        console.log("[Pitch+] live overall:", live);
        console.log("[Pitch+] fetching distribution...");
        const distR = await fetch(`${PITCH_PLUS_API}/pitcher_grades_distribution?season=${season}`);
        console.log("[Pitch+] distribution response:", distR.status);
        if (cancelled) return;
        const distJson = distR.ok ? await distR.json() : null;
        const grades = distJson?.grades || {};
        console.log("[Pitch+] grades loaded:", Object.keys(grades).length, "pitchers");

        const eligibleIds = new Set(
          (allPitchers || []).map(p => String(p.player_id)).filter(Boolean),
        );
        const filtered = Object.entries(grades).filter(([pid]) => eligibleIds.has(pid));
        console.log("[Pitch+] eligible filtered:", filtered.length);

        const percentilesAgainst = (key) => {
          const vals = filtered
            .map(([, g]) => g[key])
            .filter(v => v != null)
            .sort((a, b) => a - b);
          return vals;
        };

        const out = {
          pitcher_id: player.player_id,
          season,
          n_pitches: scores.length,
          pool_size: filtered.length,
          stuff_plus: { value: live.stuff_plus, percentile: percentileRank(live.stuff_plus, percentilesAgainst("stuff_plus")) },
          loc_plus:   { value: live.loc_plus,   percentile: percentileRank(live.loc_plus,   percentilesAgainst("loc_plus")) },
          tun_plus:   { value: live.tun_plus,   percentile: percentileRank(live.tun_plus,   percentilesAgainst("tun_plus")) },
          pitch_plus: { value: live.pitch_plus, percentile: percentileRank(live.pitch_plus, percentilesAgainst("pitch_plus")) },
        };
        console.log("[Pitch+] final:", out);

        if (!cancelled) setPitchPlusData(out);
      } catch (err) {
        console.warn("[Pitch+] Live fetch failed:", err);
      }
    }

    compute();
    return () => { cancelled = true; };
  }, [player?.player_id, season, allPitchers]);

  const metricList = useMemo(() => {
    if (!player) return [];
    return Object.keys(player.categories).map(label => ({ label }));
  }, [player]);

  const trendData = useMemo(() => {
    if (!player || !trends) return null;
    return fuzzyLookup(trends, player.name) || null;
  }, [player, trends]);

  const saveCard = useCallback(async () => {
    if (!player) return;
    const safeName = player.name.replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_pitcher_${season}.png`);
  }, [player, season]);

  if (!player) {
    return (
      <div style={{ color: "#666", padding: 40, textAlign: "center" }}>
        Select a pitcher
      </div>
    );
  }

  const cats = Object.entries(player.categories);
  const subtitle = buildBioSubtitle(bio, "throws") || `${season}${player.ip ? ` | ${player.ip} IP` : ""}`;

  return (
    <div>
      {/* === SAVEABLE CARD === */}
      <div
        ref={cardRef}
        style={{
          background: t.cardBg,
          borderRadius: 12,
          border: `1px solid ${t.cardBorder}`,
          overflow: "hidden",
          boxShadow: `0 4px 24px ${t.shadow}`,
          maxWidth: 600,
          margin: "0 auto",
        }}
      >
        <PlayerHeader
          name={player.name}
          team={player.team}
          teamId={player.team_id}
          season={season}
          playerId={player.player_id}
          subtitle={subtitle}
        />
        <ProBubblesRow data={pitchPlusData} theme={t} />
        <div style={{ padding: "8px 12px 4px" }}>
          {cats.filter(([, cat]) => cat.pctile != null).map(([label, cat]) => (
            <BubblePercentileBar
              key={label}
              label={label}
              pctile={cat.pctile}
              display={cat.display}
            />
          ))}
        </div>
        <div style={{
          padding: "8px 16px 10px",
          display: "flex", justifyContent: "space-between",
          fontSize: 10, color: t.textFaint,
        }}>
          <span>{season} Season | Min 10 IP</span>
          <span style={{ fontStyle: "italic" }}>PastTheEyeTest | Savant + FanGraphs</span>
        </div>
      </div>

      {/* === SAVE BUTTON === */}
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button
          onClick={saveCard}
          style={{
            padding: "6px 16px", fontSize: 11, fontWeight: 600,
            background: t.inputBg, color: t.textMuted,
            border: `1px solid ${t.inputBorder}`, borderRadius: 6,
            cursor: "pointer", transition: "all 0.15s",
          }}
          onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
          onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
        >
          📥 Save as PNG
        </button>
      </div>

      {/* === TREND CHART (separate) === */}
      {trendData && trendData.length >= 2 && (
        <div style={{
          background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
          maxWidth: 600, margin: "16px auto 0", padding: "12px 0 4px",
        }}>
          <MetricSelector
            metrics={metricList}
            selected={trendMetric}
            onChange={setTrendMetric}
          />
          <TrendChart
            data={trendData}
            metricLabel={trendMetric}
            metricKey={trendMetric}
          />
        </div>
      )}
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PRO+ BUBBLES ROW
// ═══════════════════════════════════════════════════════════
// Four large percentile bubbles at the top of the card: Stuff+, Location+,
// Tunnel+, Pitch+. Bubble color encodes percentile (binColor / textOnBin from
// SharedComponents), the big number is the raw 100-centered value (so users
// can read it the way Pitch Profiler / FanGraphs report it), small text below
// shows the percentile rank ("87th").
//
// Loading state: live computation takes 30-60s (game log + per-game PBP +
// /score round trip). Until pitchPlusData arrives, each bubble renders a
// rotating spinner so users see the work is in progress.
function ProBubblesRow({ data, theme }) {
  const t = theme;
  const metrics = [
    { key: "stuff_plus", label: "Stuff+" },
    { key: "loc_plus",   label: "Location+" },
    { key: "tun_plus",   label: "Tunnel+" },
    { key: "pitch_plus", label: "Pitch+" },
  ];

  const placeholder = !data || data.error;
  const isLoading = !data;
  const isUnqualified = data?.qualified === false;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: 8,
      padding: "10px 16px 6px",
      borderBottom: `1px solid ${t.divider}`,
    }}>
      <style>{`
        @keyframes ptet-spin { to { transform: rotate(360deg); } }
      `}</style>
      {metrics.map(({ key, label }) => {
        const m = !placeholder ? data[key] : null;
        const value = m?.value;
        const pctile = m?.percentile;
        const fill = pctile != null ? binColor(pctile) : t.inputBg;
        const txt = pctile != null ? textOnBin(pctile) : t.textFaintest;
        return (
          <div key={key} style={{
            display: "flex", flexDirection: "column", alignItems: "center", gap: 4,
          }}>
            <div style={{
              fontSize: 10, fontWeight: 800,
              color: t.text,
              letterSpacing: "0.06em",
              textTransform: "uppercase",
            }}>{label}</div>
            <div style={{
              width: 56, height: 56, borderRadius: "50%",
              background: fill,
              border: `2px solid ${t.cardBg}`,
              boxShadow: pctile != null ? "0 2px 6px rgba(0,0,0,0.25)" : "none",
              display: "flex", flexDirection: "column",
              alignItems: "center", justifyContent: "center",
              transition: "background 0.3s ease",
            }}>
              {isLoading ? (
                <div style={{
                  width: 22, height: 22,
                  border: `2px solid ${t.divider}`,
                  borderTopColor: t.text,
                  borderRadius: "50%",
                  animation: "ptet-spin 0.9s linear infinite",
                }} />
              ) : (
                <div style={{
                  fontSize: 18, fontWeight: 800,
                  color: txt,
                  fontFamily: "'DM Mono', monospace",
                  lineHeight: 1,
                }}>
                  {value != null ? Math.round(value) : "—"}
                </div>
              )}
            </div>
            <div style={{
              fontSize: 9, fontWeight: 700,
              color: pctile != null ? t.textSecondary : t.textFaintest,
              fontFamily: "'DM Mono', monospace",
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}>
              {pctile != null
                ? `${ordinal(Math.round(pctile))} percentile`
                : (isUnqualified ? "n/a" : isLoading ? "scoring…" : "—")}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Tiny helper — 1 → "1st", 22 → "22nd", etc. Inlined to avoid a util import.
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}
