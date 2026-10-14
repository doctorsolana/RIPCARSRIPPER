# Reference collector

[Gallery](index.html) · [All cars](cars/README.md) · [Manifest](manifest.json) · [Workflow](workflow/README.md)

The library keeps **one current five-view sheet per car**, original toy photographs, source evidence, the final exact prompt and current review. There are 12 releases: 12 accepted sheets, with 105 original photos.

```text
reference-collector/
  cars/<car-id>/
    reference/                 Original photos, sources.json, side-evidence.json
    generated/
      reference-sheet.png      Accepted sheet; draft-sheet.png for a draft instead
    generation.prompt.txt      Exact prompt for the retained sheet
    review.json                Current review and generation provenance
    manifest.json              Identity, status, layout and paths
    README.md                  Car guide
  workflow/                    Gallery builder and integrity validator
  skills/hot-wheels-reference/  Current multiview skill and prompt template
  manifest.json
  index.html
```

The sheet layout is right profile facing right, left profile facing left, overhead facing right, then front and rear below. Tripo uses the four side/front/rear views; the top remains useful for fitting and textures. Both side profiles require independent level-camera review. No external floor shadows; photographic shading stays on the car.

Use `selected` in each manifest to identify accepted sheets. A draft has `selected: null` and a `preview`; it must not silently become a production reference. The retained draft is the current reviewed choice, which may be better than a later unsuccessful attempt.

Original photos and watermarks are preserved unchanged. Sources and hashes remain beside the images; both-side evidence records distinguish observed from inferred details. Fine lettering, reflections and reconstructed shapes remain approximate. Older accepted sheets were finalized by editing previous generated sheets; their reviews preserve this distinction even though those intermediates have been removed.

Use the [multiview skill](skills/hot-wheels-reference/SKILL.md) for new cars. Git supplies version history; this tree excludes per-car experiment archives, obsolete prompts and standalone Tripo image tests.

```sh
python3 reference-collector/workflow/build_gallery.py
python3 reference-collector/workflow/validate_assets.py
```
