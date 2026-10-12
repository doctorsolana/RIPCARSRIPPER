"""Calibrate the four panels into one model frame.

Model frame (also the GLB's): x = forward (nose at +x), y = up (ground at y = 0), z = the car's right
side (the side view looks at it from +z). Units: the car's overall length is LENGTH.

The side view is the master: it sets length L and height H. The overhead is scaled uniformly so its
length matches, which gives the width W. Front and rear views are generated with their own framing,
so each is scaled independently to height H and width W (non-uniform, absorbs small AI mismatches).
"""
from dataclasses import dataclass

import numpy as np
from scipy import ndimage

from .sheet import Panel

LENGTH = 4.0


def _centre(mask: np.ndarray, axis: int) -> float:
    """Mirror-symmetry centre of a silhouette across `axis` (0 = rows, 1 = cols), in pixels.

    Searches the shift that best overlaps the mask with its mirror image; robust to asymmetric
    lighting because it only uses the silhouette."""
    m = mask.astype(np.float32)
    prof = m.sum(axis=1 - axis)  # occupancy along the axis we want the centre of
    idx = np.flatnonzero(prof)
    lo, hi = idx[0], idx[-1] + 1
    best, best_c = -1.0, (lo + hi) / 2
    for c2 in np.arange(2 * lo + (hi - lo) * 0.9, 2 * lo + (hi - lo) * 1.1 + 0.5, 1.0):  # c2 = 2 * centre
        a = np.take(m, np.arange(m.shape[axis]), axis=axis)
        src = np.clip(np.round(c2 - np.arange(m.shape[axis])).astype(int), 0, m.shape[axis] - 1)
        b = np.take(m, src, axis=axis)
        score = (a * b).sum() / max(1.0, np.maximum(a, b).sum())
        if score > best:
            best, best_c = score, c2 / 2
    return float(best_c)


def body_width_px(mask: np.ndarray, along: int, win_frac: float) -> float:
    """Widest extent of the body, ignoring narrow protrusions (mirrors): per line across the car,
    the silhouette's extent; then a 1D opening along the car removes bumps narrower than
    win_frac of the silhouette's length. along=1: lines are columns (overhead view, car along x);
    along=0: lines are rows (front/rear views, measured over height)."""
    m = mask if along == 1 else mask.T  # make the lines columns
    ext = np.zeros(m.shape[1])
    for c in range(m.shape[1]):
        idx = np.flatnonzero(m[:, c])
        if len(idx):
            ext[c] = idx[-1] - idx[0] + 1
    used = np.flatnonzero(ext)
    win = max(3, int(win_frac * (used[-1] - used[0] + 1)) | 1)
    opened = ndimage.grey_dilation(ndimage.grey_erosion(ext, size=win, mode="nearest"), size=win, mode="nearest")
    return float(opened.max())


def _end_centre(mask: np.ndarray, frac: float = 0.1) -> float:
    """Centre line of an overhead silhouette from its nose and tail ends: bumpers are symmetric and a
    view that shows a little of one side (sill, door graphics) only bulges the middle of the car."""
    cols = np.flatnonzero(mask.any(axis=0))
    x0, x1 = cols[0], cols[-1]
    n = max(3, int(frac * (x1 - x0)))
    mids = []
    for c in list(range(x0, x0 + n)) + list(range(x1 - n, x1 + 1)):
        idx = np.flatnonzero(mask[:, c])
        if len(idx):
            mids.append((idx[0] + idx[-1]) / 2)
    return float(np.median(mids))


