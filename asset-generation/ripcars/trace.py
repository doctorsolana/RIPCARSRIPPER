"""Review images for a generated mesh (Tripo route), all in the reference sheet's own pixel grid, so
anything traced on them goes straight into hints.json (model.rebake.glass, sheet px):

  qa/<car>/tripo-sheet.png    the mesh with its own texture, laid out like the sheet
  qa/<car>/tripo-clay.png     the same, clay-shaded: the real panel edges, which Tripo's paint may not follow
  qa/<car>/trace-<view>.png   one view's windows, zoomed, textured above clay, with a sheet-px ruler,
                              the sheet's own window outline (cyan) and the traced glass (magenta,
                              after mirroring) - what you trace windows on
  qa/<car>/glass-map.jpg      every view: the sheet | the repainted model with its glass in magenta
"""
import cv2
import numpy as np

from . import render

MAGENTA = (255, 0, 255)
CYAN = (0, 200, 255)


def canvas(cal, images: dict) -> np.ndarray:
    """Panel-sized images (one per view) placed where their panels sit on the sheet; white elsewhere."""
    h = max(v.panel.origin[1] + v.panel.rgb.shape[0] for v in cal.views.values())
    w = max(v.panel.origin[0] + v.panel.rgb.shape[1] for v in cal.views.values())
    out = np.full((h, w, 3), 255, np.uint8)
    for name, img in images.items():
        ox, oy = cal.views[name].panel.origin
        out[oy:oy + img.shape[0], ox:ox + img.shape[1]] = img
    return out


def clay(view, raster: render.Raster, normals_face: np.ndarray) -> np.ndarray:
    """Grey shading from the face normals: a light along the view plus one from above-front, so sloped
    glass, flat roof and body sides come out as different greys."""
    h, w = raster.face.shape
    out = np.full((h, w, 3), 255, np.uint8)
    cov = raster.cover
    n = normals_face[raster.face[cov]]
    key = np.array([0.45, 0.75, 0.35])
    key /= np.linalg.norm(key)
    s = 0.18 + 0.5 * np.abs(n @ view.direction) + 0.32 * np.clip(n @ key, 0, 1)
    out[cov] = (np.clip(s, 0, 1)[:, None] * [235, 235, 230]).astype(np.uint8)
    return out


def window_region(view, *masks) -> tuple | None:
    """Panel-px box around every window in the masks, with a margin, inside the car's box."""
    boxes = [cv2.boundingRect(m.astype(np.uint8)) for m in masks if m is not None and m.any()]
    if not boxes:
        return None
    x0 = min(b[0] for b in boxes); y0 = min(b[1] for b in boxes)
    x1 = max(b[0] + b[2] for b in boxes); y1 = max(b[1] + b[3] for b in boxes)
    bx0, by0, bx1, by1 = view.panel.bbox
    m = int(0.15 * (by1 - by0))
    return max(bx0 - 14, x0 - m), max(by0 - 14, y0 - m), min(bx1 + 14, x1 + m), min(by1 + 14, y1 + m)


