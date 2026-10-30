// similarity.js — player-similarity ranking in the browser.
//
// Reads public/similarity_{hitters,pitchers}_{season}.json (built by
// build_similarity_hitters.py / build_similarity_pitchers.py) and ranks the
// player-seasons most like a target. The maths mirrors similarity_common.py and
// the two must stay in step:
//
//   * every feature is z-scored within its own season (meta.stats), clipped ±3
//   * component distance d_c = weighted RMS of z-differences over the features
//     both players have (null when fewer than half are shared)
//   * component similarity % = 100 · max(0, 1 − d_c / D_c) with D_c the pool's
//     95th-percentile pairwise distance (meta.calib; averaged across the two
//     seasons of a pair)
//   * overall % = weighted mean of the component percentages (user weights)
//   * pitcher arsenal: usage-weighted pitch-type-to-pitch-type shape distance
//     (penalty for a pitch only one side throws) blended with the pitch-mix term

export const SIMILARITY_SEASONS = [2023, 2024, 2025, 2026];
const Z_CLIP = 3;
const MIN_SHARED_FRAC = 0.5;

const _cache = {};          // `${type}:${season}` → Promise<pool|null>

export function unpackFile(json) {
  const meta = json.meta || {};
  const fkeys = meta.feature_keys || Object.keys(meta.features || {});
  const akeys = meta.arsenal_keys || Object.keys(meta.arsenal_features || {});
  const players = {};
  for (const [pid, p] of Object.entries(json.players || {})) {
    const v = {};
    const arr = Array.isArray(p.v) ? p.v : null;
    fkeys.forEach((k, i) => { v[k] = arr ? arr[i] : p.v?.[k]; });
    let arsenal;
    if (p.arsenal) {
      arsenal = {};
      for (const [pt, a] of Object.entries(p.arsenal)) {
        if (Array.isArray(a)) {
          const o = { usage: a[0] };
          akeys.forEach((k, i) => { o[k] = a[i + 1]; });
          arsenal[pt] = o;
        } else arsenal[pt] = a;
      }
    }
    players[pid] = { ...p, pid, season: json.season, v, arsenal };
  }
  return { season: json.season, type: json.type, meta, players };
}

export function loadSimilarityPool(type, seasons = SIMILARITY_SEASONS) {
  const file = type === "pitcher" ? "similarity_pitchers" : "similarity_hitters";
  return Promise.all(seasons.map(s => {
    const key = `${type}:${s}`;
    if (!_cache[key]) {
      _cache[key] = fetch(`/${file}_${s}.json`)
        .then(r => (r.ok ? r.json() : null))
        .then(j => (j ? unpackFile(j) : null))
        .catch(() => null);
    }
    return _cache[key];
  })).then(pools => pools.filter(Boolean));
}

const isNum = v => typeof v === "number" && Number.isFinite(v);

export function zscore(v, st) {
  if (!st || !isNum(v)) return null;
  const z = (v - st.mean) / st.sd;
  return Math.max(-Z_CLIP, Math.min(Z_CLIP, z));
}

export function zVector(values, stats, keys) {
  const out = {};
  for (const k of keys) out[k] = zscore(values?.[k], stats?.[k]);
  return out;
}

// Weighted RMS z-difference over shared features; null if too few are shared.
export function componentDistance(za, zb, keys, weights) {
  let num = 0, den = 0, shared = 0;
  for (const k of keys) {
    const a = za[k], b = zb[k];
    if (a == null || b == null) continue;
    const w = weights?.[k] ?? 1;
    num += w * (a - b) * (a - b);
    den += w;
    shared += 1;
  }
  if (!keys.length || shared < Math.max(1, Math.ceil(MIN_SHARED_FRAC * keys.length)) || den <= 0) {
    return { d: null, shared };
  }
  return { d: Math.sqrt(num / den), shared };
}

function arsenalShapeDistance(arsA, arsB, statsA, statsB, weights, penalty) {
  const types = new Set([...Object.keys(arsA || {}), ...Object.keys(arsB || {})]);
  if (!types.size) return null;
  const keys = Object.keys(weights);
  let num = 0, den = 0;
  for (const pt of types) {
    const a = arsA?.[pt], b = arsB?.[pt];
    const w = ((a?.usage ?? 0) + (b?.usage ?? 0)) / 2;
    if (w <= 0) continue;
    let d = penalty;
    if (a && b) {
      const za = zVector(a, statsA?.[pt], keys);
      const zb = zVector(b, statsB?.[pt], keys);
      const r = componentDistance(za, zb, keys, weights);
      if (r.d != null) d = r.d;
    }
    num += w * d;
    den += w;
  }
  return den > 0 ? num / den : null;
}

