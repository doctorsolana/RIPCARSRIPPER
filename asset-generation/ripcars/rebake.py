"""Repaint a generated mesh (e.g. Tripo) from the car's ChatGPT reference sheet, aligned to the mesh.

    uv run --locked python -m ripcars rebake <car> [--src snapshots/tripo-multiview-clean.glb]

The sheet's drawings never sit exactly on another tool's geometry: windows, panel ends and decals land a
little off, and where the mesh has parts the drawing shows as background, white bleeds in. Tripo's own
texture, though, is consistent with its geometry (it made both). So:
  1. render the mesh with its own texture through every sheet view's camera (render.py, exact z-buffer)
  2. per view, a dense alignment (optical flow) from that render to the drawing - kept only where both
     have clear structure and agree once aligned, smoothed outward from there, capped per view, and
     dropped entirely if it doesn't improve the match (the top view: Tripo never saw one)
  3. paint into the mesh's own UV layout (its normal/roughness maps stay valid) from the aligned
     drawings, weighted by how squarely each view sees the surface; wherever the drawing disagrees with
     the generated paint after blurring both (background, a painted-in reflection), the generated paint
     is kept - so edges and view hand-overs fall back to its seamless colours
  4. windows: from the sheet's glass masks (aligned the same way). The mesh's interior (seats, cage) is
     painted through the glass from what the drawings show behind it, and the glass becomes see-through
     in the app (glass texels marked in the roughness map, as for the scripts' own models)
  5. wheels: the generator builds each from separate pieces (parts.py); each becomes a `wheel_*` pivot
     at its hub, like the scripts' wheels, so the reveal spins them
-> snapshots/<name>-guided.glb (+ .json report); review images in qa/<car>/: align-<view>.jpg, wheels.jpg, and from
trace.py tripo-sheet.png, tripo-clay.png, trace-<view>.png (trace windows on these) and glass-map.jpg
"""
import json

import cv2
import numpy as np
import trimesh
from PIL import Image
from scipy import ndimage
from scipy.optimize import minimize

from . import bake, glass, hull, parts, paths, qa, render, sheet, trace, views
from . import wheels as wh

GLASS_TINT = np.array([26, 32, 40], np.float32)
GLASS_PLAIN = np.array([58, 64, 72], np.float32)  # glass the drawings don't show squarely
GLASS_DARK = np.array([9, 10, 13], np.float32)  # super-tinted glass (model.rebake.tinted)
# Glass is roughness < 0.2 in the material map (the app's test); super-tinted glass sits at TINT_ROUGH, clear at
# 0.06 - the app reads > 0.095 as super tinted (well clear of JPEG noise on either side)
TINT_ROUGH = 0.13
MAX_SHIFT = {"side": 0.03, "left": 0.03, "top": 0.03, "front": 0.07, "rear": 0.07}  # of the panel's width


# ---- the mesh ---------------------------------------------------------------------------------------

class Textured:
    """A generated mesh with its own UVs and maps, plus outward normals for baking."""

    def __init__(self, path):
        m = trimesh.load(path, force="mesh", process=False)
        self.trimesh = m
        self.V = np.asarray(m.vertices, np.float64)
        self.F = np.asarray(m.faces, np.int64)
        uv = np.asarray(m.visual.uv, np.float64).copy()
        uv[:, 1] = 1.0 - uv[:, 1]  # glTF/top-left convention for image lookups
        self.uv = uv
        mat = m.visual.material
        self.base = np.asarray(mat.baseColorTexture.convert("RGB"))
        self.mr = np.asarray(mat.metallicRoughnessTexture.convert("RGB")) if getattr(mat, "metallicRoughnessTexture", None) else None
        self.normals_face, self.normals_vert = self._outward_normals()

    def _outward_normals(self):
        """Face/vertex normals made consistent and outward. Generated meshes split vertices at UV seams
        and wind some faces inside-out: merge by position, let trimesh fix the winding, read it back."""
        V, F = self.V, self.F
        key = np.round(V / (np.ptp(V, axis=0).max() * 1e-6)).astype(np.int64)
        _, first, inv = np.unique(key, axis=0, return_index=True, return_inverse=True)
        inv = inv.ravel()
        self._merge = (first, inv)
        merged = trimesh.Trimesh(V[first], inv[F], process=False)
        before = merged.face_normals.copy()
        merged.fix_normals(multibody=True)
        fn = merged.face_normals
        if len(fn) != len(F):  # degenerate faces dropped: fall back to raw normals
            fn = before
        return fn, self._vertex_normals(fn)

    def _vertex_normals(self, fn: np.ndarray) -> np.ndarray:
        """Area-weighted, across UV seams (vertices merged by position)."""
        first, inv = self._merge
        tri = self.V[self.F]
        area = 0.5 * np.linalg.norm(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]), axis=1)[:, None]
        acc = np.zeros((len(first), 3))
        for k in range(3):
            np.add.at(acc, inv[self.F][:, k], fn * area)
        vn = acc[inv]
        return vn / np.maximum(np.linalg.norm(vn, axis=1, keepdims=True), 1e-12)

    def orient(self, cal, rasters: dict) -> int:
        """Face the cameras. Whatever a sheet view sees front-most is on the outside, so it must face that
        view: flip the faces the views see from behind (winding repair can't settle every inside-out
        patch of a generated mesh - the Roxy's roof shell came out 76% inverted), and recompute the
        normals for the fitted shape. Returns how many faces were flipped."""
        tri = self.V[self.F]
        fn = np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0])
        fn /= np.maximum(np.linalg.norm(fn, axis=1, keepdims=True), 1e-12)
        fn *= np.where(np.sum(fn * self.normals_face, axis=1, keepdims=True) < 0, -1.0, 1.0)  # winding repair's choice
        votes = np.zeros(len(self.F))
        for name, r in rasters.items():
            seen = np.bincount(r.face[r.cover], minlength=len(self.F))
            votes += seen * (fn @ cal.views[name].direction)  # edge-on faces barely count
        flip = votes < 0
        fn[flip] *= -1
        self.normals_face, self.normals_vert = fn, self._vertex_normals(fn)
        return int(flip.sum())


