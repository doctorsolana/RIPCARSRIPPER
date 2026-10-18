import { defineConfig } from 'vite';

// The app serves stage 2's output directly: asset-generation/assets/cars/<id>/ -> /cars/<id>/
// Pages: index.html the landing, rip.html the pack-rip reveal (dev mode), drive / online the game, inspect / compare /
// views the review tools. (stills.html is a dev-server tool for scripts/render-home.mjs: not built.)
export default defineConfig({
  publicDir: '../asset-generation/assets',
  build: {
    rollupOptions: {
      input: { main: 'index.html', rip: 'rip.html', compare: 'compare.html', views: 'views.html', inspect: 'inspect.html', drive: 'drive.html', online: 'online.html' },
    },
  },
});
