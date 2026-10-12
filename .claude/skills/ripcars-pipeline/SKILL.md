---
name: ripcars-pipeline
description: Run RIPCARS cars through the whole pipeline, one car or many. The stages are pack photo and reference sheet (reference-collector), then 3D model (asset-generation), then the reveal app. Check every car's stage with `ripcars status`, batch the next steps, get one user approval for the paid Tripo calls, and give each car its hand pass with the tripo-car / retouch-car skills. Use when asked to add or process several cars, run all cars, say what's next, or explain or run the end-to-end workflow.
---

# RIPCARS pipeline

Each Hot Wheels release goes through the same steps. The scripts do everything they can. A Claude session does the hand pass on each car through its `hints.json`, and the user gives the final adjustments.

| # | Step | Run by | Output | Details |
| --- | --- | --- | --- | --- |
| 1 | Photos + five-view reference sheet | Codex with image generation (not Claude) | `reference-collector/cars/<id>/generated/reference-sheet.png`, `selected` in `manifest.json` | `reference-collector/skills/hot-wheels-reference` |
| 2 | Car folder: pack-photo crop, reveal text | Claude | `asset-generation/assets/cars/<id>/hints.json`, `meta.json` | `retouch-car`, step 1 |
| 3 | Mesh: Tripo P2 multiview (**paid**) | `ripcars tripo` | `tripo/multiview/model_url.fbx` | `tripo-car` §1 |
| 4 | Clean + fit to the sheet | `ripcars clean` | `snapshots/tripo-multiview-clean.glb` | `tripo-car` §2 |
| 5 | Repaint from the sheet, trace windows | `ripcars rebake` + Claude | `snapshots/tripo-multiview-guided.glb` | `tripo-car` §3–5 |
| 6 | Into the app + pack-photo landing | `ripcars promote` | `model.glb`, `model.json`, `alignment.json` | `tripo-car` §6 |
| 7 | Review + user adjustments | Claude + user | notes in `hints.json` | `/inspect.html` |

The fallback for a car the Tripo route can't do is `ripcars build` (the scripts model it from the sheet), using the `retouch-car` skill. Both routes produce the same files, so the app doesn't care which one made a model.

## Start with status

```sh
cd asset-generation && uv run --locked python -m ripcars status
```

One row per car: sheet, hints, tripo, clean, rebake, glass (auto or traced), model (scripts or tripo), checks, landing IoU, and **next**. Work from the `next` column.

## A batch

1. **Draft sheets** ("reference-collector: sheet not accepted yet"): list them for the user. They are Codex's work. Don't model them.
2. **No hints**: do `retouch-car` step 1 for each car. You have to look at every pack photo to set `carBox`.
3. **Tripo**:
   - Dry-run them all: `ripcars tripo <id> <id> ...`. Look at each car's four `tripo/multiview/views/` images.
   - Ask **once for the whole batch**, with the cost: N cars × ~110 credits (skyline-hck01's multiview task used 110).
   - Wait for an explicit yes, then run `ripcars tripo <ids> --send`. Cars run one after another, a few minutes each. Cars that already have a result are skipped. Never use `--force` without a new yes.
4. **Free steps** for every car that's ready: `ripcars clean <ids>`, then `ripcars rebake <ids>`.
5. **Hand pass per car**: `tripo-car` §4–6 (trace windows, review in 3D, promote). Cars are independent because each has its own `hints.json`. With many cars, give each one to a subagent running the `tripo-car` skill. They can share one dev server on port 5199.
6. Run `ripcars status` again and report a table: car, model source, checks, landing IoU, what still looks off, and the link `http://localhost:5199/inspect.html?car=<id>`. Then collect the user's adjustments and apply them through `hints.json`.

## Rules

- **Paid calls**: never send a Tripo task without the user's explicit yes for that batch. Retries and `--force` need a new yes.
- **Secrets**: `TRIPO_API_KEY` lives only in the environment or `asset-generation/.env` (git-ignored). Never print, log or commit it.
- **Hand edits** go in `hints.json` with a `notes` entry. Generated files get rebuilt, never edited.
- **Leave Codex's reference work alone**: Codex works in `reference-collector/` at the same time as you.
- **Budget**: about 16k triangles and 1–1.5 MB per car. The reveal must stay light enough for the web.
- **What git keeps**: hand inputs (`hints.json`, `meta.json`), paid outputs (`tripo/<mode>/`) and what the app serves (`model.glb`, `model.json`, `alignment.json`, the pack-photo cut-out). `snapshots/`, `review/`, `qa/` and `.cache/` are rebuilt from those and are git-ignored.
