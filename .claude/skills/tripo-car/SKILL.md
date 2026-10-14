---
name: tripo-car
description: Take a RIPCARS car through the generated-mesh (Tripo) route. A Tripo P2 multiview mesh is made from the ChatGPT five-view sheet, cleaned and fitted to the sheet in Blender, checked for size, then repainted from the sheet. Its windows are traced by hand, it is promoted into the reveal and landed on the pack photo, then reviewed. Use when asked to make or redo a car's 3D model with Tripo, fix a Tripo model's texture or windows, or put a Tripo model into the app.
---

# Tripo route: one car

This is the default way to make a car's reveal model. Scripts do the heavy lifting. Your hand pass is mostly the windows, plus a careful review. Work from `asset-generation/`. Every manual change goes into the car's `hints.json` with a `notes` entry saying why. Never edit generated files.

```sh
cd asset-generation
R="uv run --locked python -m ripcars"
$R status <id>          # where the car is, and its next step
```

The review pages need the app's dev server on port 5199. Check `lsof -i :5199` before starting one with `cd app && npm run dev -- --port 5199`.

## 0. Inputs

- The sheet must be accepted: `reference-collector/cars/<id>/generated/reference-sheet.png` exists, and `selected` in its `manifest.json` is set. Draft sheets go back to the reference stage. Use one for a Tripo test only if the user says so explicitly.
- `assets/cars/<id>/hints.json` (pack-photo `photo` + `carBox`) and `meta.json`. For a new car, follow step 1 of the `retouch-car` skill.

## 1. Tripo request: costs credits, so ask first

```sh
$R tripo <id>            # dry run (multiview is the default mode): nothing is sent
```

This writes `assets/cars/<id>/tripo/multiview/request.json` and the four images it would upload to `tripo/multiview/views/`, plus all four side by side in `qa/<id>/tripo-inputs.jpg`. Open that. Check that they are cut out on white at one scale, the wheels sit on one ground line, and right/left are the car's own sides. Tripo gets front, left, back and right, and **no top view**.

Show the user the settings (`SETTINGS` in `ripcars/tripo.py`: P2-20260801, quad, face_limit 8000, PBR texture) and the cost: 110 API credits per car so far (`credits_consumed` in each `task.json`). Give the balance too; `tripo.balance()` is a free read. Then **wait for an explicit yes**. A retry needs its own yes.

```sh
$R tripo <id> --send     # uploads, submits, polls, saves model_url.fbx + task.json + Tripo's preview
```

It refuses to re-send a car that already has a result unless you pass `--force`, which spends credits again. The key comes from `TRIPO_API_KEY` (environment, or `asset-generation/.env`, which is git-ignored). Never print, log or commit it. API credits are separate from Tripo Studio credits. A 401 usually means the wrong region: international keys use `https://openapi.tripo3d.ai/v3`.

## 2. Clean

```sh
$R clean <id>            # Blender, headless: BLENDER=/path/to/Blender overrides the macOS default
```

It joins the parts and welds seams, then drops loose and degenerate faces. It orients the mesh (nose +x, length 4, grounded) and shrinks textures to 1024 px JPEG. Then it fits the mesh **per axis** to the sheet's side and top silhouettes. Tripo guesses the proportions because it never sees the top: the Skyline came out 27% too wide, the Roxy 23%, the Impala 27% too wide and 9% too tall. Output: `snapshots/tripo-multiview-clean.glb`. The console prints triangle counts and the fit.

## 2b. Check the size: don't skip this

`clean` prints `size vs sheet {length, width, height}`: the body's length and height against the side drawing, and its width against the top drawing, measured on the silhouettes (1.0 = same). Thin parts like a wing plate or mirrors don't count. Every value must be within 0.95–1.05; `clean` warns otherwise, and `promote` turns it into a failed check.

Look at the car too: front and rear in `views.html?car=<id>&m=tripo-multiview-clean`, or the compare page from the front. Wide cyan bands on both sides of `qa/<id>/silhouette-front.png` mean the car is too wide. Width is the one to watch, because Tripo never sees the top. The Impala once went out 36% too wide when a fitting bug went unnoticed.

If a value is off and the fit can't fix it, set `model.fit` in `hints.json`, a factor on the fitted size per axis, for example `{"width": 0.95}`. Add a note, then re-run `clean` → `rebake` → `promote`. A part that is out of place, like a wing standing too high, is a shape problem, not a size one: don't rescale the car for it.

## 3. Rebake (repaint from the sheet)

```sh
$R rebake <id>           # -> snapshots/tripo-multiview-guided.glb (+ .json); ~10 s
```

