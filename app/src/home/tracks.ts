// The landing's pictures, made from the game itself by scripts/render-home.mjs (see the README): each track's still
// (track-<id>-1600 / -800.webp) and each drivable car's render, the turntable's first frame (car-<id>-1440 / -640.webp).
// Vite hashes and serves whichever exist; a car or track without one falls back.

const files = import.meta.glob<string>('./img/*.webp', { eager: true, query: '?url', import: 'default' });

export interface Pic { big: string; small: string }
function pic(name: string, big: number, small: number): Pic | null {
  const b = files[`./img/${name}-${big}.webp`], s = files[`./img/${name}-${small}.webp`];
  return b && s ? { big: b, small: s } : null;
}

/** Each track's still, by course id. */
export const TRACK_IMG: Record<string, Pic> = {};
for (const f of Object.keys(files)) {
  const m = /\/track-([a-z0-9-]+)-1600\.webp$/.exec(f);
  const p = m && pic(`track-${m[1]}`, 1600, 800);
  if (m && p) TRACK_IMG[m[1]] = p;
}
/** A car's render (transparent, 16:10), or null. */
export const carImg = (id: string) => pic(`car-${id}`, 1440, 640);

/** The courses as the landing shows them before the game server answers (its list wins: name, colour, length). */
export const TRACKS = [
  { id: 'meadow', name: 'Meadow', color: '#6fd35a' },
  { id: 'sky', name: 'Sky Tower', color: '#ff6b00' },
  { id: 'touge', name: 'Touge', color: '#9d6bff' },
];
