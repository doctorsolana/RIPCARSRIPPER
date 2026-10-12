"""Cut the car out of its blister-pack photo: what the reveal lands on.

    uv run python -m ripcars extract <car-id|all>

Reads  assets/cars/<id>/hints.json  (hand-set: photo path, rough car box, optional wheel circles,
                                     optional wing.deckLine / nearTop points for the procedural car)
Writes assets/cars/<id>/photo.webp   web copy of the pack photo (the card the reveal ends on)
                        mask.png     the car's silhouette in the photo (align fits the 3D model to it)
                        extract.json photo size, car box, wheels, outline stations, paint colour
                        side.webp    the car's pixels, background bled out (procedural car texture)
       qa/<id>/extract.jpg, extract-wheels.jpg   overlays for review
"""
import json
from pathlib import Path

import cv2
import numpy as np
from PIL import Image
from rembg import new_session, remove

N_STATIONS = 160
WEB_PHOTO_MAX_H = 2048


def largest_parts(mask: np.ndarray, keep_ratio=0.01) -> np.ndarray:
    n, labels, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8)
    if n <= 1:
        return mask
    areas = stats[1:, cv2.CC_STAT_AREA]
    biggest = areas.max()
    keep = [i + 1 for i, a in enumerate(areas) if a >= biggest * keep_ratio]
    return np.isin(labels, keep).astype(np.uint8)


def fill_holes(mask: np.ndarray) -> np.ndarray:
    h, w = mask.shape
    flood = np.pad(mask, 1).copy() * 255
    ff_mask = np.zeros((h + 4, w + 4), np.uint8)
    cv2.floodFill(flood, ff_mask, (0, 0), 128)
    holes = (flood[1:-1, 1:-1] == 0)
    return (mask | holes).astype(np.uint8)


def bleed(rgb: np.ndarray, known: np.ndarray) -> np.ndarray:
    """Push edge colours outward so texture lookups at the silhouette never hit background."""
    out = rgb.astype(np.float32)
    k = known.astype(np.float32)
    for size in (3, 5, 9, 17, 33, 65, 129):
        num = cv2.blur(out * k[..., None], (size, size))
        den = cv2.blur(k, (size, size))
        fill = (k == 0) & (den > 1e-4)
        out[fill] = num[fill] / den[fill][:, None]
        k = np.where(fill, 1.0, k)
    return np.clip(out, 0, 255).astype(np.uint8)


def column_runs(col: np.ndarray):
    d = np.diff(np.concatenate([[0], col.astype(np.int8), [0]]))
    starts, ends = np.where(d == 1)[0], np.where(d == -1)[0]
    return list(zip(starts, ends))  # [start, end)


def near_top_edge(crop, mask, cols, top, bw, anchors=(), step=2):
    """Track the near top edge: where the near side panel turns into roof/hood/deck.

    The pack camera sits a little above the car, so between the silhouette top (the *far* edge) and
    the near shoulder you see a band of top surface. Find a smooth path at depth d(x) below the
    silhouette top that rides the strongest edges (dynamic programming, depth changes ≤ 1.5 px/px).
    """
    lab = cv2.cvtColor(cv2.GaussianBlur(crop, (0, 0), 1.5), cv2.COLOR_RGB2LAB).astype(np.float32)
    g = np.zeros(mask.shape, np.float32)
    for ch, wgt in ((0, 1.0), (1, 0.7), (2, 0.7)):
        g += wgt * np.hypot(cv2.Sobel(lab[..., ch], cv2.CV_32F, 1, 0), cv2.Sobel(lab[..., ch], cv2.CV_32F, 0, 1))
    inner = cv2.erode(mask, np.ones((11, 11), np.uint8))  # ignore the silhouette's own outline
    g *= inner
    g = g / (g + np.percentile(g[inner > 0], 80) + 1e-6)  # soft-saturate: no single hard edge dominates

    D = int(bw * 0.15)
    xs, tops = cols[::step], top[::step]
    n = len(xs)
    H = mask.shape[0]
    cost = np.empty((n, D), np.float32)
    for i, (x, t) in enumerate(zip(xs, tops)):
        rows = np.clip(int(round(t)) + np.arange(D), 0, H - 1)
        cost[i] = 1.0 - g[rows, x]
    for ax, ay in anchors:
        i = int(np.argmin(np.abs(xs - ax)))
        d = ay - tops[i]
        for j in range(max(0, i - 2), min(n, i + 3)):
            cost[j, np.abs(np.arange(D) - d) > 6] = 1e6

    K, alpha = 3, 0.05
    acc = cost[0].copy()
    back = np.zeros((n, D), np.int32)
    idx = np.arange(D)
    for i in range(1, n):
        best = np.full(D, np.inf, np.float32)
        arg = np.zeros(D, np.int32)
        for k in range(-K, K + 1):
            src = idx - k
            ok = (src >= 0) & (src < D)
            cand = np.full(D, np.inf, np.float32)
            cand[ok] = acc[src[ok]] + alpha * abs(k)
            better = cand < best
            best[better], arg[better] = cand[better], src[better]
        acc = best + cost[i]
        back[i] = arg
    path = np.zeros(n, np.int32)
    path[-1] = int(np.argmin(acc))
    for i in range(n - 1, 0, -1):
        path[i - 1] = back[i, path[i]]
    return np.interp(cols, xs, tops + path)


