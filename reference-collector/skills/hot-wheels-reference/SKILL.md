---
name: hot-wheels-reference
description: Collect exact-release Hot Wheels photographs and create photographic five-view reference sheets for RIPCARS and Tripo multiview, with independent level side-profile checks and source provenance. Produces reference sheets, not meshes.
---

# Hot Wheels multiview references

Use `reference-collector/cars/<car-id>/` for the exact miniature release. Preserve the active app and modeling pipeline. Read the car's manifest, original photographs and current review before changing it. Follow the [five-view prompt](references/five-view-prompt.txt); no standalone three-quarter image is needed for the current Tripo workflow.

## Original evidence

Identify casting, product code, release, paint, wheels, graphics and panel pose. Similar recolors and full-size cars are not interchangeable. Inspect every input. Prefer physical toy photos to packaging artwork; do not mistake a base photograph for an overhead view.

Find real photos of both physical sides first, using saved sources, official Mattel pages and exact-release collector catalogues. Keep original bytes in `reference/`, with URL, dimensions and SHA-256 in `reference/sources.json`. Record each side's evidence in `reference/side-evidence.json`: `real_reference`, `partially_inferred` or `inferred`, with source files and unknown details. If an opposite side cannot be found, conservative inference is allowed but must remain labeled in metadata. Never horizontally flip a side: text, fuel doors, exhausts and liveries may differ.

## Generate from photos

Use the available imagegen skill and built-in image generator. New sheets and source-only retries use real originals only, without an earlier generated sheet as a layout example. Explicit user-requested edits may use the existing sheet and must be recorded as edits.

Make five views in four rows: vehicle-right profile facing right, vehicle-left profile facing left, vertical overhead facing right, then level front at left and rear at right. Both profiles and overhead share longitudinal scale and one mechanical pose. Keep whole silhouettes and white gutters.

Require opaque white space outside the car: no receiving floor, ground/contact/cast shadows or halos. Preserve dimensional shading ON the object: rounded highlights, metallic reflections, tire volume, recessed spokes and cabin depth. An orthographic view must still look like a photographed miniature.

Save the exact prompt before submitting it, and record ordered real inputs and hashes. Use a git-ignored `.work/` directory for temporary attempts. Inspect each result. By default allow two retries after the initial attempt; retry from real photos, addressing the observed failure. Do not replace an accepted sheet with a failed attempt.

## Acceptance

Review both actual side rows independently. Every condition must pass:

- Horizontal camera at mid-door height, precisely side-on with no apparent pitch, yaw or roll.
- No broad hood/roof/trunk top plane; a thin curved contour is allowed.
- No front grille/headlamp face, rear lamp face or downward view into seat cushions.
- Circular wheel faces with appropriate near/far overlap and level axle baseline.
- Real proportions, wheelbase, ride height, roof, fender occlusion and wing preserved; no squashing to fake the camera.

Do not hide hood artwork to disguise an elevated view. A failed or uncertain condition on either side prevents acceptance. Also check all five views for clipping, consistent identity and pose, readable non-mirrored graphics, white exterior background and photographic material depth. Record fine-text and inferred-geometry limitations honestly. This is synthetic reference material, not calibrated CAD or an exact albedo map.

## Publish only the current result

The repository keeps one current sheet per car, originals, a final exact prompt and current review. Git supplies version history; do not recreate per-car history/version folders, single-view tests or collections of old prompts.

Use the existing schema-2 manifests as examples:

- Accepted: `generated/reference-sheet.png`, with `selected` set and five-view `layout`.
- Unaccepted new car: `generated/draft-sheet.png`, `selected: null`, `preview` set, `status: needs_correction`.
- `generation.prompt.txt`: exact final submitted prompt.
- `review.json`: current version/status, prompt hash, native output metadata, real input order/roles/hashes, generation strategy and actual per-side review observations. For an edited sheet, state that the prompt depended on a previous generated image; never label it source-only.
- `reference/`: unedited source photos, source provenance and side-specific evidence.
- `manifest.json`: identity, current sheet/prompt/review pointers, source count, review summary and workflow paths.

Only replace current files after review, retain the draft status of any failed car, and update the collection manifest consistently. Measure native dimensions and hashes rather than assuming a requested resolution was delivered. Run `python3 reference-collector/workflow/build_gallery.py` and `python3 reference-collector/workflow/validate_assets.py --reference-only`. Remove temporary attempts after the current result and record are saved. Deliver the sheet with its prompt and remaining limitations. Tripo submission and 3D processing belong to the separate asset-generation workflow.
