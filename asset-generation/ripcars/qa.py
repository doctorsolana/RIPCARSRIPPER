"""Automatic checks: silhouette agreement with every sheet panel, plus quick shaded previews."""
import cv2
import numpy as np
from scipy import ndimage

from .views import View


def _project(view: View, verts: np.ndarray) -> np.ndarray:
    u, v = view.to_px(verts)
    return np.stack([u, v], axis=1)


def silhouette(view: View, meshes: list, pad: int = 0) -> np.ndarray:
    """Orthographic silhouette of the meshes in `view`'s panel pixels (bool, panel-sized, plus `pad`
    px on every side)."""
    h, w = view.panel.mask.shape
    out = np.zeros((h + 2 * pad, w + 2 * pad), np.uint8)
    for m in meshes:
        uv = np.round((_project(view, m.vertices) + pad) * 16).astype(np.int32)
        for tri in m.faces:
            cv2.fillConvexPoly(out, uv[tri], 1, lineType=cv2.LINE_8, shift=4)
    return out.astype(bool)


def match(view: View, meshes: list) -> tuple[np.ndarray, np.ndarray]:
    """The model's silhouette and the drawing's, on a canvas well beyond the drawing's crop. A model
    wider or taller than the crop must count against it: clipped to the crop, the excess vanished and
    the sheet fit made the Impala's Tripo mesh 9% wider instead of 21% narrower."""
    pad = max(view.panel.mask.shape) // 2
    return silhouette(view, meshes, pad), np.pad(view.panel.mask, pad)


def extent(mask: np.ndarray, body: float = 0.25) -> tuple[int, int]:
    """Width and height in px of the body: only rows/columns at least `body` x as full as the fullest
    count, so a wing plate, mirrors or an antenna don't make the car look taller or wider."""
    def span(counts):
        idx = np.nonzero(counts >= body * counts.max())[0]
        return int(idx[-1] - idx[0] + 1) if len(idx) else 0
    return (span(mask.sum(axis=0)), span(mask.sum(axis=1))) if mask.any() else (0, 0)


def iou(a: np.ndarray, b: np.ndarray) -> float:
    return float((a & b).sum() / max(1, (a | b).sum()))


def solid(model: np.ndarray, ref: np.ndarray) -> np.ndarray:
    """The model's silhouette with its enclosed holes filled where the reference is solid there: a
    generated mesh's open side windows (or the gap under a wing) aren't held against it when the
    sheet's or photo's matte fills them."""
    return model | (ndimage.binary_fill_holes(model) & ref)


def overlay(panel_mask: np.ndarray, model_mask: np.ndarray) -> np.ndarray:
    """White = both, red = sheet only (model too small), cyan = model only (too big)."""
    out = np.zeros(panel_mask.shape + (3,), np.uint8)
    out[panel_mask & model_mask] = (235, 235, 235)
    out[panel_mask & ~model_mask] = (40, 40, 255)
    out[~panel_mask & model_mask] = (255, 220, 0)
    return out


def rotation(yaw: float, pitch: float) -> np.ndarray:
    """Camera orbit: yaw about +y (0 = looking at the car's right side), then pitch down."""
    cy, sy, cp, sp = np.cos(yaw), np.sin(yaw), np.cos(pitch), np.sin(pitch)
    ry = np.array([[cy, 0, -sy], [0, 1, 0], [sy, 0, cy]])
    rx = np.array([[1, 0, 0], [0, cp, -sp], [0, sp, cp]])
    return rx @ ry


def shaded(meshes: list, yaw: float, pitch: float, size=(900, 520), colours=None) -> np.ndarray:
    """Flat-shaded orthographic preview (painter's algorithm), BGR. Good enough to judge shape."""
    rot = rotation(yaw, pitch)
    light = np.array([0.35, 0.8, 0.5])
    light /= np.linalg.norm(light)
    tris, cols, depth = [], [], []
    for k, m in enumerate(meshes):
        v = m.vertices @ rot.T
        n = m.face_normals @ rot.T
        base = np.array(colours[k] if colours else (200, 200, 200), float)
        visible = n[:, 2] > 0
        shade = np.clip(0.25 + 0.75 * np.clip(n @ light, 0, 1), 0, 1)
        tris.append(v[m.faces][visible])
        cols.append(base[None] * shade[visible, None])
        depth.append(v[m.faces][visible][:, :, 2].mean(axis=1))
    tris, cols, depth = np.concatenate(tris), np.concatenate(cols), np.concatenate(depth)
    lo, hi = tris[..., :2].reshape(-1, 2).min(0), tris[..., :2].reshape(-1, 2).max(0)
    scale = 0.9 * min(size[0] / (hi - lo)[0], size[1] / (hi - lo)[1])
    centre = (lo + hi) / 2
    img = np.full((size[1], size[0], 3), 245, np.uint8)
    pts = ((tris[..., :2] - centre) * scale * np.array([1, -1]) + np.array(size) / 2) * 16
    for i in np.argsort(depth):
        cv2.fillConvexPoly(img, np.round(pts[i]).astype(np.int32), cols[i][::-1].tolist(), lineType=cv2.LINE_AA, shift=4)
    return img


def _split_long(verts, faces, uv, max_edge: float, rounds: int = 6):
    from trimesh.remesh import subdivide

    for _ in range(rounds):
        e = np.linalg.norm(verts[faces] - verts[np.roll(faces, 1, axis=1)], axis=2).max(axis=1)
        big = np.flatnonzero(e > max_edge)
        if not len(big):
            break
        verts, faces, attr = subdivide(verts, faces, face_index=big, vertex_attributes={"uv": uv})
        uv = attr["uv"]
    return verts, faces, uv