@dataclass
class View:
    name: str
    panel: Panel
    direction: np.ndarray  # unit vector from the car towards this camera
    uc: float  # panel px of model axis origin (horizontal)
    vg: float  # panel px of ground / centre line (vertical)
    su: float  # model units per panel px, horizontal
    sv: float  # model units per panel px, vertical
    xwarp: tuple | None = None  # (model x anchors, where this view draws them): register() fills it
    post: tuple | None = None  # (su, du, sv, dv, cu, cv): image-space correction, bake.register_ends()

    def to_px(self, p: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
        """Model points (N, 3) -> panel pixel coordinates (u right, v down)."""
        x, y, z = p[..., 0], p[..., 1], p[..., 2]
        if self.xwarp is not None:  # this view draws things along the car at slightly different x
            x = np.interp(x, *self.xwarp)
        u, v = self._px(x, y, z)
        if self.post is not None:
            su, du, sv, dv, cu, cv = self.post
            u, v = cu + (u - cu) * su + du, cv + (v - cv) * sv + dv
        return u, v

    def _px(self, x, y, z):
        if self.name == "side":
            return self.uc + x / self.su, self.vg - y / self.sv
        if self.name == "left":  # camera on the car's left (-z): the nose points left
            return self.uc - x / self.su, self.vg - y / self.sv
        if self.name == "top":  # nose right, the car's left side (-z) at the top of the image
            return self.uc + x / self.su, self.vg + z / self.sv
        if self.name == "front":  # camera ahead of the car: its right side (+z) appears on the left
            return self.uc - z / self.su, self.vg - y / self.sv
        if self.name == "rear":
            return self.uc + z / self.su, self.vg - y / self.sv
        raise ValueError(self.name)


@dataclass
class Calibration:
    L: float
    H: float
    W: float
    W_body: float
    views: dict[str, View]
    report: dict


def calibrate(panels: dict[str, Panel]) -> Calibration:
    side, top, front, rear = (panels[n] for n in ("side", "top", "front", "rear"))  # "left" is optional
    sx0, sy0, sx1, sy1 = side.bbox
    s = LENGTH / (sx1 - sx0)
    L, H = LENGTH, (sy1 - sy0) * s
    views = {"side": View("side", side, np.array([0, 0, 1.0]), (sx0 + sx1) / 2, sy1, s, s)}

    tx0, ty0, tx1, ty1 = top.bbox
    st = LENGTH / (tx1 - tx0)
    W = (ty1 - ty0) * st  # overall, mirrors included
    W_body = body_width_px(top.mask, along=1, win_frac=0.06) * st
    views["top"] = View("top", top, np.array([0, 1.0, 0]), (tx0 + tx1) / 2, _end_centre(top.mask), st, st)

    report = {"L": L, "H": H, "W": W, "W_body": W_body, "W/L": W / L, "H/L": H / L, "top_scale_vs_side": st / s}
    if "left" in panels:  # texture source for the car's left side; the right profile stays the shape master
        left = panels["left"]
        lx0, ly0, lx1, ly1 = left.bbox
        sl = LENGTH / (lx1 - lx0)
        views["left"] = View("left", left, np.array([0, 0, -1.0]), (lx0 + lx1) / 2, ly1, sl, sl)
        report["left_height_vs_right"] = (ly1 - ly0) * sl / H - 1
    for p, d in ((front, np.array([1.0, 0, 0])), (rear, np.array([-1.0, 0, 0]))):
        x0, y0, x1, y1 = p.bbox
        # Width from the body (mirrors excluded in both views), height from the overall silhouette
        # (wings included in both): each AI view is framed independently, so each gets its own scale.
        bw = body_width_px(p.mask, along=0, win_frac=0.12)
        su, sv = W_body / bw, H / (y1 - y0)
        views[p.name] = View(p.name, p, d, _centre(p.mask, 1), y1, su, sv)
        # The panel's own aspect vs the side/top-derived one: >0 means the view drew the car too wide.
        report[f"{p.name}_aspect_mismatch"] = (bw / (y1 - y0)) / (W_body / H) - 1
    return Calibration(L, H, W, W_body, views, report)


def _axle_bumps(view: View, axles: list) -> list | None:
    """Where an overhead view draws each axle: the fender flare / tyre bulge of its outline nearest the
    side view's axle. None if the outline has no clear bulge there (straight-sided cars)."""
    from scipy import ndimage

    m = view.panel.mask
    width = np.array([(np.flatnonzero(m[:, c])[-1] - np.flatnonzero(m[:, c])[0]) if m[:, c].any() else 0
                      for c in range(m.shape[1])], float)
    width = ndimage.gaussian_filter1d(width, 2)
    out = []
    for a in axles:
        (u,), _ = view.to_px(np.array([[a["x"], 0.0, 0.0]]))
        r = a["r"] / view.su
        lo, hi = max(0, int(u - 1.3 * r)), min(len(width), int(u + 1.3 * r))
        seg = width[lo:hi]
        if seg.max() - np.median(width[width > 0]) < 0.01 * (view.panel.bbox[3] - view.panel.bbox[1]):
            return None
        near_max = np.flatnonzero(seg >= seg.max() - 0.015 * (view.panel.bbox[3] - view.panel.bbox[1]))
        out.append(float((lo + near_max.mean() - view.uc) * view.su))
    return out


def register(cal: Calibration, wheels: list, max_shift: float = 0.07) -> dict:
    """Line every other view up with the right profile along the car's length.

    The AI draws each view separately, and they disagree a few percent on where things sit along the
    car (the top view's wheelbase is typically shorter). Each view gets a piecewise-linear x-warp
    that puts its axles where the right profile has them, keeping both ends fixed - so its fender
    flares shape the body over the real wheels and its decals land where the side view's do."""
    from .wheels import side_wheels

    axles = sorted({(w["x"], w["r"]) for w in wheels})
    axles = [{"x": x, "r": r} for x, r in axles]
    half = cal.L / 2
    report = {}
    for name, view in cal.views.items():
        if name == "top":
            drawn = _axle_bumps(view, axles)
        elif name == "left":
            try:
                found = sorted(side_wheels(view), key=lambda w: -w["u"])  # nose left: rear axle at larger u
                drawn = [float(-(w["u"] - view.uc) * view.su) for w in found]
            except ValueError:
                drawn = None
        else:
            continue
        if drawn is None or len(drawn) != 2:
            report[name] = "no landmarks - left as drawn"
            continue
        shifts = [d - a["x"] for d, a in zip(drawn, axles)]
        if max(abs(v) for v in shifts) > max_shift * cal.L or not (-half < drawn[0] < drawn[1] < half):
            report[name] = f"implausible shift {shifts} - left as drawn"
            continue
        view.xwarp = (np.array([-half, axles[0]["x"], axles[1]["x"], half]), np.array([-half, drawn[0], drawn[1], half]))
        report[name] = {"axle_shift_pct": [round(v / cal.L * 100, 2) for v in shifts]}
    return report
