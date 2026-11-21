// ═══════════════════════════════════════════════════════════
// Pitch+ API client for live /score_aggregate scoring
// ═══════════════════════════════════════════════════════════
// A season or date-range Summary sends a few thousand pitches in one request. The API
// runs on a small host, and when several of those pile up it answers with a gateway
// error that carries no CORS header. The browser reports that as a CORS failure. So:
//   • only one request is in flight at a time; a newer one waits its turn, and one whose
//     Summary has moved on (aborted) is dropped before it is sent;
//   • a failure (network/CORS, 5xx, 429) is retried with backoff;
//   • successful answers are cached by payload, so going back to a range is instant.
// Resolves to the response JSON, or throws (AbortError when cancelled).

const URL_ = "https://api.pasttheeyetest.com/score_aggregate";
const RETRY_DELAYS = [1500, 4000, 9000];      // ms before attempts 2, 3, 4
const CACHE_MAX = 24;

const cache = new Map();                      // hash → response JSON (most recent last)
let queue = Promise.resolve();                // serializes requests

function hash(s) {                            // FNV-1a, plus length to keep collisions rare
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return `${s.length}:${(h >>> 0).toString(36)}`;
}

const abortError = () => new DOMException("Aborted", "AbortError");

function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const id = setTimeout(() => { signal?.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(id); reject(abortError()); };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function send(body, signal) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (attempt) await sleep(RETRY_DELAYS[attempt - 1], signal);
    try {
      const r = await fetch(URL_, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal });
      if (r.ok) return await r.json();
      lastErr = new Error(`Pitch+ API ${r.status}`);
      if (r.status < 500 && r.status !== 429) throw lastErr;   // bad request: retrying won't help
    } catch (e) {
      if (e?.name === "AbortError") throw e;
      if (e === lastErr) throw e;
      lastErr = e;                                               // network / CORS-blocked error
    }
    console.warn(`[Pitch+] /score_aggregate attempt ${attempt + 1} failed:`, lastErr?.message || lastErr);
  }
  throw lastErr;
}

export function scoreAggregate(pitches, { signal } = {}) {
  if (!pitches?.length) return Promise.resolve(null);
  const body = JSON.stringify({ pitches });
  const key = hash(body);
  if (cache.has(key)) {
    const v = cache.get(key);
    cache.delete(key); cache.set(key, v);
    return Promise.resolve(v);
  }
  const run = queue.then(async () => {
    if (signal?.aborted) throw abortError();
    if (cache.has(key)) return cache.get(key);
    const data = await send(body, signal);
    cache.set(key, data);
    while (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value);
    return data;
  });
  queue = run.catch(() => {});                // the next request waits, whatever happened here
  return run;
}
