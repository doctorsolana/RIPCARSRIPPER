---
name: tripo-car
description: Take a RIPCARS car through the generated-mesh (Tripo) route. A Tripo P2 multiview mesh is made from the ChatGPT five-view sheet, cleaned and fitted to the sheet in Blender, then repainted from the sheet. Its windows are traced by hand, it is promoted into the reveal and landed on the pack photo, then reviewed. Use when asked to make or redo a car's 3D model with Tripo, fix a Tripo model's texture or windows, or put a Tripo model into the app.
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

This writes `assets/cars/<id>/tripo/multiview/request.json` and the four images it would upload to `tripo/multiview/views/`. Open them. Check that they are cut out on white at one scale, the wheels sit on one ground line, and right/left are the car's own sides. Tripo gets front, left, back and right, and **no top view**.

Show the user the settings (`SETTINGS` in `ripcars/tripo.py`: P2-20260801, quad, face_limit 8000, PBR texture) and the cost: 110 API credits for skyline-hck01's multiview task (`credits_consumed` in its `task.json`). Then **wait for an explicit yes**. A retry needs its own yes.

```sh
$R tripo <id> --send     # uploads, submits, polls, saves model_url.fbx + task.json + Tripo's preview
```

It refuses to re-send a car that already has a result unless you pass `--force`, which spends credits again. The key comes from `TRIPO_API_KEY` (environment, or `asset-generation/.env`, which is git-ignored). Never print, log or commit it. API credits are separate from Tripo Studio credits. A 401 usually means the wrong region: international keys use `https://openapi.tripo3d.ai/v3`.

## 2. Clean

```sh
$R clean <id>            # Blender, headless: BLENDER=/path/to/Blender overrides the macOS default
```

It joins the parts and welds seams, then drops loose and degenerate faces. It orients the mesh (nose +x, length 4, grounded) and shrinks textures to 1024 px JPEG. Then it fits the mesh **per axis** to the sheet's side and top silhouettes. Tripo guesses the width because it never sees the top: the Skyline came out 27% too wide. Output: `snapshots/tripo-multiview-clean.glb`. The console prints triangle counts and the fit.

## 3. Rebake (repaint from the sheet)

```sh
$R rebake <id>           # -> snapshots/tripo-multiview-guided.glb (+ .json); ~10 s
```

Each sheet view is aligned to the mesh's own render, then painted on where it sees the surface squarely. Tripo's own paint is kept wherever the drawing disagrees, such as background bleed or painted-in reflections. Each side takes its own drawing: the left side comes from the left view, never mirrored. Look at `qa/<id>/`:

| Image | Look for |
| --- | --- |
| `align-<view>.jpg` | Columns: render, sheet, a checkerboard of both, then a checkerboard with the sheet aligned. Edges should run straight across the squares in the last column. |
| `glass-map.jpg` | Every view: the sheet, then the model with its glass in **magenta**. Magenta belongs exactly on the window panels. None on the roof, pillars, banners, or a wing seen through a window. |
| `trace-<view>.png` | One view enlarged, with Tripo's paint on top and clay shading below. It has a ruler in sheet px, the traced glass outline, and the traced corners as dots. |
| `tripo-sheet.png`, `tripo-clay.png` | The whole mesh in the sheet's layout and pixel grid. |

## 4. Windows (the main hand step)

Automatic glass comes from the sheet's window masks, aligned onto the mesh. It spills wherever the drawing and the mesh disagree. Tripo also models some windows as surfaces and others as **open holes**. The Skyline's side windows are holes with a real cage behind them. Tripo also paints its own invented details on glass. Trace the glass panels on the mesh itself:

1. Open `trace-<view>.png`. Trace on the **clay** half, because it shows the real panel edges, which Tripo's paint may not follow. Read the coordinates off the ruler. They are sheet px, the same grid as `reference-sheet.png`.
2. Trace each panel in the views that see it squarely:
   - windscreen: `front` + `top`
   - rear window: `rear` + `top`
   - side glass: `side` / `left`, but only if the clay shows a surface. A hole has nothing to paint, so leave it.

   Each texel takes its outline from the traced view that sees it best. So when a wing hides part of the rear window from behind, trace around the wing, and the top view covers the rest.