def fit(V: np.ndarray, F: np.ndarray, cal, adjust: dict | None = None) -> tuple[np.ndarray, dict]:
    """Per-axis scale + offset so the mesh's side and top silhouettes match the sheet's. `adjust`
    (hints.json model.fit, e.g. {"width": 0.97}) scales the result further by hand, per axis."""
    side, top = cal.views["side"], cal.views["top"]
    lo, hi = V.min(0), V.max(0)
    s0 = cal.L / (hi[0] - lo[0])
    base = (V - [(lo[0] + hi[0]) / 2, lo[1], (lo[2] + hi[2]) / 2]) * s0
    probe = trimesh.Trimesh(base, F, process=False)
    probe.merge_vertices()
    if len(probe.faces) > 6000:
        import fast_simplification

        v, f = fast_simplification.simplify(probe.vertices.astype(np.float32), probe.faces.astype(np.int32), target_count=6000)
        probe = trimesh.Trimesh(v, f, process=False)

    def loss(p):
        sx, sy, sz, tx, ty = p
        m = trimesh.Trimesh(probe.vertices * [sx, sy, sz] + [tx, ty, 0], probe.faces, process=False)
        return -(qa.iou(*qa.match(side, [m])) + qa.iou(*qa.match(top, [m])))

    x0 = np.array([1.0, 1.0, 1.0, 0.0, 0.0])
    init = np.vstack([x0] + [x0 + np.eye(5)[i] * d for i, d in enumerate((0.03, 0.03, 0.03, 0.02, 0.01))])
    r = minimize(loss, x0, method="Nelder-Mead", options={"initial_simplex": init, "maxfev": 160, "xatol": 1e-3, "fatol": 1e-4})
    sx, sy, sz, tx, ty = r.x
    adjust = adjust or {}
    sx, sy, sz = sx * adjust.get("length", 1.0), sy * adjust.get("height", 1.0), sz * adjust.get("width", 1.0)
    return base * [sx, sy, sz] + [tx, ty, 0], {
        "scale_xyz": [round(float(v), 4) for v in (sx, sy, sz)], "offset_xy": [round(float(v), 4) for v in (tx, ty)],
        "side+top_iou": round(-float(r.fun), 4), **({"by_hand": adjust} if adjust else {})}


# ---- alignment --------------------------------------------------------------------------------------

def _structure(rgb: np.ndarray, mask: np.ndarray, sigma: float = 6) -> tuple[np.ndarray, np.ndarray]:
    """Locally normalised grey image (lighting-insensitive) and local contrast."""
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    mu = cv2.GaussianBlur(g, (0, 0), sigma)
    sd = np.sqrt(np.maximum(cv2.GaussianBlur((g - mu) ** 2, (0, 0), sigma), 0))
    n = np.clip((g - mu) / (sd + 6), -3, 3) * 40 + 128
    n[~mask] = 128
    return n.astype(np.uint8), sd


def _ncc(a: np.ndarray, b: np.ndarray, sigma: float = 7) -> np.ndarray:
    a, b = a.astype(np.float32), b.astype(np.float32)
    ma, mb = cv2.GaussianBlur(a, (0, 0), sigma), cv2.GaussianBlur(b, (0, 0), sigma)
    va = cv2.GaussianBlur(a * a, (0, 0), sigma) - ma * ma
    vb = cv2.GaussianBlur(b * b, (0, 0), sigma) - mb * mb
    cov = cv2.GaussianBlur(a * b, (0, 0), sigma) - ma * mb
    return cov / np.sqrt(np.maximum(va, 1e-3) * np.maximum(vb, 1e-3))


