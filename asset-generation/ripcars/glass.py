"""Find the windows in every view, with clean edges, so glass gets its own material.

Per view: a greenhouse prior (where glass can be: the cabin's stretch of the car, above the
beltline) seeds GrabCut with what is surely glass (see-through holes in the side rows; grey,
colourless pixels unlike the paint) and surely not (outside the prior; pixels that match the paint),
and GrabCut snaps the boundary to the window frames' edges. Hand-drawn polygons in hints.json
(`model.glass.add` / `model.glass.remove`, sheet px) override the result where it's wrong.
"""
import cv2
import numpy as np

from .hull import Grid, Profiles
from .sheet import Panel
from .views import Calibration


def greenhouse(cal: Calibration, grid: Grid, pr: Profiles) -> dict:
    """Beltline height and the cabin's x-range, in model units."""
    valid = ~np.isnan(pr.top)
    tmpl = 0.5 * (pr.tf + pr.tr)
    peak = float(np.max(tmpl))
    above = (grid.ys > 0.4 * cal.H) & (tmpl < 0.85 * peak)
    belt = float(grid.ys[np.flatnonzero(above)[0]]) if above.any() else 0.55 * cal.H
    roof = float(np.nanmax(pr.top))
    cabin = valid & (np.nan_to_num(pr.top) > belt + 0.15 * (roof - belt))
    runs = np.split(np.flatnonzero(cabin), np.flatnonzero(np.diff(np.flatnonzero(cabin)) > 1) + 1)
    run = max(runs, key=len) if len(runs[0]) else np.flatnonzero(valid)
    return {"belt": belt, "roof": roof, "x0": float(grid.xs[run[0]]), "x1": float(grid.xs[run[-1]])}


def _prior(panel: Panel, view, gh: dict) -> np.ndarray:
    """Where glass may be, in panel px."""
    h, w = panel.mask.shape
    vv, uu = np.mgrid[0:h, 0:w]
    if view.name in ("side", "left", "top"):
        (ua, ub), _ = view.to_px(np.array([[gh["x0"], 0, 0], [gh["x1"], 0, 0]]))
        lo, hi = sorted((ua, ub))
        pad = 0.04 * abs(hi - lo)
        inx = (uu > lo - pad) & (uu < hi + pad)
    else:
        inx = np.ones((h, w), bool)
    if view.name == "top":
        return inx & panel.mask
    _, (vb,) = view.to_px(np.array([[0, gh["belt"], 0]]))
    return inx & (vv < vb) & panel.mask


def _lab(rgb):
    return cv2.cvtColor(rgb, cv2.COLOR_RGB2LAB).astype(np.float32)


