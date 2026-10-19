"""Slice a reference sheet into its views, each with a clean car matte.

Layouts (reference-collector skill), white background with white gutters between views:
  four-view: right profile (nose right) / overhead (nose right) / front + rear side by side
  five-view: right profile (nose right) / left profile (nose left) / overhead / front + rear
Panel names: side (the car's right side), left, top, front, rear.
Every panel comes out in that canonical orientation: a manifest layout whose overhead entry says
`"nose_direction": "left"` gets its top crop turned 180 deg (nose right, the car's left side at the top).
Sheet-px coordinates for that view (hints polygons, `outline`, trace-top.png) then refer to the turned
drawing, laid back into the same box: x' = ox + (w - 1 - (x - ox)), likewise y.
"""
from dataclasses import dataclass
from functools import lru_cache

import cv2
import numpy as np
from PIL import Image

NAMES = ("side", "left", "top", "front", "rear")
MATTE_VERSION = "m2"  # bump when matte() changes, so cached mattes are rebuilt
GLASS = np.array([30, 34, 40], np.uint8)  # see-through side windows become this dark tint
# manifest `layout` entries -> panel names
LAYOUT_NAMES = {"right": "side", "right_profile": "side", "side": "side", "left": "left", "left_profile": "left",
                "top": "top", "overhead": "top", "front": "front", "rear": "rear"}


@dataclass
class Panel:
    name: str
    rgb: np.ndarray  # uint8 HxWx3 crop of the sheet
    alpha: np.ndarray  # float32 HxW car matte in [0, 1]
    mask: np.ndarray  # bool HxW, the silhouette used for geometry
    origin: tuple[int, int]  # crop's top-left in sheet pixels
    bbox: tuple[int, int, int, int]  # tight car box in crop px: x0, y0, x1, y1 (exclusive)
    holes: np.ndarray | None = None  # side views: see-through windows the matte left open (bool)
    glass: np.ndarray | None = None  # set by glass.find(): window pixels (bool)
    turned: bool = False  # crop turned 180 deg to nose right (a nose-left overhead, turned_views)

    @property
    def size(self):
        x0, y0, x1, y1 = self.bbox
        return x1 - x0, y1 - y0


def not_white(rgb: np.ndarray, white_tol: int = 24, chroma_tol: int = 18) -> np.ndarray:
    """Pixels that are darker than white or visibly coloured (cream paint, chrome tint)."""
    f = rgb.astype(np.int16)
    lo, hi = f.min(axis=2), f.max(axis=2)
    return ((255 - lo) > white_tol) | ((hi - lo) > chroma_tol)


def _runs(flags: np.ndarray, min_gap: int) -> list[tuple[int, int]]:
    """Contiguous True runs as [start, end), merging runs separated by fewer than min_gap Falses."""
    idx = np.flatnonzero(flags)
    if not len(idx):
        return []
    runs, start, prev = [], idx[0], idx[0]
    for i in idx[1:]:
        if i - prev > min_gap:
            runs.append((start, prev + 1))
            start = i
        prev = i
    runs.append((start, prev + 1))
    return runs


def _valley_cuts(occ: np.ndarray, n_cuts: int, min_sep: float) -> list[int]:
    """Cut positions at the emptiest lines of an occupancy profile, at least min_sep apart - for sheets
    whose views nearly touch (a tyre or surfboard tip bridging the white gutter)."""
    sm = np.convolve(occ.astype(float), np.ones(9) / 9, mode="same")
    lo, hi = int(0.04 * len(occ)), int(0.96 * len(occ))
    cuts = []
    for y in np.argsort(sm[lo:hi], kind="stable") + lo:
        if all(abs(int(y) - c) > min_sep for c in cuts):
            cuts.append(int(y))
        if len(cuts) == n_cuts:
            break
    return sorted(cuts)


def _bands(occ: np.ndarray, n: int, gutter: int, min_frac: float) -> list[tuple[int, int]]:
    """n content bands along one axis: split at white gutters, or at the emptiest lines if the views
    touch."""
    bands = [r for r in _runs(occ > 3, gutter) if r[1] - r[0] > min_frac * len(occ)]
    if len(bands) == n:
        return bands
    edges = [0] + _valley_cuts(occ, n - 1, min_sep=0.6 * len(occ) / n) + [len(occ)]
    return [(edges[i], edges[i + 1]) for i in range(n)]


