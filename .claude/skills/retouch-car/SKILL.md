---
name: retouch-car
description: Set up a new RIPCARS car in asset-generation (pack-photo hints + meta, step 1 of every route), then build or retouch its 3D reveal model with the ripcars scripts - the fallback route that models the car from the sheet's silhouettes. Run the build, review the QA images and app renders, and fix what the scripts got wrong through hints.json overrides until the car looks right from every angle and lands on its pack photo. Use when asked to add a car folder, or to model, fix, tune or retouch a car built by the scripts. For a Tripo-made model use tripo-car; for many cars use ripcars-pipeline.
---

# Retouch a car model (scripts route)

Two routes make a car's model. The default is a generated Tripo mesh repainted from the sheet (the `tripo-car` skill). This skill covers the other one: the `ripcars` scripts in `asset-generation/` build the car from the sheet's silhouettes. Step 1 here, the car folder, is needed by both routes.

The scripts get each car most of the way automatically. You finish it, and you only change the car's `hints.json`, never generated files. Every override needs a `notes` entry saying why.

## 1. Inputs

- The sheet must exist and be accepted: `reference-collector/cars/<id>/generated/reference-sheet.png`, with `selected.layout` in its manifest. If it's missing or not accepted, the reference stage isn't done; don't model from drafts.
- **New car:** create `asset-generation/assets/cars/<id>/`:
  - `hints.json`: `photo` (relative path to `reference-collector/cars/<id>/reference/pack-photo.webp`) and `carBox` `[x, y, w, h]`, the car in the blister. Look at the photo with a pixel ruler. Add `wheels` circles if the photo is small or the tyres are dark on a dark card.
  - `meta.json`: make, model, year (+ `yearSource`), line, series, collection, `toy` (the reference manifest's `product_code`: the NFT's 'Toy #', which the game maps a wallet's Rip Cars by), rarity. RIPCARS tiers are still placeholders: common, rare, epic, legendary, chase.

## 2. Build

```sh
cd asset-generation && uv run --locked python -m ripcars build <id>
```

If the car's `model.glb` was promoted from a Tripo mesh (`model.json` has `source`), `build` and `model` leave it alone. `--force` rebuilds it from the scripts, and `ripcars promote <id>` switches back.

Read the console. `WARN ... check failed` names the gate. Then look at **every** image in `asset-generation/qa/<id>/`:

- `panels.jpg`: each view outlined. Is everything car (no shadows, no neighbouring view, nothing missing)?
- `silhouette-*.png`: red means the sheet has it and the model doesn't; cyan means the reverse. Side and top should be nearly all white.
- `shape.jpg`: untextured shape. Look for blobs, missing mirrors, a solid block under a wing, and wheels poking out.
- `glass.jpg`: every window found, and nothing else.
- `pack-fit.png` and `extract.jpg`: the landing pose against the pack photo.

Then look at it textured, the way the user will see it, in the reveal (`http://localhost:5199/rip.html?car=<id>`; shoot.mjs opens it for a query). With `cd app && npm run dev -- --port 5199` running:

```sh
node scripts/shoot.mjs /tmp/shots 1280x800 "q1:car=<id>&mode=view&az=0.75&el=0.3" "q2:car=<id>&mode=view&az=-0.9&el=0.3" "q3:car=<id>&mode=view&az=1.45&el=0.15" "land:car=<id>&mode=final&card=0.6"
```

Check at least front three-quarter, rear three-quarter, nose-on and the landing. Use `t=<seconds>` to check moments in the reveal.

## 3. Fix with overrides (`hints.json`)

| You see | Override |
| --- | --- |
| Window missed or wrong (glass.jpg) | `model.glass.add` / `.remove` → `{view: [[[x, y], ...]]}` polygons in **sheet px**. Views: `side`, `left`, `top`, `front`, `rear`. Trace with a ruler crop of the sheet. |
| Wing is a solid block, or a ducktail got split into a wing | `model.wing`: `"parts"` or `"solid"` |
| Wing plate too thick or thin; uprights in the wrong place | `model.wing_plate` (0.2–0.6), `model.wing_upright_z` (fraction of half-span) |
| Odd mirrors (wrong height, fins on the doors) | `model.mirrors: false` |
| Wheel too small or big, poking out, or a skirt not detected | `model.wheels.<rear\|front>`: `radius_scale`, `width` (fraction of body width), `covered` |
| Decals doubled or ghosted where views meet | `model.blend.agree` lower (20) sharpens; `power` higher (6) narrows the blend bands |
| Car lands at a wrong angle (yaws or tips) | `landing`: `pitch_deg` / `yaw_deg` / `roll_deg` / `stretch`, plus `"lock": true` to fix them |
| Pack-photo cut-out wrong | `carBox`, `wheels`, or `segModel` (`birefnet-general`) |
| Cut-out still clips the car or takes in card art (a car on look-alike card art, like the Godzilla Skyline's tail) | `mask.add` / `mask.remove`: polygons `[[x, y], ...]` in photo px, drawn into / cut out of the segmented mask. Trace them on a zoomed ruler crop. |

Rebuild only what changed: `model` and then `align` after shape or wheel changes, `align` alone after landing changes, and `extract` → `align` after photo hints.

## 4. Done when

- All `checks` in `model.json` pass, or a failing one has a `notes` entry explaining why. Example: "the sheet draws the rear wheel 13 px off the ground; tyres are stood on one ground line on purpose".
- Textured renders look like the toy from front, rear and both sides: no blobs, ghost decals, white glass or floating parts.
- The landing frame matches the card.

Report what you changed and why, and show the before/after renders.