def align(view, rendered: np.ndarray, cover: np.ndarray) -> tuple[np.ndarray | None, dict]:
    """Flow field (h, w, 2) taking render pixels to where the same content is in the drawing, or None."""
    S = view.panel.rgb
    Rn, r_sd = _structure(rendered, cover)
    Sn, _ = _structure(S, view.panel.mask)
    dis = cv2.DISOpticalFlow.create(cv2.DISOPTICAL_FLOW_PRESET_MEDIUM)
    raw = dis.calc(Rn, Sn, None)
    h, w = cover.shape
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    warp = lambda img, f: cv2.remap(img, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderValue=128)

    # confidence: both images have structure here, and they agree once aligned
    conf = np.clip(_ncc(Rn, warp(Sn, raw)), 0, 1) ** 2 * np.clip((r_sd - 4) / 12, 0, 1) * cover
    sig = 0.03 * np.hypot(h, w)
    num = np.stack([cv2.GaussianBlur(raw[..., c] * conf, (0, 0), sig) for c in range(2)], -1)
    den = cv2.GaussianBlur(conf, (0, 0), sig)[..., None]
    flow = np.where(den > 1e-3, num / np.maximum(den, 1e-6), 0).astype(np.float32)
    cap = MAX_SHIFT.get(view.name, 0.04) * w
    mag = np.hypot(flow[..., 0], flow[..., 1])[..., None]
    flow = np.where(mag > cap, flow * cap / np.maximum(mag, 1e-6), flow)

    # keep it only if it measurably improves the match where there is structure
    wgt = np.clip((r_sd - 4) / 12, 0, 1) * cover
    before = float((_ncc(Rn, Sn) * wgt).sum() / max(wgt.sum(), 1))
    after = float((_ncc(Rn, warp(Sn, flow)) * wgt).sum() / max(wgt.sum(), 1))
    used = after > before + 0.02
    m = np.hypot(flow[..., 0], flow[..., 1])[cover]
    return (flow if used else None), {"used": used, "match": [round(before, 3), round(after, 3)],
                                      "shift_px_median": round(float(np.median(m)), 1) if m.size else 0}


# ---- visibility -------------------------------------------------------------------------------------

def depth_maps(P: np.ndarray, grid) -> dict:
    """First-hit coordinate along each axis per grid cell from surface samples P (+ a 3x3 dilation so
    gaps between samples don't read as holes)."""
    g = grid

    def idx(coords, vals):
        return np.clip(np.round((vals - coords[0]) / g.h).astype(int), 0, len(coords) - 1)

    ix, iy, iz = idx(g.xs, P[:, 0]), idx(g.ys, P[:, 1]), idx(g.zs, P[:, 2])
    nx, ny, nz = g.shape

    def reduce(a, b, val, shape, fn):
        out = np.full(shape, -np.inf if fn == "max" else np.inf)
        (np.maximum if fn == "max" else np.minimum).at(out.ravel(), a * shape[1] + b, val)
        return ndimage.grey_dilation(out, size=3) if fn == "max" else ndimage.grey_erosion(out, size=3)

    return {"side": reduce(ix, iy, P[:, 2], (nx, ny), "max"), "left": reduce(ix, iy, P[:, 2], (nx, ny), "min"),
            "top": reduce(ix, iz, P[:, 1], (nx, nz), "max"), "front": reduce(iy, iz, P[:, 0], (ny, nz), "max"),
            "rear": reduce(iy, iz, P[:, 0], (ny, nz), "min")}


DIRS = {"side": (2, 1.0), "left": (2, -1.0), "top": (1, 1.0), "front": (0, 1.0), "rear": (0, -1.0)}


def zvis(view, raster, P: np.ndarray, N: np.ndarray, eps_px: float = 1.5) -> np.ndarray:
    """Exact visibility from a view's z-buffer: a point is seen if nothing in the buffer is nearer than it
    (with a tolerance that grows on surfaces the camera sees at a glancing angle, e.g. a raked windscreen)."""
    u, v = view.to_px(P)
    h, w = raster.depth.shape
    zb = raster.depth[np.clip(np.floor(v).astype(np.int64), 0, h - 1), np.clip(np.floor(u).astype(np.int64), 0, w - 1)]
    d = P @ view.direction
    c = np.clip(np.abs(N @ view.direction), 0.15, 1.0)
    eps = max(view.su, view.sv) * (eps_px + 2.0 * np.sqrt(1.0 - c * c) / c)
    return np.isneginf(zb) | (d >= zb - eps)


def _views_at(cal, flows, P, N, grid, maps, power=4.0, tol_cells=2.5, vis_by_view: dict | None = None):
    """Per view: weight (facing x visible x inside the drawing), aligned pixel coords and raw coords.
    vis_by_view: exact visibility per view (zvis); views missing from it fall back to the depth maps."""
    out = {}
    body = type("B", (), {"grid": grid})
    for name, (axis, sgn) in DIRS.items():
        src = name if name in cal.views else "side"
        v = cal.views[src]
        u0, v0 = v.to_px(P)
        u, vv = u0.copy(), v0.copy()
        if flows.get(src) is not None:
            f = render.sample(flows[src], u0 - 0.5, v0 - 0.5, cv2.BORDER_CONSTANT)
            u, vv = u0 + f[:, 0], v0 + f[:, 1]
        facing = np.clip(sgn * N[:, axis], 0, 1) ** power
        if vis_by_view is not None and name in vis_by_view:
            vis = vis_by_view[name]
        else:
            vis = bake._visible(body, maps, name, P, tol_cells * grid.h)
        inside = np.clip((render.sample(bake._inner_alpha(v.panel), u - 0.5, vv - 0.5, cv2.BORDER_CONSTANT)[:, 0] - 0.5) / 0.45, 0, 1)
        out[name] = {"view": v, "w": facing * vis * inside, "w_raw": facing * vis, "u": u, "v": vv, "u0": u0, "v0": v0,
                     "vis": vis}
    return out