def panel_boxes(rgb: np.ndarray, layout: list[str] | None = None, gutter: int = 14) -> dict[str, tuple]:
    """Find the views: one view per row band, the last band split into two columns (front, rear).
    `layout` (manifest order) gives the row naming; without it, 3 or 4 rows are guessed from gutters."""
    fg = cv2.morphologyEx(not_white(rgb).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    occ_rows = fg.sum(axis=1)
    if layout:  # manifest entries: names, or {"id", "row", "column"} dicts
        if isinstance(layout[0], dict):
            layout = [e["id"] for e in sorted(layout, key=lambda e: (e.get("row", 0), e.get("column") == "right"))]
        names = [LAYOUT_NAMES[n] for n in layout]
        row_names = names[:-2]
    else:
        n_found = len([r for r in _runs(occ_rows > 3, gutter) if r[1] - r[0] > 0.06 * rgb.shape[0]])
        row_names = {3: ["side", "top"], 4: ["side", "left", "top"]}.get(n_found)
        if row_names is None:
            raise ValueError(f"expected 3 or 4 rows of views, found {n_found}: give the manifest a layout")
    rows = _bands(occ_rows, len(row_names) + 1, gutter, 0.06)

    def tight(x0, y0, x1, y1):
        sub = fg[y0:y1, x0:x1]
        ys, xs = np.nonzero(sub)
        return (x0 + xs.min(), y0 + ys.min(), x0 + xs.max() + 1, y0 + ys.max() + 1)

    boxes = {}
    for name, (y0, y1) in zip(row_names, rows):
        boxes[name] = tight(0, y0, rgb.shape[1], y1)
    y0, y1 = rows[-1]
    (a0, a1), (b0, b1) = _bands(fg[y0:y1].sum(axis=0), 2, gutter, 0.1)
    boxes["front"] = tight(a0, y0, a1, y1)
    boxes["rear"] = tight(b0, y0, b1, y1)
    return boxes


@lru_cache(maxsize=1)
def _session(model: str):
    from rembg import new_session

    return new_session(model)


def matte(rgb: np.ndarray, model: str = "birefnet-general") -> np.ndarray:
    """Soft car matte: BiRefNet, plus thin non-white detail it dropped right next to its mask."""
    from rembg import remove

    a = np.asarray(remove(Image.fromarray(rgb), session=_session(model), only_mask=True), np.float32) / 255
    near = cv2.dilate((a > 0.5).astype(np.uint8), np.ones((7, 7), np.uint8)).astype(bool)
    thr = cv2.morphologyEx(not_white(rgb).astype(np.uint8), cv2.MORPH_OPEN, np.ones((2, 2), np.uint8)).astype(bool)
    return np.where(near & thr, np.maximum(a, 0.9), a).astype(np.float32)


def silhouette(alpha: np.ndarray, max_hole_frac: float = 0.004) -> np.ndarray:
    """Binary silhouette: keep the car's components, fill small holes (white lettering, glints) only —
    a big enclosed hole is a real gap, e.g. under a rear wing."""
    m = (alpha > 0.5).astype(np.uint8)
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    if n > 1:
        areas = stats[1:, cv2.CC_STAT_AREA]
        h, w = m.shape
        keep = []
        for k in range(1, n):
            x, y, bw, bh, area = stats[k]
            at_edge = y <= 1 or y + bh >= h - 1  # cut off from the view above/below
            if area >= areas.max() * (0.15 if at_edge and area < areas.max() else 0.005):
                keep.append(k)
        m = np.isin(lab, keep).astype(np.uint8)
    inv = 1 - m
    n, lab, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    h, w = m.shape
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        touches = x == 0 or y == 0 or x + bw == w or y + bh == h
        if not touches and area < m.sum() * max_hole_frac:
            m[lab == i] = 1
    return m.astype(bool)


def turned_views(layout) -> set[str]:
    """Views drawn the other way round from the canonical one: the overhead with its nose LEFT (manifest
    layout `nose_direction`). Side views keep their own convention (right nose right, left nose left)."""
    if not layout or not isinstance(layout[0], dict):
        return set()
    return {"top" for e in layout if LAYOUT_NAMES.get(e.get("id")) == "top" and e.get("nose_direction") == "left"}


def load(path, margin: int = 16, model: str = "birefnet-general", cache_dir=None, layout=None) -> dict[str, Panel]:
    """Panels with mattes. Mattes are cached per sheet hash in cache_dir (segmentation is ~10 s each)."""
    import hashlib
    from pathlib import Path

    raw = Path(path).read_bytes()
    key = hashlib.sha256(raw).hexdigest()[:16]
    rgb = np.asarray(Image.open(path).convert("RGB"))
    turned = turned_views(layout)
    panels = {}
    for name, (x0, y0, x1, y1) in panel_boxes(rgb, layout).items():
        cx0, cy0 = max(0, x0 - margin), max(0, y0 - margin)
        cx1, cy1 = min(rgb.shape[1], x1 + margin), min(rgb.shape[0], y1 + margin)
        crop = rgb[cy0:cy1, cx0:cx1]
        crop = np.ascontiguousarray(crop[::-1, ::-1] if name in turned else crop)  # 180 deg: nose right
        rot = "-r180" if name in turned else ""
        cached = Path(cache_dir) / f"matte-{MATTE_VERSION}-{model}-{name}-{key}-{cx0}-{cy0}-{cx1}-{cy1}{rot}.png" if cache_dir else None
        if cached and cached.is_file():
            a = np.asarray(Image.open(cached), np.float32) / 255
        else:
            a = matte(crop, model)
            if cached:
                cached.parent.mkdir(parents=True, exist_ok=True)
                Image.fromarray(np.round(a * 255).astype(np.uint8)).save(cached)
        m = silhouette(a, max_hole_frac=1.0 if name in ("side", "left") else 0.004)
        holes = None
        if name in ("side", "left"):
            # Side rows draw windows see-through onto the white sheet. The matte calls them background,
            # the filled silhouette calls them car: paint them as tinted glass so they don't glow.
            holes = m & (a < 0.5)
            crop = crop.copy()
            crop[holes] = GLASS
            a = np.where(holes, 1.0, a).astype(np.float32)
        ys, xs = np.nonzero(m)
        panels[name] = Panel(name, crop, a, m, (cx0, cy0), (int(xs.min()), int(ys.min()), int(xs.max()) + 1, int(ys.max()) + 1),
                             holes, turned=name in turned)
    return panels


def read_canonical(path, panels: dict[str, Panel]) -> np.ndarray:
    """The sheet image (RGB) with every turned view (turned_views) laid back in its box nose-right, so
    sheet-px overlays (qa panels.jpg, glass.jpg) line up with the panels."""
    rgb = np.asarray(Image.open(path).convert("RGB")).copy()
    for p in panels.values():
        if p.turned:
            ox, oy = p.origin
            h, w = p.rgb.shape[:2]
            rgb[oy:oy + h, ox:ox + w] = p.rgb
    return rgb


def debug_image(panels: dict[str, Panel], sheet_rgb: np.ndarray) -> np.ndarray:
    """Sheet with each panel's silhouette outline and tight box drawn on it (BGR for cv2.imwrite)."""
    out = cv2.cvtColor(sheet_rgb, cv2.COLOR_RGB2BGR).copy()
    colours = {"side": (0, 160, 255), "left": (0, 220, 220), "top": (0, 200, 0), "front": (255, 80, 0), "rear": (200, 0, 200)}
    for p in panels.values():
        ox, oy = p.origin
        cnts, _ = cv2.findContours(p.mask.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(out, [c + np.array([ox, oy]) for c in cnts], -1, colours[p.name], 2)
        x0, y0, x1, y1 = p.bbox
        cv2.rectangle(out, (ox + x0, oy + y0), (ox + x1 - 1, oy + y1 - 1), colours[p.name], 1)
        cv2.putText(out, p.name, (ox + x0, oy + y0 - 4), cv2.FONT_HERSHEY_SIMPLEX, 0.6, colours[p.name], 2)
    return out
