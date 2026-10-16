import { defineConfig } from 'vite';

// The app serves stage 2's output directly: asset-generation/assets/cars/<id>/ -> /cars/<id>/
export default defineConfig({
  publicDir: '../asset-generation/assets',
  build: { rollupOptions: { input: { main: 'index.html', compare: 'compare.html', views: 'views.html', inspect: 'inspect.html', drive: 'drive.html', online: 'online.html' } } },
});
