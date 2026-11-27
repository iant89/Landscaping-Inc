import { defineConfig } from 'vite';

// relative base so the build works on GitHub Pages under /<repo>/
export default defineConfig({
  base: './',
  // let the dev server be reached through a proxy / preview host
  server: { allowedHosts: true },
});
