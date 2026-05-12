import { useTheme } from "./ThemeContext.jsx";
import { useRef, useCallback } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import RollingChart from "./RollingChart.jsx";

export default function HitterCard({ player, season }) {
  const { theme: t } = useTheme();
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

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

  const cats = Object.entries(player.categories);

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
          subtitle={buildBioSubtitle(bio, "bats") || `${season} | ${player.pa || "—"} PA`}
        />
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
          <span>{season} Season | Min 100 PA</span>
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
        season={season}
        type="hitter"
        cardMetrics={Object.keys(player.categories || {})}
      />

    </div>
  );
}
