"""Review images for a generated mesh (Tripo route), all in the reference sheet's own pixel grid, so
anything traced on them goes straight into hints.json (model.rebake.glass, sheet px):

  qa/<car>/tripo-sheet.png    the mesh with its own texture, laid out like the sheet
  qa/<car>/tripo-clay.png     the same, clay-shaded: the real panel edges, which Tripo's paint may not follow
  qa/<car>/trace-<view>.png   one view, enlarged, textured above clay, with a sheet-px ruler and the
                              traced glass outline (after mirroring) - what you trace windows on
  qa/<car>/glass-map.jpg      every view: the sheet | the repainted model with its glass in magenta
"""
import cv2
import numpy as np

from . import render

MAGENTA = (255, 0, 255)


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


def ruler(view, textured: np.ndarray, shaded: np.ndarray, glass: np.ndarray | None = None,
          points: list | None = None, max_width: int = 1500) -> np.ndarray:
    """The view's car box (plus a margin) from both renders, stacked and enlarged, with a ruler in
    sheet px: thin lines every 10 px, labelled ones every 50. `glass` (panel-sized bool) is drawn as a
    magenta outline, `points` (sheet px polygons) as dots on their corners."""
    x0, y0, x1, y1 = view.panel.bbox
    h, w = view.panel.mask.shape
    m = 14
    x0, y0, x1, y1 = max(0, x0 - m), max(0, y0 - m), min(w, x1 + m), min(h, y1 + m)
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