3. In `top`, `front` and `rear`, trace one half only and list the view in `glass_mirror`. `top` mirrors about the long centre line, `front` and `rear` mirror left-right. The result is symmetric.
4. Leave out what stays opaque on the real toy: sun strips and banners (e.g. NISSAN SKYLINE), and black frit borders if the sheet shows them painted.

```jsonc
"model": {
  "rebake": {
    "glass": {                                    // sheet px polygons, per view
      "front": [[[140, 1216], [374, 1215], [391, 1280], [128, 1281]]],
      "top":   [[[242, 965], [248, 900], [263, 853], [340, 869], [343, 965]]]
    },
    "glass_mirror": ["top"],                      // views traced on one half
    "unseen": ["top"],                            // views Tripo never got: aligned for paint, not trusted for glass
    "power": 4, "agree": 55                       // view weighting; colour gap where Tripo's paint wins
  }
},
"notes": ["model.rebake.glass: why each panel was traced the way it was"]
```

Rebake, then check `glass-map.jpg` and the 3D views below. Repeat until the magenta sits exactly on the glass. Glass becomes a plain dark tint with a flat normal map, and it is see-through in the app. The cabin behind it is painted from what the drawings show through their windows. `model.glass`, the sheet's own window masks shared with the scripts route, decides which drawn pixels count as "seen through glass".

## 5. Review in 3D

On the dev server:

- `compare.html?car=<id>&m=tripo-multiview-clean,tripo-multiview-guided&refs=1` shows Tripo's paint next to the repaint, with the references.
  - Look from **above** (`view=0,1.5,7`), **above-behind** (`view=-2.4,0.9,5.2,-0.6,0.7,0`) and both sides (`view=0,0.1,9`, `view=3.14,0.1,9`).
  - `glass=0` makes the windows opaque, so you see exactly what was painted on them.
- `views.html?car=<id>&m=tripo-multiview-guided` puts each sheet view beside the model from the same camera.
- Screenshots: `node scripts/shoot.mjs /tmp/shots 1600x760 "top:compare.html?car=<id>&m=tripo-multiview-guided&view=0,1.5,7"`.

Check that:

- decals sit where the sheet has them, on both sides and the top
- there is no white bleed at panel ends or under the wing
- windows are clean (no letters, roof or wing on the glass) and the paint/glass edge is crisp
- the roof is the sheet's size

When something is off, find the view that paints it (`align-<view>.jpg`) and fix the cause. Don't paint over it.

## 6. Promote into the app

```sh
$R promote <id>          # model.glb + model.json + landing fit (alignment.json)
```

Promote copies the repaint to `model.glb` and writes `model.json` with silhouette IoU per view. Open windows don't count against it there. The checks use the looser `GATES_GENERATED`. Promote then re-fits the pack-photo landing. The scripts' own model is kept as `snapshots/scripted.glb`, and `$R model <id> --force` brings it back. After a promote, `model` and `build` leave the car's model alone unless you pass `--force`.

Check `qa/<id>/silhouette-*.png` and `pack-fit.png`, then the landing in the reveal:

```sh
node scripts/shoot.mjs /tmp/shots 1280x800 "land:car=<id>&mode=final&card=0.6" "q1:car=<id>&mode=view&az=0.75&el=0.3" "q2:car=<id>&mode=view&az=-2.3&el=0.35"
```

Generated meshes have their wheels baked into the body, so they don't spin in the reveal.

## 7. Done when

- `glass-map.jpg` has magenta only on glass, and above and behind look clean in 3D.
- All `checks` in `model.json` pass, or `notes` explain why not. Landing IoU is about 0.9 or better, and the landing frame shows no doubled edges.
- The model is about 16k triangles and 1.2–1.5 MB.
- `$R status <id>` says `review`.

Report what you traced and why, with before/after screenshots and the compare link. Then ask the user what to adjust.
