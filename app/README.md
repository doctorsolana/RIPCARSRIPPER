# 3 · App

The reveal: Vite + TypeScript + three.js + GSAP. A pack is ripped and the car is revealed in three beats: **year** (a backlit silhouette), **make + rarity** (paint floods in, rarity colour and effects scale with the tier), and **the car**. In the last beat it spins, settles into the exact pose of the toy in its blister, and crossfades into the real pack photo.

```sh
cd app
npm install
npm run dev -- --port 5199     # http://localhost:5199/?car=skyline-hck01
npm run build                  # static site in dist/
```

The app serves `asset-generation/assets/` directly (`vite.config.ts` → `publicDir`), so `/cars/<id>/…` is whatever stage 2 last built. `npm run build` copies that whole folder into `dist/`, including the review files and Tripo's FBX downloads. Prune them before deploying anywhere public.

## Two kinds of car

- **Modelled** (`model.glb` + `alignment.json` from stage 2): the full 360° reveal. `src/model.ts` loads the GLB, swaps in the reveal material and glues the pack photo onto the model through the landing pose. That projected photo is what makes the hand-off seamless. The GLB can come from the `ripcars` scripts (wheels spin) or be a promoted Tripo mesh (wheels are part of the body). Windows are the texels marked as glass in its roughness map; `src/glass.ts` makes them see-through.
- **Procedural fallback** (no `model.glb`, needs `params.json`): `src/car.ts` builds a car from the pack-photo outline alone. It reveals near side-on and morphs from a generic coupe into the car. Force it with `?reveal=profile`.

## URL knobs

| Query | Does |
| --- | --- |
| `car=<id>` | which car (default `porsche-911-gt3-rs`) |
| `rarity=<common\|rare\|epic\|legendary\|chase>` | override the tier (placeholders until RIPCARS publishes theirs) |
| `reveal=profile` | use the procedural car |
| `t=<seconds>` | seek the reveal and pause |
| `mode=view&az=&el=&yaw=` | static lit view from any angle (for reviewing a model) |
| `mode=final&unlit=0\|1&card=0..1` | the landing pose, with the car still visible over the card |

## Review pages (dev server)

- `/inspect.html`: every car in one place: list on the left, then a 3D viewer (clay, wireframe, preset angles), the sheet comparison, the reveal and the build report with its checks and manual retouch notes. The list comes from `asset-generation/assets/cars/index.json`, which every `ripcars` run rewrites.
- `/views.html?car=<id>[&m=<snapshot>]`: each ChatGPT sheet view next to the model, rendered from the exact same angle (raw texture, or tick *lit*). Use it to check shape, texture alignment and windows against the reference. `m` shows a snapshot instead of `model.glb`.
- `/compare.html?car=<id>&m=<a>,<b>,…`: versions of a model side by side, orbiting together. A name is a snapshot in `asset-generation/assets/cars/<id>/snapshots/<name>.glb` or `.fbx` (Tripo's raw FBX is normalised on load). `current` is the app's `model.glb`, and `scripted` is the scripts' model kept by `ripcars promote`. More options:

  | Option | Does |
  | --- | --- |
  | `refs=1` | adds the reference images |
  | `view=az,el,dist[,tx,ty,tz]` | starting camera: radians and model units. `az` 0 = right side, π/2 = front. Example: `0,1.5,7` is from above |
  | `glass=0` | opaque windows, showing exactly what is painted on the glass |
  | `clay=1` | untextured |
  | `fov=2` | near-orthographic |
  | `nogrid=1` | no ground grid |
  | `flip=<name>` | turns one model 180° |

## Screenshots

```sh
node scripts/shoot.mjs /tmp/shots 1280x800 "spin:car=skyline-hck01&t=5" "land:car=skyline-hck01&mode=final&card=0.6"
node scripts/shoot.mjs /tmp/shots 1600x760 "top:compare.html?car=skyline-hck01&m=scripted,current&view=0,1.5,7" "views:views.html?car=skyline-hck01"
```

Each shot is `name:target`. The target is either a reveal query or a review page with its query; review pages are captured full-page. This uses Playwright with the installed Chrome, and `BASE=http://localhost:<port>/` points it at another server.

## Files

- `src/main.ts`: entry point; picks the car and wires the URL knobs.
- `src/director.ts`: the reveal timeline (GSAP).
- `src/stage.ts`: scene, lights, particles, the card.
- `src/model.ts`: modelled cars (GLB).
- `src/glass.ts`: see-through windows (splits the body into paint and glass passes).
- `src/inspect.ts`, `src/compare.ts`, `src/views.ts`: the review pages.
- `src/car.ts`: shared reveal material, the photo↔world frame, and the procedural fallback car.
- `src/rarity.ts`: placeholder rarity tiers.
