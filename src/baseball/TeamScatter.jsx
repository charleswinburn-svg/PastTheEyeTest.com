import { useEffect, useMemo, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";

const METRICS = [
  { id: "stuff",    label: "Stuff+"    },
  { id: "location", label: "Location+" },
  { id: "tunnel",   label: "Tunnel+"   },
  { id: "pitch",    label: "Pitch+"    },
];

// Statcast → ESPN logo-CDN slug. Falls back to lowercase if not listed.
const ESPN_SLUG = {
  SFG: "sf", KCR: "kc", SDP: "sd", TBR: "tb", CWS: "chw",
  AZ: "ari", WAS: "wsh",
};
const espnLogo = (abbr) => {
  const slug = ESPN_SLUG[abbr] ?? abbr.toLowerCase();
  return `https://a.espncdn.com/i/teamlogos/mlb/500/${slug}.png`;
};

export default function TeamScatter({ season }) {
  const { theme: t } = useTheme();
  const [data, setData] = useState(null);
  const [err, setErr] = useState(null);
  const [metric, setMetric] = useState("stuff");

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

  if (err) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>{err}</div>;
  if (!data) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>Loading…</div>;
  if (points.length === 0) return <div style={{ color: t.textMuted, padding: 40, textAlign: "center", fontSize: 13 }}>No team-role rows in team_plus_{season}.json</div>;

  // Axis range: symmetric around 100, padded to nearest 5
  const allVals = points.flatMap(p => [p.x, p.y]);
  const maxDev = Math.max(...allVals.map(v => Math.abs(v - 100)));
  const pad = Math.max(8, Math.ceil(maxDev / 5) * 5 + 2);
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

  // Tick marks every 5
  const ticks = [];
  for (let v = Math.ceil(lo / 5) * 5; v <= hi; v += 5) ticks.push(v);

  const metricLabel = METRICS.find(m => m.id === metric).label;

  return (
    <div>
      {/* Metric selector */}
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
