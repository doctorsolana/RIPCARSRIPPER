# RIPCARS

Turn photographs of specific Hot Wheels releases into reference sheets, 3D assets, and an interactive reveal app.

## Three stages

| Folder | Purpose | Start here |
| --- | --- | --- |
| `reference-collector/` | Original photos, current five-view sheets, source evidence and final prompts | [Library](reference-collector/README.md) · [Image gallery](reference-collector/index.html) |
| `asset-generation/` | `ripcars`: reference sheet + pack photo → textured web-sized 3D model + landing pose, with QA and per-car retouch overrides | [Pipeline guide](asset-generation/README.md) |
| `app/` | Three.js/Vite reveal: year → make + rarity → the car, landing on the real pack photo | [App guide](app/README.md) |

```text
reference-collector/           → asset-generation/                 → app/
  cars/<car-id>/                  ripcars/        (the pipeline)       src/
    reference/  (pack photo)      assets/cars/<car-id>/                vite.config.ts → serves
    generated/  (sheet)             hints.json, meta.json (by hand)      asset-generation/assets/
    generation.prompt.txt           tripo/ (multiview outputs)         compare / views / inspect
    review.json                     model.glb, alignment.json, …       scripts/shoot.mjs
    manifest.json                 qa/ .cache/ snapshots/ (git-ignored)
  workflow/  skills/
```

## One car, end to end

| # | Step | Run by | Command |
| --- | --- | --- | --- |
| 1 | Collect the release's photos, then generate and review its five-view sheet | Codex with image generation | `$hot-wheels-reference` ([skill](reference-collector/skills/hot-wheels-reference/SKILL.md)) |
| 2 | Car folder: pack-photo crop (`hints.json`) and the reveal's text (`meta.json`) | Claude or you | [`retouch-car`](.claude/skills/retouch-car/SKILL.md) step 1 |
| 3 | Mesh from the sheet's four side views: Tripo P2 multiview, **spends API credits** | `ripcars tripo <id>` (dry run), then `--send` after approval | [`tripo-car`](.claude/skills/tripo-car/SKILL.md) |
| 4 | Clean the mesh in Blender and fit it to the sheet | `ripcars clean <id>` | |
| 5 | Repaint it from the sheet and trace the windows | `ripcars rebake <id>` + `hints.json` | |
| 6 | Make it the app's model and fit the landing on the pack photo | `ripcars promote <id>` | |
| 7 | Review against the sheet and in the reveal; you say what to adjust | the app's `/inspect.html` | |

Run every `ripcars` command in `asset-generation/` as `uv run --locked python -m ripcars …`. `ripcars status` shows which step each car has reached and what comes next. A car Tripo can't handle can use the scripts route instead: `ripcars build <id>` models it from the sheet's silhouettes (the `retouch-car` skill). Both routes produce the same files for the app.

## Claude skills

A Claude session in this repo runs the workflow with these project skills (`.claude/skills/`):

| Skill | For |
| --- | --- |
| [`ripcars-pipeline`](.claude/skills/ripcars-pipeline/SKILL.md) | Many cars: status, batching, one approval for the paid Tripo calls, handing each car its hand pass, reporting |
| [`tripo-car`](.claude/skills/tripo-car/SKILL.md) | One car through steps 3–7: tracing windows, 3D review, promote, landing |
| [`retouch-car`](.claude/skills/retouch-car/SKILL.md) | A new car folder (step 2), and the scripts route with its overrides |

Codex owns the reference stage with its own skill: [`reference-collector/skills/hot-wheels-reference`](reference-collector/skills/hot-wheels-reference/SKILL.md).

## Working commands

```sh
# 1. Check the reference library (standard-library Python).
python3 reference-collector/workflow/validate_assets.py

# 2. Where is every car, and what's next? Then run that step (needs uv; Blender for `clean`).
cd asset-generation && uv run --locked python -m ripcars status

# 3. Run the reveal, or inspect every car at http://localhost:5199/inspect.html
cd app && npm install && npm run dev -- --port 5199     # http://localhost:5199/?car=<car-id>
```

## The reference library

Every car has one folder in the reference library. Use `cars/<car-id>/generated/reference-sheet.png` for its current reviewed sheet and `manifest.json` for the selected version, prompt and review. The library currently contains six accepted sheets plus five drafts requiring camera correction, with 95 original photos across 11 releases.

The current sheets provide right and left profiles, overhead, front and rear views. Both side profiles must pass a separate level-camera review. Both sides of the catalogued releases have real photo evidence; the source files and uncertain details are recorded per car. These remain synthetic references: geometry is not calibrated and fine graphics can drift, which is why stage 2 fits every model to the sheet and checks it view by view. Only the current sheet is kept in each folder; use the manifest's `view_count`, `layout` and review status when reading it. Per-car experiment archives and standalone Tripo image tests have been removed.
