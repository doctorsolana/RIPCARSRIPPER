// After `vite build`: drop what the site never loads from dist/cars (vite copies all of
// asset-generation/assets as the public dir). Paid Tripo downloads and their request records, local
// snapshots and the pack-photo mask stay out of a public deploy.
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cars = new URL('../dist/cars/', import.meta.url).pathname;
if (!existsSync(cars)) {
  // vite.config.ts copies ../asset-generation/assets: outside app/, so a host that builds app/ alone has no cars
  console.error('prune-dist: dist/cars is missing - the build could not read ../asset-generation/assets. '
    + 'On Vercel: Settings > General > Root Directory, enable "Include files outside the root directory in the Build Step".');
  process.exit(1);
}
let removed = 0;
for (const id of readdirSync(cars)) {
  const dir = join(cars, id);
  if (!statSync(dir).isDirectory()) continue;
  for (const name of ['tripo', 'snapshots', 'mask.png']) {
    try {
      rmSync(join(dir, name), { recursive: true });
      removed++;
    } catch {
      // not there for this car
    }
  }
}
console.log(`prune-dist: removed ${removed} paths the site doesn't load`);
