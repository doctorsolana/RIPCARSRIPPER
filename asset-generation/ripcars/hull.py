"""Body volume from the four views.

Main body = a loft. Every slice along the car takes
  - its height range from the side view (tyres and wing removed),
  - its half-width from the overhead view (mirrors removed),
  - its *shape* from the front view (front half) / rear view (rear half): the views' half-width
    profile over height, rescaled into the slice's own height range and width.
So a narrow nose gets a small, correctly shaped section instead of the box a pure visual hull gives.

Extras = the visual hull (exact intersection of the extruded silhouettes) outside the body's
per-slice box: wings and their stands, mirrors, splitters. Thin parts survive because the hull's
crease rounding shrinks with local thickness. Wheel wells are carved only where the tyres sit.
"""
from dataclasses import dataclass

import cv2
import numpy as np
from scipy import ndimage

from .views import Calibration, View


# ---- SDF helpers ---------------------------------------------------------------------------------

def smax(a, b, k):
    """Polynomial smooth max (smooth intersection) with blend radius k (scalar or array)."""
    k = np.maximum(k, 1e-6)
    h = np.maximum(k - np.abs(a - b), 0.0) / k
    return np.maximum(a, b) + h * h * k * 0.25


def smin(a, b, k):
    return -smax(-a, -b, k)


def smoothstep(e0, e1, x):
    t = np.clip((x - e0) / (e1 - e0), 0.0, 1.0)
    return t * t * (3 - 2 * t)