def ruler(view, textured: np.ndarray, shaded: np.ndarray, glass: np.ndarray | None = None,
          points: list | None = None, max_width: int = 1500, region: tuple | None = None,
          sheet_glass: np.ndarray | None = None) -> np.ndarray:
    """A region of the view (default: the car's box plus a margin) from both renders, stacked and
    enlarged, with a ruler in sheet px: thin lines every 10 px, labelled ones every 50. `glass`
    (panel-sized bool) is drawn as a magenta outline, `sheet_glass` (the drawing's own windows) as a
    thin cyan one, `points` (sheet px polygons) as dots on their corners."""
    h, w = view.panel.mask.shape
    if region is None:
        x0, y0, x1, y1 = view.panel.bbox
        region = (x0 - 14, y0 - 14, x1 + 14, y1 + 14)
    x0, y0, x1, y1 = max(0, region[0]), max(0, region[1]), min(w, region[2]), min(h, region[3])
    k = max(1, min(4, max_width // (x1 - x0)))
    ox, oy = view.panel.origin
    rows = []
    for img in (textured, shaded):
        crop = cv2.resize(img[y0:y1, x0:x1], ((x1 - x0) * k, (y1 - y0) * k), interpolation=cv2.INTER_NEAREST)
        g = crop.astype(np.float32)
        for sx in range((ox + x0 + 9) // 10 * 10, ox + x1, 10):  # vertical lines at sheet x = sx
            c = (sx - ox - x0) * k
            g[:, c] = g[:, c] * (0.55 if sx % 50 == 0 else 0.85) + (0 if sx % 50 == 0 else 30)
        for sy in range((oy + y0 + 9) // 10 * 10, oy + y1, 10):
            r = (sy - oy - y0) * k
            g[r, :] = g[r, :] * (0.55 if sy % 50 == 0 else 0.85) + (0 if sy % 50 == 0 else 30)
        crop = np.clip(g, 0, 255).astype(np.uint8)
        if sheet_glass is not None and sheet_glass.any():
            cs, _ = cv2.findContours(sheet_glass[y0:y1, x0:x1].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(crop, [c * k + k // 2 for c in cs], -1, CYAN, 1)
        if glass is not None and glass.any():
            cs, _ = cv2.findContours(glass[y0:y1, x0:x1].astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
            cv2.drawContours(crop, [c * k + k // 2 for c in cs], -1, MAGENTA, 2)
        for poly in points or []:
            for px, py in poly:
                cv2.circle(crop, (int(round((px - ox - x0) * k)), int(round((py - oy - y0) * k))), 4, MAGENTA, -1)
        # labelled margins: sheet x along the top, sheet y down the left
        pad_t, pad_l = 18, 44
        framed = np.full((crop.shape[0] + pad_t, crop.shape[1] + pad_l, 3), 255, np.uint8)
        framed[pad_t:, pad_l:] = crop
        for sx in range((ox + x0 + 49) // 50 * 50, ox + x1, 50):
            cv2.putText(framed, str(sx), (pad_l + (sx - ox - x0) * k - 12, 13), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
        for sy in range((oy + y0 + 49) // 50 * 50, oy + y1, 50):
            cv2.putText(framed, str(sy), (2, pad_t + (sy - oy - y0) * k + 4), cv2.FONT_HERSHEY_SIMPLEX, 0.4, (0, 0, 0), 1, cv2.LINE_AA)
        rows.append(framed)
    return np.vstack([rows[0], np.full((8, rows[0].shape[1], 3), 255, np.uint8), rows[1]])


def glass_map(cal, rasters: dict, F: np.ndarray, uv_topleft: np.ndarray, tex: np.ndarray, glass_uv: np.ndarray) -> np.ndarray:
    """Per view, the sheet's drawing beside the repainted model with every glass texel in magenta."""
    g = cv2.resize(glass_uv, (tex.shape[1], tex.shape[0]), interpolation=cv2.INTER_NEAREST).astype(bool)
    marked = tex.copy()
    marked[g] = (0.35 * marked[g] + 0.65 * np.array(MAGENTA)).astype(np.uint8)
    tiles = []
    for name, v in cal.views.items():
        x0, y0, x1, y1 = v.panel.bbox
        img = render.lookup_texture(rasters[name], F, uv_topleft, marked)
        pair = np.hstack([v.panel.rgb[y0:y1, x0:x1], np.full((y1 - y0, 6, 3), 255, np.uint8), img[y0:y1, x0:x1]])
        head = np.full((24, pair.shape[1], 3), 255, np.uint8)
        cv2.putText(head, f"{name}: sheet | model, glass in magenta", (4, 17), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
        tiles.append(np.vstack([head, pair]))
    w = max(t.shape[1] for t in tiles)
    tiles = [np.pad(t, ((0, 10), (0, w - t.shape[1]), (0, 0)), constant_values=255) for t in tiles]
    return np.vstack(tiles)


def dark_outlines(sheet_like: np.ndarray, region: tuple, dark: int = 110, min_area: int = 300) -> list[dict]:
    """Outlines (sheet px) of the dark regions inside `region` (x0, y0, x1, y1, sheet px) of an image
    in the sheet's pixel grid - on tripo-sheet.png that is where the generator painted its windows,
    which sits on its own window openings: a first outline for model.rebake.glass. Biggest first."""
    x0, y0, x1, y1 = (int(round(c)) for c in region)
    crop = sheet_like[y0:y1, x0:x1]
    m = cv2.morphologyEx((crop.max(axis=2) < dark).astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    n, lab, stats, _ = cv2.connectedComponentsWithStats(m)
    out = []
    for i in range(1, n):
        x, y, w, h, a = stats[i]
        if a < min_area:
            continue
        cs, _ = cv2.findContours((lab == i).astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        poly = cv2.approxPolyDP(max(cs, key=cv2.contourArea), 2.0, True)[:, 0] + [x0, y0]
        out.append({"area": int(a), "box": [int(x + x0), int(y + y0), int(x + x0 + w), int(y + y0 + h)],
                    "polygon": poly.tolist()})
    return sorted(out, key=lambda o: -o["area"])