Faces the cameras see are turned towards them first; Tripo leaves inside-out patches (45% of the Roxy). Each sheet view is aligned to the mesh's own render, then painted on where it sees the surface squarely. Tripo's own paint is kept wherever the drawing disagrees, such as background bleed or painted-in reflections. The top view is the exception: Tripo never saw it, so the drawing wins there. Each side takes its own drawing: the left side comes from the left view, never mirrored. Look at `qa/<id>/`:

| Image | Look for |
| --- | --- |
| `align-<view>.jpg` | Columns: render, sheet, a checkerboard of both, then a checkerboard with the sheet aligned. Edges should run straight across the squares in the last column. |
| `glass-map.jpg` | Every view: the sheet, then the model with its glass in **magenta**. Magenta belongs exactly on the window panels. None on the roof, pillars, banners, or a wing seen through a window. |
| `glass.jpg` | The sheet's own window masks in cyan. They are usually right on the drawing; a sun strip or banner may need trimming. |
| `trace-<view>.png` | One view's windows zoomed, with Tripo's paint on top and clay shading below. It has a ruler in sheet px, the drawing's window outline in cyan, the glass in magenta, and traced corners as dots. |
| `wheels.jpg` | What will spin, one tint per wheel: whole wheels only, no arch or body. |
| `tripo-sheet.png`, `tripo-clay.png` | The whole mesh in the sheet's layout and pixel grid. |

## 4. Windows (the main hand step)

Decide per view where the glass comes from, in `model.rebake.glass`. Look at `trace-<view>.png`, where the cyan outline is the drawing's window put onto the mesh:

- **`"sheet"`**: use it where the cyan outline sits on the mesh's window panels. Usually that's side, left, front and rear, the views Tripo was given. It's the least work and the user found it the most accurate. Trim it with `model.glass.remove` (sheet-px polygons; check `glass.jpg`) where the finder took a sun strip or banner for glass. The Roxy's PORSCHE strip is an example.
- **Polygons traced on the mesh**: use them where the cyan misses the panel.
  - **Top view:** Tripo never saw it. The Roxy's rear window sits 40 px forward of the drawing.
  - **Steep perspective front/rear drawings:** their windows sit higher than the mesh's. The Impala's aligned sheet glass spilled onto the roof lip and over the lettering above the rear window.

  Start from `$R outline <id> --view <view>`. It prints outlines in sheet px of Tripo's own dark window paint, biggest first, and that paint sits on the mesh's window openings. Pick the one whose box matches the window. Raise `--dark` (e.g. 115) if the window paint is lighter. Check it against the **clay** half of `trace-<view>.png`, which shows the real panel edges. Extend it over any lettering Tripo invented on the glass, and leave out sun strips.
- **Leave the view out** where the mesh has open holes, such as the Skyline's and Impala's side windows. A hole has nothing to paint.

Each texel takes its glass from the listed view that sees it best. So when a wing hides part of the rear window from behind, trace around the wing, and the top view covers the rest. Steps:

1. Fill in `model.rebake.glass`, view by view, as above.
2. Panels and the views that see them squarely: windscreen `front` + `top`; rear window `rear` + `top`; side glass `side` / `left`.
3. In `top`, `front` and `rear`, trace one half only and list the view in `glass_mirror`. `top` mirrors about the long centre line, `front` and `rear` mirror left-right. The result is symmetric.
4. Leave out what stays opaque on the real toy: sun strips and banners (e.g. NISSAN SKYLINE), and black frit borders if the sheet shows them painted.

```jsonc
"model": {
  "rebake": {
    "glass": {                                    // per view: "sheet" or sheet-px polygons
      "side": "sheet", "left": "sheet", "front": "sheet", "rear": "sheet",
      "top":   [[[242, 965], [248, 900], [263, 853], [340, 869], [343, 965]]]
    },
    "glass_mirror": ["top"],                      // views traced on one half
    "unseen": ["top"],                            // views Tripo never got: the drawing beats Tripo's paint; glass only if listed
    "power": 4, "agree": 55                       // view weighting; colour gap where Tripo's paint wins
  }
},
"notes": ["model.rebake.glass: why each panel was traced the way it was"]
```

