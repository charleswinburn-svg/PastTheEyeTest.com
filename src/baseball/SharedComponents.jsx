import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, CartesianGrid, ReferenceLine } from "recharts";
import { useTheme } from "./ThemeContext.jsx";

// ── Percentile bin colors ──
export const BIN_COLORS = {
  "0-10": "#08306B", "10-25": "#2171B5", "25-45": "#6BAED6",
  "45-55": "#D9D9D9", "55-75": "#FC9272", "75-90": "#FB6A4A", "90-100": "#CB181D",
};
export const pctToBin = (p) => {
  if (p == null || !isFinite(p)) return "NA";
  if (p >= 90) return "90-100"; if (p >= 75) return "75-90";
  if (p >= 55) return "55-75";  if (p >= 45) return "45-55";
  if (p >= 25) return "25-45";  if (p >= 10) return "10-25";
  return "0-10";
};
export const binColor = (p) => BIN_COLORS[pctToBin(p)] || "#333";
export const textOnBin = (p) => {
  if (p == null) return "#aaa";
  return (p < 25 || p >= 75) ? "#fff" : "#111";
};

// ── MLB Team ID mapping (for logos) ──

// Strip diacritics for accent-insensitive matching
export const norm = s => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();

// Fuzzy name key: strip accents, periods, commas, Jr/Sr suffixes, extra spaces
const nameKey = s => norm(s).replace(/[.\-,]/g, "").replace(/\b(jr|sr|ii|iii|iv)\b/g, "").replace(/\s+/g, " ").trim();

// Fuzzy lookup into an object by normalized name
export function fuzzyLookup(obj, name) {
  if (!obj || !name) return undefined;
  // Try exact match first
  if (obj[name] !== undefined) return obj[name];
  // Normalize and search
  const key = nameKey(name);
  for (const [k, v] of Object.entries(obj)) {
    if (nameKey(k) === key) return v;
  }
  return undefined;
}

export const TEAM_IDS = {
  ARI: 109, ATL: 144, BAL: 110, BOS: 111, CHC: 112, CHW: 145, CIN: 113,
  CLE: 114, COL: 115, DET: 116, HOU: 117, KCR: 118, KC: 118, LAA: 108,
  LAD: 119, MIA: 146, MIL: 158, MIN: 142, NYM: 121, NYY: 147, OAK: 133, ATH: 133,
  PHI: 143, PIT: 134, SDP: 135, SD: 135, SEA: 136, SFG: 137, SF: 137,
  STL: 138, TBR: 139, TB: 139, TEX: 140, TOR: 141, WSH: 120, WSN: 120,
};

export function getHeadshotUrl(playerId) {
  if (!playerId) return null;
  return `/mlb-photos/mlb-photos/image/upload/d_people:generic:headshot:67:current.png/w_213,h_213,c_thumb,g_face,q_auto:best/v1/people/${playerId}/headshot/67/current`;
}

export function getLogoUrl(teamAbbr) {
  const tid = TEAM_IDS[teamAbbr?.toUpperCase()];
  if (!tid) return null;
  return `/mlb-logos/v1/team/${tid}/spots/128`;
}


// ═══════════════════════════════════════════════════════════
// BUBBLE PERCENTILE BAR
// ═══════════════════════════════════════════════════════════

