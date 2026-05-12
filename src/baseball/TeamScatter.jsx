import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";

const METRICS = [
  { id: "stuff",    label: "Stuff+"    },
  { id: "location", label: "Location+" },
  { id: "tunnel",   label: "Tunnel+"   },
  { id: "pitch",    label: "Pitch+"    },
  { id: "iswing",   label: "iSwing+",  kind: "bar" },
];

// MLB team primary colors. Keys match the team abbr produced by Statcast /
// our data files. Falls back to the orange theme accent if missing.
const TEAM_COLORS = {
  ARI: "#A71930", ATL: "#13274F", BAL: "#DF4601", BOS: "#BD3039",
  CHC: "#0E3386", CWS: "#27251F", CIN: "#C6011F", CLE: "#00385D",
  COL: "#33006F", DET: "#0C2340", HOU: "#EB6E1F", KCR: "#004687",
  LAA: "#BA0021", LAD: "#005A9C", MIA: "#00A3E0", MIL: "#FFC52F",
  MIN: "#002B5C", NYM: "#FF5910", NYY: "#003087", OAK: "#003831",
  ATH: "#003831", PHI: "#E81828", PIT: "#FDB827", SDP: "#2F241D",
  SEA: "#0C2C56", SFG: "#FD5A1E", STL: "#C41E3A", TBR: "#092C5C",
  TEX: "#003278", TOR: "#134A8E", WSH: "#AB0003", AZ: "#A71930",
};
const teamColor = (abbr) => TEAM_COLORS[abbr] || "#f59e0b";

// Statcast → ESPN logo-CDN slug. Falls back to lowercase if not listed.
const ESPN_SLUG = {
  SFG: "sf", KCR: "kc", SDP: "sd", TBR: "tb", CWS: "chw",
  AZ: "ari", WAS: "wsh",
};
const espnLogo = (abbr) => {
  const slug = ESPN_SLUG[abbr] ?? abbr.toLowerCase();
  return `https://a.espncdn.com/i/teamlogos/mlb/500/${slug}.png`;
};

