"""Texture: UV-unwrap the body and paint every texel from the views that actually see it.

For a texel's 3D point p with normal n, each view v contributes its pixel at p's projection with
weight max(0, n . d_v)^power, times a visibility test (p must be the first surface the view's ray
hits, from depth maps of the voxel body) and the panel's own matte (never sample the background).
The left side comes from the sheet's left profile when it has one (five-view sheets); otherwise from
the right profile, which mirrors any lettering on that side.
"""
import cv2
import numpy as np
import trimesh
import xatlas

from .hull import Body
from .views import Calibration

UNDERSIDE = np.array([22, 22, 24], np.float32)  # what nobody photographs
GLASS_TINT = np.array([26, 32, 40], np.float32)  # windows: dark tint (the shine comes from the material)
PAINT_RM = (0.5, 0.1)  # roughness, metalness written into the material map
GLASS_RM = (0.06, 0.0)


def unwrap(mesh: trimesh.Trimesh, size: int, padding: int = 4):
    atlas = xatlas.Atlas()
    atlas.add_mesh(mesh.vertices.astype(np.float32), mesh.faces.astype(np.uint32), mesh.vertex_normals.astype(np.float32))
    po = xatlas.PackOptions()
    po.resolution = size
    po.padding = padding
    po.bilinear = True
    atlas.generate(xatlas.ChartOptions(), po)
    vmap, faces, uv = atlas[0]  # uv in [0, 1], origin at the image's top-left
    return vmap, faces.astype(np.int64), uv.astype(np.float64)


def _texels(faces, uv, size):
    """Which triangle covers each texel centre, and its barycentric coordinates there."""
    tid = np.full((size, size), -1, np.int32)
    px = uv * size
    pts = np.round(px * 16).astype(np.int32)
    for t, f in enumerate(faces):
        cv2.fillConvexPoly(tid, pts[f], int(t), lineType=cv2.LINE_8, shift=4)
    ys, xs = np.nonzero(tid >= 0)
    t = tid[ys, xs]
    a, b, c = px[faces[t, 0]], px[faces[t, 1]], px[faces[t, 2]]
    p = np.stack([xs + 0.5, ys + 0.5], axis=1)
    v0, v1, v2 = b - a, c - a, p - a
    d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
    d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
    den = np.where(np.abs(d00 * d11 - d01 * d01) < 1e-12, 1e-12, d00 * d11 - d01 * d01)
    bv = (d11 * d20 - d01 * d21) / den
    bw = (d00 * d21 - d01 * d20) / den
    bary = np.clip(np.stack([1 - bv - bw, bv, bw], axis=1), 0, 1)
    bary /= bary.sum(axis=1, keepdims=True)
    return ys, xs, t, bary


def _sample(img: np.ndarray, u: np.ndarray, v: np.ndarray) -> np.ndarray:
    """Bilinear lookup of many points (any count: remap maps are reshaped into a tall 2D grid)."""
    n = len(u)
    cols = 2048
    rows = (n + cols - 1) // cols
    mu = np.zeros(rows * cols, np.float32)
    mv = np.zeros(rows * cols, np.float32)
    mu[:n], mv[:n] = u, v
    out = cv2.remap(img, mu.reshape(rows, cols), mv.reshape(rows, cols), cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=0)
    return out.reshape(rows * cols, -1)[:n].astype(np.float32)


def _visible(body: Body, maps: dict, name: str, p: np.ndarray, tol: float) -> np.ndarray:
    g = body.grid

    def idx(coords, vals):
        return np.clip(np.round((vals - coords[0]) / g.h).astype(int), 0, len(coords) - 1)

    ix, iy, iz = idx(g.xs, p[:, 0]), idx(g.ys, p[:, 1]), idx(g.zs, p[:, 2])
    if name == "side":
        return p[:, 2] >= maps["side"][ix, iy] - tol
    if name == "left":
        return p[:, 2] <= maps["left"][ix, iy] + tol
    if name == "top":
        return p[:, 1] >= maps["top"][ix, iz] - tol
    if name == "front":
        return p[:, 0] >= maps["front"][iy, iz] - tol
    if name == "rear":
        return p[:, 0] <= maps["rear"][iy, iz] + tol
    raise ValueError(name)


