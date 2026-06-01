import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect, useRef, useCallback } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, binColor, textOnBin, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import RollingChart from "./RollingChart.jsx";
import { useDateRangeStats } from "./statsCompute.js";

const PITCH_PLUS_API = "https://api.pasttheeyetest.com";

export default function PitcherCard({ player, season, allPitchers, isAAA = false, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [pitchPlusData, setPitchPlusData] = useState(null);
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  // Read pre-computed Stuff+/Loc+/Tun+/Pitch+ from the season summaries via
  // pitch-plus-api's /pitcher_percentiles endpoint. One network call; the
  // server has already aggregated and ranked against qualified pitchers using
  // the same pitch_plus_norm.json the summary cards use, so the values match
  // by construction.
  useEffect(() => {
    setPitchPlusData(null);
    if (!player?.player_id) return;
    let cancelled = false;
    fetch(`${PITCH_PLUS_API}/pitcher_percentiles/${player.player_id}?season=${season}`)
      .then(r => r.ok ? r.json() : null)
      .then(j => {
        if (cancelled || !j || j.error) return;
        setPitchPlusData({
          pitcher_id: player.player_id,
          season,
          stuff_plus: { value: j.stuff_plus?.value, percentile: j.stuff_plus?.percentile },
          loc_plus:   { value: j.loc_plus?.value,   percentile: j.loc_plus?.percentile },
          tun_plus:   { value: j.tun_plus?.value,   percentile: j.tun_plus?.percentile },
          pitch_plus: { value: j.pitch_plus?.value, percentile: j.pitch_plus?.percentile },
        });
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [player?.player_id, season, isAAA]);

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
    ? `${dateFrom || "start"} → ${dateTo || "now"} | ${rangeCategories?._ip != null ? `${rangeCategories._ip.toFixed(1)} IP` : "— IP"}`
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
        <div style={{ padding: "8px 12px 4px", position: "relative", minHeight: rangeLoading ? 80 : undefined }}>
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
