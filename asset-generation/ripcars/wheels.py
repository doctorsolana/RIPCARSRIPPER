"""Find the wheels in the sheet and build separate, spinnable wheel meshes.

Side view: each tyre touches the ground, so its contact patch (where the silhouette reaches the
ground line) gives the centre x, and the radius is the circle through the lower arc of the silhouette.
Front/rear views: the tyres are the silhouette's outer bottom corners, below the body's lower edge;
their inner edge gives the track. AI sheets disagree a little between views, so everything is
cross-checked and falls back to proportions when a view is ambiguous.
"""
import cv2
import numpy as np
import trimesh

from .views import Calibration, View


def _runs(flags):
    d = np.diff(np.concatenate([[0], flags.astype(np.int8), [0]]))
    return list(zip(np.flatnonzero(d == 1), np.flatnonzero(d == -1)))


def side_wheels(view: View) -> list[dict]:
    """Two wheels from the side panel: [{'u','v','r'} in panel px], rear first."""
    m = view.panel.mask
    x0, y0, x1, y1 = view.panel.bbox
    L = x1 - x0
    ground = y1 - 1
    cols = np.arange(x0, x1)
    bottom = np.array([np.flatnonzero(m[:, c]).max() if m[:, c].any() else -1 for c in cols])
    # Tyres are the two lowest places along the bottom edge. Generated sheets don't always stand both
    # on one ground line (a lowrider's skirted rear wheel floats a few px), so the tolerance grows
    # until two contact patches far enough apart show up.
    contact = []
    for tol in np.arange(2, max(3.0, 0.08 * (y1 - y0)), 1.0):
        runs = [r for r in _runs(bottom >= ground - tol) if r[1] - r[0] >= 3]
        runs = sorted(runs, key=lambda r: r[1] - r[0], reverse=True)[:2]
        if len(runs) == 2 and abs((runs[0][0] + runs[0][1]) - (runs[1][0] + runs[1][1])) / 2 > 0.3 * L:
            contact = runs
            break
    if len(contact) < 2:
        raise ValueError("could not find two tyre contact patches on the side view")
    wheels = []
    for a, b in sorted(contact):
        cu = x0 + (a + b - 1) / 2
        low = float(bottom[a:b].max())  # this tyre's own ground contact
        best = None
        for r in np.arange(L * 0.045, L * 0.14, 0.5):
            span = np.arange(max(x0, int(cu - 0.92 * r)), min(x1, int(cu + 0.92 * r) + 1))
            arc = (low - r) + np.sqrt(np.maximum(r * r - (span - cu) ** 2, 0))
            seen = bottom[span - x0]
            # only where the tyre is the lowest thing in the column (below the body's edge)
            use = seen > (low - r) + 0.25 * r
            if use.sum() < 0.6 * r:
                continue
            err = np.abs(seen[use] - arc[use]).mean()
            if best is None or err < best[0]:
                best = (err, r)
        if best is None:
            raise ValueError(f"no tyre arc found near u={cu:.0f}")
        wheels.append({"u": float(cu), "r": float(best[1]), "fit_err_px": float(best[0])})
    # same tyres front and back on most castings: if one fit is poor (fender skirt, lowrider), borrow
    errs = [w["fit_err_px"] for w in wheels]
    if max(errs) > 3 * min(errs) + 1.0:
        good = wheels[int(np.argmin(errs))]
        bad = wheels[int(np.argmax(errs))]
        bad["r"], bad["borrowed_radius"] = good["r"], True
    # nearly equal radii are one tyre size drawn inconsistently: share it
    ra, rb = wheels[0]["r"], wheels[1]["r"]
    if abs(ra - rb) / max(ra, rb) < 0.06:
        for w in wheels:
            w["r"] = (ra + rb) / 2
    for w in wheels:  # every tyre stands on the one ground line
        w["v"] = float(ground - w["r"])
    return wheels


