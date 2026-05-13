import { useTheme } from "./ThemeContext.jsx";
import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, useBio, buildBioSubtitle } from "./SharedComponents.jsx";

const CATCHER_POS  = new Set(["C"]);
const INFIELD_POS  = new Set(["1B", "2B", "3B", "SS"]);
const OUTFIELD_POS = new Set(["LF", "CF", "RF"]);
const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];

function positionGroup(pos) {
  if (CATCHER_POS.has(pos))  return "catcher";
  if (INFIELD_POS.has(pos))  return "infielder";
  if (OUTFIELD_POS.has(pos)) return "outfielder";
  return null;
}

export default function FielderCard({ player, season, fieldingData }) {
  const { theme: t } = useTheme();
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  // Available positions for the selected player (those with categories)
  const positions = useMemo(() => {
    if (!player?.positions) return [];
    return Object.keys(player.positions).sort(
      (a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b),
    );
  }, [player]);

  const [activePos, setActivePos] = useState(positions[0] || null);
  useEffect(() => {
    if (positions.length && (!activePos || !positions.includes(activePos))) {
      setActivePos(positions[0]);
    }
  }, [positions, activePos]);

  const saveCard = useCallback(async () => {
    if (!player || !activePos) return;
    const safeName = (player.name || "fielder").replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_${activePos}_fielder_${season}.png`);
  }, [player, activePos, season]);

  if (!player) {
    return (
      <div style={{ color: t.textMuted, padding: 40, textAlign: "center" }}>
        Select a player
      </div>
    );
  }
  if (!positions.length) {
    return (
      <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>
        No qualifying position ({"≥"}100 innings) for {player.name} in {season}.
      </div>
    );
  }

  const posData = player.positions[activePos] || {};
  const cats = posData.categories || {};
  const innings = posData.innings || 0;
  const group = positionGroup(activePos);
  const metricList = (group && fieldingData?.[`${group}_metrics`]) || [];

  return (
    <div>
      {/* Position selector (only shows if player has 2+ qualified positions) */}
      {positions.length > 1 && (
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 12, flexWrap: "wrap" }}>
          {positions.map(p => (
            <button
              key={p}
              onClick={() => setActivePos(p)}
              style={{
                padding: "6px 14px", fontSize: 12,
                fontWeight: activePos === p ? 700 : 600,
                color: activePos === p ? "#fff" : t.textSecondary,
                background: activePos === p ? t.accent : t.inputBg,
                border: `1px solid ${activePos === p ? t.accent : t.inputBorder}`,
                borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                transition: "all 0.15s",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <div
        ref={cardRef}
        style={{
          background: t.cardBg, borderRadius: 12,
          border: `1px solid ${t.cardBorder}`, overflow: "hidden",
          boxShadow: `0 4px 24px ${t.shadow}`,
          maxWidth: 600, margin: "0 auto",
        }}
      >
        <PlayerHeader
          name={player.name}
          team={player.team}
          season={season}
          playerId={player.player_id}
          subtitle={buildBioSubtitle(bio, null) || `${season} | ${activePos} | ${innings.toFixed(0)} Innings`}
        />
        <div style={{ padding: "8px 12px 4px" }}>
          {metricList.map(m => {
            const cat = cats[m.label];
            if (!cat || cat.pctile == null) return null;
            return (
              <BubblePercentileBar
                key={m.label}
                label={m.label}
                pctile={cat.pctile}
                display={cat.display}
              />
            );
          })}
        </div>
        <div style={{
          padding: "8px 16px 10px",
          display: "flex", justifyContent: "space-between",
          fontSize: 10, color: t.textFaint,
        }}>
          <span>{season} | {activePos} | {innings.toFixed(0)} Innings (min 100)</span>
          <span style={{ fontStyle: "italic" }}>PastTheEyeTest | Savant + FanGraphs</span>
        </div>
      </div>

      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button
          onClick={saveCard}
          style={{
            padding: "6px 16px", fontSize: 11, fontWeight: 600,
            background: t.inputBg, color: t.textMuted,
            border: `1px solid ${t.inputBorder}`, borderRadius: 6,
            cursor: "pointer", transition: "all 0.15s",
            fontFamily: "inherit",
          }}
          onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
          onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
        >
          📥 Save as PNG
        </button>
      </div>
    </div>
  );
}
