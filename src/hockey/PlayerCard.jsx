import { useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "../baseball/ThemeContext.jsx";
import { NUM_FONT, BubblePercentileBar, saveCardAsPng } from "../baseball/SharedComponents.jsx";
import FitToWidth from "../FitToWidth.jsx";
import ImpactChart from "./ImpactChart.jsx";
import { spectrum, spectrumRgb, inkOn, luminance, POSITIVE, NEGATIVE } from "./nhlColors.js";
import {
  skaterRows, goalieRows, rawValue, SKATER_PARTS, GOALIE_PARTS, skaterZ, goalieZ, zScores,
  GOALIE_TOTALS, MEASURES, POSITION_NAME, GROUP_NAME, VERSIONS, fixed, whole,
} from "./rows.js";
import { seasonLabel, logoUrl, headshotUrl, headshotFallback, flagUrl, NHL_TEAM_PRIMARY } from "./nhlData.js";

// The card header keeps the site's type (the same face the MLB card headers use);
// everything under it is set in Pliant.
const SITE_FONT = "'Inter', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif";

// Every size on the card, for the two layouts. "wide" is the two-column card on a desktop;
// "narrow" is the single column used on tablets and phones (then scaled to fit by FitToWidth).
const SIZES = {
  wide:   { width: 1320, pad: 28, name: 30, sub: 13, img: 88, flag: 21, tileLabel: 12, tileValue: 36, tier: 14, section: 14,
            row: 44, box: 16, rowGap: 6, label: 17, labelW: 172, valueW: 86, num: 23, num3: 19,
            bar: 24, barGap: 15, barLabelW: 208, barValueW: 62, chartH: 310, foot: 12 },
  narrow: { width: 640, pad: 20, name: 22, sub: 11, img: 68, flag: 16, tileLabel: 10, tileValue: 26, tier: 12, section: 12,
            row: 34, box: 10, rowGap: 5, label: 14, labelW: 128, valueW: 62, num: 18, num3: 14,
            bar: 18, barGap: 8, barLabelW: 164, barValueW: 52, chartH: 290, foot: 10 },
};

// ═══════════════════════════════════════════════════════════
// HEADER
// ═══════════════════════════════════════════════════════════
function Headshot({ id, team, season, ring, size }) {
  const first = headshotUrl(id, team, season);
  const [src, setSrc] = useState(first);
  useEffect(() => { setSrc(first); }, [first]);
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", background: ring, overflow: "hidden",
                  border: `2px solid ${ring}`, flexShrink: 0, position: "relative" }}>
      {src && <img src={src} alt="" style={{ position: "absolute", inset: 0, width: "100%", height: "100%", objectFit: "cover" }}
        onError={() => setSrc(s => (s && s !== headshotFallback(id) ? headshotFallback(id) : null))} />}
    </div>
  );
}

export function CardHeader({ name, team, flag, subtitle, playerId, season, k }) {
  const bg = NHL_TEAM_PRIMARY[team] || "#1e293b";
  const light = luminance(bg) > 0.179;
  const ink = light ? "#111111" : "#ffffff";
  const sub = light ? "rgba(0,0,0,0.62)" : "rgba(255,255,255,0.74)";
  const ring = light ? "rgba(0,0,0,0.2)" : "rgba(255,255,255,0.25)";
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16,
                  padding: `${k.pad - 4}px ${k.pad}px ${k.pad - 6}px`, background: bg, fontFamily: SITE_FONT }}>
      <div style={{ width: k.img, height: k.img, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "center" }}>
        {team && <img src={logoUrl(team)} alt={team} style={{ width: k.img, height: k.img, objectFit: "contain", filter: "drop-shadow(0 2px 8px rgba(0,0,0,0.4))" }}
          onError={e => { e.currentTarget.style.display = "none"; }} />}
      </div>
      <div style={{ flex: 1, textAlign: "center", minWidth: 0 }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 9 }}>
          <span style={{ fontSize: k.name, fontWeight: 800, color: ink, letterSpacing: "-0.02em" }}>{name}</span>
          {flag && <img src={flagUrl(flag)} alt={flag.toUpperCase()} title={flag.toUpperCase()}
            style={{ height: k.flag, border: "1px solid rgba(255,255,255,0.45)", borderRadius: 2 }}
            onError={e => { e.currentTarget.style.display = "none"; }} />}
        </div>
        <div style={{ fontSize: k.sub, color: sub, marginTop: 5, letterSpacing: "0.06em", fontStyle: "italic", fontWeight: 600, textTransform: "uppercase" }}>
          {subtitle}
        </div>
      </div>
      <Headshot id={playerId} team={team} season={season} ring={ring} size={k.img} />
    </div>
  );
}