def find(panel: Panel, view, gh: dict, paint: np.ndarray, iters: int = 4) -> np.ndarray:
    """Window mask for one panel (bool, panel px)."""
    prior = _prior(panel, view, gh)
    if prior.sum() < 50:
        return np.zeros_like(panel.mask)
    lab = _lab(panel.rgb)
    chroma = np.hypot(lab[..., 1] - 128, lab[..., 2] - 128)
    de_paint = np.linalg.norm(lab - paint[None, None], axis=2)
    glassy = (chroma < 16) & (de_paint > 24)
    gc = np.full(panel.mask.shape, cv2.GC_BGD, np.uint8)
    gc[prior] = cv2.GC_PR_BGD
    gc[prior & glassy] = cv2.GC_PR_FGD
    sure = cv2.erode((prior & glassy).astype(np.uint8), np.ones((5, 5), np.uint8)).astype(bool)
    if panel.holes is not None:
        sure |= cv2.erode(panel.holes.astype(np.uint8), np.ones((3, 3), np.uint8)).astype(bool)
    gc[sure] = cv2.GC_FGD
    gc[prior & (de_paint < 10)] = cv2.GC_BGD
    if not (gc == cv2.GC_FGD).any() and not (gc == cv2.GC_PR_FGD).any():
        return np.zeros_like(panel.mask)
    bgd, fgd = np.zeros((1, 65), np.float64), np.zeros((1, 65), np.float64)
    try:
        cv2.grabCut(np.ascontiguousarray(panel.rgb[:, :, ::-1]), gc, None, bgd, fgd, iters, cv2.GC_INIT_WITH_MASK)
    except cv2.error:
        pass
    m = ((gc == cv2.GC_FGD) | (gc == cv2.GC_PR_FGD)) & prior
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, np.ones((3, 3), np.uint8))
    m = cv2.morphologyEx(m, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    n, lab_, stats, _ = cv2.connectedComponentsWithStats(m, connectivity=8)
    keep = [i for i in range(1, n) if stats[i, cv2.CC_STAT_AREA] > 0.002 * panel.mask.sum()]
    m = np.isin(lab_, keep)
    # fill pinholes (reflections, seat highlights) inside each window
    inv = (~m).astype(np.uint8)
    n, lab_, stats, _ = cv2.connectedComponentsWithStats(inv, connectivity=4)
    for i in range(1, n):
        x, y, bw, bh, area = stats[i]
        if area < 0.01 * max(1, m.sum()) and x > 0 and y > 0 and x + bw < m.shape[1] and y + bh < m.shape[0]:
            m[lab_ == i] = True
    # clean outlines: windows are big, smooth, hole-free shapes
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9)))
    m = cv2.morphologyEx(m, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))).astype(bool)
    return m & panel.mask


def belt_line(cal: Calibration):
    """(slope, intercept): height of the side windows' lower edge along the car, fitted to the side
    view's glass. Glass never sits below it (minus a little for the windscreen's corners)."""
    v = cal.views["side"]
    g = v.panel.glass
    if g is None or not g.any():
        return None
    cols = np.flatnonzero(g.any(axis=0))
    xs = (cols - v.uc) * v.su
    ys = np.array([(v.vg - np.flatnonzero(g[:, c]).max()) * v.sv for c in cols])
    lo = np.percentile(ys, 20)
    keep = ys < lo + 0.06 * cal.H  # the lower edge proper, not glass that ends higher (quarter windows)
    if keep.sum() < 5:
        return None
    return tuple(np.polyfit(xs[keep], ys[keep], 1))


def apply_overrides(panel: Panel, mask: np.ndarray, overrides: dict | None) -> np.ndarray:
    """hints.json model.glass, polygons in sheet px:
    {"replace": [views whose automatic mask is dropped], "remove": {view: [polygon, ...]}, "add": {...}}
    Applied in that order, so hand-traced windows always win."""
    if not overrides:
        return mask
    ox, oy = panel.origin
    out = np.zeros_like(mask, np.uint8) if panel.name in overrides.get("replace", []) else mask.astype(np.uint8)
    for key, value in (("remove", 0), ("add", 1)):
        for poly in (overrides.get(key) or {}).get(panel.name, []):
            pts = np.round(np.array(poly, float) - [ox, oy]).astype(np.int32)
            cv2.fillPoly(out, [pts], value)
    return out.astype(bool) & panel.mask


def find_all(cal: Calibration, grid: Grid, pr: Profiles, overrides: dict | None = None) -> dict:
    gh = greenhouse(cal, grid, pr)
    side = cal.views["side"].panel
    pix = _lab(side.rgb)[side.mask][::7]
    _, labels, centres = cv2.kmeans(pix, 4, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 2,
                                    cv2.KMEANS_PP_CENTERS)
    paint = centres[np.argmax(np.bincount(labels.ravel(), minlength=4))]
    for name, view in cal.views.items():
        view.panel.glass = apply_overrides(view.panel, find(view.panel, view, gh, paint), overrides)
    return gh


