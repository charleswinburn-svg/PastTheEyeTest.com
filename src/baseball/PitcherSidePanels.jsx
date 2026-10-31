import { useEffect, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import CapturePanel from "./CapturePanel.jsx";
import PitcherDistributions from "./PitcherDistributions.jsx";
import { ReleaseDiagram } from "./SimilarityFigures.jsx";
import { loadSimilarityPool } from "./similarity.js";

// ═══════════════════════════════════════════════════════════
// PITCHER CARD SIDE PANELS
// ═══════════════════════════════════════════════════════════
// Two panels that sit beside (wide screens) or under (narrow) the pitcher
// card: the catcher's-view release diagram on top and the modeling (grade)
// distributions below. Neither shows a heading on the site; both save as a
// PNG that carries the player header, via CapturePanel.

const safeName = n => String(n || "player").replace(/\s+/g, "_");
const ft = v => (typeof v === "number" && Number.isFinite(v) ? `${v.toFixed(1)} ft` : "—");

// Release diagram for the card's pitcher, from the season's similarity file
// (per-pitcher release traits; requires ≥200 regular-season pitches).
export function ReleasePanel({ player, season, subtitle }) {
  const { theme: t } = useTheme();
  const [rec, setRec] = useState(undefined);   // undefined = loading, null = not in pool

  useEffect(() => {
    let cancelled = false;
    setRec(undefined);
    if (!player?.player_id) { setRec(null); return; }
    loadSimilarityPool("pitcher", [Number(season)])
      .then(pools => { if (!cancelled) setRec(pools[0]?.players?.[String(player.player_id)] || null); })
      .catch(() => { if (!cancelled) setRec(null); });
    return () => { cancelled = true; };
  }, [player?.player_id, season]);

  const v = rec?.v || {};
  const sub = rec
    ? `${season} · arm ${Number.isFinite(v.arm_angle) ? `${Math.round(v.arm_angle)}°` : "—"} · ${ft(v.release_z)} high · ${ft(v.release_x)} side · ext ${ft(v.extension)}`
    : subtitle;

  return (
    <CapturePanel
      player={player} season={season} subtitle={sub}
      filename={`${safeName(player?.name)}_release_${season}.png`}
      saveable={!!rec} maxWidth={460}
    >
      {rec === undefined ? (
        <Note t={t}>Loading release data…</Note>
      ) : rec === null ? (
        <Note t={t}>Release diagram needs ≥ 200 regular-season pitches in {season}.</Note>
      ) : (
        <div style={{ display: "flex", justifyContent: "center", padding: "10px 8px 2px" }}>
          <ReleaseDiagram p={rec} width={380} />
        </div>
      )}
    </CapturePanel>
  );
}

// Grade distributions (Stuff+/Loc+/Tun+/Pitch+ KDEs by pitch type, vs LHH / vs RHH).
export function DistributionsPanel({ player, season, subtitle, isAAA = false, dateFrom = "", dateTo = "" }) {
  return (
    <CapturePanel
      player={player} season={season} subtitle={subtitle}
      filename={`${safeName(player?.name)}_modeling_${season}.png`}
      footerLeft={`${season} · grade distributions by pitch type`}
      maxWidth={460}
    >
      <PitcherDistributions
        playerId={player?.player_id} season={season} isAAA={isAAA}
        dateFrom={dateFrom} dateTo={dateTo}
        showTitle={false} compact
      />
    </CapturePanel>
  );
}

function Note({ t, children }) {
  return <div style={{ padding: "18px 16px", fontSize: 12, color: t.textMuted, textAlign: "center" }}>{children}</div>;
}
