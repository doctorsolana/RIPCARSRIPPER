import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import { buildId } from './server/build-id.ts';

// The app serves stage 2's output directly: asset-generation/assets/cars/<id>/ -> /cars/<id>/
// Pages: index.html the landing, rip.html the pack-rip reveal (dev mode), drive / online the game, inspect / compare /
// views the review tools, 404.html the not-found page. (stills.html is a dev-server tool for scripts/render-home.mjs:
// not built.) static/ holds the site's root files - favicons, the web manifest, robots.txt, sitemap.xml, the link
// preview image (scripts/render-site.mjs makes the pictures): served at / by the dev server, copied into dist/.
const STATIC = new URL('./static/', import.meta.url).pathname;
const TYPES: Record<string, string> = {
  '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.txt': 'text/plain', '.xml': 'application/xml', '.webmanifest': 'application/manifest+json',
};
function siteRoot(): Plugin {
  let out = 'dist';
  return {
    name: 'site-root',
    configResolved(c) {
      out = c.build.outDir;
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const f = join(STATIC, (req.url ?? '').split('?')[0]);
        if (!f.startsWith(STATIC) || !existsSync(f) || f === STATIC) return next();
        res.setHeader('content-type', TYPES[extname(f)] ?? 'application/octet-stream');
        res.end(readFileSync(f));
      });
    },
    closeBundle() {
      mkdirSync(out, { recursive: true });
      for (const f of readdirSync(STATIC)) copyFileSync(join(STATIC, f), join(out, f));
    },
  };
}

/** `import { BUILD_ID } from 'virtual:build-id'`: the sim build id (server/build-id.ts - the game server computes the same
 *  from the same files and refuses a join with another). In dev it's recomputed whenever one of its files changes (the
 *  pages reload), so the dev server always says what's on disk - a game server started before the change says it's
 *  another version until it's restarted, as it really is. */
function buildIdModule(): Plugin {
  const ID = 'virtual:build-id', RID = '\0virtual:build-id';
  let files = new Set<string>();
  return {
    name: 'build-id',
    resolveId: (id) => (id === ID ? RID : undefined),
    load(id) {
      if (id !== RID) return;
      const b = buildId();
      files = new Set(b.files);
      return `export const BUILD_ID = ${JSON.stringify(b.id)};\n`;
    },
    configureServer(server) {
      const changed = (f: string) => {
        const m = server.moduleGraph.getModuleById(RID);
        if (!m || !(files.has(f) || /\/cars\/[^/]+\/(model|meta)\.json$/.test(f))) return;
        server.moduleGraph.invalidateModule(m);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', changed).on('add', changed).on('unlink', changed);
    },
  };
}

/** `import { CARS, CAR_V } from 'virtual:cars'`: assets/cars/index.json's cars, built into the pages (no fetch, never a
 *  stale list), and each car's version - a hash of the files in its folder - that src/catalog.ts puts on the URLs of
 *  its files: a car whose model changed is a new URL, so a browser never keeps the old one (vercel.json keeps a
 *  versioned car file a year). In dev the module is made again when a car's files change (the pages reload). */
const CARS_DIR = new URL('../asset-generation/assets/cars/', import.meta.url).pathname;
function carsModule(): Plugin {
  const ID = 'virtual:cars', RID = '\0virtual:cars';
  return {
    name: 'cars',
    resolveId: (id) => (id === ID ? RID : undefined),
    load(id) {
      if (id !== RID) return;
      const { cars } = JSON.parse(readFileSync(join(CARS_DIR, 'index.json'), 'utf8')) as { cars: { id: string }[] };
      const v: Record<string, string> = {};
      for (const c of cars) {
        const dir = join(CARS_DIR, c.id);
        if (!existsSync(dir)) continue;
        const h = createHash('sha1');
        for (const f of readdirSync(dir).sort()) {
          if (f.startsWith('.') || !statSync(join(dir, f)).isFile()) continue; // (its own files: not the review folders)
          h.update(f).update(readFileSync(join(dir, f)));
        }
        v[c.id] = h.digest('hex').slice(0, 10);
      }
      return `export const CARS = ${JSON.stringify(cars)};\nexport const CAR_V = ${JSON.stringify(v)};\n`;
    },
    configureServer(server) {
      const changed = (f: string) => {
        const m = server.moduleGraph.getModuleById(RID);
        if (!m || !f.startsWith(CARS_DIR) || f.slice(CARS_DIR.length).split('/').length > 2) return; // (index.json, a car's own files)
        server.moduleGraph.invalidateModule(m);
        server.ws.send({ type: 'full-reload' });
      };
      server.watcher.on('change', changed).on('add', changed).on('unlink', changed);
    },
  };
}

export default defineConfig({
  publicDir: '../asset-generation/assets',
  plugins: [siteRoot(), buildIdModule(), carsModule()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html', rip: 'rip.html', compare: 'compare.html', views: 'views.html', inspect: 'inspect.html', drive: 'drive.html', online: 'online.html', garage: 'garage.html',
        notfound: '404.html',
      },
    },
  },
});
