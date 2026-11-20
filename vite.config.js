import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import http from 'node:http';
import https from 'node:https';

// ── API pass-through for `vite` (dev) and `vite preview` ───────────────────
// Mirrors the vercel.json rewrites (/mlb-api/... → statsapi.mlb.com/..., etc.).
// On the droplet MLB answered 406 to most proxied requests (Vite's proxy, and plain Node
// when the page fired many at once) but 200 to single curl / Node requests. So these
// routes go through a small fetcher: neutral user-agent + Accept only, shared in-flight
// requests, a 10-minute cache of 200s, at most 4 at a time, retries on refusal, then a
// curl fallback. What happened is logged with an [api] prefix (~/preview.log on the
// droplet). Vercel doesn't use this file.
//
// PTET_PROXY_VIA (optional, normally unneeded): fetch through another deployment of
// this site instead (keeping the /mlb-api prefix for its own rewrites), e.g.
//   PTET_PROXY_VIA=https://www.pasttheeyetest.com npx vite preview --host 127.0.0.1 --port 4173
const VIA = (process.env.PTET_PROXY_VIA || '').replace(/\/+$/, '');

const API_ROUTES = {
  '/nhl-api':     'https://api-web.nhle.com',
  '/nhl-assets':  'https://assets.nhle.com',
  '/flag-assets': 'https://flagcdn.com',
  '/mlb-api':     'https://statsapi.mlb.com',
  '/mlb-photos':  'https://img.mlbstatic.com',
  '/mlb-logos':   'https://midfield.mlbstatic.com',
  '/mlb-static':  'https://www.mlbstatic.com',
  '/savant-api':  'https://baseballsavant.mlb.com',
};
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer', 'content-length'];
const UA = 'ptet-preview/1.0';

// GETs only (all these routes are read-only). Gentle on MLB: identical requests in flight
// share one upstream call, 200s are cached for 10 minutes, at most 4 run at once, a
// refusal (406/429/5xx) is retried with backoff, and as a last resort the request is
// made with curl, which has always been accepted from the droplet.
const MAX_ACTIVE = 4, CACHE_MS = 10 * 60 * 1000, RETRIES = 3;
const cache = new Map();      // url → { at, status, headers, body }
const inflight = new Map();   // url → Promise
let active = 0;
const waiting = [];
const slot = () => new Promise(r => (active < MAX_ACTIVE ? (active++, r()) : waiting.push(r)));
const release = () => { const n = waiting.shift(); if (n) n(); else active--; };
const sleep = ms => new Promise(r => setTimeout(r, ms));
const refused = s => s === 406 || s === 429 || s >= 500;

function nodeGet(url) {
  const lib = url.protocol === 'http:' ? http : https;
  return new Promise((resolve, reject) => {
    const rq = lib.get(url, { agent: false, headers: { 'user-agent': UA, accept: '*/*' } }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body: Buffer.concat(chunks) }));
      r.on('error', reject);
    });
    rq.setTimeout(45000, () => rq.destroy(new Error('timeout')));
    rq.on('error', reject);
  });
}

async function curlGet(url) {
  const { execFile } = await import('node:child_process');
  const fs = await import('node:fs/promises');
  const os = await import('node:os');
  const path = await import('node:path');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'ptet-api-'));
  const hf = path.join(dir, 'h'), bf = path.join(dir, 'b');
  try {
    await new Promise((resolve, reject) => execFile('curl',
      ['-s', '--max-time', '45', '-A', UA, '-H', 'Accept: */*', '-D', hf, '-o', bf, url.href],
      (err) => (err ? reject(err) : resolve())));
    const rawHeaders = await fs.readFile(hf, 'utf8');
    const blocks = rawHeaders.trim().split(/\r?\n\r?\n/);          // last block = final response
    const lines = blocks[blocks.length - 1].split(/\r?\n/);
    const status = +(lines[0].match(/\s(\d{3})/) || [])[1] || 502;
    const headers = {};
    for (const l of lines.slice(1)) { const i = l.indexOf(':'); if (i > 0) headers[l.slice(0, i).trim().toLowerCase()] = l.slice(i + 1).trim(); }
    return { status, headers, body: await fs.readFile(bf) };
  } finally {
    fs.rm(dir, { recursive: true, force: true });
  }
}

