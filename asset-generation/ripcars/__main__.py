"""RIPCARS stage 2 command line (run from asset-generation/):

    uv run python -m ripcars extract <car...|all>   pack photo      -> photo.webp, mask.png, extract.json
    uv run python -m ripcars model   <car...|all>   reference sheet -> model.glb, model.json
    uv run python -m ripcars align   <car...|all>   model + photo   -> alignment.json (the landing pose)
    uv run python -m ripcars build   <car...|all>   all three, in order
    uv run python -m ripcars status  [car...]       where every car is in the pipeline, and its next step

  Generated-mesh (Tripo) route, see README.md:
    uv run python -m ripcars tripo   <car...> [--send]
                                                    Tripo P2 quad mesh; without --send only writes the
                                                    request for review (sending spends credits)
    uv run python -m ripcars clean   <car...>       Tripo FBX -> cleaned web GLB fitted to the sheet (Blender)
    uv run python -m ripcars rebake  <car...> [--src snapshots/x.glb]   repaint it from the sheet
    uv run python -m ripcars promote <car...> [--src snapshots/x.glb]   make it the car's model.glb + align
    uv run python -m ripcars outline <car> --view top [--dark 110]     window outlines from the generator's
                                                    own dark window paint (after rebake), for model.rebake.glass

Outputs land in assets/cars/<id>/ (served by the app); review images in qa/<id>/.
"""
import argparse
from pathlib import Path
import os
import json
import shutil
import sys
import time

import cv2
import numpy as np

import trimesh

from . import align, bake, export, extract, glass, hull, mesh, paths, qa, sheet, views, wing
from . import wheels as wh

# Minimum silhouette IoU per view. Side/top/left are near-orthographic and should match closely; the
# generated front/rear views are elevated perspective shots, so they only need to roughly agree.
GATES = {"side": 0.97, "top": 0.94, "left": 0.92, "front": 0.82, "rear": 0.82}


def _layout(car: str):
    m = paths.manifest(car)
    if not m.is_file():
        return None
    data = json.loads(m.read_text())
    preview = (data.get("preview") or {}).get("layout")
    if preview and not paths.accepted_sheet(car).is_file() and paths.draft_sheet(car):
        return preview  # hints.json "sheet": the draft in use is described by the manifest's preview entry
    return data.get("layout") or (data.get("selected") or {}).get("layout")


def write_review_crops(car: str, cal) -> None:
    """The sheet's views, cropped to the car, for the app's views/compare pages (dev review only)."""
    review = paths.asset_dir(car) / "review"
    review.mkdir(exist_ok=True)
    for name, v in cal.views.items():
        x0, y0, x1, y1 = v.panel.bbox
        cv2.imwrite(str(review / f"{name}.jpg"), cv2.cvtColor(v.panel.rgb[y0:y1, x0:x1], cv2.COLOR_RGB2BGR),
                    [cv2.IMWRITE_JPEG_QUALITY, 90])


