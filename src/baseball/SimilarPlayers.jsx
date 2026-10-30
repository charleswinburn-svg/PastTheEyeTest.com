import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useTheme } from "./ThemeContext.jsx";
import { binColor, textOnBin, getHeadshotUrl, saveCardAsPng, NUM_FONT, NUM_WEIGHT } from "./SharedComponents.jsx";
import { loadSimilarityPool, rankComps, featureRows, fmtValue, SIMILARITY_SEASONS } from "./similarity.js";
import { PitcherCompareFigures, FIGURE_FOR_COMPONENT } from "./SimilarityFigures.jsx";

// ═══════════════════════════════════════════════════════════
// SIMILAR PLAYERS
// ═══════════════════════════════════════════════════════════
// Ranks the player-seasons (2023–2026) most like the card's player from the
// precomputed similarity files (see similarity.js for the model). Shows one
// overall similarity % plus a % per component, with chips to re-weight the
// components. Clicking a comp hands {playerId, season, name} to onSelect so
// the app can jump to that player's card.

const SHORT = {
  swing: "Swing", contact: "Contact", whiff: "Whiff", discipline: "Discipline",
  arsenal: "Arsenal", release: "Release", command: "Command",
};
const LIMIT = 10;

export default function SimilarPlayers({ player, season, type = "hitter", onSelect = null }) {
  const { theme: t } = useTheme();
  const [pools, setPools] = useState(null);
  const [isolate, setIsolate] = useState(null);     // component key, or null = overall
  const [sameHand, setSameHand] = useState(type === "pitcher");
  const [thisSeason, setThisSeason] = useState(false);
  const [hideSelf, setHideSelf] = useState(false);
  const [expanded, setExpanded] = useState(null);   // `${pid}:${season}`

  useEffect(() => {
    let cancelled = false;
    setPools(null);
    loadSimilarityPool(type, SIMILARITY_SEASONS).then(p => { if (!cancelled) setPools(p); });
    return () => { cancelled = true; };
  }, [type]);
  useEffect(() => { setExpanded(null); }, [player?.player_id, season]);

  const components = pools?.[0]?.meta?.components || {};
  // Isolating a component ranks on that component alone (weight 1 for it, 0 for
  // the rest); otherwise every component counts equally.
  const weights = useMemo(() => {
    if (!isolate) return {};
    const w = {};
    for (const c of Object.keys(components)) w[c] = c === isolate ? 1 : 0;
    return w;
  }, [isolate, components]);

  const ranked = useMemo(() => {
    if (!pools || !pools.length || !player?.player_id) return null;
    return rankComps({ season, pid: player.player_id }, pools,
      { weights, sameHand, excludeSelf: hideSelf, currentSeasonOnly: thisSeason, limit: LIMIT });
  }, [pools, player?.player_id, season, weights, sameHand, hideSelf, thisSeason]);

  const unitLabel = type === "pitcher" ? "pitches" : "PA";
  const isolatedLabel = isolate ? (SHORT[isolate] || components[isolate]?.label || isolate) : null;

  const box = {
    background: t.cardBg, border: `1px solid ${t.cardBorder}`, borderRadius: 12,
    boxShadow: `0 4px 24px ${t.shadow}`, maxWidth: 1040, margin: "16px auto 0", overflow: "hidden",
  };
  const chip = (selected) => ({
    padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 999, cursor: "pointer",
    border: `1px solid ${selected ? t.accent : t.inputBorder}`,
    background: selected ? t.accent : t.inputBg,
    color: selected ? "#111" : t.textMuted,
    userSelect: "none", whiteSpace: "nowrap",
  });
  const toggle = (on) => ({
    padding: "4px 10px", fontSize: 11, fontWeight: 600, borderRadius: 6, cursor: "pointer",
    border: `1px solid ${on ? t.accentSecondary : t.inputBorder}`,
    background: on ? t.accentSecondary : t.inputBg, color: on ? "#fff" : t.textMuted,
    userSelect: "none", whiteSpace: "nowrap",
  });

  return (
    <div style={box}>
      {/* Header + controls */}
      <div style={{ padding: "14px 18px 10px", borderBottom: `1px solid ${t.divider}` }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", flexWrap: "wrap", gap: 8 }}>
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, color: t.text }}>Similar Players</div>
            <div style={{ fontSize: 11, color: t.textFaint, marginTop: 2 }}>
              Closest player-seasons {SIMILARITY_SEASONS[0]}–{SIMILARITY_SEASONS[SIMILARITY_SEASONS.length - 1]} · every stat scaled within its own season ·
              100% = identical profile
            </div>
          </div>
          <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
            <span style={toggle(sameHand)} onClick={() => setSameHand(v => !v)}>Same hand</span>
            <span style={toggle(thisSeason)} onClick={() => setThisSeason(v => !v)}>{season} only</span>
            <span style={toggle(hideSelf)} onClick={() => setHideSelf(v => !v)}>Hide own seasons</span>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", marginTop: 10 }}>
          <span style={{ fontSize: 10, color: t.textFaint, marginRight: 2 }}>ISOLATE · rank on one component</span>
          <span style={chip(!isolate)} onClick={() => setIsolate(null)} title="Rank on the overall score (all components equal)">All</span>
          {Object.entries(components).map(([c, cm]) => (
            <span key={c} style={chip(isolate === c)} onClick={() => setIsolate(isolate === c ? null : c)} title={`Rank on ${cm.label} only`}>
              {cm.label}
            </span>
          ))}
        </div>
      </div>

      {/* Body */}
      {!pools ? (
        <Note t={t}>Loading similarity data…</Note>
      ) : !pools.length ? (
        <Note t={t}>No similarity files found. Run <code>build_similarity_{type === "pitcher" ? "pitchers" : "hitters"}.py</code>.</Note>
      ) : !ranked?.target ? (
        <Note t={t}>{player?.name || "This player"} isn't in the {season} similarity pool
          {type === "pitcher" ? " (fewer than 200 regular-season pitches)" : " (below the PA minimum)"}.</Note>
      ) : !ranked.results.length ? (
        <Note t={t}>No comparable player-seasons with the current filters.</Note>
      ) : (
        <div>
          {ranked.results.map((r, i) => {
            const key = `${r.pid}:${r.season}`;
            const open = expanded === key;
            return (
              <div key={key} style={{ borderBottom: `1px solid ${t.divider}`, background: i % 2 ? t.tableRowB : t.tableRowA }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12, padding: "8px 14px", flexWrap: "wrap" }}>
                  <span style={{ width: 18, textAlign: "right", fontSize: 11, color: t.textFaint, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>{i + 1}</span>
                  <Headshot pid={r.pid} name={r.name} t={t} />
                  <div style={{ flex: "1 1 180px", minWidth: 150 }}>
                    <div
                      onClick={() => onSelect && onSelect({ playerId: Number(r.pid), season: String(r.season), name: r.name })}
                      style={{ fontSize: 13, fontWeight: 700, color: t.text, cursor: onSelect ? "pointer" : "default", display: "inline-flex", gap: 6, alignItems: "center" }}
                      title={onSelect ? "Open this player's card" : undefined}
                    >
                      {r.name}
                      {r.self && (
                        <span style={{ fontSize: 9, fontWeight: 700, padding: "1px 5px", borderRadius: 4, background: t.accent, color: "#111" }}>SELF</span>
                      )}
                    </div>
                    <div style={{ fontSize: 11, color: t.textMuted }}>
                      {r.season}{r.team ? ` · ${r.team}` : ""}{r.hand ? ` · ${r.hand === "S" ? "S" : r.hand}H${type === "pitcher" ? "P" : "H"}` : ""} · {r.n?.toLocaleString?.() ?? r.n} {unitLabel}
                    </div>
                  </div>
                  <OverallBubble sim={r.overall} label={isolatedLabel} />
                  <div style={{ display: "flex", gap: 10, flexWrap: "wrap", flex: "2 1 320px" }}>
                    {Object.keys(components).map(c => (
                      <CompCell key={c} label={SHORT[c] || components[c].label} comp={r.comps[c]}
                                dim={!!isolate && isolate !== c} highlight={isolate === c} t={t} />
                    ))}
                  </div>
                  <span
                    onClick={() => setExpanded(open ? null : key)}
                    style={{ fontSize: 11, color: t.textFaint, cursor: "pointer", padding: "2px 6px", userSelect: "none" }}
                    title="Show the numbers behind this comp"
                  >{open ? "▲" : "▼"}</span>
                </div>
                {open && <FeatureTable target={ranked.target} other={r} t={t} isolate={isolate} isolatedLabel={isolatedLabel} components={components} unitLabel={unitLabel} type={type} />}
              </div>
            );
          })}
          <div style={{ padding: "6px 14px 8px", fontSize: 10, color: t.textFaint, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 6 }}>
            <span>{isolate ? `Ranked on ${isolatedLabel} only · other components shown for context` : "Overall = mean of the component scores"} · a component is blank when too few of its stats exist for both players</span>
            <span style={{ fontStyle: "italic" }}>PastTheEyeTest</span>
          </div>
        </div>
      )}
    </div>
  );
}