def _pad(img: np.ndarray, known: np.ndarray, passes: int = 10) -> np.ndarray:
    """Grow colours outward from covered texels so mip-mapping never pulls in empty space."""
    out = img.astype(np.float32)
    k = known.astype(np.float32)
    for size in (3, 5, 9, 17, 33, 65, 129, 257)[:passes]:
        num = cv2.blur(out * k[..., None], (size, size))
        den = cv2.blur(k, (size, size))
        fill = (k == 0) & (den > 1e-4)
        out[fill] = num[fill] / den[fill][:, None]
        k = np.where(fill, 1.0, k)
    return np.clip(out, 0, 255).astype(np.uint8)


def _dominant_lab(rgb: np.ndarray, mask: np.ndarray, k: int = 4) -> np.ndarray:
    """Lab centres of the main colour clusters of a panel's car pixels, largest cluster first."""
    pix = cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB)[mask].astype(np.float32)
    if len(pix) > 40000:
        pix = pix[:: len(pix) // 40000]
    _, labels, centres = cv2.kmeans(pix, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 2,
                                    cv2.KMEANS_PP_CENTERS)
    order = np.argsort(-np.bincount(labels.ravel(), minlength=k))
    return centres[order]


def _lab_to_rgb(lab: np.ndarray) -> np.ndarray:
    return cv2.cvtColor(lab.reshape(1, -1, 3).astype(np.uint8), cv2.COLOR_LAB2RGB).reshape(-1, 3).astype(np.float32)


def colour_gains(views: dict, max_de: float = 20.0) -> dict:
    """Per-view RGB gains that bring each panel's main paint colour onto the right-side profile's.

    The AI draws each view with slightly different exposure and white balance (front/rear differ the
    most), which shows as seams. A panel's largest colour cluster is matched to the nearest cluster of
    the side view; when nothing is close (different materials dominate), the panel is left alone."""
    ref = _dominant_lab(views["side"].panel.rgb, views["side"].panel.mask)
    gains = {"side": np.ones(3, np.float32)}
    for name, view in views.items():
        if name == "side":
            continue
        own = _dominant_lab(view.panel.rgb, view.panel.mask)[0]
        de = np.linalg.norm(ref - own[None], axis=1)
        if de.min() > max_de:
            gains[name] = np.ones(3, np.float32)
            continue
        a, b = _lab_to_rgb(ref[np.argmin(de)][None])[0], _lab_to_rgb(own[None])[0]
        gains[name] = np.clip((a + 8) / (b + 8), 0.8, 1.25).astype(np.float32)
    return gains


def _edges(rgb: np.ndarray) -> np.ndarray:
    g = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    e = np.hypot(cv2.Sobel(g, cv2.CV_32F, 1, 0), cv2.Sobel(g, cv2.CV_32F, 0, 1))
    return cv2.GaussianBlur(e, (0, 0), 1.5)


_INNER = {}


def _inner_alpha(panel, px: int = 3) -> np.ndarray:
    """The panel's matte pulled in by a few pixels: the outermost ring of every drawing is anti-aliased
    into the white background, and painting from it leaves light streaks along the model's edges."""
    key = id(panel)
    if key not in _INNER:
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * px + 1, 2 * px + 1))
        _INNER[key] = cv2.erode(panel.alpha, k)
    return _INNER[key]