def render_view(view: View, verts: np.ndarray, faces: np.ndarray, uv_topleft: np.ndarray, tex: np.ndarray,
                extras: list | None = None) -> tuple[np.ndarray, np.ndarray]:
    """The textured model drawn with exactly the camera of one sheet view, in that panel's pixels:
    (RGB image, coverage mask). extras: [(trimesh, rgb)] drawn flat (tyres). Painter's algorithm over
    camera-facing triangles; per-pixel barycentric texture lookup."""
    h, w = view.panel.mask.shape
    d = view.direction
    # painter's algorithm misorders long thin triangles (extruded wing parts): split big ones first
    verts, faces, uv_topleft = _split_long(verts, faces, uv_topleft, max_edge=0.04)
    ids = np.full((h, w), -1, np.int32)
    meshes = [(verts, faces, None)] + [(m.vertices, m.faces, c) for m, c in (extras or [])]
    all_tri, flat = [], {}
    offset = 0
    for k, (V, F, colour) in enumerate(meshes):
        u, v = view.to_px(V)
        P = np.stack([u, v], 1)
        tri3 = V[F]
        depth = (tri3 @ d).max(axis=1)  # nearest corner: thin parts in front of the body win
        for t in range(len(F)):  # no back-face test: winding isn't reliable after decimation
            all_tri.append((depth[t], offset + t, P[F[t]]))
        if colour is not None:
            flat[(offset, offset + len(F))] = colour
        offset += len(F)
    all_tri.sort(key=lambda r: r[0])  # far first
    for _, tid, pts in all_tri:
        q = np.round(pts * 16).astype(np.int32)
        cv2.fillConvexPoly(ids, q, int(tid), lineType=cv2.LINE_8, shift=4)
        cv2.polylines(ids, [q], True, int(tid), 1, lineType=cv2.LINE_8, shift=4)  # close cracks between triangles
    out = np.zeros((h, w, 3), np.uint8)
    cover = ids >= 0
    ys, xs = np.nonzero(cover & (ids < len(faces)))
    if len(ys):
        t = ids[ys, xs]
        u, v = view.to_px(verts)
        P = np.stack([u, v], 1)
        a, b, c = P[faces[t, 0]], P[faces[t, 1]], P[faces[t, 2]]
        p = np.stack([xs + 0.5, ys + 0.5], 1)
        v0, v1, v2 = b - a, c - a, p - a
        d00, d01, d11 = (v0 * v0).sum(1), (v0 * v1).sum(1), (v1 * v1).sum(1)
        d20, d21 = (v2 * v0).sum(1), (v2 * v1).sum(1)
        den = np.where(np.abs(d00 * d11 - d01 * d01) < 1e-12, 1e-12, d00 * d11 - d01 * d01)
        bb = np.clip((d11 * d20 - d01 * d21) / den, 0, 1)
        cc = np.clip((d00 * d21 - d01 * d20) / den, 0, 1)
        aa = np.clip(1 - bb - cc, 0, 1)
        uvp = aa[:, None] * uv_topleft[faces[t, 0]] + bb[:, None] * uv_topleft[faces[t, 1]] + cc[:, None] * uv_topleft[faces[t, 2]]
        th, tw = tex.shape[:2]
        out[ys, xs] = tex[np.clip((uvp[:, 1] * th).astype(int), 0, th - 1), np.clip((uvp[:, 0] * tw).astype(int), 0, tw - 1)]
    for (lo, hi), colour in flat.items():
        sel = (ids >= lo) & (ids < hi)
        out[sel] = colour
        cover_extra = sel if "cover_extra" not in locals() else cover_extra | sel
    render_view.last_extras = locals().get("cover_extra")  # pixels showing the flat extras (tyres)
    return out, cover


def compare_view(view: View, render: np.ndarray, cover: np.ndarray, glass: np.ndarray | None = None) -> tuple[np.ndarray, dict]:
    """Reference panel | model render | difference, cropped to the car (BGR image), plus scores:
    mean colour difference (CIE76 dE) where both have car (windows excluded: the model's glass is a
    real see-through material, the drawing paints the cabin behind it), and silhouette IoU."""
    ref = view.panel.rgb
    both = cover & view.panel.mask
    if glass is not None:
        both &= ~glass
    lab_r = cv2.cvtColor(ref, cv2.COLOR_RGB2LAB).astype(np.float32)
    lab_m = cv2.cvtColor(render, cv2.COLOR_RGB2LAB).astype(np.float32)
    de = np.linalg.norm(lab_r - lab_m, axis=2)
    heat = cv2.applyColorMap(np.clip(de * 4, 0, 255).astype(np.uint8), cv2.COLORMAP_INFERNO)
    heat[~both] = (255, 255, 255)
    heat[cover & ~view.panel.mask] = (255, 220, 0)
    heat[view.panel.mask & ~cover] = (40, 40, 255)
    bg = np.full_like(render, 255)
    model = np.where(cover[..., None], render, bg)
    x0, y0, x1, y1 = view.panel.bbox
    pad = 8
    sl = (slice(max(0, y0 - pad), y1 + pad), slice(max(0, x0 - pad), x1 + pad))
    tiles = [cv2.cvtColor(ref, cv2.COLOR_RGB2BGR)[sl], cv2.cvtColor(model, cv2.COLOR_RGB2BGR)[sl], heat[sl]]
    sep = np.full((tiles[0].shape[0], 6, 3), 200, np.uint8)
    img = np.hstack([tiles[0], sep, tiles[1], sep, tiles[2]])
    scores = {"colour_dE": round(float(de[both].mean()), 2) if both.any() else None,
              "iou": round(iou(cover, view.panel.mask), 4)}
    return img, scores
