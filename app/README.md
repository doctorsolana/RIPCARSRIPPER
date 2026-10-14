# 3 · App

The reveal: Vite + TypeScript + three.js + GSAP. A pack is ripped and the car is revealed in three beats: **year** (a backlit silhouette), **make + rarity** (paint floods in, rarity colour and effects scale with the tier), and **the car**. In the last beat it spins, settles into the exact pose of the toy in its blister, and crossfades into the real pack photo.

```sh
cd app
npm install
npm run dev -- --port 5199     # http://localhost:5199/?car=skyline-hck01
npm run build                  # static site in dist/
```

A top bar on every page links the user-facing pages: **Rip a pack** (the reveal, with a car picker and *Random pack*), **Inspect cars** (`/inspect.html`) and **Drive** (`/drive.html`, see below). Following a link keeps the car you are on. The bar hides itself in the `mode=` screenshot views and inside the inspector's embedded reveal.

The app serves `asset-generation/assets/` directly (`vite.config.ts` → `publicDir`), so `/cars/<id>/…` is whatever stage 2 last built. `npm run build` copies that whole folder into `dist/`, including the review files and Tripo's FBX downloads. Prune them before deploying anywhere public.

## Two kinds of car

- **Modelled** (`model.glb` + `alignment.json` from stage 2): the full 360° reveal. `src/model.ts` loads the GLB, swaps in the reveal material and glues the pack photo onto the model through the landing pose. That projected photo is what makes the hand-off seamless. The GLB can come from the `ripcars` scripts or be a promoted Tripo mesh; either way its wheels are `wheel_*` pivot nodes, which the reveal spins whole turns, so they land back at rest on the photo. Windows are the texels marked as glass in its roughness map; `src/glass.ts` makes them see-through.
- **Procedural fallback** (no `model.glb`, needs `params.json`): `src/car.ts` builds a car from the pack-photo outline alone. It reveals near side-on and morphs from a generic coupe into the car. Force it with `?reveal=profile`.

## URL knobs