export default function TeamScatter({ season, hitters, iswingData }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [metric, setMetric] = useState("stuff");
  const isBar = METRICS.find(m => m.id === metric)?.kind === "bar";

  useEffect(() => {
    setData(null);
    setErr(null);
    fetch(`/team_plus_${season}.json`)
      .then(r => {
        if (!r.ok) throw new Error(`team_plus_${season}.json not found. Run: python3 build_team_plus.py --year ${season}`);
        return r.json();
      })
      .then(setData)
      .catch(e => setErr(e.message));
  }, [season]);

  const points = useMemo(() => {
    if (!data?.teams) return [];
    return Object.entries(data.teams)
      .filter(([_, v]) => v.starter && v.reliever)
      .map(([abbr, v]) => ({
        abbr,
        x: v.starter[metric],
        y: v.reliever[metric],
        nS: v.starter.n,
        nR: v.reliever.n,
      }))
      .filter(p => Number.isFinite(p.x) && Number.isFinite(p.y));
  }, [data, metric]);

  // ── iSwing+ bar chart: PA-weighted average per team ──
  const bars = useMemo(() => {
    if (metric !== "iswing" || !hitters?.length || !iswingData) return [];
    const yr = String(season);
    // Use the same normalisation as fuzzyLookup so we hit iSwing entries
    const norm = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "")
                                   .toLowerCase().replace(/[.\-,]/g, "")
                                   .replace(/\b(jr|sr|ii|iii|iv)\b/g, "")
                                   .replace(/\s+/g, " ").trim();
    const byNorm = {};
    for (const [name, rec] of Object.entries(iswingData)) byNorm[norm(name)] = rec;

    const teamAgg = {};
    for (const h of hitters) {
      if (!h.team || !h.pa) continue;
      const rec = byNorm[norm(h.name)];
      const val = rec?.[yr];
      if (val == null) continue;
      if (!teamAgg[h.team]) teamAgg[h.team] = { num: 0, den: 0, n: 0 };
      teamAgg[h.team].num += val * h.pa;
      teamAgg[h.team].den += h.pa;
      teamAgg[h.team].n += 1;
    }
    return Object.entries(teamAgg)
      .filter(([, v]) => v.den > 0)
      .map(([abbr, v]) => ({ abbr, value: v.num / v.den, n: v.n, pa: v.den }))
      .sort((a, b) => b.value - a.value);
  }, [metric, hitters, iswingData, season]);

  if (isBar) {
    return (
      <div>
        <MetricButtons metric={metric} setMetric={setMetric} theme={t} />
        {bars.length === 0 ? (
          <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>
            No iSwing+ data for {season}.
          </div>
        ) : (
          <ISwingBars bars={bars} theme={t} season={season} />
        )}
      </div>
    );
  }

  if (err) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>Loading…</div>;
  if (points.length === 0) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>No team-role rows in team_plus_{season}.json</div>;

  // Axis range: symmetric around 100, padded to the next 10 so each gridline
  // is one std (matches the +/-10 = 1 sigma convention used in summary tables)
  const allVals = points.flatMap(p => [p.x, p.y]);
  const maxDev = Math.max(...allVals.map(v => Math.abs(v - 100)));
  const pad = Math.max(10, Math.ceil(maxDev / 10) * 10);
  const lo = 100 - pad, hi = 100 + pad;

  const W = 700, H = 700;
  const M = { l: 56, r: 24, t: 24, b: 52 };
  const innerW = W - M.l - M.r;
  const innerH = H - M.t - M.b;
  const sx = v => M.l + ((v - lo) / (hi - lo)) * innerW;
  const sy = v => M.t + (1 - (v - lo) / (hi - lo)) * innerH;
  const cx100 = sx(100);
  const cy100 = sy(100);
  const logoSize = 26;

  // Quadrants (math convention): Q1 = top-right (both > 100) = green;
  // Q3 = bottom-left (both < 100) = red. Adjust if you want the other corners.
  const QUAD_GREEN = "rgba(34,197,94,0.10)";
  const QUAD_RED   = "rgba(239,68,68,0.10)";

  // Tick marks every 10 (= 1 std on the +/- scale)
  const ticks = [];
  for (let v = Math.ceil(lo / 10) * 10; v <= hi; v += 10) ticks.push(v);

  const metricLabel = METRICS.find(m => m.id === metric).label;

  return (
    <div>
      <MetricButtons metric={metric} setMetric={setMetric} theme={t} />

      <div style={{
        background: t.cardBg,
        border: `1px solid ${t.cardBorder}`,
        borderRadius: 10,
        padding: 12,
      }}>
        <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
          {/* Quadrant shading */}
          <rect x={cx100} y={M.t}     width={M.l + innerW - cx100} height={cy100 - M.t}     fill={QUAD_GREEN} />
          <rect x={M.l}   y={cy100}   width={cx100 - M.l}          height={M.t + innerH - cy100} fill={QUAD_RED} />

          {/* Grid */}
          {ticks.map(v => (
            <g key={`gx-${v}`}>
              <line x1={sx(v)} y1={M.t} x2={sx(v)} y2={M.t + innerH} stroke={t.tableBorder} strokeWidth={v === 100 ? 1.2 : 0.5} />
              <text x={sx(v)} y={M.t + innerH + 16} fontSize={10} fill={t.textMuted} textAnchor="middle">{v}</text>
            </g>
          ))}
          {ticks.map(v => (
            <g key={`gy-${v}`}>
              <line x1={M.l} y1={sy(v)} x2={M.l + innerW} y2={sy(v)} stroke={t.tableBorder} strokeWidth={v === 100 ? 1.2 : 0.5} />
              <text x={M.l - 8} y={sy(v) + 3} fontSize={10} fill={t.textMuted} textAnchor="end">{v}</text>
            </g>
          ))}

          {/* Axis labels */}
          <text x={M.l + innerW / 2} y={H - 14} fontSize={13} fontWeight={600} fill={t.textSecondary} textAnchor="middle">
            Starter {metricLabel}
          </text>
          <text
            transform={`translate(${16},${M.t + innerH / 2}) rotate(-90)`}
            fontSize={13} fontWeight={600} fill={t.textSecondary} textAnchor="middle"
          >
            Reliever {metricLabel}
          </text>

          {/* Frame */}
          <rect x={M.l} y={M.t} width={innerW} height={innerH} fill="none" stroke={t.cardBorder} />

          {/* Logos */}
          {points.map(p => (
            <g key={p.abbr}>
              <image
                href={espnLogo(p.abbr)}
                x={sx(p.x) - logoSize / 2}
                y={sy(p.y) - logoSize / 2}
                width={logoSize}
                height={logoSize}
                style={{ pointerEvents: "all" }}
              >
                <title>{`${p.abbr}  •  Starter ${metricLabel}: ${p.x.toFixed(1)} (n=${p.nS})  •  Reliever ${metricLabel}: ${p.y.toFixed(1)} (n=${p.nR})`}</title>
              </image>
            </g>
          ))}
        </svg>
      </div>

      <div style={{ fontSize: 10, color: t.textFaint, marginTop: 8, textAlign: "center" }}>
        {points.length} teams · season {data.season} · 100 = league average for each role · ±10 ≈ 1σ
      </div>
    </div>
  );
}