function Note({ t, children }) {
  return <div style={{ padding: "18px 16px", fontSize: 12, color: t.textMuted, textAlign: "center" }}>{children}</div>;
}

function Headshot({ pid, name, t, size = 34 }) {
  const url = getHeadshotUrl(pid);
  return (
    <div style={{ width: size, height: size, borderRadius: "50%", overflow: "hidden", background: t.inputBg, border: `1px solid ${t.divider}`, flexShrink: 0, position: "relative", display: "flex", alignItems: "center", justifyContent: "center" }}>
      <span style={{ fontSize: Math.round(size / 3), fontWeight: 700, color: t.textFaint, position: "absolute" }}>
        {name ? name.split(" ").map(w => w[0]).join("").toUpperCase().slice(0, 2) : ""}
      </span>
      {url && <img src={url} alt="" style={{ width: "100%", height: "100%", objectFit: "cover", position: "relative", zIndex: 1 }} onError={e => { e.target.style.display = "none"; }} />}
    </div>
  );
}

// Big score bubble: the overall similarity, or the isolated component's score
// (they are the same number when one component is isolated).
function OverallBubble({ sim, label = null }) {
  const v = sim == null ? null : Math.round(sim);
  return (
    <div style={{
      width: 64, height: 44, borderRadius: 10, flexShrink: 0,
      background: binColor(v), color: textOnBin(v),
      display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    }} title={label ? `${label} similarity (isolated)` : "Overall similarity"}>
      <span style={{ fontSize: 18, lineHeight: 1, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT }}>{v == null ? "—" : `${v}%`}</span>
      <span style={{ fontSize: 8, letterSpacing: 0.5, opacity: 0.85, marginTop: 2, textTransform: "uppercase" }}>{label || "Overall"}</span>
    </div>
  );
}