export function BubblePercentileBar({ label, pctile, display }) {
  const { theme: t } = useTheme();
  const hasValue = pctile != null && isFinite(pctile);
  const barWidth = hasValue ? Math.max(3, pctile) : 0;
  const bubbleSize = 26;
  const barHeight = 22;
  const color = binColor(pctile);
  const txtColor = textOnBin(pctile);

  return (
    <div style={{
      display: "flex", alignItems: "center", marginBottom: 6,
    }}>
      {/* Label */}
      <div style={{
        width: 130, textAlign: "right", fontSize: 11, fontWeight: 500,
        color: t.text, flexShrink: 0, lineHeight: 1.2,
        marginRight: 6,
      }}>
        {label}
      </div>

      {/* Bar track + bubble */}
      <div style={{
        flex: 1, position: "relative", height: bubbleSize + 2,
        display: "flex", alignItems: "center",
      }}>
        {/* Track background */}
        <div style={{
          position: "absolute", left: 0, right: 0,
          top: "50%", transform: "translateY(-50%)",
          height: barHeight, background: t.inputBg,
          borderRadius: 4, border: `1px solid ${t.inputBorder}`,
        }} />

        {/* Filled bar */}
        {hasValue && (
          <div style={{
            position: "absolute", left: 0,
            top: "50%", transform: "translateY(-50%)",
            width: `${barWidth}%`, height: barHeight,
            background: `linear-gradient(90deg, ${color}cc, ${color})`,
            borderRadius: 4,
            transition: "width 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
          }} />
        )}

        {/* Bubble */}
        {hasValue && (
          <div style={{
            position: "absolute",
            left: `${barWidth}%`,
            top: "50%",
            transform: "translate(-50%, -50%)",
            width: bubbleSize, height: bubbleSize,
            borderRadius: "50%",
            background: color,
            border: `2px solid ${t.bg}`,
            display: "flex", alignItems: "center", justifyContent: "center",
            boxShadow: "0 1px 4px rgba(0,0,0,0.5)",
            transition: "left 0.6s cubic-bezier(0.25, 0.46, 0.45, 0.94)",
            zIndex: 2,
          }}>
            <span style={{
              fontSize: 10, fontWeight: 800,
              color: txtColor,
              fontFamily: "'DM Mono', monospace",
              lineHeight: 1,
            }}>
              {Math.round(pctile)}
            </span>
          </div>
        )}

        {/* N/A state */}
        {!hasValue && (
          <div style={{
            position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)",
            fontSize: 10, color: t.textFaintest, fontStyle: "italic",
          }}>
            N/A
          </div>
        )}
      </div>

      {/* Raw value */}
      <div style={{
        width: 52, textAlign: "right", fontSize: 11, fontWeight: 600,
        color: hasValue ? t.textSecondary : t.textFaintest,
        fontFamily: "'DM Mono', monospace",
        flexShrink: 0, marginLeft: 6,
      }}>
        {display || "—"}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// PLAYER HEADER
// ═══════════════════════════════════════════════════════════

export function PlayerHeader({ name, team, season, playerId, subtitle }) {
  const { theme: t } = useTheme();
  const headshot = getHeadshotUrl(playerId);
  const logo = getLogoUrl(team);

  return (
    <div style={{
      display: "flex", alignItems: "center", justifyContent: "space-between",
      padding: "16px 20px 10px", gap: 16,
    }}>
      {/* Headshot */}
      <div style={{
        width: 72, height: 72, borderRadius: "50%", background: t.inputBg,
        overflow: "hidden", border: `2px solid ${t.inputBorder}`, flexShrink: 0, position: "relative",
        display: "flex", alignItems: "center", justifyContent: "center",
      }}>
        <span style={{ fontSize: 22, fontWeight: 700, color: t.textFaintest, position: "absolute" }}>
          {name ? name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) : ""}
        </span>
        {headshot && (
          <img
            src={headshot} alt=""
           
            style={{ width: "100%", height: "100%", objectFit: "cover", position: "relative", zIndex: 1 }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>

      {/* Name + subtitle */}
      <div style={{ flex: 1, textAlign: "center" }}>
        <div style={{ fontSize: 20, fontWeight: 800, color: t.text, letterSpacing: "-0.02em" }}>
          {name}
        </div>
        <div style={{ fontSize: 11, color: t.textMuted, marginTop: 2, letterSpacing: "0.04em" }}>
          {subtitle || `${team ? `${team} | ` : ""}${season} Season`}
        </div>
      </div>

      {/* Logo */}
      <div style={{ width: 72, height: 72, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {logo && (
          <img
            src={logo} alt={team}
           
            style={{ width: 72, height: 72, objectFit: "contain", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.5))" }}
            onError={e => { e.target.style.display = "none"; }}
          />
        )}
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// TREND CHART
// ═══════════════════════════════════════════════════════════

export function TrendChart({ data, metricLabel, metricKey }) {
  const { theme: t } = useTheme();
  if (!data || data.length < 2) return null;

  const sorted = [...data]
    .filter(d => d[metricKey] != null)
    .sort((a, b) => a.season - b.season);

  if (sorted.length < 2) return null;

  return (
    <div style={{ padding: "8px 12px 0" }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: t.textMuted, textAlign: "center", marginBottom: 4 }}>
        {metricLabel} — 3-Year Trend
      </div>
      <ResponsiveContainer width="100%" height={140}>
        <LineChart data={sorted} margin={{ top: 8, right: 16, bottom: 4, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={t.cardBorder} />
          <XAxis
            dataKey="season" tick={{ fill: t.textMuted, fontSize: 11 }}
            tickLine={false} axisLine={{ stroke: t.divider }}
          />
          <YAxis
            tick={{ fill: t.textFaint, fontSize: 10 }} tickLine={false}
            axisLine={false} width={36}
          />
          <Line
            type="monotone" dataKey={metricKey}
            stroke="#d22d49" strokeWidth={2.5}
            dot={{ r: 4, fill: "#d22d49", stroke: t.headerBg, strokeWidth: 2 }}
          />
          <ReferenceLine y={0} stroke={t.textFaintest} strokeDasharray="4 4" />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// METRIC SELECTOR (for trend chart)
// ═══════════════════════════════════════════════════════════

export function MetricSelector({ metrics, selected, onChange }) {
  const { theme: t } = useTheme();
  return (
    <div style={{ padding: "4px 16px 8px", display: "flex", alignItems: "center", gap: 8 }}>
      <span style={{ fontSize: 10, color: t.textFaint }}>Trend:</span>
      <select
        value={selected}
        onChange={e => onChange(e.target.value)}
        style={{
          padding: "3px 8px", background: t.inputBg, border: `1px solid ${t.inputBorder}`,
          borderRadius: 4, color: t.textSecondary, fontSize: 11, outline: "none",
          fontFamily: "inherit",
        }}
      >
        {metrics.map(m => (
          <option key={m.label} value={m.label}>{m.label}</option>
        ))}
      </select>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// PNG EXPORT HELPERS
// ═══════════════════════════════════════════════════════════

export async function convertImagesForCapture(container) {
  const imgs = [...container.querySelectorAll("img")];
  const originals = [];
  await Promise.allSettled(imgs.map(async (img) => {
    if (!img.src || img.src.startsWith("data:") || !img.naturalWidth) return;
    try {
      const resp = await fetch(img.src);
      const blob = await resp.blob();
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(reader.result);
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
      originals.push({ img, orig: img.src });
      img.src = dataUrl;
    } catch (e) { /* skip failed images */ }
  }));
  await new Promise(r => setTimeout(r, 150));
  return originals;
}

export function restoreImages(originals) {
  originals.forEach(({ img, orig }) => { img.src = orig; });
}

export async function saveCardAsPng(cardRef, filename) {
  if (!cardRef.current) return;
  const originals = await convertImagesForCapture(cardRef.current);
  try {
    const html2canvas = (await import("html2canvas")).default;
    const canvas = await html2canvas(cardRef.current, { backgroundColor: "#0d0d0d", scale: 2, logging: false });
    const link = document.createElement("a");
    link.download = filename;
    link.href = canvas.toDataURL("image/png");
    link.click();
  } catch (e) {
    console.error("Save failed:", e);
  }
  restoreImages(originals);
}
