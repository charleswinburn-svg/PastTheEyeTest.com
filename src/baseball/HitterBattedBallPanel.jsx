import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import CapturePanel from "./CapturePanel.jsx";
import { SprayChart, ZonePlot, PitchTypeLegend } from "./SummaryComponents.jsx";
import SprayZoneTable from "./SprayZoneTable.jsx";
import { fetchSavantPlayerSeasonCached, fetchSavantPlayerDateRange, savantRowsToPlays } from "./mlbApi.js";

// ═══════════════════════════════════════════════════════════
// HITTER BATTED-BALL PANEL
// ═══════════════════════════════════════════════════════════
// The spray chart (All / Hits-only toggle) and the two zone plots (95+ EV
// contact, whiffs) that used to live on the Summaries hitter views, now under
// the hitter card's rolling chart. Built from the player's Savant per-pitch
// rows (regular season, or the card's date range), via the shared cached fetch
// so the rolling chart and this panel download the season once. No heading on
// the site; the PNG carries the player header (CapturePanel).

const safeName = n => String(n || "player").replace(/\s+/g, "_");
const isHitResult = r => ["Single", "Double", "Triple", "Home Run"].some(h => (r || "").includes(h));

export default function HitterBattedBallPanel({ player, season, subtitle, dateFrom = "", dateTo = "" }) {
  const { theme: t } = useTheme();
  const [plays, setPlays] = useState(undefined);   // undefined = loading
  const [hitsOnly, setHitsOnly] = useState(false);
  const ranged = !!(dateFrom || dateTo);

  useEffect(() => {
    let cancelled = false;
    setPlays(undefined);
    if (!player?.player_id) { setPlays([]); return; }
    const p = ranged
      ? fetchSavantPlayerDateRange(player.player_id, season, "batter", dateFrom, dateTo).catch(() => [])
      : fetchSavantPlayerSeasonCached(player.player_id, season, "batter");
    p.then(rows => {
      if (cancelled) return;
      const all = savantRowsToPlays(rows);
      setPlays(ranged ? all : all.filter(x => !x.gameType || x.gameType === "R"));
    });
    return () => { cancelled = true; };
  }, [player?.player_id, season, ranged, dateFrom, dateTo]);

  const battedBalls = useMemo(() => (plays || []).filter(p => p.isInPlay && p.hitData), [plays]);
  const shown = hitsOnly ? battedBalls.filter(b => isHitResult(b.result)) : battedBalls;
  const hardContact = useMemo(() => (plays || []).filter(p => p.isInPlay && p.hitData?.launchSpeed >= 95), [plays]);
  const whiffs = useMemo(() => (plays || []).filter(p => p.isWhiff), [plays]);
  const types = useMemo(() => [...new Set((plays || []).map(p => p.pitchType))], [plays]);

  const controls = battedBalls.length > 0 ? (
    <div style={{ display: "flex", justifyContent: "center", marginBottom: 10 }}>
      <div style={{ display: "inline-flex", background: t.inputBg, border: `1px solid ${t.inputBorder}`, borderRadius: 8, padding: 2 }}>
        {[["all", "All Batted Balls"], ["hits", "Hits Only"]].map(([id, label]) => {
          const active = (id === "hits") === hitsOnly;
          return (
            <button
              key={id}
              onClick={() => setHitsOnly(id === "hits")}
              style={{
                padding: "5px 14px", fontSize: 11, fontWeight: 700, borderRadius: 6, cursor: "pointer",
                border: "none", fontFamily: "inherit",
                background: active ? t.accent : "transparent",
                color: active ? "#fff" : t.textMuted, transition: "all 0.15s",
              }}
            >{label}</button>
          );
        })}
      </div>
    </div>
  ) : null;

  const scope = ranged ? `${dateFrom || "start"} → ${dateTo || "now"}` : `${season} regular season`;

  return (
    <div style={{ marginTop: 16 }}>
      <CapturePanel
        player={player} season={season} subtitle={subtitle}
        filename={`${safeName(player?.name)}_batted_balls_${season}.png`}
        footerLeft={`${scope} · spray chart · spray zones (season) · 95+ EV contact · whiffs`}
        footerRight="PastTheEyeTest | Baseball Savant"
        controls={controls} saveable={!!plays?.length} maxWidth={760}
      >
        {plays === undefined ? (
          <Note t={t}>Loading batted balls…</Note>
        ) : !plays.length ? (
          <Note t={t}>No Savant pitch data for {scope}.</Note>
        ) : (
          <div style={{ padding: "8px 0 2px" }}>
            <div style={{ display: "flex", justifyContent: "center" }}>
              <SprayChart battedBalls={shown} width={660} height={380} />
            </div>
            <SprayZoneTable playerId={player?.player_id} season={season} seasonOnlyNote={ranged} />
            <div style={{ display: "flex", justifyContent: "center", gap: 12, padding: "8px 16px", flexWrap: "wrap" }}>
              <ZonePlot pitches={hardContact} title="95+ EV Contact" width={310} height={242} />
              <ZonePlot pitches={whiffs} title="Whiffs" width={310} height={242} />
            </div>
            <PitchTypeLegend types={types} />
          </div>
        )}
      </CapturePanel>
    </div>
  );
}

function Note({ t, children }) {
  return <div style={{ padding: "18px 16px", fontSize: 12, color: t.textMuted, textAlign: "center" }}>{children}</div>;
}
