import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect, useRef, useCallback } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, binColor, textOnBin, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import RollingChart from "./RollingChart.jsx";
import PitcherArsenal from "./PitcherArsenal.jsx";
import { useDateRangeStats } from "./statsCompute.js";
import { fetchSavantPlayerDateRange, scorePitchCode } from "./mlbApi.js";

const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

export default function PitcherCard({ player, season, allPitchers, isAAA = false, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [pitchPlusData, setPitchPlusData] = useState(null);
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  useEffect(() => {
    setPitchPlusData(null);
    if (!player?.player_id) return;
    const isDateRange = !!(dateFrom || dateTo);
    let cancelled = false;

    if (!isDateRange) {
      // Full-season: use pre-computed endpoint (fast, authoritative)
      fetch(`${PITCH_PLUS_API}/pitcher_percentiles/${player.player_id}?season=${season}`)
        .then(r => r.ok ? r.json() : null)
        .then(j => {
          if (cancelled || !j || j.error) return;
          setPitchPlusData({
            stuff_plus: { value: j.stuff_plus?.value, percentile: j.stuff_plus?.percentile },
            loc_plus:   { value: j.loc_plus?.value,   percentile: j.loc_plus?.percentile },
            tun_plus:   { value: j.tun_plus?.value,   percentile: j.tun_plus?.percentile },
            pitch_plus: { value: j.pitch_plus?.value, percentile: j.pitch_plus?.percentile },
          });
        })
        .catch(() => {});
      return () => { cancelled = true; };
    }

    // Date-range: fetch Savant pitches → /score_aggregate → rank against distribution
    (async () => {
      try {
        const [savantRows, distResp] = await Promise.all([
          fetchSavantPlayerDateRange(player.player_id, season, "pitcher", dateFrom, dateTo).catch(() => []),
          fetch(`${PITCH_PLUS_API}/pitcher_grades_distribution?season=${season}`)
            .then(r => r.ok ? r.json() : null).catch(() => null),
        ]);
        if (cancelled) return;

        const sv = (v) => { const f = parseFloat(v); return isNaN(f) ? null : f; };
        const pitches = (savantRows || [])
          .filter(r => r.pitch_type && r.pitch_type !== "UN" && r.pitch_type !== "PO")
          .map(r => ({
            pitcher_id: player.player_id,
            _stand:     r.stand    || "R",
            _p_throws:  r.p_throws || "R",
            _pitchType: r.pitch_type,
            _pfx_direct: true,
            details:  { type: { code: scorePitchCode(r.pitch_type) } },
            pitchData: {
              startSpeed: sv(r.release_speed),
              extension:  sv(r.release_extension),
              strikeZoneTop:    sv(r.sz_top),
              strikeZoneBottom: sv(r.sz_bot),
              coordinates: {
                pfxX: sv(r.pfx_x),          pfxZ: sv(r.pfx_z),
                pX:   sv(r.plate_x),         pZ:   sv(r.plate_z),
                x0:   sv(r.release_pos_x),   z0:   sv(r.release_pos_z),
                vX0:  sv(r.vx0), vY0: sv(r.vy0), vZ0: sv(r.vz0),
                aX:   sv(r.ax),  aY:  sv(r.ay),  aZ:  sv(r.az),
              },
              breaks: { spinRate: sv(r.release_spin_rate), spinDirection: sv(r.spin_axis) },
            },
          }));

        if (!pitches.length || cancelled) return;

        const scoreResp = await fetch(`${PITCH_PLUS_API}/score_aggregate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ pitches }),
        });
        if (!scoreResp.ok || cancelled) return;
        const scored = await scoreResp.json();
        const overall = scored?.overall;
        if (!overall || cancelled) return;

        // Rank the date-range value against full-season qualified distribution
        // (same population as pitcher_percentiles uses — min 200 pitches in season)
        const grades = distResp?.grades || {};
        const rankPctile = (gradeKey, value) => {
          if (value == null) return null;
          const dist = Object.values(grades)
            .filter(g => g.n >= 200 && g[gradeKey] != null)
            .map(g => g[gradeKey])
            .sort((a, b) => a - b);
          if (!dist.length) return null;
          return Math.round(dist.filter(v => v <= value).length / dist.length * 100);
        };

        setPitchPlusData({
          stuff_plus: { value: overall.stuff, percentile: rankPctile("stuff_plus", overall.stuff) },
          loc_plus:   { value: overall.loc,   percentile: rankPctile("loc_plus",   overall.loc) },
          tun_plus:   { value: overall.tun,   percentile: rankPctile("tun_plus",   overall.tun) },
          pitch_plus: { value: overall.pitch, percentile: rankPctile("pitch_plus", overall.pitch) },
        });
      } catch { /* silently fail — bubbles stay blank */ }
    })();

    return () => { cancelled = true; };
  }, [player?.player_id, season, isAAA, dateFrom, dateTo]); // eslint-disable-line react-hooks/exhaustive-deps

  const saveCard = useCallback(async () => {
    if (!player) return;
    const safeName = player.name.replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_pitcher_${season}.png`);
  }, [player, season]);

  const { categories: rangeCategories, loading: rangeLoading } =
    useDateRangeStats(player, season, "pitcher", dateFrom, dateTo, allPitchers);

  const displayCategories = rangeCategories ?? player?.categories;
  const isDateRange = !!(dateFrom || dateTo);

  if (!player) {
    return (
      <div style={{ color: "#666", padding: 40, textAlign: "center" }}>
        Select a pitcher
      </div>
    );
  }

  const cats = Object.entries(displayCategories || {}).filter(([k]) => !k.startsWith("_"));

  const dateSubtitle = isDateRange
    ? `${dateFrom || "start"} → ${dateTo || "now"}`
    : null;

  const subtitle = isAAA
    ? `Parent Org: ${player?.parent_org_name || player?.parent_org_abbr || "—"} | ${season}${player?.ip ? ` | ${player.ip} IP` : ""}`
    : (dateSubtitle || buildBioSubtitle(bio, "throws") || `${season}${player.ip ? ` | ${player.ip} IP` : ""}`);

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
          maxWidth: 1040,
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
        {/* Two fluid columns (no divider): percentile bars + pitch arsenal */}
        <div style={{ display: "flex", gap: 36, flexWrap: "wrap", padding: "8px 12px 4px", position: "relative", minHeight: rangeLoading ? 80 : undefined }}>
          {/* Left column — percentile bars */}
          <div style={{ flex: "1 1 320px", minWidth: 280 }}>
            {rangeLoading ? (
              <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80 }}>
                <style>{`@keyframes ptet-spin3{to{transform:rotate(360deg)}}`}</style>
                <div style={{
                  width: 24, height: 24,
                  border: `2px solid ${t.divider}`,
                  borderTopColor: t.accent,
                  borderRadius: "50%",
                  animation: "ptet-spin3 0.8s linear infinite",
                }} />
              </div>
            ) : (
              cats.filter(([, cat]) => cat.pctile != null).map(([label, cat]) => (
                <BubblePercentileBar
                  key={label}
                  label={label}
                  pctile={cat.pctile}
                  display={cat.display}
                />
              ))
            )}
          </div>
          {/* Right column — pitch arsenal figures */}
          <div style={{ flex: "1 1 360px", minWidth: 300 }}>
            <PitcherArsenal
              playerId={player.player_id}
              season={season}
              isAAA={isAAA}
              dateFrom={dateFrom}
              dateTo={dateTo}
            />
          </div>
        </div>
        <div style={{
          padding: "8px 16px 10px",
          display: "flex", justifyContent: "space-between",
          fontSize: 10, color: t.textFaint,
        }}>
          <span>{isDateRange ? "Date range" : `${season} Season`}</span>
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

      {/* === ROLLING 10-IP CHART === */}
      <RollingChart
        playerId={player.player_id}
        playerName={player.name}
        season={season}
        type="pitcher"
        cardMetrics={Object.keys(player.categories || {})}
      />
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
