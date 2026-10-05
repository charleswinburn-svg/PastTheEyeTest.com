// Exact iSwing+ over any window, from /iswing_games_{season}.json (iswing_update.py
// write_iswing_games): batterId -> { d:[mmdd…], n:[swings…], s:[Σ raw_value…] } per
// game date, plus meta { mu, sd, minSwings }. The season number is
//   100 + 15 · (ln(mean raw_value) − mu) / sd
// over the season's swings, so the same formula over a subset of dates gives that
// window's iSwing+ on the season's scale — and the whole season lands exactly on
// the published value.
import { loadSeasonJson } from "./kde.js";

export const ISWING_MIN_SWINGS = 25;   // season qualification (v9 notebook)

export function loadISwingGames(season) {
  return loadSeasonJson(`/iswing_games_${season}.json`);
}

export function iswingScore(n, s, meta) {
  if (!(n > 0) || !(s > 0) || !meta || !(meta.sd > 0)) return null;
  return 100 + 15 * (Math.log(s / n) - meta.mu) / meta.sd;
}

// iSwing+ over the dates in [fromMMDD, toMMDD] → { value, n }, or null when the
// window has fewer than minSwings swings.
export function iswingForWindow(entry, meta, fromMMDD, toMMDD, minSwings = ISWING_MIN_SWINGS) {
  if (!entry?.d) return null;
  const lo = fromMMDD ?? 0, hi = toMMDD ?? 9999;
  let n = 0, s = 0;
  for (let i = 0; i < entry.d.length; i++) {
    if (entry.d[i] >= lo && entry.d[i] <= hi) { n += entry.n[i]; s += entry.s[i]; }
  }
  if (n < minSwings) return null;
  const value = iswingScore(n, s, meta);
  return value == null ? null : { value, n };
}

const MONTHS = { 4: "Mar/Apr", 5: "May", 6: "Jun", 7: "Jul", 8: "Aug", 9: "Sep/Oct" };

// iSwing+ by calendar month (late-March games fold into April, early-October into
// September) → [{ key, label, value, n }], months under minSwings dropped.
export function iswingByMonth(entry, meta, minSwings = ISWING_MIN_SWINGS) {
  if (!entry?.d) return [];
  const acc = new Map();
  for (let i = 0; i < entry.d.length; i++) {
    const k = Math.min(Math.max(Math.floor(entry.d[i] / 100), 4), 9);
    const a = acc.get(k) || { n: 0, s: 0 };
    a.n += entry.n[i]; a.s += entry.s[i];
    acc.set(k, a);
  }
  return [...acc.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, a]) => a.n >= minSwings)
    .map(([k, a]) => ({ key: k, label: MONTHS[k], value: iswingScore(a.n, a.s, meta), n: a.n }))
    .filter(r => r.value != null);
}