def _median1d(v: np.ndarray, win: int) -> np.ndarray:
    win = max(3, win | 1)
    pad = np.pad(v, win // 2, mode="edge")
    return np.median(np.lib.stride_tricks.sliding_window_view(pad, win), axis=1)


def _open1d(v: np.ndarray, win: int) -> np.ndarray:
    """1D morphological opening: removes bumps narrower than `win` (mirrors), keeps broad shapes
    (wheel-arch flares) intact."""
    win = max(3, win | 1)
    return ndimage.grey_dilation(ndimage.grey_erosion(v, size=win, mode="nearest"), size=win, mode="nearest")


def _straight_greenhouse(t: np.ndarray, grid: "Grid", peak: int, roof: float, fit_to: float = 0.8) -> np.ndarray:
    """Make the cabin's flanks straight. Above the beltline the front/rear views are drawn from a little
    above, so their outline curves in towards the roof like a dome; real greenhouses slope in along a
    near-straight line (tumblehome) up to a flat roof. Keep the drawn width at the beltline and along
    the lower `fit_to` of the cabin, fit a line through that, and follow it up to the roof."""
    j_belt = next((j for j in range(peak, len(t)) if t[j] < 0.9 * t[peak]), None)
    j_roof = int(np.searchsorted(grid.ys, roof)) - 1
    if j_belt is None or j_roof - j_belt < 6:
        return t
    j_fit = j_belt + max(3, int(fit_to * (j_roof - j_belt)))
    js = np.arange(j_belt, j_fit + 1)
    slope = np.polyfit(js, t[js], 1)[0]
    out = t.copy()
    rows = np.arange(j_belt, j_roof + 1)
    out[rows] = np.maximum(t[j_belt] + slope * (rows - j_belt), 0.25 * t[peak])  # starts where the drawn outline ends
    out[j_roof + 1:] = np.minimum(t[j_roof + 1:], out[j_roof])  # rows above the roof: wing etc. only
    return out


def _unimodal(v: np.ndarray, peak: int) -> np.ndarray:
    """Largest profile <= v that never rises again moving away from `peak`: bodywork narrows above its
    widest point and the roofline falls towards both ends. Mirrors, wings and spoilers violate that,
    so they drop out of the body (and come back as hull extras)."""
    out = v.copy()
    out[peak:] = np.minimum.accumulate(v[peak:])
    out[: peak + 1] = np.minimum.accumulate(v[: peak + 1][::-1])[::-1]
    return out


# ---- grid and planes -------------------------------------------------------------------------------

@dataclass
class Grid:
    xs: np.ndarray
    ys: np.ndarray
    zs: np.ndarray
    h: float

    @property
    def shape(self):
        return len(self.xs), len(self.ys), len(self.zs)

    @property
    def origin(self):
        return np.array([self.xs[0], self.ys[0], self.zs[0]])


def make_grid(cal: Calibration, nx: int = 448, margin: float = 0.08) -> Grid:
    h = cal.L / nx

    def centred(half):  # symmetric about 0, so mirroring an axis is exact
        n = int(np.ceil(half / h))
        return np.arange(-n, n + 1) * h

    ys = -margin + np.arange(int(np.ceil((cal.H + 2 * margin) / h)) + 1) * h
    return Grid(centred(cal.L / 2 + margin), ys, centred(cal.W / 2 + margin), h)


def plane_sdf(view: View, a: np.ndarray, b: np.ndarray) -> np.ndarray:
    """Signed distance (model units, negative inside) of `view`'s silhouette on the grid a x b.

    Axes: side (a=x, b=y), top (a=x, b=z), front/rear (a=z, b=y). Computed at 2x the grid
    resolution and decimated, so the zero crossing lands within ~1/4 voxel."""
    h2 = (a[1] - a[0]) / 2
    a2 = a[0] + np.arange(2 * len(a) - 1) * h2
    b2 = b[0] + np.arange(2 * len(b) - 1) * h2
    A, B = np.meshgrid(a2, b2, indexing="ij")
    p = np.zeros(A.shape + (3,))
    axes = {"side": (0, 1), "top": (0, 2), "front": (2, 1), "rear": (2, 1)}[view.name]
    p[..., axes[0]], p[..., axes[1]] = A, B
    u, v = view.to_px(p)
    m = view.panel.mask.astype(np.float32)
    inside = cv2.remap(m, u.astype(np.float32), v.astype(np.float32), cv2.INTER_LINEAR, borderValue=0) > 0.5
    d_out = ndimage.distance_transform_edt(~inside, sampling=h2)
    d_in = ndimage.distance_transform_edt(inside, sampling=h2)
    sdf = np.where(inside, -(d_in - h2 / 2), d_out - h2 / 2)
    return sdf[::2, ::2].astype(np.float32)


def planes(cal: Calibration, grid: Grid, pre_smooth: float = 0.8) -> dict:
    v = cal.views
    S = plane_sdf(v["side"], grid.xs, grid.ys)  # (nx, ny)
    T = plane_sdf(v["top"], grid.xs, grid.zs)  # (nx, nz)
    F = plane_sdf(v["front"], grid.zs, grid.ys).T  # (ny, nz)
    R = plane_sdf(v["rear"], grid.zs, grid.ys).T
    # symmetric shape: overhead by intersection (the narrower side is the more truly overhead one),
    # front/rear by averaging (their slight yaw/lean shifts features both ways)
    T = np.maximum(T, T[:, ::-1])
    F, R = 0.5 * (F + F[:, ::-1]), 0.5 * (R + R[:, ::-1])
    if pre_smooth:  # pixel jaggies would otherwise be extruded into long ridges
        S, T, F, R = (ndimage.gaussian_filter(p, pre_smooth).astype(np.float32) for p in (S, T, F, R))
    return {"side": S, "top": T, "front": F, "rear": R}


# ---- per-slice profiles ------------------------------------------------------------------------------

def _crossing(sdf_line: np.ndarray, coords: np.ndarray, i_in: int, i_out: int) -> float:
    """Sub-voxel position of the zero crossing between an inside cell and its outside neighbour."""
    a, b = sdf_line[i_in], sdf_line[i_out]
    t = a / (a - b) if a != b else 0.5
    return float(coords[i_in] + t * (coords[i_out] - coords[i_in]))


def _extent(sdf_line: np.ndarray, coords: np.ndarray):
    """(low, high) of the longest inside run along a line, sub-voxel; None if empty."""
    inside = sdf_line < 0
    d = np.diff(np.concatenate([[0], inside.astype(np.int8), [0]]))
    runs = list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))
    if not runs:
        return None
    a, b = max(runs, key=lambda r: r[1] - r[0])
    lo = _crossing(sdf_line, coords, a, a - 1) if a > 0 else coords[a]
    hi = _crossing(sdf_line, coords, b - 1, b) if b < len(coords) else coords[b - 1]
    return lo, hi


