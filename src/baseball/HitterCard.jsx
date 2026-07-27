import { useTheme } from "./ThemeContext.jsx";
import { useRef, useCallback, useMemo } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import RollingChart from "./RollingChart.jsx";
import HitterDistributions from "./HitterDistributions.jsx";
import { useDateRangeStats, computeXrvDateRange, buildXrvPctileLookup, interpolatePctile } from "./statsCompute.js";

// Fixed display order for the xRV / 600 PA column (matches build_hitter_xrv.py).
const XRV_LABELS = [
  "xRV/600", "Contact Quality", "Whiff", "Decision",
  "Fastball", "Breaking", "Offspeed",
  "Inner", "Middle (vertical)", "Outer",
  "Upper", "Middle (horizontal)", "Lower",
  "Chase",
];

export default function HitterCard({ player, season, isAAA = false, dateFrom = "", dateTo = "", allHitters = [], xrvAll = null, xrvGames = null, xrvGamesLoading = false }) {
  const { theme: t } = useTheme();
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  const { categories: rangeCategories, loading: rangeLoading } =
    useDateRangeStats(player, season, "hitter", dateFrom, dateTo, allHitters);

  const displayCategories = rangeCategories ?? player?.categories;
  const isDateRange = !!(dateFrom || dateTo);

  // Date-range xRV/600: aggregate the player's per-game sums over the window and
  // rank each metric against the full-season distribution (xrvAll). Falls back to
  // season values (player.xrv) when no range is active. Computed before the early
  // return so hook order stays stable.
  const xrvRange = useMemo(() => {
    if (!isDateRange || !Array.isArray(xrvGames)) return null;
    const r = computeXrvDateRange(xrvGames, dateFrom, dateTo);
    if (!r) return null;
    if (!r.values) return { pa: 0, metrics: null };
    const metrics = {};
    XRV_LABELS.forEach((label, i) => {
      const v = r.values[i];
      const pctile = interpolatePctile(buildXrvPctileLookup(xrvAll, label), v);
      metrics[label] = { value: v, display: `${v >= 0 ? "+" : ""}${v.toFixed(1)}`, pctile };
    });
    return { pa: r.pa, metrics };
  }, [isDateRange, xrvGames, xrvAll, dateFrom, dateTo]);

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

  // xRV/600 PA metrics (season-precomputed, merged onto player.xrv by player_id).
  // Right column only renders when present, so the card stays single-column until
  // the hitter_xrv_{season}.json pipeline output exists.
  const xrv = player?.xrv;
  const hasXrv = !!(xrv && Object.keys(xrv).length > 0);
  // Column presence stays tied to season qualification (hasXrv). When a date range
  // is active we swap in range-computed metrics once the per-game file loads.
  // xrvRange is: null = no per-game data (file missing or not loaded yet),
  //   {pa:0, metrics:null} = player has games but none in the window,
  //   {pa>0, metrics} = computed range values.
  const xrvShowRange = isDateRange && hasXrv;
  const xrvLoading = xrvShowRange && xrvGamesLoading && !xrvRange?.metrics;
  const xrvGamesMissing = xrvShowRange && !xrvGamesLoading && xrvRange == null;
  // Fall back to season values (honestly labeled) when not in range mode or when the
  // per-game file isn't available — so this never blanks out the column unnecessarily.
  const seasonFallback = !xrvShowRange || xrvGamesMissing;
  const xrvScope = seasonFallback ? "season" : "date range";
  const xrvMetrics = xrvRange?.metrics ?? (seasonFallback ? xrv : null);

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
          maxWidth: 1040,   // match the pitcher card so both share the same dimensions
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
        <div style={{ display: "flex", gap: 16, flexWrap: "wrap", padding: "8px 12px 4px", position: "relative", minHeight: rangeLoading ? 80 : undefined }}>
          {/* Left column — existing percentile bars (Savant + FanGraphs) */}
          <div style={{ flex: "1 1 320px", minWidth: 280 }}>
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

          {/* Right column — xRV / 600 PA (season, or date range when a window is set) */}
          {hasXrv && (
            <div style={{ flex: "1 1 360px", minWidth: 300 }}>
              <div style={{
                fontSize: 10, fontWeight: 700, color: t.textFaint,
                textTransform: "uppercase", letterSpacing: "0.06em",
                textAlign: "right", padding: "0 50px 4px 0",
              }}>
                xRV / 600 PA · {xrvScope}
              </div>
              {xrvLoading ? (
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
                XRV_LABELS.map((label) => (
                  <BubblePercentileBar
                    key={label}
                    label={label}
                    pctile={xrvMetrics?.[label]?.pctile ?? null}
                    display={xrvMetrics?.[label]?.display ?? "—"}
                  />
                ))
              )}
            </div>
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

      {/* === DISTRIBUTIONS (iSwing+ KDE + intercept heatmap) — MLB only === */}
      <HitterDistributions
        playerId={player.player_id}
        team={player.team}
        season={season}
        isAAA={isAAA}
      />

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
