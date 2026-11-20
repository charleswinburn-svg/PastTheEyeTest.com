import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// PTET_PROXY_VIA: send the API proxies through another deployment of this site instead
// of straight to MLB/NHL. MLB refuses some datacenter IPs (the droplet gets 406s), so a
// preview on the droplet can borrow the live site's Vercel rewrites (vercel.json):
//   PTET_PROXY_VIA=https://www.pasttheeyetest.com npx vite preview --host 127.0.0.1 --port 4173
// Unset (the default), every proxy goes direct, as before.
const VIA = (process.env.PTET_PROXY_VIA || '').replace(/\/+$/, '');

const proxyTo = (prefix, target) => (VIA
  // Keep the prefix: the other deployment's own rewrites forward /mlb-api/... etc.
  ? { target: VIA, changeOrigin: true }
  : { target, changeOrigin: true, rewrite: (path) => path.replace(new RegExp(`^${prefix}`), '') });

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
