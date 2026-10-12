"""Rear wings as clean parts - plate, endplates and uprights - extruded from the side view's outline.

A wing that stands clear of the deck can't come out of a silhouette hull (it fills in solid, and
marching cubes + smoothing blur its thin edges). hull.wing_layout() measures it; this builds it:
  plate      the top `plate` of the wing's side profile, across the full span
  endplates  the side profile's top band (what the side view shows of the wing), at the span ends
  uprights   whatever the side view shows under that band, at +-upright_z (two, mirrored)
"""
import cv2
import numpy as np
import trimesh
from shapely.geometry import Polygon

from .hull import Body


def _profiles(body: Body):
    """(nx, ny) boolean masks of the wing's side profile: plate, band (endplates) and uprights."""
    g, w, pr = body.grid, body.wing, body.profiles
    S = body.planes["side"]
    plate = np.zeros(S.shape, bool)
    band = np.zeros(S.shape, bool)
    upright = np.zeros(S.shape, bool)
    for i in w["slices"]:
        yt = w["plate_top"][i]
        wing = (S[i] < 0) & (g.ys > pr.top[i] + 0.5 * g.h)
        plate[i] = wing & (g.ys >= yt - w["plate"])
        band[i] = wing & (g.ys >= yt - w["band"])
        upright[i] = wing & (g.ys < yt - w["band"])
    return plate, band, upright


def occupancy(body: Body) -> np.ndarray:
    """The wing parts as a boolean voxel volume (for the texture bake's visibility test)."""
    g, w = body.grid, body.wing
    plate, band, upright = _profiles(body)
    z = np.abs(g.zs)
    occ = plate[:, :, None] & (z <= w["span"])[None, None, :]
    occ |= band[:, :, None] & ((z <= w["span"]) & (z >= w["span"] - w["endplate"]))[None, None, :]
    occ |= upright[:, :, None] & (np.abs(z - w["upright_z"]) <= w["upright"] / 2)[None, None, :]
    return occ


def _polygons(mask: np.ndarray, body: Body) -> list[Polygon]:
    """Outlines of a (nx, ny) profile mask as simplified polygons in model (x, y)."""
    g = body.grid
    img = np.ascontiguousarray(mask.T[::-1].astype(np.uint8))  # rows = y descending, cols = x
    img = cv2.resize(img, None, fx=4, fy=4, interpolation=cv2.INTER_NEAREST)  # smoother contours
    img = cv2.GaussianBlur(img * 255, (5, 5), 0)
    cnts, _ = cv2.findContours((img > 127).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    polys = []
    for c in cnts:
        if cv2.contourArea(c) < 16 * 4:
            continue
        c = cv2.approxPolyDP(c, 2.0, True)[:, 0, :].astype(float) / 4
        if len(c) < 3:
            continue
        xs = g.xs[0] + c[:, 0] * g.h
        ys = g.ys[-1] - c[:, 1] * g.h
        poly = Polygon(np.stack([xs, ys], 1)).buffer(0)
        if poly.area > 0:
            polys.extend(poly.geoms if hasattr(poly, "geoms") else [poly])
    return polys


def meshes(body: Body) -> list[trimesh.Trimesh]:
    """Plate, two endplates and two uprights as closed meshes in the model frame."""
    w = body.wing
    plate, band, upright = _profiles(body)
    out = []

    def slab(polys, z0, z1):
        for poly in polys:
            m = trimesh.creation.extrude_polygon(poly, z1 - z0)
            m.apply_translation([0, 0, z0])
            out.append(m)

    slab(_polygons(plate, body), -w["span"], w["span"])
    band_polys = _polygons(band, body)
    slab(band_polys, w["span"] - w["endplate"], w["span"])
    slab(band_polys, -w["span"], -w["span"] + w["endplate"])
    up_polys = _polygons(upright, body)
    for sgn in (1, -1):
        zc = sgn * w["upright_z"]
        slab(up_polys, zc - w["upright"] / 2, zc + w["upright"] / 2)
    return out
