import { useTheme } from "./ThemeContext.jsx";
import { useState, useRef, useCallback, useMemo } from "react";
import { BubblePercentileBar, PlayerHeader, TrendChart, MetricSelector, saveCardAsPng, fuzzyLookup } from "./SharedComponents.jsx";

export default function PitcherCard({ player, season, trends, allPitchers }) {
  const { theme: t } = useTheme();
  const [trendMetric, setTrendMetric] = useState("Stuff+ (FG)");
  const cardRef = useRef(null);

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
          season={season}
          playerId={player.player_id}
          subtitle={subtitle}
        />
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
