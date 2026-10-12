"""Exact orthographic rendering of a mesh with a sheet view's own camera (z-buffer, per-pixel triangle ids).

Used to compare a model with its reference views pixel for pixel: render(view, V, F) gives, for every
panel pixel, which triangle is in front and where inside it (barycentrics) - from that any per-vertex
attribute or texture can be looked up.
"""
from dataclasses import dataclass

import cv2
import numpy as np

from .views import View


@dataclass
class Raster:
    face: np.ndarray  # (h, w) int32 triangle index in front, -1 where empty
    bary: np.ndarray  # (h, w, 3) float32 barycentric coordinates in that triangle
    depth: np.ndarray  # (h, w) float32 distance towards the camera (larger = nearer)

    @property
    def cover(self) -> np.ndarray:
        return self.face >= 0


def render(view: View, V: np.ndarray, F: np.ndarray) -> Raster:
    h, w = view.panel.mask.shape
    u, v = view.to_px(V)
    P = np.stack([u, v], 1).astype(np.float64)
    d = (V @ view.direction).astype(np.float64)
    face = np.full((h, w), -1, np.int32)
    zbuf = np.full((h, w), -np.inf, np.float32)
    bary = np.zeros((h, w, 3), np.float32)
    tri = P[F]  # (n, 3, 2)
    lo = np.floor(tri.min(axis=1)).astype(int)
    hi = np.ceil(tri.max(axis=1)).astype(int)
    for i in range(len(F)):
        x0, y0 = max(lo[i, 0], 0), max(lo[i, 1], 0)
        x1, y1 = min(hi[i, 0], w - 1), min(hi[i, 1], h - 1)
        if x1 < x0 or y1 < y0:
            continue
        (ax, ay), (bx, by), (cx, cy) = tri[i]
        den = (by - cy) * (ax - cx) + (cx - bx) * (ay - cy)
        if abs(den) < 1e-12:
            continue
        X, Y = np.meshgrid(np.arange(x0, x1 + 1) + 0.5, np.arange(y0, y1 + 1) + 0.5)
        l1 = ((by - cy) * (X - cx) + (cx - bx) * (Y - cy)) / den
        l2 = ((cy - ay) * (X - cx) + (ax - cx) * (Y - cy)) / den
        l3 = 1.0 - l1 - l2
        inside = (l1 >= -1e-6) & (l2 >= -1e-6) & (l3 >= -1e-6)
        if not inside.any():
            continue
        a, b, c = F[i]
        z = (l1 * d[a] + l2 * d[b] + l3 * d[c]).astype(np.float32)
        zs = zbuf[y0:y1 + 1, x0:x1 + 1]
        upd = inside & (z > zs)
        if not upd.any():
            continue
        zs[upd] = z[upd]
        face[y0:y1 + 1, x0:x1 + 1][upd] = i
        bary[y0:y1 + 1, x0:x1 + 1][upd] = np.stack([l1, l2, l3], -1)[upd]
    return Raster(face, bary, zbuf)


def lookup_texture(r: Raster, F: np.ndarray, uv_topleft: np.ndarray, tex: np.ndarray, bg=(255, 255, 255)) -> np.ndarray:
    """RGB image of a textured mesh from a raster (uv in top-left convention, [0, 1])."""
    h, w = r.face.shape
    out = np.empty((h, w, 3), np.uint8)
    out[:] = bg
    ys, xs = np.nonzero(r.cover)
    f = r.face[ys, xs]
    b = r.bary[ys, xs]
    uvp = (b[:, :, None] * uv_topleft[F[f]]).sum(1)
    th, tw = tex.shape[:2]
    out[ys, xs] = np.clip(sample(tex, uvp[:, 0] * tw - 0.5, uvp[:, 1] * th - 0.5), 0, 255).astype(np.uint8)
    return out


def sample(img: np.ndarray, u: np.ndarray, v: np.ndarray, border: int = cv2.BORDER_REPLICATE) -> np.ndarray:
    """Bilinear lookup of many points; returns (N, channels) float32. (OpenCV's remap needs both map
    dimensions under 32767, so the points are laid out as a 2048-wide grid.)"""
    n = len(u)
    cols = 2048
    rows = max(1, (n + cols - 1) // cols)
    mu = np.zeros(rows * cols, np.float32)
    mv = np.zeros(rows * cols, np.float32)
    mu[:n], mv[:n] = u, v
    out = cv2.remap(img, mu.reshape(rows, cols), mv.reshape(rows, cols), cv2.INTER_LINEAR, borderMode=border)
    return out.reshape(rows * cols, -1)[:n].astype(np.float32)
