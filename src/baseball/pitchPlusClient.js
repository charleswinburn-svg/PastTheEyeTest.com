// ═══════════════════════════════════════════════════════════
// Pitch+ API client for live /score_aggregate scoring
// ═══════════════════════════════════════════════════════════
// A season or date-range Summary has a few thousand pitches, about 2 MB of JSON. The API
// host refuses a body that big with "413 Request Entity Too Large", and that error page
// has no CORS header, so the browser only reports a CORS failure. So:
//   • the payload is trimmed (fields the server doesn't read, numbers to 4 decimals);
//   • pitches go in pieces under a size budget, sent one at a time, and the answers are
//     combined. Every pitch is scored on its own and a grade is the mean of its pitches'
//     run values, so a pitch-count-weighted average of the pieces equals the
//     single-request grade (to the 0.1 the API rounds to). The one exception: a pitcher
//     with no stored fastball baseline, whose baseline is built from each piece's fastballs;
//   • when a piece still fails it's split in half (the size limit isn't known here), and
//     the budget drops to what worked for the rest of the session; small pieces are
//     retried with backoff;
//   • a newer request waits its turn, a cancelled one (AbortSignal) stops, and answers
//     are cached by payload so going back to a date range is instant.
// Resolves to { by_pitch_type, by_pitch_type_stand, overall, per_pitch }, or throws
// (AbortError when cancelled).

const URL_ = "https://api.pasttheeyetest.com/score_aggregate";
const RETRY_DELAYS = [1500, 4000, 9000];      // ms before attempts 2, 3, 4
const MIN_SPLIT = 120;                         // below this, retry instead of splitting
const CACHE_MAX = 24;

let budget = 450_000;                          // characters per request; lowered on failure
const cache = new Map();                       // hash → response JSON (most recent last)
let queue = Promise.resolve();                 // serializes jobs

function hash(s) {                             // FNV-1a, plus length to keep collisions rare
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const abortError = () => new DOMException("Aborted", "AbortError");
const isAbort = (e) => e?.name === "AbortError";

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const id = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(id); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

// Fields the server reads, numbers rounded to 4 decimals (far finer than the tracking
// data), nulls dropped. `_pitchType` is the page's own label and isn't sent.
function compact(v) {
  if (typeof v === "number") return Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : null;
  if (Array.isArray(v)) return v.map(compact);
  if (v && typeof v === "object") {
    const o = {};
    for (const [k, x] of Object.entries(v)) {
      if (x == null || k === "_pitchType") continue;
      const c = compact(x);
      if (c != null) o[k] = c;
    }
    return o;
  }
  return v;
}

async function post(body, signal) {
  const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
  if (r.ok) return r.json();
  const e = new Error(`Pitch+ API ${r.status}`);
  e.status = r.status;
  throw e;
}

// One piece: [pitch JSON strings] → response. Splits on failure while the piece is big.
async function scorePiece(strs, signal) {
  const body = `{"pitches":[${strs.join(",")}]}`;
  const key = hash(body);
  if (cache.has(key)) return cache.get(key);
  if (signal?.aborted) throw abortError();

  const big = strs.length >= MIN_SPLIT * 2;
  let lastErr;
  for (let attempt = 0; attempt <= (big ? 0 : RETRY_DELAYS.length); attempt++) {
    if (attempt) await sleep(RETRY_DELAYS[attempt - 1], signal);
    try {
      const data = await post(body, signal);
      cache.set(key, data);
      while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
      return data;
    } catch (e) {
      if (isAbort(e)) throw e;
      lastErr = e;
      console.warn(`[Pitch+] /score_aggregate (${strs.length} pitches, ${Math.round(body.length / 1024)} KB) failed:`, e?.message || e);
      if (e?.status && e.status < 500 && e.status !== 413 && e.status !== 429) break;   // bad request
    }
  }
  if (!big) throw lastErr;
  // Too big (or the host is struggling): halve it, and start later requests at that size.
  budget = Math.min(budget, Math.max(40_000, Math.floor(body.length / 2)));
  const mid = Math.ceil(strs.length / 2);
  const a = await scorePiece(strs.slice(0, mid), signal);
  const b = await scorePiece(strs.slice(mid), signal);
  return merge([a, b]);
}

// ── Combining pieces (same math as the server's aggregation) ──
const PLUS = ["stuff", "loc", "tun", "pitch"];
const r1 = (v) => Math.round(v * 10) / 10;

function mergeGroups(groups) {
  const out = { n: 0 };
  for (const g of groups) out.n += g?.n || 0;
  for (const k of [...PLUS, "xrv"]) {
    let s = 0, w = 0;
    for (const g of groups) if (g && g[k] != null && g.n > 0) { s += g[k] * g.n; w += g.n; }
    out[k] = w ? (k === "xrv" ? s / w : r1(s / w)) : null;
  }
  return out;
}

function overallOf(byPt) {                     // server: _weighted_overall_agg
  const g = mergeGroups(Object.values(byPt));
  if (g.xrv != null) g.xrv = Math.round(g.xrv * 1000) / 1000;
  return g;
}

function merge(parts) {
  parts = parts.filter(Boolean);
  if (parts.length === 1) return parts[0];
  const types = new Set(parts.flatMap(p => Object.keys(p.by_pitch_type || {})));
  const by_pitch_type = {};
  for (const pt of types) by_pitch_type[pt] = mergeGroups(parts.map(p => p.by_pitch_type?.[pt]));
  const by_pitch_type_stand = {};
  const standTypes = new Set(parts.flatMap(p => Object.keys(p.by_pitch_type_stand || {})));
  for (const pt of standTypes) {
    const sides = {};
    for (const side of ["L", "R"]) {
      const gs = parts.map(p => p.by_pitch_type_stand?.[pt]?.[side]).filter(Boolean);
      if (gs.length) sides[side] = mergeGroups(gs);
    }
    by_pitch_type_stand[pt] = sides;
  }
  const hasStand = parts.some(p => p.by_pitch_type_stand);
  return {
    by_pitch_type,
    ...(hasStand ? { by_pitch_type_stand } : {}),
    overall: overallOf(by_pitch_type),
    per_pitch: parts.flatMap(p => p.per_pitch || []),
  };
}

export function scoreAggregate(pitches, { signal } = {}) {
  if (!pitches?.length) return Promise.resolve(null);
  const strs = pitches.map(p => JSON.stringify(compact(p)));
  const jobKey = hash(strs.join(","));
  if (cache.has(jobKey)) return Promise.resolve(cache.get(jobKey));

  const run = queue.then(async () => {
    if (signal?.aborted) throw abortError();
    if (cache.has(jobKey)) return cache.get(jobKey);
    // Pieces of about `budget` characters, as even as possible. The size is worked out
    // again before each piece, so once a piece had to be split the rest go out smaller.
    const total = strs.reduce((s, x) => s + x.length + 1, 0);
    const avg = total / strs.length;
    const parts = [];
    for (let i = 0; i < strs.length;) {
      const left = strs.length - i;
      const nLeft = Math.max(1, Math.ceil((left * avg) / budget));
      const take = Math.ceil(left / nLeft);
      parts.push(await scorePiece(strs.slice(i, i + take), signal));
      i += take;
    }
    const data = merge(parts);
    if (parts.length > 1) console.log(`[Pitch+] Scored ${strs.length} pitches in ${parts.length} pieces (${Math.round(total / 1024)} KB)`);
    cache.set(jobKey, data);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return data;
  });
  queue = run.catch(() => {});                 // the next job waits, whatever happened here
  return run;
}