// html2canvas does not draw SVG <img>s (the team logos), so for the capture each one is
// redrawn as a PNG at three times its size. Returns a function that puts the originals back.
async function rasterizeSvgImages(root) {
  const swapped = [];
  await Promise.all([...root.querySelectorAll("img")].map(async img => {
    if (!/\.svg(\?|$)/i.test(img.src)) return;
    try {
      const w = img.offsetWidth || 64, h = img.offsetHeight || 64, canvas = document.createElement("canvas");
      canvas.width = w * 3; canvas.height = h * 3;
      const im = new Image();
      im.src = img.src;
      await im.decode();
      const iw = im.naturalWidth || w, ih = im.naturalHeight || h, f = Math.min(canvas.width / iw, canvas.height / ih);
      canvas.getContext("2d").drawImage(im, (canvas.width - iw * f) / 2, (canvas.height - ih * f) / 2, iw * f, ih * f);
      const original = img.src;
      img.src = canvas.toDataURL("image/png");
      await img.decode();
      swapped.push([img, original]);
    } catch { /* leave the logo as it is */ }
  }));
  return () => swapped.forEach(([img, src]) => { img.src = src; });
}

// ═══════════════════════════════════════════════════════════
// PERCENTILE ROWS: 100 boxes, the player's box raised
// ═══════════════════════════════════════════════════════════
// The raised box is a square exactly as tall as the row, so it is as large as it can be
// without touching the rows above and below. The strip of small boxes is inset by half a
// square on each side, so the square never hangs over an edge at the 1st or 100th percentile.
function SpectrumRow({ pct, isDark, t, k }) {
  const ROW = k.row, BOX = k.box;
  const here = pct == null ? null : Math.min(99, Math.max(0, Math.floor(pct)));
  const cells = useMemo(() => Array.from({ length: 100 }, (_, i) => (
    <div key={i} style={{ flex: 1, height: BOX, borderRadius: 1.5,
                          background: here == null ? t.textFaintest : spectrum(i + 0.5, isDark),
                          opacity: here == null ? 0.28 : 0.5 }} />
  )), [here == null, isDark, t.textFaintest, BOX]);
  const rgb = here == null ? null : spectrumRgb(here + 0.5, isDark);
  return (
    <div style={{ position: "relative", height: ROW }}>
      <div style={{ position: "absolute", left: ROW / 2, right: ROW / 2, top: (ROW - BOX) / 2, display: "flex", gap: 1 }}>{cells}</div>
      {here != null && (
        <div style={{
          position: "absolute", top: 0, left: `calc((100% - ${ROW}px) * ${(here + 0.5) / 100})`, width: ROW, height: ROW,
          borderRadius: Math.round(ROW / 5), background: `rgb(${rgb.join(",")})`, color: inkOn(rgb), boxShadow: `0 0 0 2px ${t.cardBg}`,
          display: "flex", alignItems: "center", justifyContent: "center",
          fontSize: pct >= 99.5 ? k.num3 : k.num, fontWeight: 800, lineHeight: 1 }}>
          {Math.round(pct)}
        </div>
      )}
    </div>
  );
}

