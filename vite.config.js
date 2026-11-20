import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import http from 'node:http';
import https from 'node:https';

// ── API pass-through for `vite` (dev) and `vite preview` ───────────────────
// Mirrors the vercel.json rewrites (/mlb-api/... → statsapi.mlb.com/..., etc.).
// Vite's built-in proxy got a 406 from MLB on the droplet even with the browser's
// headers stripped, while a plain Node https.get from the same machine got 200. So
// these routes are fetched exactly that way: a fresh request with only a neutral
// user-agent and Accept, streamed back. Non-2xx answers are logged to the console
// (~/preview.log on the droplet). Vercel doesn't use this file.
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
const HOP_BY_HOP = ['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'proxy-authenticate', 'proxy-authorization', 'te', 'trailer'];

function apiPassthrough(req, res, next) {
  const hit = Object.keys(API_ROUTES).find(p => req.url === p || req.url.startsWith(`${p}/`) || req.url.startsWith(`${p}?`));
  if (!hit) return next();
  const url = VIA ? new URL(req.url, VIA) : new URL(req.url.slice(hit.length) || '/', API_ROUTES[hit]);
  const headers = { 'user-agent': 'ptet-preview/1.0', accept: '*/*' };
  if (req.headers['content-type']) headers['content-type'] = req.headers['content-type'];
  const lib = url.protocol === 'http:' ? http : https;
  const up = lib.request(url, { method: req.method, headers }, (r) => {
    if (r.statusCode >= 400) console.warn(`[api] ${r.statusCode} ${req.method} ${url.href}`);
    const out = { ...r.headers };
    for (const h of HOP_BY_HOP) delete out[h];
    res.writeHead(r.statusCode, out);
    r.pipe(res);
  });
  up.on('error', (e) => {
    console.warn(`[api] error ${req.method} ${url.href}: ${e.code || e.message}`);
    if (!res.headersSent) { res.statusCode = 502; res.end(`upstream error: ${e.code || e.message}`); }
  });
  req.pipe(up);
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
