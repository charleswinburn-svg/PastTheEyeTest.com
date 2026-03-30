import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      // ── NHL proxies (existing) ──
      '/nhl-api': {
        target: 'https://api-web.nhle.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nhl-api/, ''),
      },
      '/nhl-assets': {
        target: 'https://assets.nhle.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/nhl-assets/, ''),
      },
      '/flag-assets': {
        target: 'https://flagcdn.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/flag-assets/, ''),
      },
      // ── MLB proxies ──
      '/mlb-api': {
        target: 'https://statsapi.mlb.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mlb-api/, ''),
      },
      '/mlb-photos': {
        target: 'https://img.mlbstatic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mlb-photos/, ''),
      },
      '/mlb-logos': {
        target: 'https://midfield.mlbstatic.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/mlb-logos/, ''),
      },
      '/savant-api': {
        target: 'https://baseballsavant.mlb.com',
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/savant-api/, ''),
      },
    },
  },
});