def build_model(car: str, target_faces: int | None = None, texture: int | None = None, nx: int = 448) -> dict:
    """target_faces/texture: None = the car's hints.json "model" value, else 12000 / 1536."""
    t0 = time.time()
    out = paths.asset_dir(car)
    hints = json.loads((out / "hints.json").read_text()) if (out / "hints.json").is_file() else {}
    tune = hints.get("model", {})
    target_faces = target_faces or tune.get("faces", 12_000)
    texture = texture or tune.get("texture", 1536)
    qadir = paths.qa_dir(car)
    panels = sheet.load(paths.sheet(car), cache_dir=paths.cache_dir(car), layout=_layout(car))
    cal = views.calibrate(panels)
    wheels = wh.locate(cal, tune.get("wheels"))
    registration = views.register(cal, wheels) if tune.get("register", True) else {}
    grid = hull.make_grid(cal, nx=nx)
    found = {}

    def cabin_fn(pr):  # find the windows first, then let them shape the cabin
        found["greenhouse"] = glass.find_all(cal, grid, pr, tune.get("glass"))
        found["cabin"] = glass.cabin(cal, grid, pr)
        return found["cabin"]

    body = hull.build(cal, grid, wheels, tune=tune, cabin_fn=cabin_fn)
    overhang = hull.tyre_overhang(body, wheels)
    bulge = wh.top_bulge(cal, wheels)  # does the top view show the tyres standing proud of the body?
    if tune.get("tyres_flush", True) and max(overhang) > 0.004:
        # tyres poke out of the bodywork although the top view shows none: pull them in flush and
        # rebuild the wells around them (cars whose sheet shows proud tyres keep them)
        for w, o, b in zip(wheels, overhang, bulge):
            if o > 0 and not b:
                w["z_outer"] -= o
                w["z_inner"] -= o
        body = hull.build(cal, grid, wheels, tune=tune, cabin_fn=cabin_fn)
    surf = mesh.surface(body, target_faces=target_faces, smooth_iters=8)
    n_body_faces = None
    if body.wing is not None:  # crisp separate parts, flat-shaded (each face its own vertices)
        n_body_faces = len(surf.faces)
        parts = [m for m in wing.meshes(body)]
        for m in parts:
            m.unmerge_vertices()
        surf = trimesh.util.concatenate([surf] + parts)
    greenhouse = found.get("greenhouse") or glass.find_all(cal, grid, body.profiles, tune.get("glass"))
    cab = found.get("cabin")
    maps = hull.depth_maps(body, wheels)
    report = {"car": car, "calibration": {k: round(v, 4) for k, v in cal.report.items()}, "registration": registration,
              "wing": None if body.wing is None else {k: round(float(v), 4) for k, v in body.wing.items()
                                                       if k not in ("slices", "plate_top")}}
    blend = tune.get("blend", {})
    verts, norms, faces, uv, tex, mat = bake.bake(surf, cal, body, maps, size=texture, report=report,
                                                  power=blend.get("power", 4.0), agree=blend.get("agree", 30.0),
                                                  parts_from=n_body_faces,
                                                  hand_glass="replace" in tune.get("glass", {}))
    report["greenhouse"] = {k: round(v, 4) for k, v in greenhouse.items()}
    report["cabin_from_glass"] = None if cab is None else {
        "x": [round(v, 3) for v in cab["x"]],
        "roof_half_width": round(float(np.nanmedian(cab["z_in"])), 3),
        "glass_outer_half_width": round(float(np.nanmedian(cab["z_out"])), 3),
        "belt": round(float(np.nanmedian(cab["belt"])), 3)}

    rims = {"right": {}, "left": {}}
    by_axle = {w["name"].split("_")[1]: w for w in wheels}
    for w in wheels:
        side = "right" if w["side"] > 0 else "left"
        axle = w["name"].split("_")[1]
        src = w
        if w.get("covered"):  # skirted: borrow the other axle's rim drawing
            other = by_axle["front" if axle == "rear" else "rear"]
            src = other if not other.get("covered") else w
        if side == "right":
            rims[side][axle] = wh.rim_texture(cal.views["side"], src)
        elif "left" in cal.views:
            rims[side][axle] = wh.rim_texture(cal.views["left"], src)
        else:
            rims[side][axle] = wh.rim_texture(cal.views["side"], src)[:, ::-1].copy()
    glb = export.write(out / "model.glb", verts, norms, faces, uv, tex, wheels, rims, material_rgb=mat)

    # QA: silhouettes against every panel, overlays and shaded previews
    tyres = []
    for w in wheels:
        t = wh.tyre_mesh(w["r"], w["z_outer"] - w["z_inner"], segments=36)
        t.apply_translation([w["x"], w["y"], w["side"] * (w["z_outer"] + w["z_inner"]) / 2])
        tyres.append(t)
    ious = {}
    for name, v in cal.views.items():
        post, v.post = v.post, None  # the shape is judged against the sheet as drawn
        sil, ref = qa.match(v, [surf] + tyres)
        v.post = post
        ious[name] = round(qa.iou(sil, ref), 4)
        cv2.imwrite(str(qadir / f"silhouette-{name}.png"), qa.overlay(ref, sil))
    # the textured model with each sheet view's own camera, beside the reference: what to tune against
    tiles, view_scores = [], {}
    for name, v in cal.views.items():
        rgb, cover = qa.render_view(v, verts, faces, uv, tex, [(t, (35, 35, 38)) for t in tyres])
        tyre_px = qa.render_view.last_extras
        m_rgb, _ = qa.render_view(v, verts, faces, uv, mat, [(t, (255, 255, 255)) for t in tyres])
        skip = cover & (m_rgb[..., 1] < 50)  # glass and (below) tyres: not compared on colour
        if tyre_px is not None:
            skip |= tyre_px
        img, sc = qa.compare_view(v, rgb, cover, glass=skip)
        view_scores[name] = sc
        cv2.imwrite(str(qadir / f"compare-{name}.jpg"), img, [cv2.IMWRITE_JPEG_QUALITY, 88])
    report["view_match"] = view_scores
    write_review_crops(car, cal)
    cols = [(205, 205, 205)] + [(60, 60, 60)] * len(tyres)
    shots = [qa.shaded([surf] + tyres, y, p, colours=cols) for y, p in ((0, 0.15), (0.7, 0.3), (-0.8, 0.25), (2.6, 0.3))]
    cv2.imwrite(str(qadir / "shape.jpg"), np.vstack([np.hstack(shots[:2]), np.hstack(shots[2:])]))
    cv2.imwrite(str(qadir / "texture.jpg"), cv2.cvtColor(tex, cv2.COLOR_RGB2BGR)[::2, ::2])
    sheet_rgb = sheet.read_canonical(paths.sheet(car), panels)
    cv2.imwrite(str(qadir / "panels.jpg"), sheet.debug_image(panels, sheet_rgb))
    cv2.imwrite(str(qadir / "glass.jpg"), glass.debug_image(cal, sheet_rgb))

    checks = {f"{k}_iou>={g}": ious[k] >= g for k, g in GATES.items() if k in ious}
    checks["every_view_paints_the_texture"] = all(v > 0.02 for k, v in report["texture_share"].items()
                                                  if k in ("side", "top", "front", "rear"))
    checks["body_outward"] = bool(surf.volume > 0)
    report.update({
        "checks": checks,
        "passed": all(checks.values()),
        "model": "model.glb",
        "frame": "nose +x, up +y, right side +z, ground y=0, length 4.0",
        "dimensions": {"length": cal.L, "height": round(cal.H, 4), "width": round(cal.W, 4)},
        "wheels": [{k: (round(v, 4) if isinstance(v, float) else v) for k, v in w.items()} for w in wheels],
        "views": sorted(cal.views),
        "silhouette_iou": ious,
        "glb": glb,
        "seconds": round(time.time() - t0, 1),
    })
    (out / "model.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


# A generated mesh is fitted to the sheet per axis, not built from its silhouettes, so it is held to
# looser gates (the Skyline's Tripo P2 multiview mesh: side .95, top .92, left .92, front .93, rear .94).
GATES_GENERATED = {"side": 0.93, "top": 0.90, "left": 0.90, "front": 0.80, "rear": 0.80}


def proportions(cal, meshes: list) -> dict:
    """The model's body size against the drawings' (model / sheet, 1.0 = same): length and height from
    the side view, width from the top. Thin parts (wing plate, mirrors) don't count. A generated mesh
    is only as wide as the fit makes it - Tripo never sees the top."""
    (sw, sh), (qw, qh) = (qa.extent(m) for m in qa.match(cal.views["side"], meshes))
    (_, th), (_, rh) = (qa.extent(m) for m in qa.match(cal.views["top"], meshes))
    return {"length": round(sw / qw, 3), "width": round(th / rh, 3), "height": round(sh / qh, 3)}


def promote_model(car: str, src: str | None = None) -> dict:
    """Make a repainted generated mesh (default snapshots/tripo-multiview-guided.glb) the car's
    model.glb, with a model.json in the scripts' format (dimensions, silhouette IoU per view, checks),
    so the app, the landing fit and the inspect page treat it like any other model. The scripts' own
    build is kept as snapshots/scripted.glb; `ripcars model <car> --force` brings it back."""
    out = paths.asset_dir(car)
    src_path = out / (src or "snapshots/tripo-multiview-guided.glb")
    if not src_path.is_file():
        raise FileNotFoundError(f"{src_path.relative_to(out)} missing: run tripo, clean and rebake first")
    old = json.loads((out / "model.json").read_text()) if (out / "model.json").is_file() else {}
    if (out / "model.glb").is_file() and not old.get("source"):
        snaps = out / "snapshots"
        snaps.mkdir(exist_ok=True)
        shutil.copyfile(out / "model.glb", snaps / "scripted.glb")
        (snaps / "scripted.json").write_text(json.dumps(old, indent=2) + "\n")
    shutil.copyfile(src_path, out / "model.glb")
    mesh_ = trimesh.load(out / "model.glb", force="mesh", process=False)
    n_tris = len(mesh_.faces)
    mesh_.merge_vertices()
    panels = sheet.load(paths.sheet(car), cache_dir=paths.cache_dir(car), layout=_layout(car))
    cal = views.calibrate(panels)
    qadir = paths.qa_dir(car)
    ious = {}
    for name, v in cal.views.items():
        sil, ref = qa.match(v, [mesh_])
        sil = qa.solid(sil, ref)  # open side windows don't count
        ious[name] = round(qa.iou(sil, ref), 4)
        cv2.imwrite(str(qadir / f"silhouette-{name}.png"), qa.overlay(ref, sil))
    size = proportions(cal, [mesh_])
    made = src_path.with_suffix(".json")
    made = json.loads(made.read_text()) if made.is_file() else {}
    checks = {f"{k}_iou>={g}": ious[k] >= g for k, g in GATES_GENERATED.items() if k in ious}
    checks.update({f"{k}_within_5%_of_sheet": abs(r - 1) <= 0.05 for k, r in size.items()})
    V = mesh_.vertices
    report = {
        "car": car,
        "source": str(src_path.relative_to(out)),
        "made_from": made.get("source"),
        "sheet_fit": made.get("fit"),
        "glass_source": made.get("glass_source"),
        "checks": checks,
        "passed": all(checks.values()),
        "model": "model.glb",
        "frame": "nose +x, up +y, right side +z, ground y=0, length 4.0",
        "dimensions": {"length": round(float(np.ptp(V[:, 0])), 4), "height": round(float(V[:, 1].max()), 4),
                       "width": round(float(np.ptp(V[:, 2])), 4)},
        "wheels": made.get("wheels", []),  # found in the generated mesh and exported as spinning pivots (rebake)
        "wing": None,
        "cabin_from_glass": None,
        "views": sorted(cal.views),
        "silhouette_iou": ious,
        "proportions_vs_sheet": size,
        "glb": {"bytes": (out / "model.glb").stat().st_size, "triangles": int(n_tris)},
    }
    (out / "model.json").write_text(json.dumps(report, indent=2) + "\n")
    return report


def status(only: list[str] | None = None) -> list[dict]:
    """Every car in the reference library and/or the assets folder: how far it got, and what's next."""
    ids = sorted({p.parent.name for p in paths.REFERENCES.glob("*/manifest.json")} |
                 {d.name for d in paths.ASSETS.iterdir() if d.is_dir()})
    rows = []
    for car in ids:
        if only and car not in only:
            continue
        a = paths.ASSETS / car
        load = lambda f: json.loads((a / f).read_text()) if (a / f).is_file() else None
        man = json.loads(paths.manifest(car).read_text()) if paths.manifest(car).is_file() else {}
        hints, model, landing = load("hints.json") or {}, load("model.json"), load("alignment.json")
        snap = lambda n: (a / "snapshots" / n).is_file()
        row = {
            "car": car,
            "sheet": "accepted" if man.get("selected") and paths.accepted_sheet(car).is_file() else
                     ("draft*" if paths.draft_sheet(car) else ("draft" if man else "-")),
            "hints": "yes" if (a / "hints.json").is_file() and (a / "meta.json").is_file() else "-",
            "tripo": ("multiview" if (a / "tripo/multiview/model_url.fbx").is_file() else "") or
                     ("dry run" if any((a / "tripo").glob("*/request.json")) else "-"),
            "clean": "yes" if snap("tripo-multiview-clean.glb") else "-",
            "rebake": "yes" if snap("tripo-multiview-guided.glb") else "-",
            "glass": "+".join(sorted({"sheet" if g == "sheet" else "traced" for g in
                                      (hints.get("model", {}).get("rebake", {}).get("glass") or {}).values()})) or "auto",
            "model": "-" if not model else ("tripo" if model.get("source") else "scripts"),
            "checks": "-" if not model else ("pass" if model.get("passed") else "FAIL"),
            "landing": f"{landing['iou']:.3f}" if landing else "-",
        }
        if row["sheet"] not in ("accepted", "draft*"):  # draft*: a draft approved for this car in hints.json "sheet"
            nxt = "reference-collector: sheet not accepted yet"
        elif row["hints"] == "-":
            nxt = "add hints.json + meta.json (retouch-car skill, step 1)"
        elif row["tripo"] in ("-", "dry run"):
            nxt = "tripo (dry run), get approval, then --send"
        elif row["clean"] == "-":
            nxt = "clean"
        elif row["rebake"] == "-":
            nxt = "rebake"
        elif row["model"] != "tripo":
            nxt = "review the rebake (trace glass if needed), then promote"
        elif row["landing"] == "-":
            nxt = "align"
        else:
            nxt = "review" if row["checks"] == "pass" else "review failed checks (notes)"
        row["next"] = nxt
        rows.append(row)
    return rows


def write_index():
    """assets/cars/index.json: every car the app can show, for the inspect page."""
    cars = []
    for d in sorted(paths.ASSETS.iterdir()):
        if not (d / "meta.json").is_file():
            continue
        meta = json.loads((d / "meta.json").read_text())
        model = json.loads((d / "model.json").read_text()) if (d / "model.json").is_file() else None
        snaps = sorted({f.stem for f in (d / "snapshots").glob("*") if f.suffix in (".glb", ".fbx")}) if (d / "snapshots").is_dir() else []
        cars.append({"id": d.name, "make": meta.get("make"), "model": meta.get("model"), "year": meta.get("year"),
                     "rarity": meta.get("rarity"), "modelled": (d / "model.glb").is_file(),
                     "passed": model.get("passed") if model else None, "versions": snaps,
                     "source": model.get("source") if model else None})
    (paths.ASSETS / "index.json").write_text(json.dumps({"cars": cars}, indent=2) + "\n")


def main(argv=None):
    ap = argparse.ArgumentParser(prog="ripcars")
    ap.add_argument("command", choices=["extract", "model", "align", "build", "status", "tripo", "clean", "rebake", "promote", "outline"])
    ap.add_argument("--view", choices=["side", "left", "top", "front", "rear"], help="outline: which sheet view")
    ap.add_argument("--dark", type=int, default=110, help="outline: brightest channel below this counts as window paint")
    ap.add_argument("--src", help="rebake/promote: mesh, relative to the car folder")
    ap.add_argument("--mode", choices=["multiview"], default="multiview", help="tripo/clean: input mode")
    ap.add_argument("--force", action="store_true", help="model/build: rebuild from the scripts even if a generated mesh was "
                    "promoted; tripo --send: send again although a result exists")
    ap.add_argument("--sheet", help="tripo multiview: five-view sheet (default the selected or latest draft)")
    ap.add_argument("--send", action="store_true", help="tripo: actually call the API (spends credits)")
    ap.add_argument("cars", nargs="*", help="car ids, or 'all'")
    ap.add_argument("--faces", type=int, default=None, help="body triangle budget (default 12000)")
    ap.add_argument("--texture", type=int, default=None, help="body texture size in px (default 1536)")
    args = ap.parse_args(argv)
    if args.command == "status":
        rows = status(args.cars or None)
        cols = list(rows[0]) if rows else []
        width = {c: max(len(c), *(len(str(r[c])) for r in rows)) for c in cols}
        for r in [dict(zip(cols, cols))] + rows:
            print("  ".join(str(r[c]).ljust(width[c]) for c in cols))
        return 0
    if not args.cars:
        ap.error("name the cars (or 'all')")
    cars = paths.cars() if args.cars == ["all"] else args.cars
    failed = []
    for car in cars:
        try:
            if args.command == "rebake":
                from . import rebake

                r = rebake.rebake(car, args.src)
                print(f"{car}: rebaked {r['source']} - fit {r['fit']}, {r['glb']}, glass {r['glass_source']}")
                print(f"{car}: wheels - {r['wheels_note']}")
                continue
            if args.command == "outline":
                from . import trace

                panels = sheet.load(paths.sheet(car), cache_dir=paths.cache_dir(car), layout=_layout(car))
                v = views.calibrate(panels).views[args.view or "top"]
                ox, oy = v.panel.origin
                x0, y0, x1, y1 = trace.window_region(v, v.panel.glass) or v.panel.bbox  # around the drawing's windows
                img = cv2.cvtColor(cv2.imread(str(paths.qa_dir(car) / "tripo-sheet.png")), cv2.COLOR_BGR2RGB)
                found = trace.dark_outlines(img, (ox + x0, oy + y0, ox + x1, oy + y1), args.dark)
                print(json.dumps(found[:6], indent=None))
                continue
            if args.command == "promote":
                if not (paths.asset_dir(car) / "extract.json").is_file():  # the landing fit needs the pack-photo cut-out
                    extract.run(car)
                r = promote_model(car, args.src)
                print(f"{car}: model.glb <- {r['source']}, {r['glb']['triangles']} tris, "
                      f"{r['glb']['bytes'] / 1e6:.2f} MB, IoU {r['silhouette_iou']}, "
                      f"size vs sheet {r['proportions_vs_sheet']}")
                for name, ok in r["checks"].items():
                    if not ok:
                        print(f"  WARN {car}: check failed: {name} - review qa/{car}/silhouette-*.png", file=sys.stderr)
                a = align.fit(car)
                print(f"{car}: landing pose pitch {a['pitch_deg']:.1f} yaw {a['yaw_deg']:.1f} roll {a['roll_deg']:.1f} deg, "
                      f"stretch {a['stretch']:.3f}, IoU {a['iou']}")
                continue
            if args.command == "clean":
                import subprocess

                blender = os.environ.get("BLENDER", "/Applications/Blender.app/Contents/MacOS/Blender")
                d = paths.asset_dir(car)
                src = d / "tripo" / args.mode / "model_url.fbx"
                dst = d / "snapshots" / f"tripo-{args.mode}-clean.glb"
                dst.parent.mkdir(exist_ok=True)
                rep = d / "tripo" / args.mode / "clean.json"
                script = str(Path(__file__).with_name("blender_clean.py"))
                subprocess.run([blender, "-b", "--python", script, "--", str(src), str(dst), str(rep), "1024"],
                               check=True, capture_output=True)
                # Tripo's multiview takes no top view and gets the width wrong: rescale to the sheet's side+top
                from . import rebake

                panels = sheet.load(paths.sheet(car), cache_dir=paths.cache_dir(car), layout=_layout(car))
                first = trimesh.load(dst, force="mesh", process=False)
                adjust = json.loads((d / "hints.json").read_text()).get("model", {}).get("fit") if (d / "hints.json").is_file() else None
                _, fitted = rebake.fit(np.asarray(first.vertices, float), np.asarray(first.faces), views.calibrate(panels), adjust)
                f = fitted["scale_xyz"] + fitted["offset_xy"]
                subprocess.run([blender, "-b", "--python", script, "--", str(src), str(dst), str(rep), "1024", "0", "0",
                                ",".join(str(v) for v in f)], check=True, capture_output=True)
                r = json.loads(rep.read_text())
                print(f"{car}: {r['before']['triangles']} -> {r['after']['triangles']} triangles, "
                      f"{src.stat().st_size / 1e6:.2f} MB FBX -> {dst.stat().st_size / 1e6:.2f} MB GLB, "
                      f"fitted to the sheet {fitted}: {dst}")
                cleaned = trimesh.load(dst, force="mesh", process=False)
                cleaned.merge_vertices()
                size = proportions(views.calibrate(panels), [cleaned])
                print(f"{car}: size vs sheet {size}")
                for k, ratio in size.items():
                    if abs(ratio - 1) > 0.05:
                        print(f"  WARN {car}: {k} is {ratio:.2f}x the sheet's - check qa/{car}/silhouette-*.png after "
                              f"promote; hints.json model.fit {{\"{k}\": {1 / ratio:.3f}}} rescales it", file=sys.stderr)
                continue
            if args.command == "tripo":
                from . import tripo

                done = paths.asset_dir(car) / "tripo" / args.mode / "model_url.fbx"
                if args.send and done.is_file() and not args.force:  # a paid result exists: never re-buy it by accident
                    print(f"{car}: skipped - tripo/{args.mode}/model_url.fbx exists (--force sends again, spending credits)")
                    continue
                plan = tripo.prepare(car, sheet_path=args.sheet)
                if not args.send:
                    print(json.dumps(plan, indent=2))
                    print("dry run - nothing sent. Add --send to submit (spends Tripo credits).")
                else:
                    print(f"{car}: {tripo.send(plan)}")
                continue
            if args.command in ("extract", "build"):
                r = extract.run(car)
                print(f"{car}: extracted, car box {r['bbox']}, {len(r['wheels'])} wheels")
            promoted = (paths.ASSETS / car / "model.json").is_file() and \
                json.loads((paths.ASSETS / car / "model.json").read_text()).get("source")
            if args.command in ("model", "build") and promoted and not args.force:
                print(f"{car}: model.glb is the promoted {promoted} - not rebuilt from the scripts (--force does)")
            elif args.command in ("model", "build"):
                r = build_model(car, args.faces, args.texture)
                print(f"{car}: {r['glb']['triangles']} tris, {r['glb']['bytes'] / 1e6:.2f} MB, IoU {r['silhouette_iou']}, {r['seconds']}s")
                for name, ok in r["checks"].items():
                    if not ok:
                        print(f"  WARN {car}: check failed: {name} - review qa/{car}/", file=sys.stderr)
            if args.command in ("align", "build"):
                r = align.fit(car)
                print(f"{car}: landing pose pitch {r['pitch_deg']:.1f} yaw {r['yaw_deg']:.1f} roll {r['roll_deg']:.1f} deg, "
                      f"stretch {r['stretch']:.3f}, IoU {r['iou']}")
        except Exception as e:  # keep going so one bad sheet doesn't block the others
            failed.append(car)
            print(f"{car}: FAILED {type(e).__name__}: {e}", file=sys.stderr)
    write_index()
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
