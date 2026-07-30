// Gaussian KDE on a fixed [lo,hi] grid — mirrors iswing_update.py `_kde_curve`
// and build_pitcher_grade_dist.py `kde_on_grid` (Silverman bandwidth). Returns a
// length-`n` density array (area ~1), the same shape KdeCurve consumes, or null.
export function gaussianKde(vals, lo, hi, n = 64) {
  const s = [];
  for (const v of vals || []) if (Number.isFinite(v)) s.push(v);
  if (s.length < 2) return null;
  const mean = s.reduce((a, b) => a + b, 0) / s.length;
  const variance = s.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (s.length - 1);
  let std = Math.sqrt(variance);
  if (!Number.isFinite(std) || std <= 0) std = 1;
  let h = 1.06 * std * Math.pow(s.length, -1 / 5);   // Silverman's rule
  if (h <= 0) h = 1;
  const norm = s.length * h * Math.sqrt(2 * Math.PI);
  const out = new Array(n);
  for (let i = 0; i < n; i++) {
    const x = lo + (hi - lo) * (i / (n - 1));
    let sum = 0;
    for (let j = 0; j < s.length; j++) {
      const z = (x - s[j]) / h;
      sum += Math.exp(-0.5 * z * z);
    }
    out[i] = Math.round((sum / norm) * 1e5) / 1e5;
  }
  return out;
}

// "2026-07-15" -> 715 (month*100+day), matching the pipeline's per-event `_mmdd`.
// Monotonic within a season, so range comparisons work. null if unparseable.
export function mmddFromDate(dateStr) {
  if (!dateStr) return null;
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(String(dateStr));
  return m ? parseInt(m[1], 10) * 100 + parseInt(m[2], 10) : null;
}

// Shared cached fetch (per-URL) so the large per-swing file is loaded + parsed once
// even though both the hitter card (bubble) and its distribution panel need it.
const _seasonCache = new Map();
export function loadSeasonJson(url) {
  if (!_seasonCache.has(url)) {
    _seasonCache.set(url, fetch(url).then(r => (r.ok ? r.json() : null)).catch(() => null));
  }
  return _seasonCache.get(url);
}

// Filter parallel {v:[…], d:[…mmdd…]} to a [fromMMDD,toMMDD] window → the kept v's.
export function filterByWindow(v, d, fromMMDD, toMMDD) {
  if (!Array.isArray(v) || !Array.isArray(d)) return [];
  const lo = fromMMDD ?? 0, hi = toMMDD ?? 9999;
  const out = [];
  for (let i = 0; i < v.length; i++) {
    const m = d[i];
    if (m == null || (m >= lo && m <= hi)) out.push(v[i]);
  }
  return out;
}
