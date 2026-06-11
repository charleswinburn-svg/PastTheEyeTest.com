import { useRef, useCallback } from "react";
import { BubblePercentileBar, saveCardAsPng } from "../baseball/SharedComponents.jsx";
import { buildPlayerCategories } from "./soccerApi.js";

const T = {
  bg: "#0a0f1a",
  card: "#0f172a",
  cardBorder: "#1e3a5f",
  text: "#f8fafc",
  textSecondary: "#cbd5e1",
  textMuted: "#94a3b8",
  textFaint: "#475569",
  textFaintest: "#334155",
  accent: "#f59e0b",
  inputBg: "#1e293b",
  inputBorder: "#334155",
  shadow: "rgba(0,0,0,0.6)",
  divider: "#1e293b",
};

// FIFA country colors (fallback to a World Cup green)
const COUNTRY_COLORS = {
  BRA: "#009C3B", ARG: "#74ACDF", FRA: "#002395", ENG: "#cf091e",
  ESP: "#AA151B", GER: "#000000", POR: "#006600", ITA: "#003580",
  NED: "#FF4F00", BEL: "#000000", URU: "#5EB6E4", MEX: "#006847",
  USA: "#002868", JPN: "#BC002D", SEN: "#00853F", MAR: "#C1272D",
  AUS: "#00008B", CAN: "#FF0000", CHN: "#DE2910", KOR: "#003478",
  COL: "#FCD116", ECU: "#FFD100", CRC: "#002B7F", TUN: "#E70013",
  CMR: "#007A5E", GHA: "#006B3F", NGR: "#008751", EGY: "#CE1126",
  ALG: "#006233", SAU: "#006C35", IRN: "#239F40", QAT: "#8D1B3D",
};

function hexLum(hex) {
  return [hex.slice(1,3), hex.slice(3,5), hex.slice(5,7)].reduce((s, h, i) => {
    const c = parseInt(h, 16) / 255;
    const l = c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
    return s + l * [0.2126, 0.7152, 0.0722][i];
  }, 0);
}

function SoccerPlayerHeader({ player }) {
  const cc = (player.country_code ?? "").toUpperCase();
  const bgColor = COUNTRY_COLORS[cc] || "#1b4332";
  const light = hexLum(bgColor) > 0.179;
  const textColor = light ? "#111" : "#fff";
  const subColor = light ? "rgba(0,0,0,0.6)" : "rgba(255,255,255,0.72)";
  const ringColor = light ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.25)";
  const initColor = light ? "rgba(0,0,0,0.25)" : "rgba(255,255,255,0.2)";

  const initials = (player.name ?? "")
    .split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2);

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 20px 14px", gap: 16, background: bgColor,
    }}>
      {/* Photo / initials */}
      <div style={{
        width: 72, height: 72, borderRadius: "50%",
        overflow: "hidden", border: `2px solid ${ringColor}`, flexShrink: 0,
        position: "relative", display: "flex", alignItems: "center", justifyContent: "center",
        background: ringColor,
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: initColor, position: "absolute" }}>
          {initials}
        </span>
        {player.photo && (
          <img
            src={player.photo} alt=""
            style={{ width: "100%", height: "100%", objectFit: "cover", position: "relative", zIndex: 1 }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>

      {/* Name + subtitle */}
      <div style={{ flex: 1, textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: textColor, letterSpacing: "-0.02em" }}>
          {player.name}
        </div>
        <div style={{
          fontSize: 11, color: subColor, marginTop: 4,
          letterSpacing: "0.06em", fontStyle: "italic", fontWeight: 600, textTransform: "uppercase",
        }}>
          {player.team} · {player.matches}G {player.minutes}'
        </div>
      </div>

      {/* Country flag */}
      <div style={{ width: 72, height: 72, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {cc && (
          <img
            src={`/flag-assets/w80/${cc.toLowerCase()}.png`}
            alt={cc}
            style={{ maxWidth: 72, maxHeight: 48, objectFit: "contain", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.4))" }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>
    </div>
  );
}

export default function SoccerPlayerCard({ player, allPlayers }) {
  const cardRef = useRef(null);

  const saveCard = useCallback(async () => {
    if (!player) return;
    const safeName = (player.name ?? "player").replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_WC2026.png`);
  }, [player]);

  if (!player) {
    return (
      <div style={{ color: T.textFaint, padding: 40, textAlign: "center" }}>
        Select a player
      </div>
    );
  }

  const categories = buildPlayerCategories(player, allPlayers);
  const cats = Object.entries(categories).filter(([, cat]) => cat.pctile != null || cat.display !== "—");

  return (
    <div>
      {/* Saveable card */}
      <div
        ref={cardRef}
        style={{
          background: T.card,
          borderRadius: 12,
          border: `1px solid ${T.cardBorder}`,
          overflow: "hidden",
          boxShadow: `0 4px 24px ${T.shadow}`,
          maxWidth: 600,
          margin: "0 auto",
        }}
      >
        <SoccerPlayerHeader player={player} />

        <div style={{ padding: "8px 12px 4px" }}>
          {cats.length === 0 ? (
            <div style={{ color: T.textFaint, padding: 20, textAlign: "center", fontSize: 12 }}>
              No stats yet (player needs 45+ minutes)
            </div>
          ) : (
            cats.map(([label, cat]) => (
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
          fontSize: 10, color: T.textFaint,
        }}>
          <span>FIFA World Cup 2026</span>
          <span style={{ fontStyle: "italic" }}>PastTheEyeTest | bzzoiro</span>
        </div>
      </div>

      {/* Save button */}
      <div style={{ textAlign: "center", marginTop: 12 }}>
        <button
          onClick={saveCard}
          style={{
            padding: "6px 16px", fontSize: 11, fontWeight: 600,
            background: T.inputBg, color: T.textMuted,
            border: `1px solid ${T.inputBorder}`, borderRadius: 6,
            cursor: "pointer", transition: "all 0.15s",
          }}
          onMouseEnter={e => { e.target.style.background = T.divider; e.target.style.color = T.text; }}
          onMouseLeave={e => { e.target.style.background = T.inputBg; e.target.style.color = T.textMuted; }}
        >
          Save as PNG
        </button>
      </div>
    </div>
  );
}