// ── Metric selector buttons (shared by scatter + bar views) ────────────────
function MetricButtons({ metric, setMetric, theme: t }) {
  return (
    <div style={{ display: "flex", gap: 6, marginBottom: 14, justifyContent: "center", flexWrap: "wrap" }}>
      {METRICS.map(m => (
        <button
          key={m.id}
          onClick={() => setMetric(m.id)}
          style={{
            padding: "7px 14px",
            fontSize: 12,
            fontWeight: metric === m.id ? 700 : 600,
            letterSpacing: "0.03em",
            color: metric === m.id ? "#fff" : t.textSecondary,
            background: metric === m.id ? t.accent : t.inputBg,
            border: `1px solid ${metric === m.id ? t.accent : t.inputBorder}`,
            borderRadius: 6,
            cursor: "pointer",
            fontFamily: "inherit",
            transition: "all 0.15s",
          }}
        >
          {m.label}
        </button>
      ))}
    </div>
  );
}


// ── iSwing+ team bar chart ────────────────────────────────────────────────
function ISwingBars({ bars, theme: t, season }) {
  const W = 900;
  const M = { l: 48, r: 16, t: 28, b: 64 };  // bottom leaves room for logos + abbr
  const barGap = 6;
  const innerW = W - M.l - M.r;
  const barW = (innerW - barGap * (bars.length - 1)) / bars.length;
  const H = 460;
  const innerH = H - M.t - M.b;

  const maxVal = Math.max(...bars.map(b => b.value));
  const minVal = Math.min(...bars.map(b => b.value));
  // Y range padded to nearest 5 below the minimum and above the maximum,
  // and snapped so 100 is always visible
  const yLo = Math.min(95, Math.floor(Math.min(minVal, 100) / 5) * 5 - 2);
  const yHi = Math.max(105, Math.ceil(Math.max(maxVal, 100) / 5) * 5 + 2);
  const sy = v => M.t + (1 - (v - yLo) / (yHi - yLo)) * innerH;
  const y100 = sy(100);

  const ticks = [];
  for (let v = Math.ceil(yLo / 5) * 5; v <= yHi; v += 5) ticks.push(v);

  const logoSize = Math.min(28, barW * 0.85);

  return (
    <div style={{
      background: t.cardBg,
      border: `1px solid ${t.cardBorder}`,
      borderRadius: 10,
      padding: 12,
    }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
        {/* Y gridlines + labels */}
        {ticks.map(v => (
          <g key={`g-${v}`}>
            <line x1={M.l} y1={sy(v)} x2={M.l + innerW} y2={sy(v)}
                  stroke={t.tableBorder} strokeWidth={v === 100 ? 1.2 : 0.5} />
            <text x={M.l - 8} y={sy(v) + 3} fontSize={10} fill={t.textMuted} textAnchor="end">{v}</text>
          </g>
        ))}

        {/* 100 reference baseline emphasised */}
        <line x1={M.l} y1={y100} x2={M.l + innerW} y2={y100}
              stroke={t.textMuted} strokeDasharray="4 4" strokeWidth={0.8} />

        {/* Bars */}
        {bars.map((b, i) => {
          const x = M.l + i * (barW + barGap);
          const v = b.value;
          const yTop = sy(Math.max(v, 100));
          const yBot = sy(Math.min(v, 100));
          const h = Math.max(1, yBot - yTop);
          const fill = teamColor(b.abbr);
          // Logo and label sit below the chart area regardless of bar height
          const logoY = M.t + innerH + 6;
          const labelY = logoY + logoSize + 12;
          return (
            <g key={b.abbr}>
              <rect x={x} y={yTop} width={barW} height={h} fill={fill}
                    stroke={t.cardBg} strokeWidth={1}>
                <title>{`${b.abbr}  •  iSwing+: ${v.toFixed(1)}  •  ${b.n} hitters · ${b.pa} PA`}</title>
              </rect>
              {/* Value above the bar */}
              <text x={x + barW / 2} y={(v >= 100 ? yTop : yBot) - 4}
                    fontSize={10} fontWeight={700} fill={t.textSecondary} textAnchor="middle">
                {v.toFixed(0)}
              </text>
              {/* Logo at the base */}
              <image href={`https://a.espncdn.com/i/teamlogos/mlb/500/${(b.abbr || "").toLowerCase()}.png`}
                     x={x + barW / 2 - logoSize / 2} y={logoY}
                     width={logoSize} height={logoSize} />
              <text x={x + barW / 2} y={labelY} fontSize={9} fill={t.textMuted} textAnchor="middle">
                {b.abbr}
              </text>
            </g>
          );
        })}

        {/* Y axis label */}
        <text transform={`translate(${14},${M.t + innerH / 2}) rotate(-90)`}
              fontSize={13} fontWeight={600} fill={t.textSecondary} textAnchor="middle">
          iSwing+
        </text>
      </svg>
      <div style={{ fontSize: 10, color: t.textFaint, marginTop: 8, textAlign: "center" }}>
        {bars.length} teams · season {season} · PA-weighted average · 100 = league average
      </div>
    </div>
  );
}
