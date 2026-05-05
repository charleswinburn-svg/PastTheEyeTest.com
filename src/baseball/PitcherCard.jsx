import { useTheme } from "./ThemeContext.jsx";
import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { BubblePercentileBar, PlayerHeader, TrendChart, MetricSelector, saveCardAsPng, fuzzyLookup, binColor, textOnBin } from "./SharedComponents.jsx";

const PITCH_PLUS_API = "https://pitch-plus-api.onrender.com";

export default function PitcherCard({ player, season, trends, allPitchers }) {
  const { theme: t } = useTheme();
  const [trendMetric, setTrendMetric] = useState("Stuff+ (FG)");
  const [pitchPlusData, setPitchPlusData] = useState(null);
  const cardRef = useRef(null);

  // Fetch Stuff+/Loc+/Tun+/Pitch+ percentiles for the selected pitcher.
  // Resets on player/season change so we never show stale bubbles.
  useEffect(() => {
    setPitchPlusData(null);
    if (!player?.player_id) return;
    let cancelled = false;
    fetch(`${PITCH_PLUS_API}/pitcher_percentiles/${player.player_id}?season=${season}`)
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (cancelled) return;
        if (data?.error) {
          console.warn("[Pitch+] No percentile data:", data.error);
          return;
        }
        setPitchPlusData(data);
      })
      .catch(err => console.warn("[Pitch+] Fetch failed:", err));
    return () => { cancelled = true; };
  }, [player?.player_id, season]);

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
  const subtitleParts = [season];
  if (player.ip) subtitleParts.push(`${player.ip} IP`);
  const subtitle = subtitleParts.filter(Boolean).join(" | ");

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
        <div style={{ padding: "8px 16px 4px" }}>
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
          <span>{season} Season | Min 20 IP</span>
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
function ProBubblesRow({ data, theme }) {
  const t = theme;
  const metrics = [
    { key: "stuff_plus", label: "Stuff+" },
    { key: "loc_plus",   label: "Location+" },
    { key: "tun_plus",   label: "Tunnel+" },
    { key: "pitch_plus", label: "Pitch+" },
  ];

  // While loading or for unqualified pitchers, render the row with placeholders
  // so the layout doesn't jump when data arrives.
  const placeholder = !data || data.error;

  return (
    <div style={{
      display: "grid",
      gridTemplateColumns: "repeat(4, 1fr)",
      gap: 8,
      padding: "10px 16px 6px",
      borderBottom: `1px solid ${t.divider}`,
    }}>
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
              <div style={{
                fontSize: 18, fontWeight: 800,
                color: txt,
                fontFamily: "'DM Mono', monospace",
                lineHeight: 1,
              }}>
                {value != null ? Math.round(value) : "—"}
              </div>
            </div>
            <div style={{
              fontSize: 9, fontWeight: 700,
              color: pctile != null ? t.textSecondary : t.textFaintest,
              fontFamily: "'DM Mono', monospace",
              letterSpacing: "0.02em",
              whiteSpace: "nowrap",
            }}>
              {pctile != null ? `${ordinal(Math.round(pctile))} percentile` : (placeholder && data?.qualified === false ? "n/a" : "…")}
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
