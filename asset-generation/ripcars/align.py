"""Fit the 3D car onto its pack photo: the pose the reveal lands in.

The blister photo sees the car from a little above and not quite square. Search an orthographic pose
- pitch (camera elevation), yaw, roll (photo tilt), scale, position and a small lengthwise stretch
(the generated sheet's proportions differ a few % from the real toy) - whose silhouette best overlaps
the car mask that extract.py cut out of the photo (IoU, coarse to fine, with a prior that keeps the
camera plausible: pack shots are side-on, from level to a little above).

Photo pixel of model point p:  u = tx + s * (R S p).x,  v = ty - s * (R S p).y,
R = Rz(roll) Rx(pitch) Ry(yaw),  S = diag(stretch, 1, 1).
"""
import json

import cv2
import numpy as np
import trimesh
from PIL import Image
from scipy.optimize import minimize

from . import paths, qa


def rotation(pitch: float, yaw: float, roll: float) -> np.ndarray:
    cy, sy = np.cos(yaw), np.sin(yaw)
    cp, sp = np.cos(pitch), np.sin(pitch)
    cr, sr = np.cos(roll), np.sin(roll)
    ry = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])  # +pitch tips the roof towards the camera (+z)
    rz = np.array([[cr, -sr, 0], [sr, cr, 0], [0, 0, 1]])
    return rz @ rx @ ry


def quaternion(m: np.ndarray) -> list[float]:
    q = trimesh.transformations.quaternion_from_matrix(np.vstack([np.hstack([m, [[0], [0], [0]]]), [0, 0, 0, 1]]))
    return [float(q[1]), float(q[2]), float(q[3]), float(q[0])]  # three.js order: x, y, z, w


def _proxy(car: str, faces: int = 1600) -> trimesh.Trimesh:
    """All of the car's GLB geometry (body + tyres, in the model frame), decimated for fast rasterising."""
    scene = trimesh.load(paths.asset_dir(car) / "model.glb", force="scene")
    mesh = scene.to_geometry() if hasattr(scene, "to_geometry") else scene.dump(concatenate=True)
    # glTF is y-up like our frame; trimesh keeps the node transforms
    # Flat-shaded parts (the wing) are stored with unshared vertices; merge them first, or the
    # simplifier sees thousands of loose triangles and collapses them away.
    mesh.merge_vertices(merge_tex=True, merge_norm=True)
    if len(mesh.faces) > faces:
        import fast_simplification

        v, f = fast_simplification.simplify(mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), target_count=faces)
        mesh = trimesh.Trimesh(v, f, process=False)
    return mesh


def _raster(verts2d: np.ndarray, faces: np.ndarray, shape) -> np.ndarray:
    """Silhouette: every triangle filled on its own (one fillPoly over all of them would cancel
    overlaps with its even-odd rule; culling back faces would punch holes where a decimated or open
    mesh has flipped triangles)."""
    out = np.zeros(shape, np.uint8)
    pts = np.round(verts2d[faces] * 16).astype(np.int32)
    for t in pts:
        cv2.fillConvexPoly(out, t, 1, lineType=cv2.LINE_8, shift=4)
    return out.astype(bool)