export function arsenalDistance(pa, pb, za, zb, metaA, metaB, fweights) {
  const calib = metaA.calib || {};
  const penalty = calib.missing_pitch_penalty ?? 1.5;
  const shapeW = calib.shape_weight ?? 0.7;
  const aw = {};
  for (const [k, f] of Object.entries(metaA.arsenal_features || {})) aw[k] = f.weight ?? 1;
  const dShape = arsenalShapeDistance(pa.arsenal, pb.arsenal, metaA.arsenal_stats, metaB.arsenal_stats, aw, penalty);
  const mixKeys = metaA.components?.arsenal?.features || [];
  const mix = componentDistance(za, zb, mixKeys, fweights);
  if (dShape == null && mix.d == null) return { d: null, shared: 0 };
  if (dShape == null) return { d: mix.d, shared: mix.shared };
  if (mix.d == null) return { d: dShape, shared: mixKeys.length };
  return { d: shapeW * dShape + (1 - shapeW) * mix.d, shared: mixKeys.length };
}

export const simFromDistance = (d, D) => (d == null || !D ? null : 100 * Math.max(0, 1 - d / D));

function featureWeights(meta) {
  const w = {};
  for (const [k, f] of Object.entries(meta.features || {})) w[k] = f.weight ?? 1;
  return w;
}

// Compare two unpacked players (each carrying its pool's meta). Returns
// { comps: {c: {sim, d, shared}}, overall } or null when nothing is comparable.
export function comparePlayers(a, metaA, b, metaB, compWeights = {}) {
  const fw = featureWeights(metaA);
  const keys = Object.keys(metaA.features || {});
  const za = zVector(a.v, metaA.stats, keys);
  const zb = zVector(b.v, metaB.stats, keys);
  const comps = {};
  let num = 0, den = 0;
  for (const [c, cm] of Object.entries(metaA.components || {})) {
    const r = (metaA.type === "pitcher" || c === "arsenal") && c === "arsenal"
      ? arsenalDistance(a, b, za, zb, metaA, metaB, fw)
      : componentDistance(za, zb, cm.features || [], fw);
    const Da = metaA.calib?.[c], Db = metaB.calib?.[c];
    const D = Da && Db ? (Da + Db) / 2 : (Da || Db);
    const sim = simFromDistance(r.d, D);
    comps[c] = { sim, d: r.d, shared: r.shared };
    const w = compWeights[c] ?? 1;
    if (sim != null && w > 0) { num += w * sim; den += w; }
  }
  if (den <= 0) return null;
  return { comps, overall: num / den };
}

// Rank every player-season in `pools` against the target.
// opts: { weights: {component: 0|1|2}, sameHand, excludeSelf, currentSeasonOnly, limit }
export function rankComps(target, pools, opts = {}) {
  const { weights = {}, sameHand = false, excludeSelf = false, currentSeasonOnly = false, limit = 10 } = opts;
  const tPool = pools.find(p => String(p.season) === String(target.season));
  const tp = tPool?.players?.[String(target.pid)];
  if (!tp) return { target: null, results: [] };
  const metaA = { ...tPool.meta, type: tPool.type };
  const out = [];
  for (const pool of pools) {
    if (currentSeasonOnly && String(pool.season) !== String(target.season)) continue;
    for (const [pid, p] of Object.entries(pool.players)) {
      const self = pid === String(tp.pid);
      if (self && String(pool.season) === String(tPool.season)) continue;
      if (self && excludeSelf) continue;
      if (sameHand && tp.hand && p.hand && tp.hand !== "S" && p.hand !== "S" && tp.hand !== p.hand) continue;
      const cmp = comparePlayers(tp, metaA, p, pool.meta, weights);
      if (!cmp) continue;
      out.push({ pid, season: pool.season, name: p.name, team: p.team, team_id: p.team_id, hand: p.hand,
                 n: p.n, self, overall: cmp.overall, comps: cmp.comps, player: p, meta: pool.meta });
    }
  }
  out.sort((x, y) => y.overall - x.overall);
  return { target: { ...tp, meta: metaA }, results: limit ? out.slice(0, limit) : out };
}

// Side-by-side feature rows for an expanded comp: [{key, label, fmt, component, a, b, za, zb}]
export function featureRows(target, metaA, other, metaB) {
  const rows = [];
  for (const [c, cm] of Object.entries(metaA.components || {})) {
    for (const k of cm.features || []) {
      const f = metaA.features?.[k] || {};
      rows.push({ key: k, component: c, label: f.label || k, fmt: f.fmt || ".1f",
                  a: target.v?.[k], b: other.v?.[k],
                  za: zscore(target.v?.[k], metaA.stats?.[k]), zb: zscore(other.v?.[k], metaB.stats?.[k]) });
    }
  }
  return rows;
}

// Python-style fmt (".1f", "+.1f", ".0f", ".3f") for display.
export function fmtValue(v, fmt = ".1f") {
  if (!isNum(v)) return "—";
  const m = /^(\+?)\.(\d)f$/.exec(fmt);
  const plus = m ? m[1] === "+" : false;
  const nd = m ? parseInt(m[2], 10) : 1;
  const s = v.toFixed(nd);
  return plus && v > 0 ? `+${s}` : s;
}