def tyre_width(view: View, wheel_r: float) -> float | None:
    """Tyre tread width (model units) from a front or rear panel: just above the ground only the two
    tyres touch down, so a low row splits into two runs. None when a splitter/diffuser/skirt reaches
    that low and joins them."""
    m = view.panel.mask
    x0, y0, x1, y1 = view.panel.bbox
    widths = []
    for frac in (0.06, 0.1, 0.14):
        row = int(round(y1 - 1 - frac * wheel_r / view.sv))
        runs = [(a, b) for a, b in _runs(m[row]) if b - a > 2]
        if len(runs) >= 2:
            (la, lb), (ra, rb) = runs[0], runs[-1]
            widths.append(((lb - la) + (rb - ra)) / 2 * view.su)
    return float(np.median(widths)) if widths else None


def tyre_outer(view: View, x: float, r: float) -> float:
    """|z| of the tyre's outer face from the overhead view: the silhouette's half-width over the tyre's
    footprint (tyres are the widest thing at the axle on a Hot Wheels car, or flush with the fender)."""
    m = view.panel.mask
    zs = []
    for dx in np.linspace(-0.4 * r, 0.4 * r, 9):
        u, _ = view.to_px(np.array([[x + dx, 0.0, 0.0]]))
        col = m[:, int(round(u[0]))]
        idx = np.flatnonzero(col)
        if len(idx):
            zs.append((idx[-1] - idx[0] + 1) / 2 * view.sv)
    return float(np.median(zs))


def locate(cal: Calibration, overrides: dict | None = None) -> list[dict]:
    """Wheels in model coordinates: x, y (centre height), r, z_outer, z_inner (|z|), one entry per axle side."""
    sv = cal.views["side"]
    found = side_wheels(sv)
    axles = []
    for w in found:
        x = (w["u"] - sv.uc) * sv.su
        y = (sv.vg - w["v"]) * sv.sv
        r = w["r"] * sv.su
        axles.append({"x": float(x), "y": float(y), "r": float(r), "fit_err_px": w["fit_err_px"]})
    rear, front = sorted(axles, key=lambda a: a["x"])
    for axle, view in ((front, cal.views["front"]), (rear, cal.views["rear"])):
        outer = min(tyre_outer(cal.views["top"], axle["x"], axle["r"]), cal.W_body / 2) - 0.006 * cal.L
        width = tyre_width(view, axle["r"])
        axle["width_source"] = view.name if width else "proportional"
        width = width if width else 0.19 * cal.W_body
        width = float(np.clip(width, 0.12 * cal.W_body, 0.3 * cal.W_body))
        axle.update({"z_outer": outer, "z_inner": outer - width})
    # A fender skirt hides a wheel down past its hub: tuck that tyre inside the body so only the strip
    # under the skirt shows, and dress its face with the other axle's (visible) rim drawing.
    for name, axle, covered in zip(("rear", "front"), (rear, front), covered_axles(sv, [rear, front])):
        o = (overrides or {}).get(name, {})  # hints.json model.wheels.<rear|front>
        axle["r"] *= o.get("radius_scale", 1.0)
        axle["y"] = axle["r"] if "radius_scale" in o else axle["y"]  # keep it on the ground
        axle["covered"] = o.get("covered", covered)
        if "width" in o:  # tread width as a fraction of the body width
            axle["z_inner"] = axle["z_outer"] - o["width"] * cal.W_body
        if axle["covered"]:
            axle["z_outer"] -= 0.12 * cal.W_body
            axle["z_inner"] -= 0.12 * cal.W_body
    wheels = []
    for name, axle in (("rear", rear), ("front", front)):
        for side, sgn in (("right", 1), ("left", -1)):
            wheels.append({**axle, "name": f"wheel_{name}_{side}", "side": sgn})
    return wheels


def wheel_symmetry(view: View, wheel: dict, size: int = 72) -> float:
    """How wheel-like the middle of a wheel looks: a rim repeats when turned by one spoke (or by half
    a turn), bodywork with artwork on it doesn't. Best correlation of the inner disc with itself
    rotated by 360/n for common spoke counts; ~1 for a rim, low for a fender skirt."""
    g = cv2.cvtColor(view.panel.rgb, cv2.COLOR_RGB2GRAY).astype(np.float32)
    (cu,), (cv_,) = view.to_px(np.array([[wheel["x"], wheel["y"], 0.0]]))
    r = 0.62 * wheel["r"] / view.su
    lin = (np.arange(size) + 0.5) / size * 2 - 1
    gx, gy = np.meshgrid(lin, lin)
    patch = cv2.remap(g, (cu + gx * r).astype(np.float32), (cv_ + gy * r).astype(np.float32), cv2.INTER_LINEAR)
    disc = np.hypot(gx, gy) < 0.95
    best = -1.0
    for n in (2, 3, 4, 5, 6, 7, 8, 9, 10, 12, 16):
        rot = cv2.warpAffine(patch, cv2.getRotationMatrix2D((size / 2 - 0.5, size / 2 - 0.5), 360.0 / n, 1.0), (size, size))
        a, b = patch[disc], rot[disc]
        a, b = a - a.mean(), b - b.mean()
        best = max(best, float((a * b).sum() / max(1e-6, np.sqrt((a * a).sum() * (b * b).sum()))))
    return best


