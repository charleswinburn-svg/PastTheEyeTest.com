import { useEffect, useMemo, useState } from "react";
import { DARK, LIGHT } from "../baseball/ThemeContext.jsx";
import { PALETTES, ACTIVE_PALETTE, makeScale } from "./colorScale.js";
import PercentileBoxes from "./PercentileBoxes.jsx";

// ═══════════════════════════════════════════════════════════
// /palette: every candidate color scale on site components, dark and light side by side.
// Dev-only page (not linked from the nav). ?p=<palette key>&accent=amber|ice
// ═══════════════════════════════════════════════════════════

const NUM_FONT = "'Pliant', sans-serif";
const ICE_ACCENT = { dark: "#5BC0EB", light: "#1F7FBF" };

const HITTER = [
  ["xwOBA", 96, ".412"], ["Barrel %", 88, "16.1%"], ["Hard-Hit %", 71, "49.8%"], ["Bat Speed", 63, "74.6"],
  ["K %", 52, "21.9%"], ["BB %", 34, "7.4%"], ["Chase %", 18, "33.0%"], ["Whiff %", 7, "33.8%"], ["Sprint Speed", null, "—"],
];
const PRO = [["Stuff+", 121], ["Location+", 104], ["Tunnel+", 96], ["Pitch+", 82]];
const PITCHES = [
  { type: "4-Seam", color: "#D22D49", velo: [97.8, 88], ivb: [18.9, 91], whiff: [31.2, 84], stuff: 126, loc: 101, pitch: 118 },
  { type: "Slider", color: "#EEE716", velo: [87.1, 62], ivb: [2.1, 50], whiff: [38.5, 70], stuff: 109, loc: 93, pitch: 104 },
  { type: "Changeup", color: "#1DBE3A", velo: [88.4, 41], ivb: [9.2, 38], whiff: [24.0, 33], stuff: 92, loc: 99, pitch: 95 },
  { type: "Curveball", color: "#00D1ED", velo: [79.0, 22], ivb: [-12.4, 12], whiff: [19.7, 14], stuff: 84, loc: 87, pitch: 83 },
];
const STATBAR = [["IP", null, "6.1"], ["ERA", 81, "2.84"], ["K%", 92, "33.1%"], ["BB%", 28, "10.2%"], ["Whiff%", 77, "31.0%"], ["HR/9", 50, "1.02"], ["xFIP", 14, "4.61"]];
const TIERS = [["1st line", 92], ["2nd line", 68], ["3rd line", 32], ["4th line", 8]];
const ordinal = n => { const s = ["th", "st", "nd", "rd"], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

function Section({ title, t, children }) {
  return (
    <div style={{ marginBottom: 18 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: "0.08em", textTransform: "uppercase", color: t.textMuted, marginBottom: 8 }}>{title}</div>
      {children}
    </div>
  );
}

function ThemeColumn({ t, scale, accent }) {
  const isDark = t.id === "dark";
  const acc = accent === "ice" ? ICE_ACCENT[t.id] : t.accent;
  const card = { background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 12, padding: 14 };
  const density = useMemo(() => {
    const g = [];
    for (let r = 0; r < 7; r++) for (let c = 0; c < 7; c++) {
      const d = Math.exp(-(((c - 3.6) ** 2) / 3.2 + ((r - 2.6) ** 2) / 2.2));
      g.push(d);
    }
    return g;
  }, []);
  const pctOfPlus = v => scale.plusPct(v);
  const plusCell = v => scale.cell(pctOfPlus(v), isDark, t.cardBg);

  return (
    <div style={{ flex: "1 1 460px", minWidth: 0, background: t.bg, borderRadius: 14, padding: 16, border: `1px solid ${t.cardBorder}` }}>
      {/* mock nav: shows the UI accent next to the scale */}
      <div style={{ display: "flex", gap: 2, borderBottom: `2px solid ${acc}`, marginBottom: 14, flexWrap: "wrap" }}>
        {["Cards", "Summaries", "Leaderboards", "NHL"].map((n, i) => (
          <div key={n} style={{ padding: "8px 12px", fontSize: 12, fontWeight: i === 0 ? 700 : 600, color: i === 0 ? acc : t.textMuted,
                                borderBottom: `3px solid ${i === 0 ? acc : "transparent"}`, marginBottom: -2 }}>{n}</div>
        ))}
        <div style={{ marginLeft: "auto", alignSelf: "center", fontSize: 12, fontWeight: 700, fontStyle: "italic", paddingRight: 4 }}>
          <span style={{ color: t.accentSecondary }}>Past The</span> <span style={{ color: t.accent }}>Eye Test</span>
        </div>
      </div>

      <div style={{ fontSize: 12, fontWeight: 800, color: t.text, marginBottom: 10 }}>{isDark ? "Dark mode" : "Light mode"}</div>

      <Section title="Scale (0 → 50 → 100)" t={t}>
        <div style={{ height: 18, borderRadius: 5, background: scale.gradient(isDark, 40) }} />
        <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: t.textFaint, fontFamily: NUM_FONT, marginTop: 3 }}>
          {[0, 25, 50, 75, 100].map(n => <span key={n}>{n}</span>)}
        </div>
      </Section>

      <Section title="Percentile boxes (hitter card)" t={t}>
        <div style={card}>
          {HITTER.map(([label, p, disp]) => (
            <PercentileBoxes key={label} label={label} pctile={p} display={disp} labelWidth={92} theme={t} isDark={isDark} scale={scale}
                             delta={label === "xwOBA" ? { text: "+.031", color: scale.pctColor(85, isDark) } : label === "Chase %" ? { text: "+2.4", color: scale.pctColor(10, false) } : null} />
          ))}
        </div>
      </Section>

      <Section title="Pro+ tiles (pitcher card)" t={t}>
        <div style={{ ...card, display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 8 }}>
          {PRO.map(([label, v]) => {
            const p = pctOfPlus(v), rgb = scale.pctRgb(p, isDark);
            return (
              <div key={label} style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
                <div style={{ fontSize: 10, fontWeight: 800, color: t.text, letterSpacing: "0.06em", textTransform: "uppercase" }}>{label}</div>
                <div style={{ width: 56, height: 56, borderRadius: 11, background: `rgb(${rgb.join(",")})`, boxShadow: `0 0 0 2px ${t.cardBg}, 0 2px 6px rgba(0,0,0,0.25)`,
                              display: "flex", alignItems: "center", justifyContent: "center",
                              fontSize: 18, fontWeight: 800, fontFamily: NUM_FONT, color: scale.pctInk(p, isDark) }}>{v}</div>
                <div style={{ fontSize: 9, fontWeight: 700, color: t.textSecondary, fontFamily: NUM_FONT }}>{ordinal(Math.round(p))} percentile</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Summary stat bar" t={t}>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
          {STATBAR.map(([label, p, val]) => {
            const c = p == null ? null : scale.cell(p, isDark, t.bg, 0.3, 1);
            return (
              <div key={label} style={{ minWidth: 54, padding: "6px 8px", borderRadius: 8, textAlign: "center",
                                        background: c ? c.bg : t.inputBg, border: `1px solid ${c ? c.border : t.inputBorder}` }}>
                <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: "0.05em", color: c ? c.ink : t.textMuted, opacity: 0.85 }}>{label}</div>
                <div style={{ fontSize: 15, fontWeight: 800, fontFamily: NUM_FONT, color: c ? c.ink : t.text }}>{val}</div>
              </div>
            );
          })}
        </div>
      </Section>

      <Section title="Summary pitch table" t={t}>
        <div style={{ ...card, padding: 0, overflowX: "auto" }}>
          <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 12, fontFamily: NUM_FONT }}>
            <thead>
              <tr>{["Pitch", "Velo", "IVB", "Whiff%", "Stuff+", "Loc+", "Pitch+"].map(h => (
                <th key={h} style={{ padding: "7px 8px", fontSize: 10, color: t.textFaint, textAlign: h === "Pitch" ? "left" : "right", borderBottom: `1px solid ${t.tableHeaderBorder}`, fontFamily: "inherit" }}>{h}</th>
              ))}</tr>
            </thead>
            <tbody>
              {PITCHES.map((r, i) => {
                const raw = ([v, p]) => { const c = scale.cell(p, isDark, t.cardBg); return { v, c }; };
                const cells = [raw(r.velo), raw(r.ivb), raw(r.whiff), { v: r.stuff, c: plusCell(r.stuff) }, { v: r.loc, c: plusCell(r.loc) }, { v: r.pitch, c: plusCell(r.pitch) }];
                return (
                  <tr key={r.type} style={{ background: i % 2 ? t.tableRowB : t.tableRowA }}>
                    <td style={{ padding: "6px 8px", color: t.text, fontWeight: 700, whiteSpace: "nowrap" }}>
                      <span style={{ display: "inline-block", width: 8, height: 8, borderRadius: 4, background: r.color, marginRight: 6 }} />{r.type}
                    </td>
                    {cells.map(({ v, c }, j) => (
                      <td key={j} style={{ padding: "6px 8px", textAlign: "right", fontWeight: 700, background: c ? c.bg : "transparent", color: c ? c.ink : t.textSecondary }}>{v}</td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Section>

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "1 1 180px" }}>
          <Section title="Zone density" t={t}>
            <div style={{ ...card, padding: 8, display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 1, maxWidth: 220 }}>
              {density.map((d, i) => <div key={i} style={{ aspectRatio: "1", background: scale.densityColor(d, isDark), borderRadius: 2 }} />)}
            </div>
          </Section>
        </div>
        <div style={{ flex: "1 1 200px" }}>
          <Section title="NHL impact tiers + signed bars" t={t}>
            <div style={{ ...card, padding: 8 }}>
              {TIERS.map(([n, p]) => (
                <div key={n} style={{ padding: "6px 8px", marginBottom: 2, borderRadius: 4, fontSize: 11, fontWeight: 700,
                                      background: scale.cell(p, isDark, t.cardBg, 0.35, 0.7)?.bg, color: t.text }}>{n}</div>
              ))}
              {[["Even strength", 2.1], ["Power play", 0.8], ["Penalty kill", -1.3]].map(([n, v]) => (
                <div key={n} style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 6, fontSize: 10, color: t.textSecondary }}>
                  <span style={{ width: 78, textAlign: "right" }}>{n}</span>
                  <div style={{ position: "relative", flex: 1, height: 10, background: t.inputBg, borderRadius: 3 }}>
                    <div style={{ position: "absolute", top: 0, bottom: 0, width: `${Math.abs(v) / 3 * 50}%`,
                                  background: v >= 0 ? scale.pctColor(88, isDark) : scale.pctColor(12, isDark),
                                  ...(v >= 0 ? { left: "50%" } : { right: "50%" }) }} />
                    <div style={{ position: "absolute", left: "50%", top: -2, bottom: -2, width: 1, background: t.textFaint }} />
                  </div>
                </div>
              ))}
            </div>
          </Section>
        </div>
      </div>
    </div>
  );
}

export default function PalettePreview() {
  const qs = new URLSearchParams(window.location.search);
  const [key, setKey] = useState(PALETTES[qs.get("p")] ? qs.get("p") : ACTIVE_PALETTE);
  const [accent, setAccent] = useState(qs.get("accent") === "ice" ? "ice" : "amber");
  const scale = useMemo(() => makeScale(key), [key]);

  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set("p", key); u.searchParams.set("accent", accent);
    window.history.replaceState(null, "", u);
    document.title = `Palette · ${PALETTES[key].name}`;
  }, [key, accent]);

  const chip = active => ({
    display: "flex", flexDirection: "column", gap: 5, padding: 8, borderRadius: 10, cursor: "pointer", textAlign: "left",
    background: active ? "#1e293b" : "#0f172a", border: `1px solid ${active ? "#f8fafc" : "#334155"}`, color: "#e2e8f0",
  });

  return (
    <div style={{ minHeight: "100vh", background: "#05080f", color: "#f8fafc", padding: "20px 16px 40px" }}>
      <div style={{ maxWidth: 1240, margin: "0 auto" }}>
        <h1 style={{ fontSize: 22, fontWeight: 800, letterSpacing: "-0.02em" }}>Color scale preview</h1>
        <p style={{ fontSize: 13, color: "#94a3b8", margin: "4px 0 14px", maxWidth: 760, lineHeight: 1.5 }}>
          Pick a scale. Every sample below re-colors. 0 is worst, 50 is average, 100 is best. The pick is saved in the URL, so you can bookmark or share one.
        </p>

        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(150px, 1fr))", gap: 8, marginBottom: 12 }}>
          {Object.entries(PALETTES).map(([k, p]) => (
            <button key={k} onClick={() => setKey(k)} style={chip(k === key)}>
              <div style={{ height: 12, borderRadius: 4, background: makeScale(k).gradient(true, 16) }} />
              <span style={{ fontSize: 11, fontWeight: 700 }}>{p.name}{k === ACTIVE_PALETTE ? " ★" : ""}</span>
            </button>
          ))}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 16, flexWrap: "wrap", fontSize: 12, color: "#94a3b8" }}>
          <span style={{ fontWeight: 700 }}>UI accent (tabs, borders):</span>
          {[["amber", "Amber (current)"], ["ice", "Ice blue"]].map(([v, n]) => (
            <button key={v} onClick={() => setAccent(v)}
                    style={{ padding: "5px 10px", borderRadius: 6, cursor: "pointer", fontSize: 12, fontWeight: 700,
                             background: accent === v ? "#1e293b" : "transparent", color: accent === v ? "#f8fafc" : "#94a3b8",
                             border: `1px solid ${accent === v ? "#f8fafc" : "#334155"}` }}>{n}</button>
          ))}
          <span>★ = chosen scale (ACTIVE_PALETTE in src/ui/colorScale.js)</span>
        </div>

        <div style={{ display: "flex", gap: 16, flexWrap: "wrap" }}>
          <ThemeColumn t={DARK} scale={scale} accent={accent} />
          <ThemeColumn t={LIGHT} scale={scale} accent={accent} />
        </div>
      </div>
    </div>
  );
}
