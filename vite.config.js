import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PTET_PROXY_VIA (optional, normally unneeded): send the API proxies through another
// deployment of this site instead of straight to MLB/NHL, e.g. the live site's Vercel
// rewrites (vercel.json), if a machine's IP is ever refused:
//   PTET_PROXY_VIA=https://www.pasttheeyetest.com npx vite preview --host 127.0.0.1 --port 4173
// Unset (the default), every proxy goes direct, as before.
const VIA = (process.env.PTET_PROXY_VIA || '').replace(/\/+$/, '');

// The dev/preview proxy forwards the browser's own headers by default. MLB's bot filter
// answers a server-side request that claims to be Chrome (user-agent, sec-ch-ua,
// sec-fetch-*, cookies) with 406, while a plain request from the same machine gets 200.
// So strip those and send a neutral client, like curl. Vercel's rewrites don't use this file.
const BROWSER_HEADERS = [
  'user-agent', 'cookie', 'origin', 'referer', 'accept-language',
  'sec-ch-ua', 'sec-ch-ua-mobile', 'sec-ch-ua-platform',
  'sec-fetch-site', 'sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-user',
  'priority', 'dnt', 'upgrade-insecure-requests',
];
const scrubBrowserHeaders = (proxy) => {
  proxy.on('proxyReq', (proxyReq) => {
    for (const h of BROWSER_HEADERS) proxyReq.removeHeader(h);
    proxyReq.setHeader('user-agent', 'ptet-preview/1.0');
    proxyReq.setHeader('accept', '*/*');
  });
};

const proxyTo = (prefix, target) => (VIA
  // Keep the prefix: the other deployment's own rewrites forward /mlb-api/... etc.
  ? { target: VIA, changeOrigin: true, configure: scrubBrowserHeaders }
  : { target, changeOrigin: true, configure: scrubBrowserHeaders,
      rewrite: (path) => path.replace(new RegExp(`^${prefix}`), '') });

export default defineConfig({
  plugins: [react()],
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
    // `vite preview` uses these too.
    proxy: {
      // ── NHL proxies ──
      '/nhl-api':     proxyTo('/nhl-api', 'https://api-web.nhle.com'),
      '/nhl-assets':  proxyTo('/nhl-assets', 'https://assets.nhle.com'),
      '/flag-assets': proxyTo('/flag-assets', 'https://flagcdn.com'),
      // ── MLB proxies ──
      '/mlb-api':     proxyTo('/mlb-api', 'https://statsapi.mlb.com'),
      '/mlb-photos':  proxyTo('/mlb-photos', 'https://img.mlbstatic.com'),
      '/mlb-logos':   proxyTo('/mlb-logos', 'https://midfield.mlbstatic.com'),
      '/mlb-static':  proxyTo('/mlb-static', 'https://www.mlbstatic.com'),
      '/savant-api':  proxyTo('/savant-api', 'https://baseballsavant.mlb.com'),
      // ── Bzzoiro Football API ──
      '/bzzoiro': {
        target: 'https://sports.bzzoiro.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/bzzoiro/, ''),
      },
    },
  },
});