def debug_image(cal: Calibration, sheet_rgb: np.ndarray) -> np.ndarray:
    """Sheet with every view's window mask tinted cyan and outlined (BGR)."""
    out = cv2.cvtColor(sheet_rgb, cv2.COLOR_RGB2BGR).copy()
    for view in cal.views.values():
        p = view.panel
        if p.glass is None:
            continue
        ox, oy = p.origin
        h, w = p.glass.shape
        roi = out[oy:oy + h, ox:ox + w]
        roi[p.glass] = (0.45 * roi[p.glass] + 0.55 * np.array([255, 200, 0])).astype(np.uint8)
        cnts, _ = cv2.findContours(p.glass.astype(np.uint8), cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
        cv2.drawContours(roi, cnts, -1, (255, 255, 0), 1)
    return out


def cabin(cal: Calibration, grid: Grid, pr: Profiles, min_run: float = 0.08) -> dict | None:
    """The greenhouse measured from the windows, per slice along the car (model units, nan = unknown):
      belt   height of the side windows' lower edge (side view glass)
      z_out  half-width where the side glass meets the shoulder (top view: outer edge of the glass strip)
      z_in   half-width of the roof (top view: inner edge of the glass strip)
    Only slices where the top view shows two side strips with roof between them count; the windscreen
    and rear-window stretches are left to the front/rear views."""
    side, top = cal.views["side"], cal.views["top"]
    if side.panel.glass is None or top.panel.glass is None:
        return None
    nx = len(grid.xs)
    belt, z_in, z_out = (np.full(nx, np.nan) for _ in range(3))
    sh, th = side.panel.glass, top.panel.glass
    for i, x in enumerate(grid.xs):
        if np.isnan(pr.top[i]):
            continue
        (u,), _ = side.to_px(np.array([[x, 0.0, 0.0]]))
        u = int(round(u))
        if 0 <= u < sh.shape[1] and sh[:, u].any():
            belt[i] = (side.vg - np.flatnonzero(sh[:, u]).max()) * side.sv
        (u,), _ = top.to_px(np.array([[x, 0.0, 0.0]]))
        u = int(round(u))
        if not (0 <= u < th.shape[1]):
            continue
        rows = np.flatnonzero(th[:, u])
        centre = int(round(top.vg))
        if len(rows) < 4 or th[max(0, centre - 2):centre + 3, u].any():
            continue  # no glass, or glass across the middle (windscreen / rear window)
        z = (rows - top.vg) * top.sv
        lo, hi = z[z < 0], z[z > 0]
        if not len(lo) or not len(hi):
            continue
        zi = (abs(lo.max()) + hi.min()) / 2  # inner edges of both strips
        zo = (abs(lo.min()) + hi.max()) / 2  # outer edges
        if zo - zi > 0.01 and zi > 0.15 * cal.W_body / 2 and zo <= 1.02 * pr.w[i]:
            z_in[i], z_out[i] = zi, zo
    ok = ~np.isnan(z_in) & ~np.isnan(belt)
    if ok.sum() * grid.h < min_run * cal.L:
        return None
    # keep the longest run, smooth it, drop strays
    idx = np.flatnonzero(ok)
    runs = np.split(idx, np.flatnonzero(np.diff(idx) > 3) + 1)
    run = max(runs, key=len)
    keep = np.zeros(nx, bool)
    keep[run[0]:run[-1] + 1] = True
    out = {}
    for k, v in (("belt", belt), ("z_in", z_in), ("z_out", z_out)):
        vv = np.where(keep, v, np.nan)
        good = ~np.isnan(vv)
        filled = np.interp(np.arange(nx), np.flatnonzero(good), vv[good])
        med = filled.copy()
        win = 7
        for j in range(run[0], run[-1] + 1):
            a, b = max(run[0], j - win), min(run[-1], j + win) + 1
            med[j] = np.median(filled[a:b])
        out[k] = np.where(keep, med, np.nan)
    out["x"] = (float(grid.xs[run[0]]), float(grid.xs[run[-1]]))
    return out