def covered_axles(view: View, axles: list) -> list[bool]:
    """Which wheels a fender skirt hides: the middle of the wheel isn't rotationally symmetric while
    the other wheel's is. (Colour tests fail on liveries that share the wheel's colours, like the
    Impala's red-and-gold skirt over red-and-gold wire wheels.)"""
    sym = [wheel_symmetry(view, a) for a in axles]
    for a, v in zip(axles, sym):
        a["rim_symmetry"] = round(v, 3)
    return [bool(v < 0.45 and sym[1 - i] > 0.6) for i, v in enumerate(sym)]


def arch_line(view: View, wheel: dict, xs: np.ndarray) -> np.ndarray:
    """Height (model y) of the body's lower edge over a wheel, for each model x in xs (nan outside).

    Fender skirts and tucked arches hide part of the tyre, so a circle isn't the arch. Instead the
    wheel's own colours (rubber, rim, whitewall) are learned from the bottom of its disc, which is
    always visible, and each column's arch is where those colours begin. When body and tyre look alike
    (black paint) every column matches at the top of the circle - the plain round arch."""
    panel = view.panel
    lab = cv2.cvtColor(panel.rgb, cv2.COLOR_RGB2LAB).astype(np.float32)
    (cu,), (cv_,) = view.to_px(np.array([[wheel["x"], wheel["y"], 0.0]]))
    r = wheel["r"] / view.su
    h, w = panel.mask.shape
    vv, uu = np.mgrid[0:h, 0:w]
    dist = np.hypot(uu - cu, vv - cv_)
    ref = (dist < 0.97 * r) & (vv > cv_ + 0.55 * r) & panel.mask
    out = np.full(len(xs), np.nan)
    if ref.sum() < 30:
        return out
    pix = lab[ref]
    k = min(3, len(pix) // 10)
    _, labels, centres = cv2.kmeans(pix, k, None, (cv2.TERM_CRITERIA_EPS + cv2.TERM_CRITERIA_MAX_ITER, 30, 0.5), 3,
                                    cv2.KMEANS_PP_CENTERS)
    tol = np.array([max(14.0, 2.5 * float(np.sqrt(((pix[labels.ravel() == i] - centres[i]) ** 2).sum(1).mean())))
                    for i in range(k)])
    d = np.min(np.linalg.norm(lab[:, :, None, :] - centres[None, None], axis=3) - tol[None, None], axis=2)
    wheel_like = (d < 0) & panel.mask
    r_arch = 1.03 * r
    for i, x in enumerate(xs):
        (u,), _ = view.to_px(np.array([[x, 0.0, 0.0]]))
        du = u - cu
        if abs(du) >= r_arch:
            continue
        col = int(round(u))
        v_top = int(np.floor(cv_ - np.sqrt(r_arch ** 2 - du ** 2)))
        v_bot = int(min(h - 1, cv_ + r))
        run = 0
        for v in range(max(0, v_top), v_bot + 1):
            run = run + 1 if wheel_like[v, col] else 0
            if run >= 3:
                out[i] = view.vg - (v - 2)  # px row of the arch, converted below
                break
        else:
            out[i] = view.vg - v_bot
    ok = ~np.isnan(out)
    if ok.sum() >= 5:  # rows -> model y, light smoothing along the arch
        vals = out[ok]
        pad = np.pad(vals, 2, mode="edge")
        out[ok] = np.median(np.lib.stride_tricks.sliding_window_view(pad, 5), axis=1)
    return out * view.sv


def tyre_mesh(r: float, width: float, segments: int = 48) -> trimesh.Trimesh:
    """Rounded tyre (lathe of a rounded-rectangle profile) around +z, centred at the origin, open at
    the rim so the textured face disc closes it."""
    hw = width / 2
    fillet = min(0.22 * r, 0.45 * hw)
    prof = [(0.62 * r, hw)]
    for t in np.linspace(0, np.pi / 2, 5):  # outer shoulder
        prof.append((r - fillet + fillet * np.sin(t), hw - fillet + fillet * np.cos(t)))
    for t in np.linspace(np.pi / 2, np.pi, 5):  # inner shoulder
        prof.append((r - fillet + fillet * np.sin(t), -hw + fillet + fillet * np.cos(t)))
    prof.append((0.62 * r, -hw))
    prof = np.array(prof)
    angles = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    verts = np.array([[rad * np.cos(a), rad * np.sin(a), z] for a in angles for rad, z in prof])
    n = len(prof)
    faces = []
    for i in range(segments):
        j = (i + 1) % segments
        for k in range(n - 1):
            a, b, c, d = i * n + k, i * n + k + 1, j * n + k, j * n + k + 1
            faces += [(a, b, c), (b, d, c)]  # wound so the tread faces outward (the tyre is open at the rim)
    return trimesh.Trimesh(verts, faces, process=True)


def face_disc(r: float, segments: int = 64) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Disc in the xy plane facing +z: (vertices, faces, uv) with uv covering the unit square."""
    ang = np.linspace(0, 2 * np.pi, segments, endpoint=False)
    verts = np.vstack([[0, 0, 0], np.stack([r * np.cos(ang), r * np.sin(ang), np.zeros_like(ang)], 1)])
    faces = np.array([[0, 1 + i, 1 + (i + 1) % segments] for i in range(segments)])
    uv = verts[:, :2] / (2 * r) + 0.5
    return verts, faces, uv


def rim_texture(view: View, wheel: dict, size: int = 512) -> np.ndarray:
    """Square crop of a side view around a wheel, resampled to size x size (RGB uint8): the face
    texture, rim and sidewall exactly as the sheet draws them. Wherever bodywork overlaps the wheel
    in the drawing (fender lip, skirt), the pixels come from the opposite side of the hub instead -
    otherwise a piece of fender would spin with the wheel."""
    p = np.array([[wheel["x"], wheel["y"], 0.0]])
    u, v = view.to_px(p)
    rpx = wheel["r"] / view.su
    lin = (np.arange(size) + 0.5) / size * 2 - 1
    gx, gy = np.meshgrid(lin, lin)
    mu = (u[0] + gx * rpx).astype(np.float32)
    mv = (v[0] + gy * rpx).astype(np.float32)
    crop = cv2.remap(view.panel.rgb, mu, mv, cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
    flip = 1.0 if view.name != "left" else -1.0  # the left view looks at the car nose-left
    xs = wheel["x"] + flip * lin * wheel["r"]
    arch = arch_line(view, wheel, xs)  # model y of the body's lower edge per crop column
    y = wheel["y"] - lin * wheel["r"]  # model y per crop row
    occluded = np.isfinite(arch)[None, :] & (y[:, None] > np.nan_to_num(arch, nan=np.inf)[None, :] - 0.01 * wheel["r"])
    if occluded.any():
        crop = np.where(occluded[:, :, None], crop[::-1, ::-1], crop)
    return crop


def top_bulge(cal: Calibration, wheels: list, frac: float = 0.012) -> list[bool]:
    """Per wheel: is the overhead outline wider over the axle than just ahead of and behind the arch?
    That's tyres (or flares around them) standing proud - drawn on purpose, so they stay out."""
    v = cal.views["top"]
    m = v.panel.mask

    def half(x):
        (u,), _ = v.to_px(np.array([[x, 0.0, 0.0]]))
        col = m[:, int(np.clip(round(u), 0, m.shape[1] - 1))]
        idx = np.flatnonzero(col)
        return (idx[-1] - idx[0] + 1) / 2 * v.sv if len(idx) else 0.0

    out = []
    for w in wheels:
        at = max(half(w["x"] + d * w["r"]) for d in (-0.3, 0.0, 0.3))
        beside = min(half(w["x"] - 1.3 * w["r"]), half(w["x"] + 1.3 * w["r"]))
        out.append(at - beside > frac * cal.W)
    return out