def register_ends(cal: Calibration, body: Body, maps: dict, p: np.ndarray, n: np.ndarray, report: dict | None) -> None:
    """Line the front and rear views up with the rest before painting.

    ChatGPT draws the front and rear as product shots from slightly above, so their headlights, grilles
    and lamps sit a little off from where the side and top views put them; painted together the details
    come out twice. On surfaces that both an end view and a side/top view see, search the end view's
    image-space scale and offset whose edges best match the side/top views' edges, and keep it."""
    tol = 2.5 * body.grid.h
    ref_views = {"side": (2, 1.0), "left": (2, -1.0), "top": (1, 1.0)}
    for name, (axis, sgn) in (("front", (0, 1.0)), ("rear", (0, -1.0))):
        view = cal.views[name]
        f_end = np.clip(sgn * n[:, axis], 0, 1) * _visible(body, maps, name, p, tol)
        best_ref, best_w = None, np.zeros(len(p))
        ref_val = np.zeros(len(p), np.float32)
        for rname, (ax, sg) in ref_views.items():
            if rname not in cal.views:
                continue
            w = np.clip(sg * n[:, ax], 0, 1) * _visible(body, maps, rname, p, tol)
            rv = cal.views[rname]
            u, v = rv.to_px(p)
            val = _sample(_edges(rv.panel.rgb), u, v)[:, 0]
            take = w > best_w
            ref_val[take], best_w[take] = val[take], w[take]
        both = (f_end > 0.3) & (best_w > 0.3)
        if both.sum() < 300:
            continue
        idx = np.flatnonzero(both)[:: max(1, both.sum() // 6000)]
        pts, ref = p[idx], ref_val[idx]
        ref = (ref - ref.mean()) / (ref.std() + 1e-6)
        edges = _edges(view.panel.rgb)
        x0, y0, x1, y1 = view.panel.bbox
        cu, cv_ = (x0 + x1) / 2, (y0 + y1) / 2
        view.post = None
        u0, v0 = view.to_px(pts)

        def score(su, du, sv, dv):
            val = _sample(edges, cu + (u0 - cu) * su + du, cv_ + (v0 - cv_) * sv + dv)[:, 0]
            val = (val - val.mean()) / (val.std() + 1e-6)
            return float((val * ref).mean())

        h, w = y1 - y0, x1 - x0
        best = (score(1, 0, 1, 0), 1.0, 0.0, 1.0, 0.0)
        base = best[0]
        for sv in np.arange(0.88, 1.13, 0.03):  # vertical first: that's where the views disagree most
            for dv in np.arange(-0.12, 0.121, 0.01) * h:
                sc = score(1, 0, sv, dv)
                if sc > best[0]:
                    best = (sc, 1.0, 0.0, sv, dv)
        _, su, du, sv, dv = best
        for su_ in np.arange(0.92, 1.09, 0.02):
            for du_ in np.arange(-0.05, 0.051, 0.01) * w:
                sc = score(su_, du_, sv, dv)
                if sc > best[0]:
                    best = (sc, su_, du_, sv, dv)
        sc, su, du, sv, dv = best
        if sc > base + 0.02:  # only when it clearly lines up better
            view.post = (su, du, sv, dv, cu, cv_)
        if report is not None:
            report.setdefault("end_registration", {})[name] = {
                "applied": view.post is not None, "edge_match": [round(base, 3), round(sc, 3)],
                "scale": [round(su, 3), round(sv, 3)], "shift_px": [round(du, 1), round(dv, 1)]}


def bake(mesh: trimesh.Trimesh, cal: Calibration, body: Body, maps: dict, size: int = 2048,
         power: float = 4.0, agree: float = 30.0, report: dict | None = None, parts_from: int | None = None,
         hand_glass: bool = False):
    """Returns (vertices, normals, faces, uv_topleft, texture RGB uint8, material map RGB uint8).

    Blending: weights max(0, n.d)^power x visibility x matte, then agreement-gated - each view's
    weight is damped by how far its colour is from the best-placed view's (Gaussian, sigma `agree` in
    RGB), so misregistered views fade out instead of printing a ghost of the same decal."""
    vmap, faces, uv = unwrap(mesh, size)
    verts = mesh.vertices[vmap]
    norms = mesh.vertex_normals[vmap]
    ys, xs, t, bary = _texels(faces, uv, size)
    f = faces[t]
    p = (bary[:, :, None] * verts[f]).sum(axis=1)
    n = (bary[:, :, None] * norms[f]).sum(axis=1)
    n /= np.maximum(np.linalg.norm(n, axis=1, keepdims=True), 1e-9)

    register_ends(cal, body, maps, p, n, report)
    views = dict(cal.views)
    gains = colour_gains(views)
    sources = {"side": "side", "left": "left" if "left" in views else "side", "top": "top", "front": "front", "rear": "rear"}
    dirs = {"side": (2, 1.0), "left": (2, -1.0), "top": (1, 1.0), "front": (0, 1.0), "rear": (0, -1.0)}
    tol = 2.5 * body.grid.h
    W = np.zeros((len(dirs), len(p)), np.float32)
    C = np.zeros((len(dirs), len(p), 3), np.float32)
    G = np.zeros((len(dirs), len(p)), np.float32)
    for k, (name, (axis, sgn)) in enumerate(dirs.items()):
        facing = np.clip(sgn * n[:, axis], 0, 1) ** power
        vis = _visible(body, maps, name, p, tol)
        view = views[sources[name]]
        u, v = view.to_px(p)
        a = _sample(_inner_alpha(view.panel), u, v)[:, 0]
        W[k] = facing * vis * np.clip((a - 0.5) / 0.45, 0, 1)
        C[k] = np.clip(_sample(view.panel.rgb, u, v) * gains[sources[name]], 0, 255)
        if view.panel.glass is not None:
            G[k] = _sample(view.panel.glass.astype(np.float32), u, v)[:, 0]
    if parts_from is not None:
        # Wing parts take their paint from the side and top views only: the front view never shows
        # the wing, and the rear view is a perspective shot whose wing sits lower than the side view's,
        # so it would paint the background seen through the gap under the plate onto it.
        for k in ("front", "rear"):
            W[list(dirs).index(k), t >= parts_from] = 0
    best = np.argmax(W, axis=0)
    # windows come from the single best-placed view only: blending would soften their edges
    glass = (G[best, np.arange(len(p))] > 0.5) & (W.max(axis=0) > 1e-3)
    # 3D sanity: glass sits above the side windows' lower edge and never on the roof's flat middle,
    # whatever a single view's colour-based mask says (dark paint looks like dark glass)
    from .glass import belt_line
    bl = belt_line(cal)
    if bl is not None and not hand_glass:
        above_belt = p[:, 1] > np.polyval(bl, p[:, 0]) - 0.02 * cal.H
        glass &= above_belt
        roof_top = p[:, 1] > np.percentile(p[:, 1], 99) - 0.03 * cal.H
        glass &= ~(roof_top & (n[:, 1] > 0.9))
        # Windscreen and rear window by shape, not colour: on surfaces facing forward/backward above
        # the window line, glass is everything inside the pillars (the outer 15% of the body's width
        # at that point), off the flat roof. Side windows keep the side views' masks, which are reliable.
        endish = (np.abs(n[:, 0]) > 0.3) & (np.abs(n[:, 2]) < 0.6) & above_belt & ~(roof_top & (n[:, 1] > 0.8))
        xb = np.clip(((p[:, 0] - p[:, 0].min()) / 0.04).astype(int), 0, 999)
        yb = np.clip(((p[:, 1] - p[:, 1].min()) / 0.04).astype(int), 0, 999)
        key = xb * 1000 + yb
        half = np.zeros(len(p))
        order = np.argsort(key)
        ks, starts = np.unique(key[order], return_index=True)
        mx = np.maximum.reduceat(np.abs(p[order, 2]), starts)
        half[order] = np.repeat(mx, np.diff(np.append(starts, len(order))))
        inside_pillars = np.abs(p[:, 2]) < 0.85 * half
        glass = np.where(endish, inside_pillars, glass)
    ref = C[best, np.arange(len(p))]
    W *= np.exp(-((np.linalg.norm(C - ref[None], axis=2) / agree) ** 2))
    acc = (C * W[:, :, None]).sum(axis=0)
    wsum = W.sum(axis=0)
    under = np.clip(-n[:, 1], 0, 1) ** power * 0.25 + 1e-4  # the underside stays dark
    acc += UNDERSIDE * under[:, None]
    wsum += under
    col = acc / wsum[:, None]
    col[glass] = 0.8 * GLASS_TINT + 0.2 * col[glass]  # keep a hint of the interior behind the tint
    img = np.zeros((size, size, 3), np.float32)
    img[ys, xs] = col
    known = np.zeros((size, size), bool)
    known[ys, xs] = True
    rm = np.zeros((size, size, 3), np.float32)
    rm[..., 0] = 255
    rough = np.where(glass, GLASS_RM[0], PAINT_RM[0])
    metal = np.where(glass, GLASS_RM[1], PAINT_RM[1])
    rm[ys, xs, 1] = rough * 255
    rm[ys, xs, 2] = metal * 255
    if report is not None:
        total = float(W.sum())
        report["texture_share"] = {k: round(float(W[i].sum()) / total, 3) for i, k in enumerate(dirs)}
        report["left_source"] = sources["left"]
        report["colour_gains"] = {k: [round(float(x), 3) for x in g] for k, g in gains.items()}
        report["glass_share"] = round(float(glass.mean()), 4)
    return verts, norms, faces, uv, _pad(img, known), _pad(rm, known)
