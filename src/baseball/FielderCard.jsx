import { useTheme } from "./ThemeContext.jsx";
import { useRef, useCallback, useMemo, useState, useEffect } from "react";
import { BubblePercentileBar, PlayerHeader, saveCardAsPng, useBio, buildBioSubtitle } from "./SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";
import FramingZoneDiagram from "./FramingZoneDiagram.jsx";

const CATCHER_POS  = new Set(["C"]);
const INFIELD_POS  = new Set(["1B", "2B", "3B", "SS"]);
const OUTFIELD_POS = new Set(["LF", "CF", "RF"]);
const POS_ORDER = ["C", "1B", "2B", "3B", "SS", "LF", "CF", "RF"];
const ALL_TAB = "All";

function positionGroup(pos) {
  if (CATCHER_POS.has(pos))  return "catcher";
  if (INFIELD_POS.has(pos))  return "infielder";
  if (OUTFIELD_POS.has(pos)) return "outfielder";
  return null;
}

// A metric that only stands in when another row on the same card is missing
// (overall arm strength vs the position's own arm strength).
const FALLBACK_FOR = { arm_overall: "arm_strength" };
const LABEL_OVERRIDE = { arm_overall: "Arm Strength" };

// Rows that have a value, grouped into their sections in metric-list order.
// Categories are keyed by metric key (older files keyed them by label).
function buildSections(metricList, cats) {
  const sections = [];
  for (const raw of metricList) {
    const cat = cats[raw.key] ?? cats[raw.label];
    if (!cat || cat.value == null) continue;
    const primary = FALLBACK_FOR[raw.key];
    if (primary && cats[primary]?.value != null) continue;
    const m = LABEL_OVERRIDE[raw.key] ? { ...raw, label: LABEL_OVERRIDE[raw.key] } : raw;
    const name = m.section || "Overall";
    let sec = sections.find(s => s.name === name);
    if (!sec) { sec = { name, rows: [] }; sections.push(sec); }
    sec.rows.push({ m, cat });
  }
  return sections;
}

function SectionHeader({ name, first }) {
  const { theme: t } = useTheme();
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 8,
      margin: first ? "2px 0 6px" : "10px 0 6px",
      fontSize: 10, fontWeight: 700, letterSpacing: 0.6, textTransform: "uppercase",
      color: t.textFaint,
    }}>
      <span>{name}</span>
      <span style={{ flex: 1, height: 1, background: t.divider }} />
    </div>
  );
}

export default function FielderCard({ player, season, fieldingData }) {
  const { theme: t } = useTheme();
  const cardRef = useRef(null);
  const bio = useBio(player?.player_id);

  // Qualified positions, plus an "All" tab for players with 2+ of them.
  const positions = useMemo(() => {
    if (!player?.positions) return [];
    return Object.keys(player.positions).sort(
      (a, b) => POS_ORDER.indexOf(a) - POS_ORDER.indexOf(b),
    );
  }, [player]);
  const tabs = useMemo(
    () => (positions.length > 1 && player?.combined ? [ALL_TAB, ...positions] : positions),
    [positions, player],
  );

  const [activeTab, setActiveTab] = useState(tabs[0] || null);
  useEffect(() => {
    if (tabs.length && (!activeTab || !tabs.includes(activeTab))) {
      setActiveTab(tabs[0]);
    }
  }, [tabs, activeTab]);

  const saveCard = useCallback(async () => {
    if (!player || !activeTab) return;
    const safeName = (player.name || "fielder").replace(/\s+/g, "_");
    await saveCardAsPng(cardRef, `${safeName}_${activeTab}_fielder_${season}.png`);
  }, [player, activeTab, season]);

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
        No qualifying position ({"≥"}50 innings) for {player.name} in {season}.
      </div>
    );
  }

  const isAll = activeTab === ALL_TAB && !!player.combined;
  const pos = isAll ? null : (positions.includes(activeTab) ? activeTab : positions[0]);
  const posData = isAll ? player.combined : (player.positions[pos] || {});
  const cats = posData.categories || {};
  const innings = posData.innings || 0;
  let metricList;
  if (isAll) {
    metricList = fieldingData?.all_metrics || [];
  } else {
    const group = positionGroup(pos);
    metricList = ((group && fieldingData?.[`${group}_metrics`]) || [])
      .filter(m => !m.positions || m.positions.includes(pos));
  }

  const sections = buildSections(metricList, cats);
  const zones = !isAll && pos === "C" ? posData.framing_zones : null;
  if (zones && !sections.some(s => s.name === "Framing")) {
    sections.splice(Math.min(1, sections.length), 0, { name: "Framing", rows: [] });
  }

  const posSummary = isAll
    ? Object.entries(player.combined.positions || {}).map(([p, inn]) => `${p} ${Math.round(inn)}`).join(" · ")
    : null;
  const tabLabel = isAll ? `All (${posSummary})` : pos;
  const sources = (fieldingData?.meta?.sources || ["Savant", "FanGraphs", "BP"]).join(" + ");

  return (
    <div>
      {/* Tab selector (only shows for players with 2+ qualified positions) */}
      {tabs.length > 1 && (
        <div style={{ display: "flex", gap: 6, justifyContent: "center", marginBottom: 12, flexWrap: "wrap" }}>
          {tabs.map(p => (
            <button
              key={p}
              onClick={() => setActiveTab(p)}
              style={{
                padding: "6px 14px", fontSize: 12,
                fontWeight: activeTab === p ? 700 : 600,
                color: activeTab === p ? "#fff" : t.textSecondary,
                background: activeTab === p ? t.accent : t.inputBg,
                border: `1px solid ${activeTab === p ? t.accent : t.inputBorder}`,
                borderRadius: 6, cursor: "pointer", fontFamily: "inherit",
                transition: "all 0.15s",
              }}
            >
              {p}
            </button>
          ))}
        </div>
      )}

      <FitToWidth designWidth={600}>
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
          subtitle={buildBioSubtitle(bio, null) || `${season} | ${tabLabel} | ${innings.toFixed(0)} Innings`}
        />
        <div style={{ padding: "8px 12px 4px" }}>
          {sections.map((sec, i) => (
            <div key={sec.name}>
              <SectionHeader name={sec.name} first={i === 0} />
              {sec.rows.map(({ m, cat }) => (
                <BubblePercentileBar
                  key={m.key}
                  label={m.label}
                  labelWidth={150}
                  pctile={cat.pctile}
                  display={cat.display}
                />
              ))}
              {sec.name === "Framing" && zones && <FramingZoneDiagram zones={zones} />}
            </div>
          ))}
        </div>
        <div style={{
          padding: "8px 16px 10px",
          display: "flex", justifyContent: "space-between", gap: 12,
          fontSize: 10, color: t.textFaint,
        }}>
          <span>
            {season} | {tabLabel} | {innings.toFixed(0)} Innings (min 50)
            {isAll && ` | pctiles vs primary ${player.combined.primary}`}
          </span>
          <span style={{ fontStyle: "italic", whiteSpace: "nowrap" }}>PastTheEyeTest | {sources}</span>
        </div>
      </div>
      </FitToWidth>

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