# ---- the bake ---------------------------------------------------------------------------------------

def _hand_glass(vs: dict, masks: dict) -> np.ndarray:
    """Glass from the views listed in model.rebake.glass: outlines traced on the generated model's own
    renders (qa trace-<view>.png) are projected straight through the view's camera, so they sit exactly
    on the model's windows; "sheet" masks are aligned like the paint. The best-placed listed view decides."""
    names = [n for n in vs if vs[n]["view"].name in masks]
    if not names:
        return np.zeros(len(next(iter(vs.values()))["w"]), bool)
    W = np.stack([vs[n]["w_raw"] for n in names])
    G = []
    for n in names:
        m, aligned = masks[vs[n]["view"].name]
        u, v = (vs[n]["u"], vs[n]["v"]) if aligned else (vs[n]["u0"], vs[n]["v0"])  # sheet masks move with the paint
        G.append(render.sample(m.astype(np.float32), u - 0.5, v - 0.5, cv2.BORDER_CONSTANT)[:, 0] > 0.5)
    G = np.stack(G)
    best = np.argmax(W, axis=0)
    i = np.arange(W.shape[1])
    return G[best, i] & (W[best, i] > 1e-3)


def guided_bake(mesh: Textured, cal, grid, flows: dict, renders: dict, size: int = 2048, power: float = 4.0,
                agree_sigma: float = 55.0, hand_glass: bool = False, report: dict | None = None,
                unseen: frozenset = frozenset({"top"}), traced: dict | None = None, tinted: dict | str | None = None,
                flat: dict | None = None, trust: dict | None = None, skip: dict | None = None,
                rasters: dict | None = None):
    """unseen: views the generator never got - not aligned, and not trusted to say where the glass is
    (their window outlines don't line up with the generated greenhouse). tinted: "all" (every window super
    tinted) or {view: (mask, aligned)} marking the super-tinted panels (model.rebake.tinted, as for the glass)."""
    V, F = mesh.V, mesh.F
    # where the generated UV islands overlap (a windscreen laid over the dashboard behind it), the face the views see
    # most wins the texels: faces drawn in order of how much of them the views' renders show
    order = None
    if rasters:
        seen = np.zeros(len(F), np.int64)
        for r in rasters.values():
            seen += np.bincount(r.face[r.face >= 0], minlength=len(F))
        order = np.argsort(seen, kind="stable")
    ys, xs, t, bary = bake._texels(F, mesh.uv, size, order)
    P = (bary[:, :, None] * V[F[t]]).sum(1)
    N = (bary[:, :, None] * mesh.normals_vert[F[t]]).sum(1)
    N /= np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-9)
    base = mesh.base[ys * mesh.base.shape[0] // size, xs * mesh.base.shape[1] // size].astype(np.float32)

    # Visibility: exact, from z-buffers through each view's own camera. (A view the sheet lacks - the left
    # profile of a four-view sheet - falls back to depth maps from surface samples.)
    zviews = [n for n in DIRS if n in cal.views]
    vis_full = {n: zvis(cal.views[n], render.render(cal.views[n], V, F), P, N) for n in zviews}
    need_maps = len(zviews) < len(DIRS)
    if need_maps:
        sp, sf = trimesh.sample.sample_surface(trimesh.Trimesh(V, F, process=False), 1_500_000)
    full = depth_maps(sp, grid) if need_maps else None
    tv_full = _views_at(cal, flows, P, N, grid, full, power, vis_by_view=vis_full)
    if traced:
        is_glass = _hand_glass(tv_full, traced)
    else:
        is_glass = _glass_at(tv_full, exclude=unseen)
        if not hand_glass:
            is_glass = _glass_prior(is_glass, P, N, cal)
    # ...and again with the glass removed: what each view sees *through* the windows
    cnt = np.bincount(t, minlength=len(F))
    glass_face = np.bincount(t[is_glass], minlength=len(F)) > 0.5 * np.maximum(cnt, 1)
    Fo = F[~glass_face]
    vis_thru = {n: zvis(cal.views[n], render.render(cal.views[n], V, Fo), P, N) for n in zviews}
    through = depth_maps(sp[~glass_face[sf]], grid) if need_maps else None
    tv = _views_at(cal, flows, P, N, grid, through, power, vis_by_view=vis_thru)

    names = list(DIRS)
    gains = bake.colour_gains(dict(cal.views))
    blur = {k: cv2.GaussianBlur(v.panel.rgb, (0, 0), 2.5) for k, v in cal.views.items()}
    rblur = {k: cv2.GaussianBlur(r, (0, 0), 2.5) for k, r in renders.items()}
    Wt = np.zeros((len(names), len(P)), np.float32)
    C = np.zeros((len(names), len(P), 3), np.float32)
    for k, name in enumerate(names):
        e = tv[name]
        src = e["view"].name
        col = render.sample(e["view"].panel.rgb, e["u"] - 0.5, e["v"] - 0.5) * gains.get(src, 1.0)
        C[k] = np.clip(col, 0, 255)
        seen_through = e["vis"] & ~tv_full[name]["vis"]  # behind a window: the drawing shows it through the glass
        # agreement with the generated paint, both blurred (sharper decals pass, background/reflections don't)
        s_b = render.sample(blur[src], e["u"] - 0.5, e["v"] - 0.5)
        r_b = render.sample(rblur[src], e["u0"] - 0.5, e["v0"] - 0.5)
        agree = np.exp(-(np.linalg.norm(s_b - r_b, axis=1) / agree_sigma) ** 2)
        # trusted as drawn: what's seen through glass and the glass itself - and everything a view the
        # generator never got paints (its paint there is a guess: a roof banner twice, invented lettering)
        agree = np.where(seen_through | is_glass | (src in unseen), 1.0, agree)
        if trust and src in trust:  # model.rebake.trust: here this view's drawing beats the generated paint
            m, aligned = trust[src]
            tu, tvv = (e["u"], e["v"]) if aligned else (e["u0"], e["v0"])
            agree = np.where(render.sample(m.astype(np.float32), tu - 0.5, tvv - 0.5, cv2.BORDER_CONSTANT)[:, 0] > 0.5, 1.0, agree)
        # a view only paints glass where its own drawing shows glass there (not a wing drawn in front of
        # the rear window), and only paints bodywork where it doesn't show glass (no cabin on the pillars)
        g = e["view"].panel.glass
        if g is not None:
            gv = render.sample(g.astype(np.float32), e["u"] - 0.5, e["v"] - 0.5, cv2.BORDER_CONSTANT)[:, 0]
            # ...and paints the cabin behind the glass only where its drawing shows window there too
            # (the rear drawing has the wing in front of the rear window: its lettering isn't the cabin)
            agree = agree * np.where(is_glass | seen_through, 0.05 + 0.95 * gv, 1.0 - 0.9 * gv)
        Wt[k] = e["w"] * agree
        if skip and src in skip:  # model.rebake.skip: this view never paints here (its drawing shows it at a slant)
            m, aligned = skip[src]
            su, sv = (e["u"], e["v"]) if aligned else (e["u0"], e["v0"])
            Wt[k] = np.where(render.sample(m.astype(np.float32), su - 0.5, sv - 0.5, cv2.BORDER_CONSTANT)[:, 0] > 0.5, 0.0, Wt[k])
    total = Wt.sum(0)
    sheet_col = (C * Wt[:, :, None]).sum(0) / np.maximum(total, 1e-6)[:, None]
    beta = np.clip(total / 0.3, 0, 1) ** 0.5  # how much the drawings take over from the generated paint
    # match the generated paint's overall colour to the drawings where both are trusted, so hand-overs don't show
    trusted = (beta > 0.9) & ~is_glass
    if trusted.sum() > 500:
        g = np.median((sheet_col[trusted] + 8) / (base[trusted] + 8), axis=0)
        base = np.clip(base * np.clip(g, 0.7, 1.4), 0, 255)
    # glass never falls back to the generated paint (milky, with invented lettering): plain tinted glass
    fallback = np.where(is_glass[:, None], GLASS_PLAIN, base)
    col = beta[:, None] * sheet_col + (1 - beta[:, None]) * fallback
    # the glass itself is plain tint: what the drawings show through it is real geometry behind it
    # (painted above), so painting it onto the glass too would show the cabin twice
    col[is_glass] = GLASS_TINT
    if tinted == "all":
        dark = is_glass.copy()
    elif tinted:
        dark = is_glass & _hand_glass(tv_full, tinted)
    else:
        dark = np.zeros_like(is_glass)
    col[dark] = GLASS_DARK

    img = np.zeros((size, size, 3), np.float32)
    img[ys, xs] = col
    known = np.zeros((size, size), bool)
    known[ys, xs] = True
    # material map: keep the generated one (stretched to our size), mark glass, keep paint off "glass" values
    if mesh.mr is not None:
        mr = cv2.resize(mesh.mr, (size, size), interpolation=cv2.INTER_LINEAR).astype(np.float32)
    else:
        mr = np.zeros((size, size, 3), np.float32)
        mr[..., 1], mr[..., 2] = 0.5 * 255, 0.1 * 255
    # the app treats roughness < 0.2 as glass: keep paint well above it, so texels blended across a
    # window edge (texture filtering, JPEG) fall on the paint side instead of eating into the pillars
    mr[..., 1] = np.maximum(mr[..., 1], 0.4 * 255)
    mr[ys[is_glass], xs[is_glass], 1] = 0.06 * 255
    mr[ys[is_glass], xs[is_glass], 2] = 0
    mr[ys[dark], xs[dark], 1] = TINT_ROUGH * 255
    glass_uv = np.zeros((size, size), np.uint8)
    # 2: bodywork whose generated relief is flattened (model.rebake.flat: lettering the generator embossed
    # where the drawing has its own), 1: glass (also flat)
    if flat:
        fl = _hand_glass(tv_full, flat) & ~is_glass
        glass_uv[ys[fl], xs[fl]] = 2
        if report is not None:
            report["flat_share"] = round(float(fl.mean()), 4)
    glass_uv[ys[is_glass], xs[is_glass]] = 1
    if report is not None:
        report["sheet_share"] = round(float(beta.mean()), 3)
        report["glass_share"] = round(float(is_glass.mean()), 4)
        report["tinted_share"] = round(float(dark.mean()), 4)
        report["seen_through_glass"] = round(float(np.mean([(tv[n]["vis"] & ~tv_full[n]["vis"]).mean() for n in names])), 4)
    return bake._pad(img, known), bake._pad(mr, known), glass_uv


def _glass_at(vs: dict, second: float = 0.35, exclude: frozenset = frozenset()) -> np.ndarray:
    """Glass where the best-placed view's (aligned) glass mask says so, unless the second-best view
    also sees the spot well (weight >= `second` x best) and says it isn't glass - a roof rail or a
    pillar that one drawing's window outline happens to cover."""
    names = [n for n, e in vs.items() if e["view"].panel.glass is not None and n not in exclude]
    if not names:
        return np.zeros(len(next(iter(vs.values()))["w"]), bool)
    W = np.stack([vs[n]["w"] for n in names])
    G = np.stack([render.sample(vs[n]["view"].panel.glass.astype(np.float32), vs[n]["u"] - 0.5, vs[n]["v"] - 0.5,
                                cv2.BORDER_CONSTANT)[:, 0] > 0.5 for n in names])
    vote = (W * G).sum(0) / np.maximum(W.sum(0), 1e-6)  # weighted vote: no texel-by-texel flicker
    return (vote > 0.5) & (W.max(0) > 1e-3)


def _glass_prior(gl, P, N, cal):
    bl = glass.belt_line(cal)
    if bl is None:
        return gl
    gl = gl & (P[:, 1] > np.polyval(bl, P[:, 0]) - 0.02 * cal.H)
    roof_top = P[:, 1] > np.percentile(P[:, 1], 99) - 0.03 * cal.H
    return gl & ~(roof_top & (N[:, 1] > 0.9))


# ---- driver -----------------------------------------------------------------------------------------

def rebake(car: str, src: str | None = None, texture: int = 1536) -> dict:
    from .__main__ import _layout, write_review_crops

    out = paths.asset_dir(car)
    qadir = paths.qa_dir(car)
    src_path = out / (src or "snapshots/tripo-multiview-clean.glb")
    hints = json.loads((out / "hints.json").read_text()) if (out / "hints.json").is_file() else {}
    tune = hints.get("model", {})
    panels = sheet.load(paths.sheet(car), cache_dir=paths.cache_dir(car), layout=_layout(car))
    cal = views.calibrate(panels)
    wheels = wh.locate(cal, tune.get("wheels"))
    views.register(cal, wheels)
    grid = hull.make_grid(cal)
    pr = hull.profiles(cal, grid, hull.planes(cal, grid), wheels, tune=tune)
    glass.find_all(cal, grid, pr, tune.get("glass"))

    mesh = Textured(src_path)
    mesh.V, fit_report = fit(mesh.V, mesh.F, cal, tune.get("fit"))
    report = {"source": str(src_path.relative_to(out)), "fit": fit_report, "alignment": {}}

    renders, flows, rasters = {}, {}, {}
    # views the generator never got (Tripo multiview: front/left/back/right): aligning to them is guesswork
    unseen = frozenset(tune.get("rebake", {}).get("unseen", ["top"]))
    for name, v in cal.views.items():
        r = rasters[name] = render.render(v, mesh.V, mesh.F)
        renders[name] = render.lookup_texture(r, mesh.F, mesh.uv, mesh.base)
        flows[name], report["alignment"][name] = align(v, renders[name], r.cover)
        if name in tune.get("rebake", {}).get("noalign", ()):
            # (hints: model.rebake.noalign) a weak alignment can shear fine paint - a roof decal over
            # featureless generated paint: project the drawing straight through the camera instead
            flows[name] = None
            report["alignment"][name]["note"] = "not aligned (hints: noalign): the drawing is projected as it is"
        if name in unseen:
            report["alignment"][name]["note"] = "generator never saw this view: aligned for paint only, not trusted for glass"
        _debug(qadir / f"align-{name}.jpg", v, renders[name], flows[name])
    report["faces_turned_outward"] = mesh.orient(cal, rasters)

    rb = tune.get("rebake", {})
    write_review_crops(car, cal)
    # the sheet's own window masks (model.glass): they decide where the drawings show glass and cabin
    sheet_rgb = sheet.read_canonical(paths.sheet(car), panels)
    cv2.imwrite(str(qadir / "glass.jpg"), glass.debug_image(cal, sheet_rgb))
    traced = _traced_masks(cal, rb.get("glass"), mirror=tuple(rb.get("glass_mirror", ())))
    # super-tinted windows (model.rebake.tinted): "all", or per view "sheet" / sheet-px polygons like the glass
    # (traced over the panels to darken; only glass texels are touched), mirrored by tinted_mirror
    # areas whose generated normal-map relief is flattened (model.rebake.flat: per view polygons, like the glass)
    flat = _traced_masks(cal, rb.get("flat"), mirror=tuple(rb.get("flat_mirror", ()))) if rb.get("flat") else None
    # areas where a view's drawing always wins over the generated paint (model.rebake.trust: per view polygons) -
    # where the generator painted its own invented detail (lettering) that the drawing's agreement test keeps
    trust = _traced_masks(cal, rb.get("trust"), mirror=tuple(rb.get("trust_mirror", ()))) if rb.get("trust") else None
    # areas a view never paints (model.rebake.skip: per view polygons) - an elevated drawing's view of a top
    # surface (a wing's lettering) would smear across it; the view that sees it squarely paints it alone
    skip = _traced_masks(cal, rb.get("skip"), mirror=tuple(rb.get("skip_mirror", ()))) if rb.get("skip") else None
    tinted = rb.get("tinted")
    if isinstance(tinted, dict):
        tinted = _traced_masks(cal, tinted, mirror=tuple(rb.get("tinted_mirror", ())))
    clays = {name: trace.clay(v, rasters[name], mesh.normals_face) for name, v in cal.views.items()}
    _write(qadir / "tripo-sheet.png", trace.canvas(cal, renders))
    _write(qadir / "tripo-clay.png", trace.canvas(cal, clays))
    for name, v in cal.views.items():
        mask = traced[name][0] if name in traced else None
        polys = (rb.get("glass") or {}).get(name)
        _write(qadir / f"trace-{name}.png", trace.ruler(
            v, renders[name], clays[name], mask, polys if isinstance(polys, list) else None,
            region=trace.window_region(v, v.panel.glass, mask), sheet_glass=v.panel.glass))
    report["glass_source"] = ({n: "sheet mask" if aligned else "traced" for n, (_, aligned) in traced.items()}
                              if traced else "sheet masks, aligned")
    tex, mr, glass_uv = guided_bake(mesh, cal, grid, flows, renders, size=texture, hand_glass="replace" in tune.get("glass", {}),
                          report=report, unseen=unseen, power=rb.get("power", 4.0), agree_sigma=rb.get("agree", 55.0),
                          traced=traced, tinted=tinted, flat=flat, trust=trust, skip=skip, rasters=rasters)
    name = src_path.stem.replace("-clean", "") + "-guided"
    dst = out / "snapshots" / f"{name}.glb"
    wheels, report["wheels_note"] = parts.find_wheels(mesh.V, mesh.F) if rb.get("wheels", True) else ([], "off (hints)")
    report["wheels"] = [{"name": w["name"], "centre": [round(float(c), 4) for c in w["centre"]], "r": round(w["r"], 4),
                         "pieces": w["pieces"]} for w in wheels]
    _write(qadir / "wheels.jpg", trace.wheel_map(cal, rasters, renders, wheels))
    report["glb"] = _export(mesh, tex, mr, dst, glass_uv, wheels)
    (out / "snapshots" / f"{name}.json").write_text(json.dumps(report, indent=2) + "\n")
    _write(qadir / "glass-map.jpg", trace.glass_map(cal, rasters, mesh.F, mesh.uv, tex, (glass_uv == 1).astype(np.uint8)))
    return report


def _write(path, rgb: np.ndarray) -> None:
    params = [cv2.IMWRITE_JPEG_QUALITY, 88] if str(path).endswith(".jpg") else []
    cv2.imwrite(str(path), cv2.cvtColor(rgb, cv2.COLOR_RGB2BGR), params)


def _traced_masks(cal, polys: dict | None, mirror=()) -> dict:
    """hints.json model.rebake.glass: {view: [polygon [[x, y], ...] in sheet px, ...] | "sheet"} ->
    {view: (panel mask, aligned)}. Polygons are traced on the generated model's own render and projected
    as they are; "sheet" takes the drawing's own window mask (model.glass, qa glass.jpg) and aligns it
    like the paint - right for views the generator was given, where mesh and drawing agree.
    Views listed in model.rebake.glass_mirror are mirrored across the car's centre line (top: about
    the long axis; front/rear: left-right), so a window traced on one half comes out symmetric."""
    masks = {}
    for name, plist in (polys or {}).items():
        if name not in cal.views or not plist:
            continue
        v = cal.views[name]
        p = v.panel
        if plist == "sheet":
            if p.glass is not None:
                masks[name] = (p.glass.astype(bool), True)
            continue
        m = np.zeros(p.mask.shape, np.uint8)
        for poly in plist:
            cv2.fillPoly(m, [np.round(np.array(poly, float) - p.origin).astype(np.int32)], 1)
        if name in mirror:
            h, w = m.shape
            if name == "top":  # mirror rows about the centre line (z = 0)
                src = np.clip(np.round(2 * v.vg - np.arange(h)).astype(int), 0, h - 1)
                m = m | m[src, :]
            elif name in ("front", "rear"):  # mirror columns about the centre line
                src = np.clip(np.round(2 * v.uc - np.arange(w)).astype(int), 0, w - 1)
                m = m | m[:, src]
        masks[name] = (m.astype(bool), False)
    return masks


def _export(mesh: Textured, tex: np.ndarray, mr: np.ndarray, dst, glass_uv: np.ndarray | None = None,
            wheels: list | None = None) -> dict:
    """Same geometry and UVs (fitted), new base colour + material map, the generated normal map kept -
    flattened on the glass, where the generator had embossed its own (invented) window lettering, and on
    any bodywork marked flat (glass_uv 1 glass, 2 flat bodywork)."""
    import io

    from trimesh.visual.material import PBRMaterial
    from trimesh.visual.texture import TextureVisuals

    def jpeg(rgb, q=88):
        buf = io.BytesIO()
        Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8)).save(buf, format="JPEG", quality=q)
        buf.seek(0)
        img = Image.open(buf)
        img.load()
        return img

    old = mesh.trimesh.visual.material
    normal = getattr(old, "normalTexture", None)
    if normal is not None:
        nm = np.asarray(normal.convert("RGB")).copy()
        if glass_uv is not None and glass_uv.any():
            g = cv2.resize(glass_uv, (nm.shape[1], nm.shape[0]), interpolation=cv2.INTER_NEAREST)
            g = cv2.dilate(g, np.ones((5, 5), np.uint8)).astype(bool)
            nm[g] = (128, 128, 255)  # flat tangent-space normal
        # always JPEG: passed through as-is, the decoded map would be written as PNG (a car with no glass
        # and nothing flattened, e.g. the Splittin' Image: 644 KB instead of ~50-70 KB)
        normal = jpeg(nm, 92)
    mat = PBRMaterial(name="paint", baseColorTexture=jpeg(tex), metallicRoughnessTexture=jpeg(mr, 92),
                      normalTexture=normal, metallicFactor=1.0, roughnessFactor=1.0)
    uv = mesh.uv.copy()
    uv[:, 1] = 1.0 - uv[:, 1]
    # wind every face outward (orient()): the app draws back faces as dark cabin and culls glass seen
    # from behind, so an inside-out patch would show as a black hole; turn the vertex normals to match
    F = mesh.F.copy()
    tri = mesh.V[F]
    inside_out = np.sum(np.cross(tri[:, 1] - tri[:, 0], tri[:, 2] - tri[:, 0]) * mesh.normals_face, axis=1) < 0
    F[inside_out] = F[inside_out][:, ::-1]
    vn = np.asarray(mesh.trimesh.vertex_normals, float).copy()
    vn *= np.where(np.sum(vn * mesh.normals_vert, axis=1, keepdims=True) < 0, -1.0, 1.0)
    def part(mask, to_local=None):
        used, idx = np.unique(F[mask], return_inverse=True)
        v, n = mesh.V[used], vn[used]
        if to_local is not None:
            v, n = trimesh.transform_points(v, to_local), n @ to_local[:3, :3].T
        return trimesh.Trimesh(v, idx.reshape(-1, 3), vertex_normals=n, process=False,
                               visual=TextureVisuals(uv=uv[used], material=mat))

    in_wheel = np.zeros(len(F), bool)
    for w in wheels or []:
        in_wheel[w["faces"]] = True
    scene = trimesh.Scene()
    scene.add_geometry(part(~in_wheel), node_name="body", geom_name="body")  # "body": the app's glass split applies
    for w in wheels or []:  # same layout as the scripts' wheels: pivot at the hub, local +z out of the car
        pivot = np.eye(4)
        if w["name"].endswith("left"):
            pivot[:3, :3] = trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0])[:3, :3]
        pivot[:3, 3] = w["centre"]
        scene.graph.update(frame_from=scene.graph.base_frame, frame_to=w["name"], matrix=pivot)
        only = np.zeros(len(F), bool)
        only[w["faces"]] = True
        scene.add_geometry(part(only, np.linalg.inv(pivot)), node_name=f"{w['name']}_wheel",
                           geom_name=f"{w['name']}_wheel", parent_node_name=w["name"])
    data = scene.export(file_type="glb", include_normals=True)
    dst.write_bytes(data)
    return {"bytes": len(data), "triangles": int(len(mesh.F)), "faces_rewound": int(inside_out.sum()),
            "spinning_wheels": len(wheels or [])}


def _debug(path, view, rendered, flow):
    S = view.panel.rgb
    h, w = S.shape[:2]
    gx, gy = np.meshgrid(np.arange(w, dtype=np.float32), np.arange(h, dtype=np.float32))
    f = flow if flow is not None else np.zeros((h, w, 2), np.float32)
    warped = cv2.remap(S, gx + f[..., 0], gy + f[..., 1], cv2.INTER_LINEAR, borderValue=(255, 255, 255))
    cb = ((gx // 24 + gy // 24) % 2).astype(bool)[..., None]
    x0, y0, x1, y1 = view.panel.bbox
    sl = (slice(max(0, y0 - 6), y1 + 6), slice(max(0, x0 - 6), x1 + 6))
    row = np.hstack([rendered[sl], S[sl], np.where(cb, rendered, S)[sl], np.where(cb, rendered, warped)[sl]])
    cv2.imwrite(str(path), cv2.cvtColor(row, cv2.COLOR_RGB2BGR), [cv2.IMWRITE_JPEG_QUALITY, 85])