function PercentileRows({ p, rows, style, isDark, t, k }) {
  if (style === "bars") {
    return <div>{rows.map(([label, col, tip]) => (
      <div key={col} title={tip}><BubblePercentileBar label={label} pctile={p[col]} display={rawValue(p, col) || "–"} labelWidth={k.labelW} /></div>
    ))}</div>;
  }
  return (
    <div style={{ display: "grid", gridTemplateColumns: `${k.labelW}px 1fr ${k.valueW}px`, rowGap: k.rowGap, columnGap: 10, alignItems: "center" }}>
      {rows.map(([label, col, tip]) => {
        const raw = rawValue(p, col), ranked = p[col] != null;
        return [
          <div key={col + "l"} title={tip} style={{ textAlign: "right", fontSize: k.label, fontWeight: 600, color: t.textSecondary, whiteSpace: "nowrap" }}>{label}</div>,
          <div key={col + "b"} title={`${label}: ${ranked ? Math.round(p[col]) : "not ranked"}. ${tip}`}><SpectrumRow pct={p[col]} isDark={isDark} t={t} k={k} /></div>,
          <div key={col + "v"} style={{ textAlign: "right", fontSize: k.label, fontWeight: ranked ? 700 : 500, whiteSpace: "nowrap",
                                         color: raw && ranked ? t.text : t.textFaint }}>{raw || "n/a"}</div>,
        ];
      })}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// SIGNED BARS: right and red adds value, left and blue costs value
// ═══════════════════════════════════════════════════════════
function SignedRows({ rows, limit, labelWidth, t, k }) {
  return (
    <div style={{ flex: 1, display: "grid", gridTemplateColumns: `${labelWidth}px 1fr ${k.barValueW}px`, rowGap: k.barGap, columnGap: 12,
                  alignItems: "center", alignContent: "space-between" }}>
      {rows.map(({ label, value, text, tip }) => {
        const w = value == null ? 0 : Math.min(Math.abs(value), limit) / limit * 50;
        return [
          <div key={label + "l"} title={tip} style={{ textAlign: "right", fontSize: k.label, fontWeight: 600, color: t.textSecondary, whiteSpace: "nowrap" }}>{label}</div>,
          <div key={label + "b"} title={tip} style={{ position: "relative", height: k.bar, borderRadius: 4, background: t.inputBg }}>
            {value != null && w > 0 && (
              <div style={{ position: "absolute", top: 0, bottom: 0, width: `${w}%`, background: value >= 0 ? POSITIVE : NEGATIVE,
                            ...(value >= 0 ? { left: "50%", borderRadius: "0 4px 4px 0" } : { right: "50%", borderRadius: "4px 0 0 4px" }) }} />
            )}
            <div style={{ position: "absolute", left: "50%", top: -3, bottom: -3, width: 2, marginLeft: -1, background: t.textFaint }} />
          </div>,
          <div key={label + "v"} style={{ textAlign: "right", fontSize: k.label, fontWeight: value == null ? 500 : 700,
                                           color: value == null ? t.textFaint : t.text }}>{text}</div>,
        ];
      })}
    </div>
  );
}

function Section({ title, right, children, t, k, grow }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", flex: grow ? `${grow} 1 auto` : undefined, minWidth: 0 }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, marginBottom: Math.round(k.section * 0.9) }}>
        <div style={{ fontSize: k.section, fontWeight: 800, color: t.text, letterSpacing: "0.07em", textTransform: "uppercase" }}>{title}</div>
        {right}
      </div>
      {children}
    </div>
  );
}

export function Segmented({ value, options, onChange, t, small }) {
  return (
    <div data-html2canvas-ignore={small ? "" : undefined} style={{ display: "inline-flex", border: `1px solid ${t.inputBorder}`, borderRadius: 6, overflow: "hidden", flexShrink: 0 }}>
      {options.map(([id, label]) => (
        <button key={id} onClick={() => onChange(id)}
          style={{ padding: small ? "3px 10px" : "6px 12px", fontSize: small ? 11 : 12, fontWeight: value === id ? 800 : 600, fontFamily: "inherit",
                   background: value === id ? `${t.accent}26` : "transparent", color: value === id ? t.accent : t.textMuted,
                   border: "none", borderLeft: id === options[0][0] ? "none" : `1px solid ${t.inputBorder}`, cursor: "pointer", whiteSpace: "nowrap" }}>
          {label}
        </button>
      ))}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// THE CARD
// ═══════════════════════════════════════════════════════════
export default function PlayerCard({ p, kind, v, season, seasonDone, zRef, history, seasons, inProgressSeason, wide, pctStyle }) {
  const { theme: t, isDark } = useTheme();
  const cardRef = useRef(null);
  const [measure, setMeasure] = useState("WAR");
  const [saving, setSaving] = useState(false);
  const [showNumbers, setShowNumbers] = useState(false);
  if (!p) return <div style={{ color: t.textFaint, padding: 40, textAlign: "center" }}>Select a player</div>;

  const goalie = kind === "goalies";
  const group = GROUP_NAME[p.pos_group] || "skaters";
  const inProgress = seasonDone < 1;
  const seasonText = seasonLabel(season) + (inProgress ? " (in progress)" : "");
  const version = VERSIONS.find(x => x.id === v);
  const k = wide ? SIZES.wide : SIZES.narrow, width = k.width;
  // Wide: two columns. Left holds the percentiles with the impact chart directly under them;
  // right holds the WAR breakdown and the z-scores, spread to the same height. Narrow: one
  // column in that same order.
  const COL_GAP = 40, inner = width - 2 * k.pad, leftW = wide ? Math.round((inner - COL_GAP) * 0.62) : inner;

  const subtitle = [p.team, goalie ? "Goalie" : (POSITION_NAME[p.position] || p.position), seasonText,
    (goalie ? p.games : p.gp) ? `${whole(goalie ? p.games : p.gp)} GP` : null,
    goalie ? `${whole(p.shots)} shots faced` : (p.min_5v5_1y != null ? `${whole(p.min_5v5_1y)} min 5v5` : null),
  ].filter(Boolean).join(" | ");

  // The three headline boxes: the same value three ways, in the ratings version being shown.
  const span = v === "3y" ? "3-year" : "this season";
  const tiles = [
    ["WAR", "Wins above replacement", p[`war_${v}`], goalie
      ? "Wins above replacement, built on goals saved above expected (GSAx), not raw saves."
      : "Goals above replacement divided by the number of goals a win costs."],
    ["GAR", goalie ? "Goals saved above replacement" : "Goals above replacement", p[`gar_${v}`],
      "Value against a replacement-level player in the same workload, in goals."],
    ["GAA", goalie ? "Goals saved above average" : "Goals above average", p[`gaa_${v}`],
      "Value against a league-average player in the same workload, in goals."],
  ].map(([label, name, value, tip]) => [label, name, fixed(value, 1),
    `${name}, ${v === "3y" ? "a typical season at his 3-year level" : "from this season alone"}. ${tip}`]);

  const rows = goalie ? goalieRows(v) : skaterRows(v);
  const parts = (goalie ? GOALIE_PARTS : SKATER_PARTS)
    .map(([label, stem, tip]) => ({ label, value: p[`${stem}_${v}`], tip }))
    .filter(x => x.value != null && !((x.label === "Setup results" || x.label === "Rebound control") && Math.abs(x.value) < 1e-9));
  const partLimit = Math.max(0.5, ...parts.map(x => Math.abs(x.value)));
  const zs = zScores(p, goalie ? goalieZ(v) : skaterZ(v), zRef?.[v]?.[p.pos_group]);
  const zForAvg = zs.filter(z => z.z != null && !(!goalie && z.label.startsWith("Quality")));
  const zAvg = zForAvg.length ? zForAvg.reduce((s, z) => s + z.z, 0) / zForAvg.length : null;
  const mine = history?.players?.[String(p.player_id)] || [];
  const unit = MEASURES.find(m => m.id === measure).unit;

  const notice = goalie
    ? (p[`war_${v}_pct`] == null ? "Too few shots faced to be ranked in these percentiles." : null)
    : (p.active === false ? "Under the minutes cutoff this season, so he is not ranked in the 3-year percentiles." : null);

  const percentiles = (
    <Section t={t} k={k} title={`Percentiles among ${group}`}>
      <PercentileRows p={p} rows={rows} style={pctStyle} isDark={isDark} t={t} k={k} />
    </Section>
  );
  const breakdown = (
    <Section t={t} k={k} grow={parts.length} title="Where his WAR comes from">
      <SignedRows t={t} k={k} limit={partLimit} labelWidth={k.barLabelW}
        rows={parts.map(x => ({ label: x.label, value: x.value, text: fixed(x.value, 2), tip: `${x.label}: ${fixed(x.value, 2)} wins. ${x.tip}` }))} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: k.barGap, paddingTop: 10, borderTop: `1px solid ${t.divider}`,
                    fontSize: k.label, fontWeight: 800, color: t.text }}>
        <span>Total (WAR, {version.label})</span><span>{fixed(p[`war_${v}`], 2)}</span>
      </div>
    </Section>
  );
  const zscores = (
    <Section t={t} k={k} grow={zs.length} title="Against the league average (z-score)">
      <SignedRows t={t} k={k} limit={3} labelWidth={k.barLabelW}
        rows={zs.map(z => ({ label: z.label, value: z.z, text: z.z == null ? "n/a" : fixed(z.z, 2),
          tip: z.z == null ? "Not ranked on this row" : `${z.label}: ${fixed(z.value, 3)} against a league average of ${fixed(z.mean, 3)} (${z.n} ${group})` }))} />
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: k.barGap, paddingTop: 10, borderTop: `1px solid ${t.divider}`,
                    fontSize: k.label, fontWeight: 800, color: t.text }}
        title={goalie ? "The mean of the z-scores above that he is ranked on." : "The mean of the z-scores above that he is ranked on, leaving out quality of competition and teammates."}>
        <span>{goalie ? "Average z-score" : "Average z-score, performance rows"}</span><span>{zAvg == null ? "–" : fixed(zAvg, 2)}</span>
      </div>
    </Section>
  );
  const chart = (
    <Section t={t} k={k} title={`Impact by season · ${unit}`}
      right={<Segmented small t={t} value={measure} onChange={setMeasure} options={MEASURES.map(m => [m.id, m.id])} />}>
      <ImpactChart rows={mine} cuts={history?.cuts?.[p.pos_group]} pos={p.pos_group} seasons={seasons}
        inProgress={inProgressSeason} measure={measure} width={leftW} height={k.chartH} big={wide} t={t} />
    </Section>
  );

  const save = async () => {
    if (saving) return;
    setSaving(true);
    try {
      if (document.fonts?.ready) await document.fonts.ready;
      const restore = await rasterizeSvgImages(cardRef.current);
      try { await saveCardAsPng(cardRef, `${p.player}_${seasonLabel(season)}_${v}.png`.replace(/\s+/g, "_")); }
      finally { restore(); }
    } finally { setSaving(false); }
  };
  const btn = { padding: "6px 16px", fontSize: 11, fontWeight: 600, background: t.inputBg, color: t.textMuted,
                border: `1px solid ${t.inputBorder}`, borderRadius: 6, cursor: "pointer", fontFamily: "inherit" };

  return (
    <div>
      <FitToWidth designWidth={width}>
        <div ref={cardRef} style={{ width, background: t.cardBg, borderRadius: 12, border: `1px solid ${t.cardBorder}`,
                                    overflow: "hidden", boxShadow: `0 4px 24px ${t.shadow}` }}>
          <CardHeader name={p.player} team={p.team} flag={p.flag} subtitle={subtitle} playerId={p.player_id} season={season} k={k} />
          <div style={{ padding: `${k.pad - 4}px ${k.pad}px 6px`, fontFamily: NUM_FONT, color: t.text, display: "grid", rowGap: k.pad }}>
            <div>
              <div style={{ display: "grid", gridTemplateColumns: `repeat(${tiles.length}, 1fr)`, gap: wide ? 12 : 8 }}>
                {tiles.map(([label, name, value, tip]) => (
                  <div key={label} title={tip} style={{ background: t.inputBg, border: `1px solid ${t.cardBorder}`, borderRadius: 10, padding: wide ? "12px 16px 11px" : "9px 12px 9px" }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", gap: 8, fontSize: k.tileLabel, fontWeight: 700,
                                  letterSpacing: "0.05em", textTransform: "uppercase", whiteSpace: "nowrap" }}>
                      <span style={{ color: t.text, fontWeight: 800 }}>{label}</span>
                      <span style={{ color: t.textFaint }}>{span}</span>
                    </div>
                    <div style={{ fontSize: k.tileValue, fontWeight: 800, color: t.text, lineHeight: 1.15, marginTop: 2 }}>{value}</div>
                    <div style={{ fontSize: k.tileLabel, fontWeight: 600, color: t.textMuted, marginTop: 1, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{name}</div>
                  </div>
                ))}
              </div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: "4px 14px", marginTop: 12, fontSize: k.tier, fontWeight: 600, color: t.textMuted }}>
                {p.tier_WAR && <span>Impact tier this season: <b style={{ color: t.text }}>{p.tier_WAR}</b></span>}
                {notice && <span style={{ color: t.accent }}>{notice}</span>}
              </div>
            </div>
            {wide ? (
              <div style={{ display: "grid", gridTemplateColumns: `${leftW}px 1fr`, columnGap: COL_GAP, alignItems: "stretch" }}>
                <div style={{ display: "grid", rowGap: k.pad, alignContent: "start" }}>{percentiles}{chart}</div>
                <div style={{ display: "flex", flexDirection: "column", gap: k.pad }}>{breakdown}{zscores}</div>
              </div>
            ) : <>{percentiles}{chart}{breakdown}{zscores}</>}
          </div>
          <div style={{ padding: `12px ${k.pad}px 14px`, display: "flex", justifyContent: "space-between", gap: 12, fontSize: k.foot,
                        color: t.textFaint, fontFamily: NUM_FONT, fontWeight: 600 }}>
            <span>{seasonText} | {version.long} | ranked among {group}</span>
            <span style={{ fontStyle: "italic" }}>PastTheEyeTest</span>
          </div>
        </div>
      </FitToWidth>

      <div style={{ maxWidth: width, margin: "10px auto 0", display: "flex", justifyContent: "space-between", gap: 8, fontFamily: NUM_FONT }}>
        <button style={btn} onClick={() => setShowNumbers(s => !s)}>{showNumbers ? "Hide the numbers" : "Show the numbers"}</button>
        <button style={{ ...btn, cursor: saving ? "wait" : "pointer" }} onClick={save} disabled={saving}>{saving ? "Saving…" : "Save as PNG"}</button>
      </div>
      {showNumbers && <Numbers p={p} goalie={goalie} rows={rows} parts={parts} zs={zs} mine={mine} v={v} t={t} width={width} />}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// THE NUMBERS BEHIND EVERY GRAPHIC