**Super-tinted windows** (dark privacy glass on the real toy, e.g. the Beach Bomb's rear windows): add `model.rebake.tinted`, either `"all"` or per view `"sheet"` / sheet-px polygons drawn over the panels to darken, mirrored by `tinted_mirror`. Only glass texels change. They are baked near black, and the app draws them almost opaque (roughness 0.13 instead of 0.06 marks them; `app/src/glass.ts`). Tinted on the toy is still glass: don't leave a dark window out just because the sheet draws it black.

Rebake, then check `glass-map.jpg` and the 3D views below. Repeat until the magenta sits exactly on the glass. Glass becomes a plain dark tint with a flat normal map, and it is see-through in the app. The cabin behind it is painted from what the drawings show through their windows. `model.glass`, the sheet's own window masks shared with the scripts route, decides which drawn pixels count as "seen through glass".

## 5. Review in 3D

On the dev server:

- `compare.html?car=<id>&m=tripo-multiview-clean,tripo-multiview-guided&refs=1` shows Tripo's paint next to the repaint, with the references.
  - Look from **above** (`view=0,1.5,7`), **above-behind** (`view=-2.4,0.9,5.2,-0.6,0.7,0`) and both sides (`view=0,0.1,9`, `view=3.14,0.1,9`).
  - `glass=0` makes the windows opaque, so you see exactly what was painted on them. Check the glass edges from the drawings' own elevated angles too: `view=1.5708,0.42,5.2` (front), `view=-1.5708,0.42,5.2` (rear), `view=0.0001,1.5,6.5` (top). A level front view sees the roof edge-on, so spilled glass hides there.
- `views.html?car=<id>&m=tripo-multiview-guided` puts each sheet view beside the model from the same camera.
- Screenshots: `node scripts/shoot.mjs /tmp/shots 1600x760 "top:compare.html?car=<id>&m=tripo-multiview-guided&view=0,1.5,7"`.

Check that:

- decals sit where the sheet has them, on both sides and the top
- there is no white bleed at panel ends or under the wing
- windows are clean (no letters, roof or wing on the glass) and the paint/glass edge is crisp
- the roof is the sheet's size

When something is off, find the view that paints it (`align-<view>.jpg`) and fix the cause. Don't paint over it. The tools for that, all in `model.rebake`, with a note each:

| You see | Override |
| --- | --- |
| A decal on a featureless area comes out sheared or stepped (the Godzilla's roof claws: Tripo painted the roof plain red, the top alignment matched only 0.26) | `noalign: ["top"]`: project that drawing straight through the camera. Not for views Tripo was given: a rear without its alignment doubled the plate and badge. |
| A drawn decal comes out faded toward the body colour (the Beach Bomb's white roof stripes came out lavender) | Check `glass.jpg`: the sheet's window finder probably took the decal for glass, so the repaint weights that drawing down there. Redraw that view's mask with `model.glass` `{"replace": [view], "add": {view: [polygons]}}` (this one is the sheet's mask, not `model.rebake`) |
| Tripo embossed its own invented lettering into a surface (relief under the drawn decal) | `flat`: per view sheet-px polygons whose normal-map relief is flattened, as on glass |
| Tripo's own garbled paint survives under a drawn decal | `trust`: per view polygons where that view's drawing always wins |
| An elevated drawing smears a top surface (the rear drawing sees a wing's top lettering at a slant) | `skip`: per view polygons that view never paints, so the view that sees the surface squarely paints it alone |

## 6. Promote into the app

```sh
$R promote <id>          # model.glb + model.json + landing fit (alignment.json)
```

Promote copies the repaint to `model.glb` and writes `model.json` with silhouette IoU per view. Open windows don't count against it there. The checks use the looser `GATES_GENERATED`. Promote then re-fits the pack-photo landing. The scripts' own model is kept as `snapshots/scripted.glb`, and `$R model <id> --force` brings it back. After a promote, `model` and `build` leave the car's model alone unless you pass `--force`.

Check `qa/<id>/silhouette-*.png` and `pack-fit.png`, then the landing in the reveal:

```sh
node scripts/shoot.mjs /tmp/shots 1280x800 "land:car=<id>&mode=final&card=0.6" "q1:car=<id>&mode=view&az=0.75&el=0.3" "q2:car=<id>&mode=view&az=-2.3&el=0.35"
```

The wheels spin: `rebake` finds them as Tripo's separate tyre, rim and hub pieces and exports a `wheel_*` pivot per wheel. Check `qa/<id>/wheels.jpg`: each wheel tinted, nothing else. The console line `wheels - …` says if it couldn't find all four; then they stay in the body.

## 7. Done when

- `glass-map.jpg` has magenta only on glass, and above and behind look clean in 3D.
- Size vs sheet is within 5% on length, width and height (`model.json` → `proportions_vs_sheet`).
- All `checks` in `model.json` pass, or `notes` explain why not. Landing IoU is about 0.9 or better, and the landing frame shows no doubled edges.
- The model is about 16k triangles and 1.2–1.5 MB.
- `$R status <id>` says `review`.

Report what you traced and why, with before/after screenshots and the compare link. Then ask the user what to adjust.