function CompCell({ label, comp, dim = false, highlight = false, t }) {
  const sim = comp?.sim;
  const v = sim == null ? null : Math.round(sim);
  return (
    <div style={{ minWidth: 72, flex: "1 1 72px", opacity: dim ? 0.45 : 1 }} title={comp?.d != null ? `distance ${comp.d.toFixed(2)} z · ${comp.shared} shared stats` : "not comparable"}>
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 10, color: highlight ? t.accent : t.textMuted, fontWeight: highlight ? 700 : 400 }}>
        <span>{label}</span>
        <span style={{ fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT, color: t.text }}>{v == null ? "—" : `${v}%`}</span>
      </div>
      <div style={{ height: 5, borderRadius: 3, background: t.divider, marginTop: 3, overflow: "hidden" }}>
        <div style={{ width: `${v ?? 0}%`, height: "100%", background: binColor(v), transition: "width 0.2s" }} />
      </div>
    </div>
  );
}

// Expanded comparison: a self-contained block (names and headshots at the top,
// the similarity scores, then the figures and stat tables) that can be saved
// as a PNG on its own.
function FeatureTable({ target, other, t, isolate = null, isolatedLabel = null, components = {}, unitLabel = "PA", type = "hitter" }) {
  const rows = featureRows(target, target.meta, other.player, other.meta);
  // With a component isolated, the block (and the PNG) covers only that component.
  const allComps = target.meta.components || {};
  const comps = isolate && allComps[isolate] ? { [isolate]: allComps[isolate] } : allComps;
  const shownComponents = isolate && components[isolate] ? { [isolate]: components[isolate] } : components;
  const figureShow = isolate ? (FIGURE_FOR_COMPONENT[isolate] || null) : "both";
  const showArsenalTable = !isolate || isolate === "arsenal";
  const arsenalA = target.arsenal, arsenalB = other.player.arsenal;
  const akeys = Object.keys(target.meta.arsenal_features || {});
  const cell = { padding: "2px 8px", fontSize: 11, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT, textAlign: "right", whiteSpace: "nowrap" };
  const head = { padding: "3px 8px", fontSize: 10, color: t.textFaint, textAlign: "right", fontWeight: 600, whiteSpace: "nowrap" };
  // compact variants for the side-by-side pitch tables of an isolated Arsenal
  const tight = { ...head, padding: "2px 5px", fontSize: 9 };
  const tcell = { ...cell, padding: "1px 5px", fontSize: 10 };
  const captureRef = useRef(null);
  const [saving, setSaving] = useState(false);
  const saveComparison = useCallback(async () => {
    if (saving) return;
    setSaving(true);
    try {
      const safe = s => String(s || "").replace(/\s+/g, "_");
      const suffix = isolate ? `_${safe(isolatedLabel || isolate).toLowerCase()}` : "";
      await saveCardAsPng(captureRef, `${safe(target.name)}_${target.season}_vs_${safe(other.name)}_${other.season}${suffix}.png`);
    } finally { setSaving(false); }
  }, [saving, target.name, target.season, other.name, other.season, isolate, isolatedLabel]);

  const meta = (p, season) => [season, p?.team, p?.hand ? `${p.hand}H${type === "pitcher" ? "P" : "H"}` : null, p?.n != null ? `${p.n.toLocaleString?.() ?? p.n} ${unitLabel}` : null].filter(Boolean).join(" · ");
  const Who = ({ p, season, name, color, align }) => (
    <div style={{ display: "flex", alignItems: "center", gap: 10, flexDirection: align === "right" ? "row-reverse" : "row", textAlign: align, minWidth: 0 }}>
      <Headshot pid={p.pid} name={name} t={t} size={48} />
      <div style={{ minWidth: 0 }}>
        <div style={{ fontSize: 15, fontWeight: 800, color: t.text, lineHeight: 1.15 }}>{name}</div>
        <div style={{ fontSize: 11, color: t.textMuted }}>{meta(p, season)}</div>
        <div style={{ height: 3, width: 44, background: color, borderRadius: 2, marginTop: 4, marginLeft: align === "right" ? "auto" : 0 }} />
      </div>
    </div>
  );

  return (
    <div style={{ padding: "4px 14px 12px 64px" }}>
    <div ref={captureRef} style={{ background: t.cardBg, borderRadius: 10, border: `1px solid ${t.divider}`, padding: "12px 14px 10px" }}>
      {/* header: who vs whom, with the scores */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 16, flexWrap: "wrap" }}>
        <Who p={target} season={target.season} name={target.name} color={t.accent} align="left" />
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4, flex: "1 1 220px" }}>
          <div style={{ fontSize: 9, letterSpacing: 1, color: t.textFaint, fontWeight: 700 }}>SIMILARITY</div>
          <OverallBubble sim={other.overall} label={isolatedLabel} />
        </div>
        <Who p={other.player} season={other.season} name={other.name} color={t.accentSecondary} align="right" />
      </div>
      <div style={{ display: "flex", gap: 10, flexWrap: "wrap", margin: "10px 0 12px", padding: "8px 10px", background: t.inputBg, borderRadius: 8 }}>
        {Object.keys(shownComponents).map(c => (
          <CompCell key={c} label={SHORT[c] || shownComponents[c].label} comp={other.comps[c]}
                    highlight={isolate === c} t={t} />
        ))}
      </div>
    {arsenalA && arsenalB && figureShow && <PitcherCompareFigures target={target} other={other} show={figureShow} />}
    {isolate ? (
      /* Isolated view: mirrored — the card's player's numbers on the left, the
         comp's on the right, stat label and Δz down the middle. */
      <div>
        {Object.entries(comps).map(([c, cm]) => {
          const rs = rows.filter(r => r.component === c);
          if (!rs.length) return null;
          const big = { ...cell, fontSize: 14, padding: "4px 10px" };
          const side = (name, season, color, align) => (
            <div style={{ fontSize: 11, fontWeight: 700, color, textAlign: align, padding: "0 10px 4px", borderBottom: `2px solid ${color}` }}>{name} {season}</div>
          );
          return (
            <div key={c} style={{ display: "grid", gridTemplateColumns: "1fr auto 1fr", columnGap: 12, alignItems: "stretch", maxWidth: 760, margin: "0 auto" }}>
              {side(target.name, target.season, t.accent, "right")}
              <div style={{ ...head, textAlign: "center", color: t.textMuted, alignSelf: "end" }}>{cm.label}</div>
              {side(other.name, other.season, t.accentSecondary, "left")}
              {rs.map((r, i) => {
                const dz = r.za != null && r.zb != null ? r.za - r.zb : null;
                const bg = i % 2 ? t.tableRowB : "transparent";
                return [
                  <div key={`${r.key}a`} style={{ ...big, textAlign: "right", color: t.text, background: bg }}>{fmtValue(r.a, r.fmt)}</div>,
                  <div key={`${r.key}m`} style={{ display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", padding: "2px 8px", background: bg, minWidth: 150 }}>
                    <span style={{ fontSize: 11, color: t.textMuted, whiteSpace: "nowrap" }}>{r.label}</span>
                    <span style={{ fontSize: 10, fontFamily: NUM_FONT, fontWeight: NUM_WEIGHT, color: dz == null ? t.textFaint : Math.abs(dz) < 0.5 ? t.textFaint : Math.abs(dz) < 1.25 ? t.accent : "#CB181D" }}>
                      Δz {dz == null ? "—" : (dz > 0 ? "+" : "") + dz.toFixed(1)}
                    </span>
                  </div>,
                  <div key={`${r.key}b`} style={{ ...big, textAlign: "left", color: t.text, background: bg }}>{fmtValue(r.b, r.fmt)}</div>,
                ];
              })}
            </div>
          );
        })}
        {arsenalA && arsenalB && showArsenalTable && (
          <div style={{ display: "flex", gap: 28, flexWrap: "wrap", alignItems: "flex-start", justifyContent: "space-between", marginTop: 14 }}>
            {[[target, arsenalA, t.accent], [other, arsenalB, t.accentSecondary]].map(([p, ars, color], idx) => (
              <table key={idx} style={{ borderCollapse: "collapse", flex: "1 1 300px", minWidth: 0 }}>
                <thead>
                  <tr>
                    <th style={{ ...tight, textAlign: "left", color, borderBottom: `2px solid ${color}`, fontWeight: 700 }}>{p.name} {p.season}</th>
                    <th style={tight}>Usage</th>
                    {akeys.filter(k => !["axis_sin", "axis_cos", "rel_x", "rel_z"].includes(k)).map(k => (
                      <th key={k} style={tight}>{target.meta.arsenal_features[k]?.label || k}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(ars).sort((x, y) => (ars[y].usage ?? 0) - (ars[x].usage ?? 0)).map(pt => (
                    <tr key={pt}>
                      <td style={{ ...tcell, textAlign: "left", fontFamily: "inherit", fontWeight: 600, color: t.textMuted }}>{pt}</td>
                      <td style={{ ...tcell, color: t.text }}>{`${Math.round(ars[pt].usage * 100)}%`}</td>
                      {akeys.filter(k => !["axis_sin", "axis_cos", "rel_x", "rel_z"].includes(k)).map(k => (
                        <td key={k} style={{ ...tcell, color: t.text }}>{fmtValue(ars[pt][k], target.meta.arsenal_features[k]?.fmt)}</td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            ))}
          </div>
        )}
      </div>
    ) : (
    <div style={{ display: "flex", gap: 24, flexWrap: "wrap", alignItems: "flex-start" }}>
      {Object.entries(comps).map(([c, cm]) => {
        const rs = rows.filter(r => r.component === c);
        if (!rs.length) return null;
        return (
          <table key={c} style={{ borderCollapse: "collapse" }}>
            <thead>
              <tr>
                <th style={{ ...head, textAlign: "left", color: t.textMuted }}>{cm.label}</th>
                <th style={head}>{target.name?.split(" ").slice(-1)[0]} {target.season}</th>
                <th style={head}>{other.name?.split(" ").slice(-1)[0]} {other.season}</th>
                <th style={head}>Δz</th>
              </tr>
            </thead>
            <tbody>
              {rs.map(r => {
                const dz = r.za != null && r.zb != null ? r.za - r.zb : null;
                return (
                  <tr key={r.key}>
                    <td style={{ ...cell, textAlign: "left", fontFamily: "inherit", fontWeight: 500, color: t.textMuted }}>{r.label}</td>
                    <td style={{ ...cell, color: t.text }}>{fmtValue(r.a, r.fmt)}</td>
                    <td style={{ ...cell, color: t.text }}>{fmtValue(r.b, r.fmt)}</td>
                    <td style={{ ...cell, color: dz == null ? t.textFaint : Math.abs(dz) < 0.5 ? t.textFaint : Math.abs(dz) < 1.25 ? t.accent : "#CB181D" }}>
                      {dz == null ? "—" : (dz > 0 ? "+" : "") + dz.toFixed(1)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        );
      })}
      {arsenalA && arsenalB && showArsenalTable && (
        <table style={{ borderCollapse: "collapse" }}>
          <thead>
            <tr>
              <th style={{ ...head, textAlign: "left", color: t.textMuted }}>Pitch</th>
              <th style={head}>Usage</th>
              {akeys.filter(k => !["axis_sin", "axis_cos", "rel_x", "rel_z"].includes(k)).map(k => (
                <th key={k} style={head}>{target.meta.arsenal_features[k]?.label || k}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {[...new Set([...Object.keys(arsenalA), ...Object.keys(arsenalB)])].sort().map(pt => (
              [["a", arsenalA[pt], target], ["b", arsenalB[pt], other]].map(([who, a, p]) => (
                <tr key={`${pt}:${who}`} style={{ opacity: a ? 1 : 0.45 }}>
                  <td style={{ ...cell, textAlign: "left", fontFamily: "inherit", fontWeight: 600, color: t.textMuted }}>
                    {pt} · {p.name?.split(" ").slice(-1)[0]} {p.season}
                  </td>
                  <td style={{ ...cell, color: t.text }}>{a ? `${Math.round(a.usage * 100)}%` : "—"}</td>
                  {akeys.filter(k => !["axis_sin", "axis_cos", "rel_x", "rel_z"].includes(k)).map(k => (
                    <td key={k} style={{ ...cell, color: t.text }}>{a ? fmtValue(a[k], target.meta.arsenal_features[k]?.fmt) : "—"}</td>
                  ))}
                </tr>
              ))
            ))}
          </tbody>
        </table>
      )}
    </div>
    )}
      <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, fontSize: 9, color: t.textFaint }}>
        <span>Similar Players{isolate ? ` · ${isolatedLabel} only` : ""} · {SIMILARITY_SEASONS[0]}–{SIMILARITY_SEASONS[SIMILARITY_SEASONS.length - 1]} player-seasons, each stat scaled within its own season · 100% = identical</span>
        <span style={{ fontStyle: "italic" }}>PastTheEyeTest</span>
      </div>
    </div>
    <div style={{ textAlign: "center", marginTop: 10 }}>
      <button
        onClick={saveComparison}
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
        {saving ? "Saving…" : "📥 Save comparison as PNG"}
      </button>
    </div>
    </div>
  );
}