// ═══════════════════════════════════════════════════════════
function Table({ title, head, rows, t }) {
  const cell = { padding: "5px 10px", fontSize: 12, borderBottom: `1px solid ${t.tableBorder}`, whiteSpace: "nowrap" };
  return (
    <div style={{ minWidth: 0 }}>
      <div style={{ fontSize: 11, fontWeight: 800, color: t.textMuted, letterSpacing: "0.07em", textTransform: "uppercase", margin: "0 0 6px" }}>{title}</div>
      <div style={{ overflowX: "auto", border: `1px solid ${t.tableBorder}`, borderRadius: 8 }}>
        <table style={{ width: "100%", borderCollapse: "collapse", background: t.tableRowA }}>
          <thead><tr>{head.map((h, i) => <th key={h} style={{ ...cell, textAlign: i ? "right" : "left", color: t.textMuted, fontSize: 11, background: t.tableHeaderBg }}>{h}</th>)}</tr></thead>
          <tbody>{rows.map((r, k) => (
            <tr key={k} style={{ background: k % 2 ? t.tableRowB : t.tableRowA }}>
              {r.map((c, i) => <td key={i} style={{ ...cell, textAlign: i ? "right" : "left", color: i ? t.text : t.textSecondary, fontWeight: i ? 700 : 500 }}>{c}</td>)}
            </tr>
          ))}</tbody>
        </table>
      </div>
    </div>
  );
}

