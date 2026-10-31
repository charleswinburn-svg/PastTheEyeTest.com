import { useCallback, useRef, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { PlayerHeader, saveCardAsPng } from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";

// ═══════════════════════════════════════════════════════════
// CAPTURE PANEL
// ═══════════════════════════════════════════════════════════
// A card-style panel that shows no heading on the site but, when saved as a
// PNG, carries the same player header and footer as the player cards. The
// header/footer are rendered hidden with `data-ptet-capture-only`, which
// saveCardAsPng reveals in its html2canvas clone only. `controls` (toggles,
// selectors) render above the panel, outside the captured area.
export default function CapturePanel({
  player, season, subtitle, filename, children,
  footerLeft = null, footerRight = "PastTheEyeTest | Savant + FanGraphs",
  controls = null, saveable = true, maxWidth = 1040, style = {},
}) {
  const { theme: t } = useTheme();
  const ref = useRef(null);
  const [saving, setSaving] = useState(false);
  const save = useCallback(async () => {
    if (saving || !ref.current) return;
    setSaving(true);
    try { await saveCardAsPng(ref, filename); } finally { setSaving(false); }
  }, [saving, filename]);

  return (
    <div>
      {controls}
      {/* Rendered at its design width and scaled down to fit (phones), exactly like
          the player cards; saveCardAsPng neutralises the scale for the capture. */}
      <FitToWidth designWidth={maxWidth}>
      <div
        ref={ref}
        style={{
          background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
          overflow: "hidden", boxShadow: `0 4px 24px ${t.shadow}`,
          width: maxWidth, margin: "0 auto", ...style,
        }}
      >
        {player && (
          <div data-ptet-capture-only="" style={{ display: "none" }}>
            <PlayerHeader
              name={player.name} team={player.team} teamId={player.team_id}
              season={season} playerId={player.player_id} subtitle={subtitle}
            />
          </div>
        )}
        {children}
        <div data-ptet-capture-only="" style={{ display: "none" }}>
          <div style={{ padding: "8px 16px 10px", display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint }}>
            <span>{footerLeft ?? `${season} Season`}</span>
            <span style={{ fontStyle: "italic" }}>{footerRight}</span>
          </div>
        </div>
      </div>
      </FitToWidth>
      {saveable && (
        <div style={{ textAlign: "center", marginTop: 10 }}>
          <button
            onClick={save}
            disabled={saving}
            style={{
              padding: "6px 16px", fontSize: 11, fontWeight: 600,
              background: t.inputBg, color: t.textMuted,
              border: `1px solid ${t.inputBorder}`, borderRadius: 6,
              cursor: saving ? "wait" : "pointer", transition: "all 0.15s",
            }}
            onMouseEnter={e => { e.target.style.background = t.divider; e.target.style.color = t.text; }}
            onMouseLeave={e => { e.target.style.background = t.inputBg; e.target.style.color = t.textMuted; }}
          >
            {saving ? "Saving…" : "📥 Save as PNG"}
          </button>
        </div>
      )}
    </div>
  );
}