async function fetchUpstream(url) {
  await slot();
  try {
    let r, err;
    for (let attempt = 0; attempt <= RETRIES; attempt++) {
      if (attempt) await sleep(400 * 2 ** (attempt - 1));
      try { r = await nodeGet(url); err = null; } catch (e) { err = e; r = null; }
      if (r && !refused(r.status)) {
        if (attempt) console.warn(`[api] ${r.status} after ${attempt} retr${attempt === 1 ? 'y' : 'ies'}: ${url.href}`);
        return r;
      }
    }
    const first = r ? r.status : (err?.code || err?.message);
    try {
      const c = await curlGet(url);
      console.warn(`[api] node got ${first}, curl got ${c.status}: ${url.href}`);
      return c;
    } catch (e) {
      console.warn(`[api] node got ${first}, curl failed (${e.code || e.message}): ${url.href}`);
      if (r) return r;
      throw err || e;
    }
  } finally { release(); }
}

function apiPassthrough(req, res, next) {
  const hit = Object.keys(API_ROUTES).find(p => req.url === p || req.url.startsWith(`${p}/`) || req.url.startsWith(`${p}?`));
  if (!hit) return next();
  if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end('read-only proxy'); }
  const url = VIA ? new URL(req.url, VIA) : new URL(req.url.slice(hit.length) || '/', API_ROUTES[hit]);
  const key = url.href;

  const send = ({ status, headers, body }) => {
    const out = { ...headers };
    for (const h of HOP_BY_HOP) delete out[h];
    out['content-length'] = body.length;
    res.writeHead(status, out);
    res.end(req.method === 'HEAD' ? undefined : body);
  };

  const c = cache.get(key);
  if (c && Date.now() - c.at < CACHE_MS) return send(c);

  let p = inflight.get(key);
  if (!p) {
    p = fetchUpstream(url).then((r) => {
      if (r.status >= 400) console.warn(`[api] ${r.status} GET ${key}`);
      if (r.status === 200) cache.set(key, { ...r, at: Date.now() });
      return r;
    }).finally(() => inflight.delete(key));
    inflight.set(key, p);
  }
  p.then(send, (e) => {
    console.warn(`[api] error GET ${key}: ${e.code || e.message}`);
    if (!res.headersSent) { res.statusCode = 502; res.end(`upstream error: ${e.code || e.message}`); }
  });
}

const apiPlugin = {
  name: 'ptet-api-passthrough',
  configureServer(server) { server.middlewares.use(apiPassthrough); },
  configurePreviewServer(server) { server.middlewares.use(apiPassthrough); },
};

export default defineConfig({
  plugins: [react(), apiPlugin],
  server: {
    port: 5173,
    // The dev server watches the whole project by default. On the droplet that
    // includes the Python venvs, parquet/CSV data and build output, which blows
    // past the inotify watcher limit (ENOSPC). Only the app sources need watching.
    watch: {
      ignored: [
        '**/.venv*/**', '**/venv/**', '**/__pycache__/**',
        '**/dist/**', '**/tmp/**', '**/notebooks/**', '**/data/**',
        '**/*.parquet', '**/*.csv', '**/*.pkl', '**/*.ipynb', '**/*.png',
      ],
    },
    // `vite preview` uses these too. (MLB/NHL routes are handled by apiPlugin above.)
    proxy: {
      // ── Bzzoiro Football API ──
      '/bzzoiro': {
        target: 'https://sports.bzzoiro.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bzzoiro/, ''),
      },
    },
  },
});
