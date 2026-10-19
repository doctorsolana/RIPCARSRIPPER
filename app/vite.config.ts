import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
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

export default defineConfig({
  publicDir: '../asset-generation/assets',
  plugins: [siteRoot(), buildIdModule()],
  build: {
    rollupOptions: {
      input: {
        main: 'index.html', rip: 'rip.html', compare: 'compare.html', views: 'views.html', inspect: 'inspect.html', drive: 'drive.html', online: 'online.html',
        notfound: '404.html',
      },
    },
  },
});