def fit(car: str) -> dict:
    out = paths.asset_dir(car)
    ex = json.loads((out / "extract.json").read_text())
    m = ex["mask"]
    target_full = np.asarray(Image.open(out / m["src"]).convert("L")) > 127  # crop of the photo
    mesh = _proxy(car)
    V, F = mesh.vertices, mesh.faces

    def render(params, scale_down, shape):
        pitch, yaw, roll, s, tx, ty, sx = params
        p = (V * np.array([sx, 1.0, 1.0])) @ rotation(pitch, yaw, roll).T
        u = (tx + s * p[:, 0] - m["x"]) / scale_down
        v = (ty - s * p[:, 1] - m["y"]) / scale_down
        return _raster(np.stack([u, v], 1), F, shape)

    def prior(params):
        pitch, yaw, _, _, _, _, sx = params
        pd, yd = np.degrees(pitch), np.degrees(yaw)
        return 0.004 * ((yd / 6) ** 2 + (max(0.0, -pd) / 2) ** 2 + (max(0.0, pd - 18) / 2) ** 2 + ((sx - 1) / 0.06) ** 2)

    def loss(params, target, scale_down):
        params = np.array(params)
        for i in locked:
            params[i] = x0[i]
        sil = qa.solid(render(params, scale_down, target.shape), target)
        inter = (sil & target).sum()
        return 1.0 - inter / max(1, (sil | target).sum()) + prior(params)

    # initial guess: length and centre from the mask's box, ground line from the tyres, slight elevation
    bx, by, bw, bh = ex["bbox"]
    L = float(np.ptp(V[:, 0]))
    s0 = bw / L
    x_mid = (V[:, 0].max() + V[:, 0].min()) / 2
    wheels = ex["wheels"]
    roll0 = -np.arctan2(wheels[-1]["cy"] - wheels[0]["cy"], wheels[-1]["cx"] - wheels[0]["cx"]) if len(wheels) >= 2 else 0.0
    x0 = np.array([np.radians(10), 0.0, roll0, s0, bx + bw / 2 - s0 * x_mid, ex["groundY"], 1.0])
    # hints.json "landing": seed (or with "lock": true, fix) the camera angles and stretch by hand
    hints = json.loads((out / "hints.json").read_text()) if (out / "hints.json").is_file() else {}
    land = hints.get("landing", {})
    seeded = {i: v for i, v in ((0, land.get("pitch_deg")), (1, land.get("yaw_deg")), (2, land.get("roll_deg"))) if v is not None}
    for i, v in seeded.items():
        x0[i] = np.radians(v)
    if land.get("stretch") is not None:
        x0[6] = land["stretch"]
        seeded[6] = land["stretch"]
    locked = set(seeded) if land.get("lock") else set()

    # coarse-to-fine; the coarsest level tries a few elevations/yaws so it can't settle in a bad basin
    best_x = x0
    for k, sd in enumerate((8, 4, 2)):
        h, w = target_full.shape
        target = cv2.resize(target_full.astype(np.uint8) * 255, (int(np.ceil(w / sd)), int(np.ceil(h / sd))),
                            interpolation=cv2.INTER_AREA) > 127
        if k == 0 and not seeded:
            starts = [x0 + np.array([np.radians(dp), np.radians(dy), 0, 0, 0, 0, 0]) for dp in (-6, 0, 6) for dy in (-6, 0, 6)]
        elif k == 0:
            starts = [x0]
        else:
            starts = [best_x]
        step = np.array([np.radians(3), np.radians(3), np.radians(1), s0 * 0.02, bw * 0.01, bh * 0.02, 0.02]) / (k + 1)
        best_f = np.inf
        for st in starts:
            init = np.vstack([st] + [st + np.eye(7)[i] * step[i] for i in range(7)])
            r = minimize(loss, st, args=(target, sd), method="Nelder-Mead",
                         options={"initial_simplex": init, "maxfev": 900, "xatol": 1e-4, "fatol": 1e-5})
            if r.fun < best_f:
                best_x, best_f = r.x, r.fun

    for i in locked:
        best_x[i] = x0[i]
    pitch, yaw, roll, s, tx, ty, sx = best_x
    R = rotation(pitch, yaw, roll)
    sil = qa.solid(render(best_x, 1, target_full.shape), target_full)
    iou = float((sil & target_full).sum() / max(1, (sil | target_full).sum()))
    over = np.zeros(target_full.shape + (3,), np.uint8)
    over[sil & target_full] = (235, 235, 235)
    over[target_full & ~sil] = (40, 40, 255)
    over[sil & ~target_full] = (255, 220, 0)
    cv2.imwrite(str(paths.qa_dir(car) / "pack-fit.png"), over)
    result = {
        "photo": ex["photo"],
        "projection": "orthographic: u = tx + scale * (R S p).x, v = ty - scale * (R S p).y, S = diag(stretch, 1, 1) (photo px, v down)",
        "scale": float(s),
        "tx": float(tx),
        "ty": float(ty),
        "pitch_deg": float(np.degrees(pitch)),
        "yaw_deg": float(np.degrees(yaw)),
        "roll_deg": float(np.degrees(roll)),
        "quaternion": quaternion(R),
        "stretch": float(sx),
        "iou": round(iou, 4),
    }
    (out / "alignment.json").write_text(json.dumps(result, indent=2) + "\n")
    return result
