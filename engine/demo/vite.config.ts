import { defineConfig } from 'vite';

// The demo is its own Vite root, so it needs its own config (the repo root one is not picked up).
// `base: './'` keeps the built demo portable; `allowedHosts` lets the dev server run behind a proxy.
export default defineConfig({
  base: './',
  server: { allowedHosts: true },
});
