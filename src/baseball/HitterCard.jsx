import { useTheme } from "./ThemeContext.jsx";
import { useRef, useCallback } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import RollingChart from "./RollingChart.jsx";
import { useDateRangeStats } from "./statsCompute.js";

export default function HitterCard({ player, season, isAAA = false, dateFrom = "", dateTo = "", allHitters = [] }) {
  const { theme: t } = useTheme();
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  const { categories: rangeCategories, loading: rangeLoading } =
    useDateRangeStats(player, season, "hitter", dateFrom, dateTo, allHitters);

  const displayCategories = rangeCategories ?? player?.categories;
  const isDateRange = !!(dateFrom || dateTo);

  const saveCard = useCallback(async () => {
    if (!player) return;
    const safeName = player.name.replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_hitter_${season}.png`);
  }, [player, season]);

  if (!player) {
    return (
      <div style={{ color: "#666", padding: 40, textAlign: "center" }}>
        Select a player
      </div>
    );
  }

  const cats = Object.entries(displayCategories || {}).filter(([k]) => !k.startsWith("_"));

  const dateSubtitle = isDateRange
    ? `${dateFrom || "start"} → ${dateTo || "now"} | ${rangeCategories?._pa ?? "—"} PA`
    : null;

  const subtitle = isAAA
    ? `Parent Org: ${player.parent_org_name || player.parent_org_abbr || "—"} | ${season} | ${player.pa || "—"} PA`
    : (dateSubtitle || buildBioSubtitle(bio, "bats") || `${season} | ${player.pa || "—"} PA`);

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
        <div style={{ padding: "8px 12px 4px", position: "relative", minHeight: rangeLoading ? 80 : undefined }}>
          {rangeLoading ? (
            <div style={{ display: "flex", alignItems: "center", justifyContent: "center", height: 80 }}>
              <style>{`@keyframes ptet-spin2{to{transform:rotate(360deg)}}`}</style>
              <div style={{
                width: 24, height: 24,
                border: `2px solid ${t.divider}`,
                borderTopColor: t.accent,
                borderRadius: "50%",
                animation: "ptet-spin2 0.8s linear infinite",
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

      {/* === SAVE BUTTON (outside card) === */}
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

      {/* === ROLLING 50-PA CHART === */}
      <RollingChart
        playerId={player.player_id}
        playerName={player.name}
        season={season}
        type="hitter"
        cardMetrics={Object.keys(player.categories || {})}
      />

    </div>
  );
}