function Numbers({ p, goalie, rows, parts, zs, mine, v, t, width }) {
  return (
    <div style={{ maxWidth: width, margin: "14px auto 0", display: "grid", gap: 16, fontFamily: NUM_FONT,
                  gridTemplateColumns: width > 700 ? "1fr 1fr" : "1fr" }}>
      <Table t={t} title="Percentiles" head={["Row", "Percentile", "Rating"]}
        rows={rows.map(([label, col]) => [label, p[col] == null ? "–" : Math.round(p[col]), rawValue(p, col) || "–"])} />
      <Table t={t} title="WAR breakdown" head={["Part", "Wins"]}
        rows={[...parts.map(x => [x.label, fixed(x.value, 3)]), ["Total (WAR)", fixed(p[`war_${v}`], 3)]]} />
      <Table t={t} title="By season" head={["Season", "Team", "WAR", "GAR", "GAA", "Tier"]}
        rows={mine.map(r => [seasonLabel(r[0]), r[1], fixed(r[2], 2), fixed(r[3], 2), fixed(r[4], 2), r[5]])} />
      <Table t={t} title="Against the league average" head={["Row", "Value", "League average", "z", "Players"]}
        rows={zs.map(z => [z.label, fixed(z.value, 3), fixed(z.mean, 3), z.z == null ? "–" : fixed(z.z, 2), z.n ?? "–"])} />
      {goalie && <Table t={t} title="This season's totals, from the league average" head={["This season", "Total"]}
        rows={GOALIE_TOTALS.map(([label, col]) => [label, fixed(p[col], 2)])} />}
    </div>
  );
}
