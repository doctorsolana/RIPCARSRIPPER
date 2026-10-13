# 2 · Asset generation

Turns each car's **reference sheet** (from [reference-collector/](../reference-collector/README.md)) and **pack photo** into what the [app](../app/README.md) reveals: a textured, web-sized 3D model (`model.glb`) and the pose that lands it exactly on the photo (`alignment.json`).

```sh
cd asset-generation
uv run --locked python -m ripcars status        # every car: how far it got, and its next step
```

Every command below is `uv run --locked python -m ripcars <command> <car-id ...|all>`. A car needs a sheet in `reference-collector/cars/<id>/generated/reference-sheet.png` **and** an `assets/cars/<id>/` folder with `hints.json` and `meta.json`.

## Two routes to a model

| Route | The mesh comes from | Use it | Claude skill |
| --- | --- | --- | --- |
| **Generated** (default) | Tripo P2 multiview, made from the sheet's four side views, then cleaned, fitted and repainted from the sheet | every car with an accepted sheet | [`tripo-car`](../.claude/skills/tripo-car/SKILL.md) |
| **Scripts** (fallback) | `ripcars` itself, lofted from the sheet's silhouettes | a car Tripo can't do, or offline work | [`retouch-car`](../.claude/skills/retouch-car/SKILL.md) |

Both write the same `model.glb` + `model.json` + `alignment.json`, so the app doesn't care which route made a car. `model.json` → `source` says which one did. Many cars at once: the [`ripcars-pipeline`](../.claude/skills/ripcars-pipeline/SKILL.md) skill.

## Generated route (Tripo)

| Step | Command | Writes to `assets/cars/<id>/` | Notes |
| --- | --- | --- | --- |
| request | `tripo <id>` | `tripo/multiview/request.json`, `views/` | Dry run: writes the four images and the request body, sends nothing. `qa/<id>/tripo-inputs.jpg` shows the four side by side for review |
| send | `tripo <id> --send` | `tripo/multiview/model_url.fbx`, `rendered_image_url.webp`, `task.json` | **Spends Tripo API credits**: 110 per car so far (Skyline, Impala, Roxy), about 2.5 minutes each. Skips cars that already have a result unless you pass `--force` |
| clean | `clean <id>` | `snapshots/tripo-multiview-clean.glb`, `tripo/multiview/clean.json` | Headless Blender (`BLENDER=` overrides the path). Joins the parts, welds seams and drops loose or degenerate faces. Turns the nose to +x, sets length 4 and grounds it. Textures become 1024 px JPEG. Then fits each axis to the sheet's side and top. Tripo never sees a top view, so its proportions are off: the Skyline came out 27% too wide, the Roxy 23%, the Impala 27% too wide and 9% too tall. Prints `size vs sheet` (body length, width, height against the drawings) and warns past 5%. **Check it before going on**; `model.fit` corrects it by hand |
| rebake | `rebake <id>` | `snapshots/tripo-multiview-guided.glb` + `.json` | Repaints the mesh from the sheet, see below. Takes about 10 s |
| promote | `promote <id>` | `model.glb`, `model.json`, `alignment.json` | The app now shows it. The scripts' model is kept as `snapshots/scripted.glb` (`model <id> --force` restores it) |

Use the sheet's four views for Tripo. The retired single-image experiment and its images have been removed.

**Tripo API.** Set `TRIPO_API_KEY` in the environment or in `asset-generation/.env`, which is git-ignored. Never commit or print it. International keys use `https://openapi.tripo3d.ai/v3` (`TRIPO_API_BASE` overrides it); the `.com` host is the China region and answers 401. API credits are separate from Tripo Studio credits. The settings are in `ripcars/tripo.py` → `SETTINGS`: model `P2-20260801`, quad, `face_limit` 8000, PBR texture.

### Rebake: painting the sheet onto someone else's mesh

A drawing never sits exactly on another tool's geometry: windows, panel ends and decals land a little off. Tripo's own texture, though, matches its geometry. So `rebake`:

1. renders the mesh with its own texture through every sheet view's camera (`render.py`, an exact z-buffer), and turns every face a camera sees towards that camera. Tripo leaves inside-out patches (45% of the Roxy), which would otherwise never get painted and would show as black holes in the app.
2. aligns each drawing to that render with dense optical flow. It keeps the flow only where both images have structure and agree, caps it per view, and drops it if it doesn't improve the match. The top view is aligned for paint only, because Tripo never saw one.
3. paints each texel from the views that see it squarely. Wherever the blurred drawing disagrees with Tripo's paint (background, painted-in reflections), Tripo's paint is kept, so edges never bleed white. The exception is the top view: Tripo never saw it, so its paint there is a guess, such as a roof banner twice or a mirrored "PORSCHE", and the drawing wins. Each side has its own drawing: the left side comes from the left view, never mirrored.
4. finds the wheels: Tripo builds each from separate pieces (a tyre standing at a corner, plus the rim and hub centred in it). Each is exported as a `wheel_*` pivot at its hub, the same layout as the scripts' wheels, so the reveal spins them. A brake caliper or anything else off-centre stays still. `qa/<id>/wheels.jpg` tints what will spin; `model.rebake.wheels: false` turns this off.
5. makes the glass a plain dark tint and marks it see-through in the material map. The normal map is flattened there too, since Tripo embosses invented lettering on glass. The cabin behind the glass is painted from what the drawings show through their windows.