def detect_wheels(crop: np.ndarray, mask: np.ndarray, bbox):
    bx, by, bw, bh = bbox
    gray = cv2.medianBlur(cv2.cvtColor(crop, cv2.COLOR_RGB2GRAY), 5)
    circles = cv2.HoughCircles(
        gray, cv2.HOUGH_GRADIENT, dp=1.5, minDist=bw * 0.3,
        param1=90, param2=35, minRadius=int(bw * 0.05), maxRadius=int(bw * 0.085),
    )
    if circles is None:
        return []
    picked = {}
    for cx, cy, r in circles[0]:
        if cy < by + bh * 0.4:  # wheels live in the lower part of the car
            continue
        side = "rear" if cx < bx + bw / 2 else "front"
        if side not in picked:  # Hough returns strongest first
            picked[side] = [float(cx), float(cy), float(r)]
    wheels = []
    for side in ("rear", "front"):
        if side not in picked:
            continue
        cx, cy, r = picked[side]
        wheels.append({"cx": cx, "cy": cy, "r": r})
    return wheels


def run(car_id: str) -> dict:
    from . import paths

    car = paths.asset_dir(car_id)
    qa = paths.qa_dir(car_id)
    hints = json.loads((car / "hints.json").read_text())
    photo_path = (car / hints["photo"]).resolve()
    img = np.array(Image.open(photo_path).convert("RGB"))
    H, W = img.shape[:2]

    x, y, w, h = hints["carBox"]
    pad = int(0.04 * w)
    x0, y0 = max(0, x - pad), max(0, y - pad)
    x1, y1 = min(W, x + w + pad), min(H, y + h + pad)
    crop = img[y0:y1, x0:x1]

    session = new_session(hints.get("segModel", "birefnet-general-lite"))
    alpha = np.array(remove(Image.fromarray(crop), session=session, only_mask=True))
    mask = fill_holes(largest_parts((alpha > 127).astype(np.uint8)))
    ys, xs = np.where(mask > 0)
    bbox = (int(xs.min()), int(ys.min()), int(xs.max() - xs.min() + 1), int(ys.max() - ys.min() + 1))
    bx, by, bw, bh = bbox

    # --- wheels (crop px) -------------------------------------------------------------------
    if hints.get("wheels"):
        wheels = [{"cx": wh["cx"] - x0, "cy": wh["cy"] - y0, "r": wh["r"]} for wh in hints["wheels"]]
    else:
        wheels = detect_wheels(crop, mask, bbox)

    # --- body: car mask minus wheel discs → per-column top/bottom ---------------------------
    body = mask.copy()
    for wh in wheels:
        cv2.circle(body, (int(round(wh["cx"])), int(round(wh["cy"]))), int(round(wh["r"] * 1.02)), 0, -1)

    cols = np.arange(bx, bx + bw)
    top = np.full(len(cols), np.nan)
    bot = np.full(len(cols), np.nan)
    for i, cx in enumerate(cols):
        runs = column_runs(body[:, cx] > 0)
        if not runs:
            continue
        s, e = max(runs, key=lambda r: r[1] - r[0])  # body = longest run; drops a floating wing
        top[i], bot[i] = s, e - 1
    valid = ~np.isnan(top)
    top = np.interp(cols, cols[valid], top[valid])
    bot = np.interp(cols, cols[valid], bot[valid])

    # Strut spikes: anything sticking up much further than its neighbourhood median is not body.
    win = max(5, int(bw * 0.035)) | 1
    padded = np.pad(top, win // 2, mode="edge")
    top_med = np.median(np.lib.stride_tricks.sliding_window_view(padded, win), axis=1)
    spike = (top_med - top) > bw * 0.015
    top = np.where(spike, top_med, top)

    # Claude-marked deck line: everything above it (within its x-range) is wing, not body.
    deck = hints.get("wing", {}).get("deckLine")
    if deck:
        dx = np.array([pt[0] for pt in deck], float) - x0
        dy = np.array([pt[1] for pt in deck], float) - y0
        in_range = (cols >= dx.min()) & (cols <= dx.max())
        top = np.where(in_range, np.maximum(top, np.interp(cols, dx, dy)), top)

    # --- addons: mask pixels above the body profile (wings) ---------------------------------
    above = np.zeros_like(mask)
    for i, cx in enumerate(cols):
        t = int(round(top[i])) - 2
        if t > 0:
            above[:t, cx] = mask[:t, cx]
    addons = []
    n, labels, stats, _ = cv2.connectedComponentsWithStats(above, connectivity=8)
    for k in range(1, n):
        if stats[k, cv2.CC_STAT_AREA] < mask.sum() * 0.004:
            continue
        comp = (labels == k).astype(np.uint8)
        cnts, _ = cv2.findContours(comp, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        poly = cv2.approxPolyDP(max(cnts, key=cv2.contourArea), bw * 0.003, True)[:, 0, :]
        cxk = stats[k, cv2.CC_STAT_LEFT] + stats[k, cv2.CC_STAT_WIDTH] / 2
        kind = "wing" if cxk < bx + bw * 0.35 else "bump"
        addon = {"type": kind, "polygon": [[float(px + x0), float(py + y0)] for px, py in poly]}
        if kind == "wing":
            # The wing's top plane: upper ~16% of its side silhouette, extruded across the car later.
            ky, kh = stats[k, cv2.CC_STAT_TOP], stats[k, cv2.CC_STAT_HEIGHT]
            plate = comp.copy()
            plate[ky + int(kh * 0.16):] = 0
            pc, _ = cv2.findContours(plate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
            if pc:
                pp = cv2.approxPolyDP(max(pc, key=cv2.contourArea), bw * 0.003, True)[:, 0, :]
                addon["plate"] = [[float(px + x0), float(py + y0)] for px, py in pp]
        addons.append(addon)

    # --- near top edge (the visible shoulder line) -------------------------------------------
    anchors = [(ax - x0, ay - y0) for ax, ay in hints.get("nearTop", [])]
    near = near_top_edge(crop, mask, cols, top, bw, anchors)

    # --- stations (full px) -----------------------------------------------------------------
    st_x = np.linspace(bx, bx + bw - 1, N_STATIONS)
    stations = [
        [float(sx + x0), float(np.interp(sx, cols, top) + y0), float(np.interp(sx, cols, bot) + y0),
         float(np.interp(sx, cols, near) + y0)]
        for sx in st_x
    ]

    # --- paint colour: saturated mid-tones of the body ---------------------------------------
    hsv = cv2.cvtColor(crop, cv2.COLOR_RGB2HSV)
    body_px = body > 0
    sat = (hsv[..., 1] > 90) & (hsv[..., 2] > 60) & (hsv[..., 2] < 235) & body_px
    pick = sat if sat.sum() > body_px.sum() * 0.15 else body_px & (hsv[..., 2] > 20) & (hsv[..., 2] < 160)
    paint = np.median(crop[pick], axis=0).astype(int)
    paint_hex = "#%02x%02x%02x" % tuple(paint)

    # Tyres are dark on a dark blister, so the segmenter often clips them; trust the wheel circles.
    for wh in wheels:
        cv2.circle(mask, (int(round(wh["cx"])), int(round(wh["cy"]))), int(round(wh["r"])), 1, -1)

    # --- textures ----------------------------------------------------------------------------
    m = int(bw * 0.02)
    tx0, ty0 = max(0, bx - m), max(0, by - m)
    tx1, ty1 = min(crop.shape[1], bx + bw + m), min(crop.shape[0], by + bh + m)
    tex = bleed(crop[ty0:ty1, tx0:tx1], mask[ty0:ty1, tx0:tx1])
    Image.fromarray(tex).save(car / "side.webp", quality=92)
    Image.fromarray(mask[ty0:ty1, tx0:tx1] * 255).save(car / "mask.png")

    web = Image.open(photo_path).convert("RGBA")  # keep the card's die-cut transparency
    if web.height > WEB_PHOTO_MAX_H:
        web = web.resize((round(W * WEB_PHOTO_MAX_H / H), WEB_PHOTO_MAX_H), Image.LANCZOS)
    web.save(car / "photo.webp", quality=90)

    wheels_full = sorted(
        [{"cx": wh["cx"] + x0, "cy": wh["cy"] + y0, "r": wh["r"]} for wh in wheels], key=lambda wh: wh["cx"]
    )
    out = {
        "photo": {"src": "photo.webp", "w": W, "h": H},
        "texture": {"src": "side.webp", "x": tx0 + x0, "y": ty0 + y0, "w": tx1 - tx0, "h": ty1 - ty0},
        "mask": {"src": "mask.png", "x": tx0 + x0, "y": ty0 + y0, "w": tx1 - tx0, "h": ty1 - ty0},
        "bbox": [bx + x0, by + y0, bw, bh],
        "groundY": max([wh["cy"] + wh["r"] for wh in wheels_full] + [by + y0 + bh - 1]),
        "stations": stations,
        "wheels": wheels_full,
        "addons": addons,
        "paint": paint_hex,
    }
    (car / "extract.json").write_text(json.dumps(out, indent=1))

    # --- debug overlay -----------------------------------------------------------------------
    dbg = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
    cnts, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)
    cv2.drawContours(dbg, cnts, -1, (160, 160, 160), 1)
    pts_top = np.array([[s[0] - x0, s[1] - y0] for s in stations], np.int32)
    pts_bot = np.array([[s[0] - x0, s[2] - y0] for s in stations], np.int32)
    cv2.polylines(dbg, [pts_top], False, (255, 120, 0), 3)
    cv2.polylines(dbg, [pts_bot], False, (255, 0, 255), 3)
    pts_near = np.array([[s[0] - x0, s[3] - y0] for s in stations], np.int32)
    cv2.polylines(dbg, [pts_near], False, (0, 255, 0), 3)
    for ax, ay in anchors:
        cv2.circle(dbg, (int(ax), int(ay)), 7, (0, 255, 255), 2)
    for wh in wheels:
        cv2.circle(dbg, (int(wh["cx"]), int(wh["cy"])), int(wh["r"]), (0, 0, 255), 3)
        cv2.circle(dbg, (int(wh["cx"]), int(wh["cy"])), 6, (0, 0, 255), -1)
    for a in addons:
        poly = np.array([[px - x0, py - y0] for px, py in a["polygon"]], np.int32)
        cv2.polylines(dbg, [poly], True, (0, 255, 255) if a["type"] == "wing" else (200, 200, 200), 3)
    if deck:
        cv2.polylines(dbg, [np.array([[pt[0] - x0, pt[1] - y0] for pt in deck], np.int32)], False, (255, 255, 255), 2)
    cv2.rectangle(dbg, (bx, by), (bx + bw, by + bh), (255, 255, 255), 1)
    cv2.imwrite(str(qa / "extract.jpg"), dbg, [cv2.IMWRITE_JPEG_QUALITY, 85])

    tiles = []
    for wh in wheels:
        half = int(wh["r"] * 1.6)
        cx, cy = int(round(wh["cx"])), int(round(wh["cy"]))
        src = cv2.cvtColor(crop, cv2.COLOR_RGB2BGR)
        tile = cv2.copyMakeBorder(src, half, half, half, half, cv2.BORDER_CONSTANT)[cy:cy + 2 * half, cx:cx + 2 * half]
        tile = cv2.resize(tile, (2 * half * 2, 2 * half * 2), interpolation=cv2.INTER_LINEAR)
        for f, col in ((0.9, (0, 255, 0)), (1.0, (0, 0, 255)), (1.1, (0, 255, 0))):
            cv2.circle(tile, (2 * half, 2 * half), int(wh["r"] * f * 2), col, 1)
        cv2.circle(tile, (2 * half, 2 * half), 3, (0, 0, 255), -1)
        tiles.append(cv2.resize(tile, (600, 600)))
    if tiles:
        cv2.imwrite(str(qa / "extract-wheels.jpg"), np.hstack(tiles), [cv2.IMWRITE_JPEG_QUALITY, 85])

    return out
