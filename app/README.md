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

`/drive.html?car=<id>` takes the car for a spin on one of two courses, picked with `?track=` or the *Meadow | Sky Tower* switch in the top bar (under 1200 px wide it hangs below the bar's right end):

- **Meadow** (the default; `?track=meadow` or no `track`): a 2,740 u lap for a 4 u car, about 65 s. Twisty asphalt roads with mown grass verges, tyre walls and hay bales, a loose dirt stretch, and orange Hot Wheels plastic for the set pieces only - the raised start gate and its drop, a small kicker over a gap on scaffolding, the big jump (a booster up a steep ramp on a tall scaffold tower, about 2.3 s of air over the road below, a long landing ramp; a pond and a RIPCARS banner beside it), a booster into the loop and a banked climb on stone pillars back to the gate.
- **Sky Tower** (`?track=sky`): track 2, the crazy one - the Hot Wheels Sky Crash Tower set with a Trackmania edge. The gate sits high on a tall blue lattice tower; the plunge drops off it in the narrow classic channel straight into a loop, then come chained boosters, a steeply banked 180, a double jump and the wall ride - a 180 banked at 70° that you drive up onto from the meadow, with one narrow booster pad in the middle of its approach (line up for it, or ride the wall slower) - then a single rounded crest in the straight off the wall ride (1.6 u high, 32 u long), esses and a chicane where drifting pays, a rhythm section of two long rollers on the wide straight east to the climb (2 u high, 46 u crest to crest; `SKY_BUMPS` in `tracks/sky.ts`), the climb (a row of chained pads into a ramp that goes up past vertical, over the top upside down and rolls out into a banked right-hander onto a deck 41 u up - Hot Wheels' up the wall and over: it's the pads' speed that carries you, and a car that comes to it too slow falls off and is put back before the pads), the sky jump's in-run (the deck runs on north, and off its far end the dive turns right and down: a 270° descending right-hander, banked 20°, that comes back round and passes UNDER the deck - the classic Hot Wheels over/under, ~16 u of headroom, the deck's stilts standing clear of it - lines up, then plunges at 11° where the speed builds, to a booster pad at its foot) and the sky jump itself (a short steep kicker low down, up and over a gap through a hoop onto a long ski-slope landing hill: the biggest air in the game, ~3.3 s; land early near its top or further down - anything from 0.85 to 1.15 of the run-up's speed lands lined up; manual like the meadow's big jump, so a straight hit lands perfect), and the spiral climbing round the tower back up to the start. It is built for racing side by side: most of the lap is wide enough for three or four cars abreast (the meadow's plastic channel takes two), narrowing to the classic channel only where the squeeze is the point (the plunge and its loop), with a start grid for 8 cars at the gate.

A course is one file in `src/drive/tracks/` exporting a `Course` (`tracks/course.ts`): its id, name, blurb and colour, its layout (written with the `Path` pieces in `tracks/path.ts`, two free straights closing the lap), the start line, its own support kinds and set dressing, the world style, and its medal pace (`pars`, measured with the autopilot). Adding track 3 is that file plus one entry in `COURSES` (`tracks/index.ts`); the track switch, *Try*, the bests' keys and the medals pick it up from there.

Three laps, splits against your best lap, results with a medal, *Again*, *Rip a pack* and *Try* the other course. Bests (and the air record) are kept per car and course in `localStorage`: `ripcars.drive.<car>.<lap length>` on the meadow (the key it had before track 2, so earlier bests stand) and `ripcars.drive.<car>.sky.<lap length>` on the Sky Tower; a layout with a new length starts afresh. Changing course reloads the page with the same car and URL knobs (`auto`, `laps`, ...); the bar's car picker and *Random car* keep the course. The reveal's *Take it for a spin* button and the top bar's *Drive* link from the other pages open the meadow for the car you are on. The car waits in the start gate under the course's name; the first key, tap or pad button drops it and unlocks the sound.

- **Keys**: W / ↑ gas, S / ↓ brake and reverse, A D / ← → steer, Space or Shift drift, R restart, M mute. **Pad**: stick, RT / LT, A or RB drift, Start restart.
- **Touch**: the car drives itself; drag anywhere to steer. Hold full lock (or tap a second finger) to drift; centre the thumb or lift it and the car straightens, which ends the drift and fires the boost.
- A drift is a tap, not a hold: the rear goes loose and the slide is yours - steer to hold it, counter-steer or lift to catch it. It ends by itself once the car is straight again (or at a second tap). Slide long enough and the sparks go blue, purple, then the car's tier colour (0.9, 1.8 and 2.7 s of real sliding), and a slide kept going twice as long as gold, linked through a whole S, hits a hidden fourth: the *magic max*, with its own sparks, chime and a longer, stronger boost. A drift that ends clean fires a boost that grows with the tier (a wall hit or a spin cancels it). Land a jump straight for a PERFECT boost. Booster pads, two jumps and a loop are on the meadow's lap. The big jump flies off whatever you bring to the lip - hit the booster fast and straight, leave the wheel alone in the air for a PERFECT; miss and you're put back before the run-up.
- **Boosts stack.** Every boost - a booster pad (1 s of push, plus its instant +8 u/s kick), a drift's mini-turbo (0.5 / 1 / 1.5 s by tier, the magic max's 2.5 s and 1.3x stronger) and a PERFECT landing (0.5 s) - pours its time into one shared tank, so nothing is wasted: a big drift cashed in just before a pad runs on after the pad's push. The tank burns its strongest push first (pad and landing, then the magic max's, then a mini-turbo's), so a lone boost pushes exactly as it always did. Each boost added while the tank is still running is a stack (`x2`, `x3` ... toasts; `state.boostStack`): it raises the boost's top speed by 4 u/s (56 alone, 60 at x2, 64 at x3 ...), fading back over the tank's last second; the stack is gone once the tank is empty. There is no cap on the tank or the stacks - a run of pads throws the car as fast and as far as the physics says, and stacking into a jump can carry it past the landing (then the usual miss rules put it back). The flames burn longer, wider and hotter and the boost hiss and engine get louder per stack. The Sky Tower's chained pads stack to x3 on every lap (the meadow's pads are too far apart).
- **Air records**: the longest landed flight (0.9 s or more) is kept per car and course with the bests (the same `localStorage` key, as `air`); beating one from an earlier race says so as the car lands (*Big air 4.6 s, record!*), and the results card shows the race's longest air against the record.
- Each car drives and sounds like itself (`PROFILES` in `vehicles/arcade.ts`, multipliers on the shared tuning; `ENGINES` in `audio.ts`), and medals are judged against each car's own pace on each course (each course's `pars` in its `tracks/<course>.ts`: the autopilot's average speed over 3 laps; a course without a car's number uses its meadow pace, so the par time scales with the lap's length):
  - **Porsche 911 GT3 R** (Roxy): the most grip, the hardest brakes, the sharpest steering and the highest top speed, but hard to get sideways and slow on dirt. A flat-6 race wail with crackles on the lift.
  - **Skyline LB-ER34**: a breath of turbo lag, then the strongest mid-range pull; the easiest, most controllable drifter. An RB26 inline-6 with turbo whistle and a blow-off on every lift.
  - **1964 Impala**: a heavy, soft boat with a lower top speed, lazy steering and big floaty slides, but at home on the dirt and the one that carries a hill's speed furthest. A big-block V8 burble through a lazy 3-speed automatic.
  - **Porsche 911 GT3 RS**: the road-going racer, a step below the GT3 R on grip, with a flat-6 that revs to 8,400 through a 6-speed manual.
  - **Porsche 964**: an air-cooled classic 911 whose tail swings readily on a lift. A dry, raspy flat-6 and a 5-speed.
  - **'77 Firebird Trans Am**: a muscle car that pulls hard out of corners, fades up top and steps its tail out under power. An angry V8 through a 4-speed.
  - **Beach Bomb Too**: the VW bus with surfboards, the slowest car, tall, soft and floaty, but happy on the dirt. An air-cooled flat-4 putter.
  - **'99 Civic Type R**: a light front-drive hot hatch, nimble and grippy but hard to get sideways. A VTEC four screaming to 8,400.
  - **'93 Mustang Cobra R**: a Fox-body V8 with a strong low-down shove and a willing tail. A 5.8 V8 through a 5-speed.
  - **Godzilla, green and gold Skylines** drive and sound like the other Skyline (same RB26). A car without its own entry drives the stock car and gets an engine by make.
- Drive against the lap and a WRONG WAY sign comes up; after 4 s of it, or 4 s stuck, the car is put back on the track facing the right way. A missed jump puts it back well before the booster.

The driving model is hand-written (`src/drive/vehicles/arcade.ts`, no physics engine): the car lives in track space, gravity is projected onto the track so slopes, banks and the loop just work, and it flies off any crest it's too fast to stay on (see *Crests and bumps* above). Each surface grips and tops out differently (plastic fastest, asphalt grippiest, dirt loose and bumpy, the grass verge slow and slippery). The throttle pushes only up to the car's top speed; past it only the air drags, gently, so a hill (the start drop, the big jump's landing ramp) carries the car well over its top speed into the next corners, where the tyres grip no harder than at top speed: brake, or take a wider line. Walls push back at the corner that touches, with the restitution and friction of what they are made of (plastic rail, tyre wall, hay bales): a glancing hit scrapes along, a hard one stuns for a moment, a very hard one spins the car out (hay bales only swallow the hit and slow the car, never spin it), and the car never sticks to a wall. The simulation runs in fixed 1/120 s steps and is deterministic and input-driven - no randomness, no clocks, and game time never slows or stops (no slow motion, no hit-stop), so it can run in lockstep for multiplayer later; a hard hit's drama is the camera's kick, shake and FOV punch, the sound, the sparks and the haptics. Everything is generated in code, sounds included; the only downloads are the car's GLB and JSON.

**Crests and bumps throw the car**: it leaves the track wherever the track can't hold it at its speed - the same test as the loop's (gravity into the surface against the speed's pull off a crest), with only a little toy-track magnet (`hopStick`, 0.15 g) - flies the same ballistics and lands with the same landings. So the Sky Tower's bumps throw it: at race speed it hops from crest to crest through the rhythm section (two long rollers, ~0.5 s of air each at race speed) and flies ~0.7 s off the crest after the wall ride; slower, it rolls over them. A hop is quiet: it shows as airborne (dust, sound, camera) once it's 0.1 s or 0.25 u clear of the track, it isn't steered (the wheel held through it doesn't twist the car: it lands straight), and only a flight of 0.9 s or more is graded (PERFECT, ok, bad). Banked turns (over 15°) hold the car, there's no new hop within 0.1 s of a landing (no buzz), and the set pieces fly, fall or hold as built: both big jumps (in-run, lip, gap, landing ramp), the kickers, the loops, the climb, and the start drops (the Sky Tower's plunge would throw a car 1.3-1.7 s down the tower into the loop's mouth, so it holds). The meadow has no crest sharp enough to throw a car at its speeds. It's all deterministic.

| Query | Does |
| --- | --- |
| `track=meadow\|sky` | which course (default and fallback: the meadow) |
| `auto=1` | the autopilot drives (tests, demos) |
| `laps=<1-9>` | race length (default 3) |
| `tune=1` / `tune=camera` | live sliders for the driving model / the chase camera, with *Copy* to paste the changes back into the source |
| `fps=1` | frame rate readout |
| `fast=<2-16>` | runs the simulation N times faster than real time (tests on slow software rendering; never part of the game) |

Scripts can wait for `window.__ready` and read `window.__drive` (state, course, laps, lap times, event counts, `renderer.info`); setting `__drive.frozen = true` with `__drive.timeScale(0)` holds the current frame for a screenshot.

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
- `src/nav.ts`: the top bar (pages, car picker, random pack, the drive page's track switch).
- `src/inspect.ts`, `src/compare.ts`, `src/views.ts`: the review pages.
- `src/car.ts`: shared reveal material, the photo↔world frame, and the procedural fallback car.
- `src/rarity.ts`: placeholder rarity tiers.
- `src/drive/`: the drive page. `main.ts` (entry, race rules, HUD wiring), `types.ts` (the contracts between the modules), `tracks/` (the courses, one file each - `meadow.ts`, `sky.ts`: layout, constants, set pieces, colour, medal pace, how the world / camera / audio dress it - listed in `index.ts` (`COURSES`); and the shared builder: `path.ts` the pieces a layout is written in, `frames.ts` the closure solve, ground clearance and frame table (surface and edge per frame), `build.ts` the meshes and queries, with `kit.ts` (the toy kit's numbers), `geo.ts` (hand-built geometry, the props' palette), `channel.ts` (the plastic and the booster pads), `road.ts`, `supports.ts`, `props.ts`; `track.ts` only re-exports it for scripts that load it by path), `world-outdoor.ts` (the meadow round it, the pond and banner by the big jump), `vehicles/arcade.ts` (the driving model and its `TUNING`), `rig.ts` (the GLB as a drivable rig: steer, spin, body springs), `camera.ts` (the chase camera and the big jump's side-on "ad" shot), `fx.ts` (skids, tyre tracks in the grass, dust off the dirt, sparks, smoke, flames, the big jump's trail and confetti), `audio.ts` (all sounds generated, each car's engine from its firing pulses and gearbox), `input.ts` (keys, pad, touch, autopilot), `hud.ts`, `loop.ts` (fixed 1/120 s step), `tune.ts`.