### Windows by hand

With no settings, glass comes from the sheet's window masks (`qa/<id>/glass.jpg`), aligned to the mesh. Set each view's glass explicitly instead:

- **`"sheet"`** uses that view's own window mask, aligned like its paint. This suits views Tripo was given (side, left, front, rear), where mesh and drawing agree. Trim a mask with `model.glass.remove`, for example a sun strip the finder took for glass.
- **Polygons** are traced on the mesh itself. Use them where the mesh and the drawing disagree. That is usually the top view: Tripo put the Roxy's rear window 40 px forward of the drawing.
- **Leave a view out** when its windows are open holes on the mesh (the Skyline's and Impala's side windows).

`rebake` writes the tracing images: `qa/<id>/trace-<view>.png` zooms in on the view's windows. Tripo's paint is on top and clay shading below, with a ruler in sheet px, the drawing's window outline in cyan and the current glass in magenta. Trace on the clay, which shows the real panel edges:

```jsonc
"model": {
  "rebake": {
    "glass": {"side": "sheet", "front": "sheet", "top": [[[x, y], ...]]},   // per view: "sheet" or polygons in sheet px
    "glass_mirror": ["top"],   // traced on one half: mirrored across the centre line
    "unseen": ["top"],         // views the generator never got: their drawing beats Tripo's paint; glass only if listed above
    "power": 4, "agree": 55    // view weighting; colour gap above which Tripo's paint wins
  }
}
```

`ripcars outline <id> --view <view>` gives a first outline. It prints the outlines of Tripo's own dark window paint in sheet px, which sits on the mesh's window openings. Prefer tracing over `"sheet"` where a drawing is a steep perspective shot: the Impala's front and rear drawings put its windows higher than the mesh's, so the aligned sheet glass spilled onto the roof lip and the lettering above the rear window. Check from the drawings' own elevated angles with `glass=0` on the compare page; a level front view sees the roof edge-on.

Each texel takes its glass from the listed view that sees it best. A wing hiding part of the rear window from behind is fine: trace around it, and the top view covers the rest. Then check `qa/<id>/glass-map.jpg`, which puts every view's glass in magenta next to the sheet, and look from above and behind on the compare page.

## Scripts route

```sh
uv run --locked python -m ripcars build <car-id ...|all>   # extract + model + align
```

| Step | Command | Reads | Writes to `assets/cars/<id>/` |
| --- | --- | --- | --- |
| extract | `extract <car>` | `hints.json`, the pack photo | `photo.webp` (the card the reveal ends on), `mask.png`, `extract.json`, `side.webp` |
| model | `model <car>` | the five-view sheet, `hints.json` → `model` | `model.glb`, `model.json` (dimensions, wheels, QA) |
| align | `align <car>` | `model.glb`, `mask.png` | `alignment.json` (landing pose) |

`extract` and `align` serve both routes; `promote` runs them itself. `model` and `build` leave a promoted car's `model.glb` alone unless you pass `--force`.

How the scripts build a model:

1. **Slice the sheet** (`sheet.py`): find the five views (right and left profiles, top, front, rear), using white gutters or, if the views touch, the emptiest rows. Each view gets a BiRefNet matte. See-through side windows become dark glass.
2. **Calibrate** (`views.py`): the right profile is the master scale. The top view sets the width. Front and rear views are fitted to the body width with mirrors ignored, since they're generated product shots and not true elevations.
3. **Wheels** (`wheels.py`): tyres are fitted to the lower arc of the side silhouette and stood on one ground line. Track and tread width come from the top and front/rear views. Fender skirts are spotted because the wheel's middle isn't rotationally symmetric there.
4. **Body** (`hull.py`): a loft along the car. Each slice gets its height from the side view, its width from the top view and its cross-section shape from the front/rear views. Mirrors and spoilers are added from the silhouettes only where the views agree they exist. Wheel wells follow the drawn arches.
5. **Wing** (`wing.py`): a rear wing that stands clear of the deck is rebuilt as crisp parts (plate, endplates, two uprights). A solid ducktail stays part of the body.
6. **Mesh** (`mesh.py`): marching cubes, Taubin smoothing, then decimation to about 12k triangles.
7. **Glass** (`glass.py`): windows are found in every view with GrabCut, seeded by colour and limited to the cabin.
8. **Texture** (`bake.py`): one 1536 px atlas. Each texel takes its colour from the views that see it squarely. Views that disagree are damped instead of blended, so decals don't double up. View colours are matched to the side view. Windows come from a single view, so their edges stay crisp.
9. **GLB** (`export.py`): the body, with glass encoded in its roughness/metalness map, plus four wheel pivots (tyre mesh plus the sheet's own rim drawing). About 15k triangles and 0.8–1.0 MB per car.
10. **Landing pose** (`align.py`): fits the model's silhouette to the pack photo's car (pitch, yaw, roll, scale, position, a small lengthwise stretch). Holes in the model's silhouette, such as open side windows, don't count against it. The app glues the photo onto the model through that pose and crossfades to the card.

## hints.json: every hand change

The scripts get each car most of the way. A person or a Claude session finishes it by overriding in `hints.json` and rebuilding; the skills above walk through it. Every override gets a `notes` entry saying why.

```jsonc
{
  "photo": "../../../../reference-collector/cars/<id>/reference/pack-photo.webp",
  "carBox": [x, y, w, h],                    // where the car sits in the pack photo (px)
  "wheels": [{"cx": 0, "cy": 0, "r": 0}],    // pack-photo wheel circles, if detection misses
  "model": {
    "glass": {"add": {"top": [[[x, y], ...]]}, "remove": {"side": [[[x, y], ...]]}},  // the sheet's window masks (sheet px), both routes
    "rebake": {"glass": {...}, "glass_mirror": [...]},                                 // generated route: see above
    "fit": {"width": 0.97},                  // generated route: factor on the fitted size per axis (length/width/height)
    "wing": "auto | parts | solid",          // scripts route from here on: force the rear-wing treatment
    "wing_plate": 0.4,                       // plate thickness, fraction of the endplate height
    "wing_upright_z": 0.45,                  // uprights' position, fraction of the half-span
    "mirrors": true,                         // false: no mirrors from the silhouettes
    "wheels": {"rear": {"covered": true, "radius_scale": 1.0, "width": 0.19}, "front": {}},
    "blend": {"power": 4, "agree": 30},      // texture blending sharpness / ghost damping
    "faces": 12000, "texture": 1536          // budget
  },
  "landing": {"pitch_deg": 10, "yaw_deg": 0, "roll_deg": 0, "stretch": 1.0, "lock": false},
  "notes": ["why each override is there"]
}
```

## QA

`model.json` → `checks` holds silhouette IoU gates per view. Scripts models use `GATES`. Promoted generated meshes use the looser `GATES_GENERATED` in `ripcars/__main__.py`, with open windows not counted, plus `proportions_vs_sheet`: body length, width and height within 5% of the drawings. Silhouettes are compared on a canvas well beyond each view's crop, so a model wider than the crop counts against it. Before this, the Impala's excess width fell outside the crop and went unseen. A failed gate prints a warning; it doesn't stop the build. Review images go to `qa/<id>/`, which is git-ignored and rebuilt on demand, as are the segmentation mattes in `.cache/`:

| `qa/<id>/` | Route | Shows |
| --- | --- | --- |
| `align-<view>.jpg` | generated | the mesh's render, the sheet, then checkerboards of both before and after alignment |
| `glass-map.jpg` | generated | every view: the sheet next to the repainted model, glass in magenta |
| `wheels.jpg` | generated | side, left and front views with the faces that will spin tinted, one colour per wheel |
| `trace-<view>.png` | generated | one view's windows zoomed, paint above and clay below, sheet-px ruler, the drawing's windows (cyan) and the glass (magenta): trace windows here |
| `tripo-inputs.jpg` | generated | the four images a Tripo request sends (written by the dry run) |
| `tripo-sheet.png`, `tripo-clay.png` | generated | the whole mesh in the sheet's layout and pixel grid |
| `panels.jpg` | both | how the sheet was sliced and segmented |
| `silhouette-<view>.png` | both | model vs sheet: white both, red sheet only, cyan model only |
| `pack-fit.png` | both | landing pose vs the pack photo |
| `extract.jpg` | both | pack-photo cut-out, outline and wheels |
| `glass.jpg` | both | the sheet's own window masks (`model.glass`), in cyan |
| `shape.jpg`, `texture.jpg`, `compare-<view>.jpg` | scripts | untextured shape, the atlas, textured model vs each view |

For textured checks in 3D, use the app's review pages and screenshot script (see the [app guide](../app/README.md)).

## What a car folder holds

| File | Who writes it | Kept in git |
| --- | --- | --- |
| `hints.json`, `meta.json`, optional `params.json` (procedural fallback car) | you / Claude | yes |
| `tripo/<mode>/` (request, Tripo's FBX, preview, task record) | `ripcars tripo` | yes: they cost credits (`views/` is regenerated) |
| `model.glb`, `model.json`, `alignment.json`, `photo.webp`, `mask.png`, `extract.json`, `side.webp` | `ripcars` | yes: the app serves them |
| `snapshots/` (every version for the compare page), `review/` (sheet crops) | `ripcars` | no: rebuilt from the above |

## Known limits

The sheets are AI-generated. Proportions differ a few percent from the real toy (the landing stretch absorbs this), front and rear views are perspective shots, and fine lettering can drift.

- **Scripts route**: concave shapes that no silhouette shows, such as a hood sunk between fenders, come out filled.
- **Generated meshes**: some windows come out as open holes, and Tripo invents what it couldn't see (underside, interior). Wheels spin only when Tripo builds them as separate pieces, which it has for every car so far; otherwise `rebake` leaves them in the body and says so.

The texture already carries the toy's painted-in reflections, so the 3D materials keep their own reflections light.
