// After `vite build`: drop what the site never loads from dist/cars (vite copies all of
// asset-generation/assets as the public dir). Paid Tripo downloads and their request records, local
// snapshots and the pack-photo mask stay out of a public deploy.
import { readdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

const cars = new URL('../dist/cars/', import.meta.url).pathname;
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