| Query | Does |
| --- | --- |
| `car=<id>` | which car (default `skyline-hck01`). A car with no `model.glb` and no `params.json` shows a "no 3D model yet" note |
| `rarity=<common\|rare\|epic\|legendary\|chase>` | override the tier (placeholders until RIPCARS publishes theirs) |
| `reveal=profile` | use the procedural car |
| `t=<seconds>` | seek the reveal and pause (a seek skips the timeline's update callback, so wheel spin and morphs show as at rest) |
| `mode=view&az=&el=&yaw=` | static lit view from any angle (for reviewing a model) |
| `mode=final&unlit=0\|1&card=0..1` | the landing pose, with the car still visible over the card |

## Drive page

`/drive.html?car=<id>` takes the car for a spin round a meadow course (a 2,740 u lap for a 4 u car, about 65 s): twisty asphalt roads with mown grass verges, tyre walls and hay bales, a loose dirt stretch, and orange Hot Wheels plastic for the set pieces only - the raised start gate and its drop, a small kicker over a gap on scaffolding, the big jump (a booster up a steep ramp on a tall scaffold tower, about 2.3 s of air over the road below, a long landing ramp; a pond and a RIPCARS banner beside it), a booster into the loop and a banked climb on stone pillars back to the gate. Three laps, splits against your best lap (kept per car and course in `localStorage`), results with a medal, *Again* and *Rip a pack*. The reveal's *Take it for a spin* button and the top bar's *Drive* link open it for the car you are on. The car waits in the start gate; the first key, tap or pad button drops it and unlocks the sound.

- **Keys**: W / ↑ gas, S / ↓ brake and reverse, A D / ← → steer, Space or Shift drift, R restart, M mute. **Pad**: stick, RT / LT, A or RB drift, Start restart.
- **Touch**: the car drives itself; drag anywhere to steer. Hold full lock (or tap a second finger) to drift; centre the thumb or lift it and the car straightens, which ends the drift and fires the boost.
- A drift is a tap, not a hold: the rear goes loose and the slide is yours - steer to hold it, counter-steer or lift to catch it. It ends by itself once the car is straight again (or at a second tap). Slide long enough and the sparks go blue, purple, then the car's tier colour (0.9, 1.8 and 2.7 s of real sliding), and a slide kept going twice as long as gold, linked through a whole S, hits a hidden fourth: the *magic max*, with its own sparks, chime and a longer, stronger boost. A drift that ends clean fires a boost that grows with the tier (a wall hit or a spin cancels it). Land a jump straight for a PERFECT boost. Booster pads, two jumps and a loop are on the lap. The big jump flies off whatever you bring to the lip - hit the booster fast and straight, leave the wheel alone in the air for a PERFECT; miss and you're put back before the run-up.
- Each car drives and sounds like itself (`PROFILES` in `vehicles/arcade.ts`, multipliers on the shared tuning; `ENGINES` in `audio.ts`), and medals are judged against each car's own pace:
  - **Porsche 911 GT3 R** (Roxy): the most grip, the hardest brakes, the sharpest steering and the highest top speed, but hard to get sideways and slow on dirt. A flat-6 race wail with crackles on the lift.
  - **Skyline LB-ER34**: a breath of turbo lag, then the strongest mid-range pull; the easiest, most controllable drifter. An RB26 inline-6 with turbo whistle and a blow-off on every lift.
  - **1964 Impala**: a heavy, soft boat with a lower top speed, lazy steering and big floaty slides, but at home on the dirt and the one that carries a hill's speed furthest. A big-block V8 burble through a lazy 3-speed automatic.
  - **Porsche 911 GT3 RS**: the road-going racer, a step below the GT3 R on grip, with a flat-6 that revs to 8,400 through a 6-speed manual.
  - **Porsche 964**: an air-cooled classic 911 whose tail swings readily on a lift. A dry, raspy flat-6 and a 5-speed.
  - **'77 Firebird Trans Am**: a muscle car that pulls hard out of corners, fades up top and steps its tail out under power. An angry V8 through a 4-speed.
  - **Beach Bomb Too**: the VW bus with surfboards, the slowest car, tall, soft and floaty, but happy on the dirt. An air-cooled flat-4 putter.
  - **Godzilla Skyline** drives and sounds like the other Skyline (same RB26). A car without its own entry drives the stock car and gets an engine by make.
- Drive against the lap and a WRONG WAY sign comes up; after 4 s of it, or 4 s stuck, the car is put back on the track facing the right way. A missed jump puts it back well before the booster.

The driving model is hand-written (`src/drive/vehicles/arcade.ts`, no physics engine): the car lives in track space, gravity is projected onto the track so slopes, banks and the loop just work, and only a jump's gap throws it into a ballistic flight (every other crest holds it). Each surface grips and tops out differently (plastic fastest, asphalt grippiest, dirt loose and bumpy, the grass verge slow and slippery). The throttle pushes only up to the car's top speed; past it only the air drags, gently, so a hill (the start drop, the big jump's landing ramp) carries the car well over its top speed into the next corners, where the tyres grip no harder than at top speed: brake, or take a wider line. Walls push back at the corner that touches, with the restitution and friction of what they are made of (plastic rail, tyre wall, hay bales): a glancing hit scrapes along, a hard one stuns for a moment, a very hard one spins the car out (hay bales only swallow the hit and slow the car, never spin it), and the car never sticks to a wall. The simulation runs in fixed 1/120 s steps and is deterministic and input-driven - no randomness, no clocks, and game time never slows or stops (no slow motion, no hit-stop), so it can run in lockstep for multiplayer later; a hard hit's drama is the camera's kick, shake and FOV punch, the sound, the sparks and the haptics. Everything is generated in code, sounds included; the only downloads are the car's GLB and JSON.

| Query | Does |
| --- | --- |
| `auto=1` | the autopilot drives (tests, demos) |
| `laps=<1-9>` | race length (default 3) |
| `tune=1` / `tune=camera` | live sliders for the driving model / the chase camera, with *Copy* to paste the changes back into the source |
| `fps=1` | frame rate readout |
| `fast=<2-16>` | runs the simulation N times faster than real time (tests on slow software rendering; never part of the game) |

Scripts can wait for `window.__ready` and read `window.__drive` (state, laps, lap times, event counts, `renderer.info`); setting `__drive.frozen = true` with `__drive.timeScale(0)` holds the current frame for a screenshot.

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
- `src/nav.ts`: the top bar (pages, car picker, random pack).
- `src/inspect.ts`, `src/compare.ts`, `src/views.ts`: the review pages.
- `src/car.ts`: shared reveal material, the photo↔world frame, and the procedural fallback car.
- `src/rarity.ts`: placeholder rarity tiers.
- `src/drive/`: the drive page. `main.ts` (entry, race rules, HUD wiring), `types.ts` (the contracts between the modules), `track.ts` (the course: frame table with surface and edge per frame, the road / plastic / props meshes, queries), `world-outdoor.ts` (the meadow round it, the pond and banner by the big jump), `vehicles/arcade.ts` (the driving model and its `TUNING`), `rig.ts` (the GLB as a drivable rig: steer, spin, body springs), `camera.ts` (the chase camera and the big jump's side-on "ad" shot), `fx.ts` (skids, tyre tracks in the grass, dust off the dirt, sparks, smoke, flames, the big jump's trail and confetti), `audio.ts` (all sounds generated, each car's engine from its firing pulses and gearbox), `input.ts` (keys, pad, touch, autopilot), `hud.ts`, `loop.ts` (fixed 1/120 s step), `tune.ts`.
