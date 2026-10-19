import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

// The sim's build id: which code the server's authoritative sim and the page's prediction share. The page and the server
// deploy separately (Vercel, Fly), and client prediction only works when both run exactly the same sim, so the page
// sends its id in the join and the server refuses another (index.ts; the page says 'A new version is out').
//
// What's in it: every file under src/ that the shared entry points below import, following relative imports
// (`import type` too, as types.ts holds the shapes), plus every car's model.json and meta.json (the car's spec - mass,
// grip, wheels - comes from them: race.ts carSpecOf). A plain content hash: any change to those files, comments and
// whitespace included, is a new id. The site's build computes it with this same function (vite.config.ts: the
// `virtual:build-id` module; in dev it's recomputed when one of the files changes) and the server once at start.

/** The shared code: the sim (vehicles, tracks, the autopilot the bots drive with), car-to-car contact, the race rules
 *  and the wire format. Paths from the app folder. */
export const SHARED_ENTRIES = [
  'src/drive/vehicles/arcade.ts',
  'src/drive/tracks/index.ts',
  'src/drive/input.ts',
  'src/drive/net/contact.ts',
  'src/drive/net/protocol.ts',
  'src/drive/net/codec.ts',
  'src/drive/net/race.ts',
];
// (not net/world.ts or client.ts: the page's side of prediction, which the server doesn't run - a change there alone
// still talks to the same server)

const APP = resolve(dirname(new URL(import.meta.url).pathname), '..');

/** The files that make the id (absolute paths, sorted). `app`: the app folder. */
export function sharedFiles(app = APP): string[] {
  const src = join(app, 'src') + '/';
  const seen = new Set<string>();
  const todo = SHARED_ENTRIES.map((f) => join(app, f));
  while (todo.length) {
    const f = todo.pop()!;
    if (seen.has(f)) continue;
    seen.add(f);
    const text = readFileSync(f, 'utf8');
    for (const m of text.matchAll(/(?:from\s*|import\s*\(\s*|import\s+)['"](\.{1,2}\/[^'"]+)['"]/g)) {
      const base = resolve(dirname(f), m[1]);
      const hit = [base, `${base}.ts`, join(base, 'index.ts')].find((p) => p.endsWith('.ts') && existsSync(p));
      if (hit && hit.startsWith(src)) todo.push(hit);
    }
  }
  const cars = join(app, '..', 'asset-generation', 'assets', 'cars');
  if (existsSync(cars)) {
    for (const id of readdirSync(cars)) {
      for (const name of ['model.json', 'meta.json']) {
        const p = join(cars, id, name);
        if (existsSync(p)) seen.add(p);
      }
    }
  }
  return [...seen].sort();
}

/** The build id: 12 hex characters of a SHA-256 over the shared files (their paths from the repo root and contents). */
export function buildId(app = APP): { id: string; files: string[] } {
  const files = sharedFiles(app), root = resolve(app, '..'), h = createHash('sha256');
  for (const f of files) h.update(relative(root, f)).update('\0').update(readFileSync(f)).update('\0');
  return { id: h.digest('hex').slice(0, 12), files };
}

// `node server/build-id.ts`: print the id and its files
if (process.argv[1] && resolve(process.argv[1]) === new URL(import.meta.url).pathname) {
  const { id, files } = buildId();
  console.log(id);
  if (process.argv.includes('--files')) for (const f of files) console.log(`  ${relative(APP, f)}`);
}