def _half_width(sdf_line: np.ndarray, coords: np.ndarray):
    e = _extent(sdf_line, coords)
    return None if e is None else max(abs(e[0]), abs(e[1]))


@dataclass
class Profiles:
    top: np.ndarray  # (nx,) body top (wing removed), nan outside the car
    bot: np.ndarray  # (nx,) body bottom with wheel arches
    sill: np.ndarray  # (nx,) bottom with the arches bridged
    w: np.ndarray  # (nx,) body half-width (mirrors removed)
    tf: np.ndarray  # (ny,) front-view half-width profile over height (body only)
    tr: np.ndarray  # (ny,) rear-view half-width profile (body only)
    blend: np.ndarray  # (nx,) 0 = rear template, 1 = front template
    lat_f: np.ndarray  # (ny,) bool: heights where the FRONT view shows parts sticking out sideways
                       # beyond the body (mirrors) - the only heights side extras may occupy (front half)
    lat_r: np.ndarray  # (ny,) same from the rear view, for the rear half
    above: np.ndarray  # (nx,) bool: slices where the side view has real material above the body (wing)
    mirror_x: np.ndarray  # (nx,) bool: slices where the overhead view shows mirrors


def profiles(cal: Calibration, grid: Grid, pl: dict, wheels: list, front_rear_blend: float = 0.25,
             tune: dict | None = None) -> Profiles:
    tune = tune or {}
    nx, ny, nz = grid.shape
    S, T, F, R = pl["side"], pl["top"], pl["front"], pl["rear"]
    axles = {(w["x"], w["y"], w["r"]) for w in wheels}

    # side view without the wheels: below each wheel's arch line nothing is body
    from .wheels import arch_line
    Sb = S.copy()
    seen = set()
    for wd in wheels:
        key = (wd["x"], wd["y"], wd["r"])
        if key in seen:
            continue
        seen.add(key)
        arch = arch_line(cal.views["side"], wd, grid.xs)
        for i in np.flatnonzero(~np.isnan(arch)):
            Sb[i, grid.ys < arch[i]] = np.abs(Sb[i, grid.ys < arch[i]]) + grid.h
    top, bot = np.full(nx, np.nan), np.full(nx, np.nan)
    for i in range(nx):
        e = _extent(Sb[i], grid.ys)
        if e is not None:
            bot[i], top[i] = e
    raw_top = top.copy()
    valid = ~np.isnan(top)
    idx = np.flatnonzero(valid)
    # roofline: highest point in the middle 60% of the car, falling away towards nose and tail
    mid = valid & (np.abs(grid.xs) < 0.3 * cal.L)
    peak = np.flatnonzero(mid)[np.argmax(top[mid])]
    tv = top[valid]
    top[valid] = _unimodal(tv, int(np.searchsorted(idx, peak)))

    sill = bot.copy()
    arch = np.zeros(nx, bool)
    for x, _, r in axles:
        arch |= np.abs(grid.xs - x) < r * 1.08
    keep = valid & ~arch
    sill[valid] = np.interp(grid.xs[valid], grid.xs[keep], bot[keep])

    # overhead: body half-width per slice
    w = np.full(nx, np.nan)
    for i in idx:
        hw = _half_width(T[i], grid.zs)
        w[i] = hw if hw is not None else 0.0
    raw_w = w.copy()
    wv = _open1d(w[valid], int(0.06 * cal.L / grid.h))  # mirrors, door handles
    w[valid] = ndimage.gaussian_filter1d(wv, 1.0, mode="nearest")

    # mirrors: overhead bumps beyond the body, long enough to be a mirror (not a crease or a vent),
    # in the cabin's stretch of the car
    bump = valid & (np.nan_to_num(raw_w - w) > 0.012 * cal.W) & (grid.xs > -0.15 * cal.L) & (grid.xs < 0.25 * cal.L)
    lab, n = ndimage.label(bump)
    for k in range(1, n + 1):
        if (lab == k).sum() * grid.h < 0.025 * cal.L:
            bump[lab == k] = False
    mirror_x = ndimage.binary_dilation(bump, iterations=2)
    if tune.get("mirrors") is False:
        mirror_x[:] = False

    def template(P):
        raw = np.zeros(ny)
        for j in range(ny):
            hw = _half_width(P[j], grid.zs)
            raw[j] = hw if hw is not None else 0.0
        t = raw.copy()
        centre = P[:, nz // 2] < 0
        if centre.any():  # below the body's lower edge only the tyres show: hold the edge's width
            j0 = np.flatnonzero(centre)[0]
            t[:j0] = t[j0]
        # widest point of the body proper: in the lower half, where mirrors and wings can't be
        band = (grid.ys > 0.12 * cal.H) & (grid.ys < 0.55 * cal.H)
        peak = np.flatnonzero(band)[np.argmax(t[band])]
        t = _unimodal(t, peak)
        # a near-horizontal silhouette edge (roof) makes the width jump from row to row: smooth it
        # lightly - a wide blur here rounds the roof's shoulders
        t = ndimage.gaussian_filter1d(t, 1.2, mode="nearest")
        if tune.get("roof", {}).get("straight", True):
            t = _straight_greenhouse(t, grid, peak, np.nanmax(top))
        # where the view is wider than the body template, something sticks out at that height
        # (mirrors); only within the body's own height - a wing above the roof is handled separately
        # Mirrors sit between the beltline and the window top: keep the biggest protruding band there.
        roof = np.nanmax(top)
        sticks_out = (raw - t > 0.012 * cal.W) & (grid.ys > 0.35 * roof) & (grid.ys < 0.88 * roof)
        lab, n = ndimage.label(sticks_out)
        if n > 1:
            sizes = ndimage.sum(sticks_out, lab, range(1, n + 1))
            sticks_out = lab == 1 + int(np.argmax(sizes))
        return t, ndimage.binary_dilation(sticks_out, iterations=2)

    (tf, lat_f), (tr, lat_r) = template(F), template(R)
    body_rows = grid.ys <= np.nanmax(top)  # ignore a wing above the roof
    body_cap = max(tf[body_rows].max(), tr[body_rows].max())
    w = np.minimum(w, body_cap)  # a rear wing wider than the body must not widen the body
    blend = smoothstep(-front_rear_blend * cal.L, front_rear_blend * cal.L, grid.xs)
    # highest silhouette point per slice - any part, so a wing plate floating over a gap counts too
    high = np.array([grid.ys[np.flatnonzero(S[i] < 0)[-1]] if (S[i] < 0).any() else np.nan for i in range(nx)])
    above = valid & (np.nan_to_num(np.fmax(raw_top, high) - top) > 0.025 * cal.H) & (grid.xs < -0.2 * cal.L)  # wings live at the back
    above = ndimage.binary_dilation(above, iterations=3)
    return Profiles(top, bot, sill, w, tf, tr, blend, lat_f, lat_r, above, mirror_x)


# ---- volumes -------------------------------------------------------------------------------------------

@dataclass
class Body:
    grid: Grid
    sdf: np.ndarray  # (nx, ny, nz) float32, negative inside
    planes: dict
    profiles: Profiles
    wing: dict | None = None  # wing_layout() when the wing is built from parts


def loft(grid: Grid, pr: Profiles, wheels: list, round_top: float = 0.12, round_bot: float = 0.14,
         crown: float = 0.012, edge_blend: float = 0.01, cabin: dict | None = None) -> np.ndarray:
    """Implicit body: inside iff bottom <= y <= top and |z| <= zmax(x, y).

    round_top is a fraction of the width *at the top of the slice* (the roof, over the cabin), not of
    the body: rounding by the body width turned whole roofs into a dome. crown is the roof's sideways
    bow and edge_blend the softening where the flanks meet the roof, both in model units / fractions
    of the body half-width; real roofs are nearly flat with tight edges."""
    nx, ny, nz = grid.shape
    valid = ~np.isnan(pr.top)
    top = np.where(valid, pr.top, -1.0)[:, None]  # (nx, 1)
    bot = np.where(valid, pr.bot, 1.0)[:, None]
    sill = np.where(valid, pr.sill, 1.0)[:, None]
    W = np.where(valid, pr.w, 0.0)[:, None]
    Y = grid.ys[None, :]  # (1, ny)

    tmpl = pr.tr[None, :] * (1 - pr.blend[:, None]) + pr.tf[None, :] * pr.blend[:, None]  # (nx, ny)
    in_range = (Y >= sill) & (Y <= top)
    M = np.where(in_range, tmpl, 0).max(axis=1, keepdims=True)
    zmax = W * tmpl / np.maximum(M, 1e-6)
    if cabin is not None:
        # Above the side windows' lower edge the cabin is a straight flank from the glass's outer edge
        # up to the roof's edge, as the windows show it; below, the drawn body (the shoulder is the
        # step between). Faded in over a few slices at the ends of the measured stretch.
        ok = ~np.isnan(cabin["z_in"])
        # fade in over ~12% of the car length so the cabin doesn't pop up where the side windows end
        sigma = 0.03 * (grid.xs[-1] - grid.xs[0]) / grid.h
        wgt = (ndimage.gaussian_filter1d(ok.astype(float), sigma) * 1.6).clip(0, 1)
        idx = np.flatnonzero(ok)
        fill = lambda v: np.interp(np.arange(nx), idx, v[idx])[:, None]  # extend the measured values
        belt, zi, zo = fill(cabin["belt"]), fill(cabin["z_in"]), fill(cabin["z_out"])
        h = np.maximum(top - belt, 1e-3)
        t = np.clip((Y - belt) / h, 0, 1)
        # body width at the beltline -> (rounded shoulder over the lowest 25%) -> glass outer edge,
        # then straight up to the roof's edge: a shoulder, not a shelf
        j_belt = np.clip(np.searchsorted(grid.ys, belt[:, 0]), 0, ny - 1)
        z_belt = zmax[np.arange(nx), j_belt][:, None]
        s_ = smoothstep(0.0, 0.25, t)
        z_sh = z_belt + (np.minimum(zo, z_belt) - z_belt) * s_
        flank = np.where(t < 0.25, z_sh, zo + (zi - zo) * (t - 0.25) / 0.75)
        flank = np.minimum(flank, zmax)  # never wider than the drawn body
        above = (Y >= belt)
        w2 = wgt[:, None] * above
        zmax = zmax * (1 - w2) + flank * w2

    # rounded top and bottom edges (rounded-rectangle corners of radius r)
    h = np.maximum(top - bot, 1e-3)
    # width of the slice just below its top: the roof over the cabin, the hood/deck elsewhere
    j_top = np.clip(np.searchsorted(grid.ys, top[:, 0] - 2 * grid.h), 0, ny - 1)
    w_top = zmax[np.arange(nx), j_top][:, None]
    rt = np.minimum(round_top * w_top, 0.45 * np.maximum(top - sill, 1e-3))
    rb = np.minimum(round_bot * W, 0.45 * h)
    dt = Y - (top - rt)
    zmax = np.where(dt > 0, zmax - rt + np.sqrt(np.maximum(rt * rt - dt * dt, 0)), zmax)
    db = (bot + rb) - Y
    zmax = np.where(db > 0, zmax - rb + np.sqrt(np.maximum(rb * rb - db * db, 0)), zmax)
    zmax = np.maximum(zmax, 0)

    Z = np.abs(grid.zs)[None, None, :]
    # wells: the arch bottom applies only across the tyre's width, the floor stays at the sill inside
    z_inner = np.full(nx, np.inf)
    for w in wheels:
        near = np.abs(grid.xs - w["x"]) < w["r"] * 1.08
        z_inner[near] = np.minimum(z_inner[near], w["z_inner"] - 0.015)
    in_well = Z > z_inner[:, None, None]
    floor = np.where(in_well, bot[:, :, None], sill[:, :, None])

    top_c = top[:, :, None] - crown * W[:, :, None] * (Z / np.maximum(W[:, :, None], 1e-6)) ** 2
    side = (Z - zmax[:, :, None]).astype(np.float32)
    lid = (Y[:, :, None] - top_c).astype(np.float32)
    f = np.maximum(smax(side, lid, np.float32(edge_blend)), floor - Y[:, :, None])
    return np.where(valid[:, None, None], f, 1.0).astype(np.float32)


def visual_hull(cal: Calibration, grid: Grid, pl: dict, k_frac: float = 0.03, thin_scale: float = 0.6,
                front_rear_blend: float = 0.03) -> np.ndarray:
    """Front view governs the front half, rear view the rear half (a narrow cross-fade at x = 0):
    averaging the two would let a wing seen in the rear view stretch a mirror seen in the front."""
    """Smooth intersection of the extruded silhouettes; crease radius shrinks on thin parts."""
    S, T, F, R = pl["side"], pl["top"], pl["front"], pl["rear"]
    k_max = k_frac * cal.W
    reach = max(2, int(round(k_max / grid.h)))

    def radius(p):  # local half-thickness: largest inscribed circle nearby
        return ndimage.grey_dilation(np.maximum(-p, 0), size=(2 * reach + 1,) * 2).astype(np.float32)

    w = smoothstep(-front_rear_blend * cal.L, front_rear_blend * cal.L, grid.xs).astype(np.float32)[:, None, None]
    E = R[None] * (1 - w) + F[None] * w
    rE = radius(R)[None] * (1 - w) + radius(F)[None] * w
    k = np.clip(thin_scale * np.minimum(radius(S)[:, :, None], radius(T)[:, None, :]), 1e-4, k_max)
    d = smax(S[:, :, None], T[:, None, :], k)
    return smax(d, E, np.clip(thin_scale * np.minimum(k, rE), 1e-4, k_max)).astype(np.float32)


def build(cal: Calibration, grid: Grid, wheels: list, extras_gap: float = 0.012, join: float = 0.02,
          tune: dict | None = None, cabin_fn=None) -> Body:
    """tune: hints.json "model" - see README. cabin_fn(profiles) -> glass.cabin() result or None: the
    greenhouse measured from the windows, which then shapes the cabin above the beltline."""
    tune = tune or {}
    pl = planes(cal, grid)
    pr = profiles(cal, grid, pl, wheels, tune=tune)
    roof = tune.get("roof", {})  # hints.json model.roof: {"round", "crown", "blend", "from_glass"}
    cab = cabin_fn(pr) if cabin_fn and roof.get("from_glass", True) else None
    body = loft(grid, pr, wheels, round_top=roof.get("round", 0.12), crown=roof.get("crown", 0.012),
                edge_blend=roof.get("blend", 0.01), cabin=cab)

    # Extras: hull parts the body can't hold. Allowed regions (SDF, negative inside):
    #   above the body's roofline in slices where the side view shows something up there (wings,
    #   stands, spoilers), and mirrors: only in the slices where the overhead view shows them AND at
    #   the heights where the front view shows them. Both limits matter - without the height limit
    #   the overhead bump is extruded into a rod down the whole door; without the slice limit the
    #   front view's mirror band is extruded into a ledge along the whole car.
    hull = visual_hull(cal, grid, pl)
    valid = ~np.isnan(pr.top)
    top = np.where(valid, pr.top, -1.0)[:, None, None]
    bot = np.where(valid, pr.bot, 1.0)[:, None, None]
    W = np.where(valid, pr.w, 0.0)[:, None, None]
    Y, Z = grid.ys[None, :, None], np.abs(grid.zs)[None, None, :]
    box = pr.mirror_x[:, None] & pr.lat_f[None, :]  # (nx, ny)
    box_sdf = np.where(box, -ndimage.distance_transform_edt(box, sampling=grid.h),
                       ndimage.distance_transform_edt(~box, sampling=grid.h)).astype(np.float32)
    lateral = np.broadcast_to(box_sdf[:, :, None], hull.shape)
    up = (pr.above | ~valid)[:, None, None]
    above = np.where(up, top - Y, (top + 0.03) - Y)  # elsewhere only clearly-above material counts
    region = np.minimum(above, lateral)  # nothing below the floor: tyres are separate meshes
    extras = np.maximum(hull, region)
    for w in wheels:  # tyres are separate meshes: clear everything outboard of each tyre's inner face
        extras = np.maximum(extras, -_tyre_sdf(grid, w, pad=0.02, outboard=True))
    wing = wing_layout(cal, grid, pl, pr, mode=tune.get("wing", "auto"), plate_frac=tune.get("wing_plate", 0.4),
                       upright_frac=tune.get("wing_upright_z", 0.45))
    if wing is not None:  # the wing becomes separate clean parts (wing.py): keep it out of the hull
        cols = np.zeros(grid.shape[0], bool)
        cols[wing["slices"]] = True
        cols = ndimage.binary_dilation(cols, iterations=2)
        above_deck = Y > top + 0.5 * grid.h
        extras = np.where(cols[:, None, None] & above_deck, np.maximum(extras, grid.h), extras)
    sdf = smin(body, extras, join).astype(np.float32)
    return Body(grid, sdf, pl, pr, wing)


def wing_layout(cal: Calibration, grid: Grid, pl: dict, pr: Profiles, min_gap_share: float = 0.2,
                min_gap_cols: int = 6, plate_frac: float = 0.4, upright_frac: float = 0.45,
                mode: str = "auto") -> dict | None:
    """Measure a rear wing that stands clear of the deck, or None (no wing, or a solid ducktail).

    A silhouette hull fills a wing in solid: the side view gives the plate and its supports in
    profile, the overhead view the plate's plan, and no view sees through the gap under it (the car
    is behind). When the side view shows background between the wing and the deck in enough of the
    wing's length, the wing is rebuilt from parts (see wing.py): the side view's top band (above the
    gap) is what the endplates show, the plate is the top `plate_frac` of that band across the span,
    and whatever the side view shows below the band is the uprights."""
    if mode == "solid":
        return None
    S, T = pl["side"], pl["top"]
    wing = np.flatnonzero(pr.above & ~np.isnan(pr.top))
    if len(wing) < 3:
        return None
    plate_top, thickness, gap = {}, [], 0
    for i in wing:
        rows = np.flatnonzero((S[i] < 0) & (grid.ys > pr.top[i] + grid.h))
        if not len(rows):
            continue
        runs = np.split(rows, np.flatnonzero(np.diff(rows) > 1) + 1)
        highest = runs[-1]
        plate_top[i] = grid.ys[highest[-1]]
        if highest[0] > np.searchsorted(grid.ys, pr.top[i]) + 2:  # background between wing and deck
            gap += 1
            thickness.append((highest[-1] - highest[0] + 1) * grid.h)
    if mode != "parts" and (gap < max(min_gap_cols, min_gap_share * len(wing)) or not thickness):
        return None
    t = float(np.clip(np.median(thickness) if thickness else 0.06 * cal.H, 2 * grid.h, 0.12 * cal.H))
    span = max((_half_width(T[i], grid.zs) or 0.0) for i in wing)
    return {
        "slices": np.array(sorted(plate_top)),
        "plate_top": plate_top,
        "band": t,  # endplate height
        "plate": max(2 * grid.h, plate_frac * t),  # plate thickness
        "span": span,
        "endplate": max(2 * grid.h, 0.025 * cal.W),
        "upright": max(2 * grid.h, 0.035 * cal.W),
        "upright_z": upright_frac * span,
    }


def _tyre_sdf(grid: Grid, w: dict, pad: float, outboard: bool = False) -> np.ndarray:
    X, Y, Z = np.meshgrid(grid.xs, grid.ys, grid.zs, indexing="ij", sparse=True)
    radial = np.hypot(X - w["x"], Y - w["y"]) - (w["r"] + pad)
    if outboard:  # from the tyre's inner face out to infinity on its side of the car
        axial = (w["z_inner"] - pad) - w["side"] * Z
    else:
        zc = w["side"] * (w["z_outer"] + w["z_inner"]) / 2
        axial = np.abs(Z - zc) - ((w["z_outer"] - w["z_inner"]) / 2 + pad)
    return np.maximum(radial, axial).astype(np.float32)


def depth_maps(body: Body, wheels: list) -> dict:
    """First-hit surface coordinate along each view axis, from the occupied voxels: used to decide
    which panel actually sees a surface point when baking the texture. The tyres count as occluders,
    or the wheel-well walls behind them would get the wheel painted on them a second time."""
    g = body.grid
    occ = body.sdf < 0
    for w in wheels:
        occ |= _tyre_sdf(g, w, pad=0.0) < 0
    if body.wing is not None:
        from .wing import occupancy

        occ |= occupancy(body)

    def last(axis, coords):
        any_ = occ.any(axis=axis)
        idx = occ.shape[axis] - 1 - np.argmax(np.flip(occ, axis=axis), axis=axis)
        return np.where(any_, coords[idx], -np.inf)

    def first(axis, coords):
        any_ = occ.any(axis=axis)
        idx = np.argmax(occ, axis=axis)
        return np.where(any_, coords[idx], np.inf)

    return {
        "side": last(2, g.zs),  # (nx, ny): max z
        "left": first(2, g.zs),  # (nx, ny): min z
        "top": last(1, g.ys),  # (nx, nz): max y
        "front": last(0, g.xs),  # (ny, nz): max x
        "rear": first(0, g.xs),  # (ny, nz): min x
    }


def tyre_overhang(body: Body, wheels: list, inset: float = 0.004) -> list[float]:
    """How far each tyre's outer face sticks out past the bodywork beside its arch (model units, > 0 =
    sticks out). Measured on the built body just ahead of and behind the arch, at hub height +-0.3r,
    where the fender lip is; Hot Wheels tyres sit flush with or inside it."""
    g = body.grid
    out = []
    for w in wheels:
        widths = []
        for dx in (-1.2 * w["r"], 1.2 * w["r"]):
            i = int(np.argmin(np.abs(g.xs - (w["x"] + dx))))
            rows = (g.ys > w["y"] - 0.3 * w["r"]) & (g.ys < w["y"] + 0.3 * w["r"])
            inside = body.sdf[i][rows] < 0  # (rows, nz)
            zs = np.abs(g.zs)[None, :].repeat(inside.shape[0], 0)[inside]
            if len(zs):
                widths.append(np.percentile(zs, 95))
        out.append(float(w["z_outer"] - (min(widths) - inset)) if widths else 0.0)
    return out
