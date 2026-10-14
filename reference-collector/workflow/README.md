# Reference workflow

Use the [Hot Wheels reference skill](../skills/hot-wheels-reference/SKILL.md) and its [five-view prompt](../skills/hot-wheels-reference/references/five-view-prompt.txt).

1. Identify the exact release and collect original physical-toy photos, including both sides where available. Save source URLs, dimensions, hashes and inference notes.
2. Generate the entire five-view sheet directly from real photos. Layout: right profile, left profile, overhead, then front and rear. Keep true level side cameras and photographic depth; use white space with no external shadows.
3. Review both profiles independently, plus identity, material depth, clipping, pose and graphics. A failed side-camera check keeps the sheet a draft.
4. Keep only the current sheet, exact final prompt, original photos and current review in each car folder. Use Git for earlier versions. Temporary attempts belong in ignored `.work/` and should be removed after the current result is saved.
5. Rebuild the gallery and check file integrity:

```sh
python3 reference-collector/workflow/build_gallery.py
python3 reference-collector/workflow/validate_assets.py
```

Accepted sheets use `generated/reference-sheet.png`; drafts use `generated/draft-sheet.png` and `selected: null`. Consult each manifest before using a sheet. Twelve accepted sheets are currently retained. Acceptance covers the strict side-profile review; read each review for remaining texture and front/rear camera limitations.

The older accepted sheets were finalized through generated-image edits; their reviews say so. The final prompts are preserved exactly, but retired intermediate images are not part of the current tree. New sheets use real photos directly.

[Asset generation](../../asset-generation/README.md) crops front, left, rear and right for Tripo multiview. The overhead view supports fitting and texture work. Separate elevated three-quarter images are no longer part of this workflow.
