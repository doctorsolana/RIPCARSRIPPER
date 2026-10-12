"""Generate a car's mesh with Tripo (P2, quad) from its reference images.

    uv run --locked python -m ripcars tripo <car> [--sheet PATH] [--send]

Without --send this is a dry run: it writes the exact images and request body it would send to
assets/cars/<id>/tripo/multiview/ and calls nothing. With --send it uploads, submits, waits and saves
the outputs + task.json there. Each sent task spends Tripo credits.

  multiview  the five-view sheet's front, left, rear and right views, cut out on white at one
             common scale -> POST /v3/generation/multiview-to-model

Needs TRIPO_API_KEY (environment, or asset-generation/.env - git-ignored).
Docs: https://developers.tripo3d.com/en/docs/generation-multiview-to-model/p.md
"""
import json
import mimetypes
import os
import time
import urllib.error
import urllib.request
import uuid
from pathlib import Path

import cv2
import numpy as np

from . import paths, sheet

# International accounts (developers.tripo3d.ai) use the .ai API host; .com is Tripo's China region,
# and keys only work in their own region.
BASE = os.environ.get("TRIPO_API_BASE", "https://openapi.tripo3d.ai/v3")
# Tripo view name -> our panel name. "left"/"right" are the car's own left/right sides.
VIEWS = {"front": "front", "left": "left", "back": "rear", "right": "side"}
# P2 ("smart mesh"), quad topology. Quad output is limited to 25,000 faces; 8,000 quads (~16k triangles)
# matches the app's ~15k-triangle budget per car.
SETTINGS = {"model": "P2-20260801", "quad": True, "face_limit": 8000, "texture": True, "pbr": True,
            "texture_quality": "standard"}


def balance() -> dict:
    """Free call: the account's API credit balance."""
    return _request("GET", f"{BASE}/account/balance", api_key())


def api_key() -> str:
    key = os.environ.get("TRIPO_API_KEY")
    env = paths.STAGE / ".env"
    if not key and env.is_file():
        for line in env.read_text().splitlines():
            if line.strip().startswith("TRIPO_API_KEY="):
                key = line.split("=", 1)[1].strip().strip('"').strip("'")
    if not key:
        raise SystemExit("TRIPO_API_KEY is not set: add it to your environment or to asset-generation/.env")
    return key


def _request(method: str, url: str, key: str, body: bytes | None = None, ctype: str | None = None) -> dict:
    req = urllib.request.Request(url, data=body, method=method, headers={"Authorization": f"Bearer {key}"})
    if ctype:
        req.add_header("Content-Type", ctype)
    try:
        with urllib.request.urlopen(req, timeout=120) as r:
            data = json.loads(r.read())
    except urllib.error.HTTPError as e:
        raise SystemExit(f"Tripo {method} {url} -> HTTP {e.code}: {e.read().decode(errors='replace')[:500]}")
    if data.get("code") not in (0, None):
        raise SystemExit(f"Tripo error {data.get('code')}: {data.get('message')}")
    return data.get("data", data)


def upload(path: Path, key: str) -> str:
    boundary = uuid.uuid4().hex
    mime = mimetypes.guess_type(path.name)[0] or "image/png"
    body = (f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{path.name}\"\r\n"
            f"Content-Type: {mime}\r\n\r\n").encode() + path.read_bytes() + f"\r\n--{boundary}--\r\n".encode()
    return _request("POST", f"{BASE}/files", key, body, f"multipart/form-data; boundary={boundary}")["file_token"]


def default_sheet(car: str) -> Path:
    if paths.sheet(car).is_file():
        return paths.sheet(car)
    m = paths.manifest(car)
    preview = (json.loads(m.read_text()).get("preview") or {}) if m.is_file() else {}
    for key in ("file", "version_file", "path"):
        if preview.get(key) and (paths.REFERENCES / car / preview[key]).is_file():
            return paths.REFERENCES / car / preview[key]
    raise SystemExit(f"no current five-view sheet for {car}: pass --sheet")


def multiview_images(sheet_path: Path, car: str, out: Path, size: int = 1024) -> dict[str, Path]:
    """Front, left, rear and right cut out (matte) onto white, centred in squares, all four at the
    same scale (the car's length fills 88% of the side views) so Tripo sees one consistent object."""
    from .views import calibrate

    panels = sheet.load(sheet_path, cache_dir=paths.cache_dir(car))
    cal = calibrate(panels)
    px_per_unit = 0.88 * size / cal.L
    out.mkdir(parents=True, exist_ok=True)
    files = {}
    for tview, name in VIEWS.items():
        if name not in cal.views:
            continue
        v = cal.views[name]
        p = v.panel
        x0, y0, x1, y1 = p.bbox
        rgb = p.rgb[y0:y1, x0:x1].astype(np.float32)
        a = p.alpha[y0:y1, x0:x1, None]
        img = (rgb * a + 255 * (1 - a)).astype(np.uint8)
        img = cv2.resize(img, (max(1, round((x1 - x0) * v.su * px_per_unit)), max(1, round((y1 - y0) * v.sv * px_per_unit))),
                         interpolation=cv2.INTER_AREA)
        h, w = img.shape[:2]
        canvas = np.full((size, size, 3), 255, np.uint8)
        top = (size - h) // 2  # every view is the same height at this scale: ground lines line up
        canvas[top:top + h, (size - w) // 2:(size - w) // 2 + w] = img
        files[tview] = out / f"{tview}.png"
        cv2.imwrite(str(files[tview]), cv2.cvtColor(canvas, cv2.COLOR_RGB2BGR))
    return files


def prepare(car: str, sheet_path: str | None = None) -> dict:
    """Write the inputs and the exact request; nothing is sent."""
    mode = "multiview"
    out = paths.asset_dir(car) / "tripo" / mode
    out.mkdir(parents=True, exist_ok=True)
    src = Path(sheet_path) if sheet_path else default_sheet(car)
    files = multiview_images(src, car, out / "views")
    endpoint = "/generation/multiview-to-model"
    body = {"inputs": [{view: {"file_token": f"<file_token of {p.name}>"}} for view, p in files.items()], **SETTINGS}
    rel = lambda f: str(Path(f).resolve().relative_to(paths.REPO))  # records stay valid on any machine
    plan = {"car": car, "mode": mode, "source": rel(src), "endpoint": BASE + endpoint,
            "files": {k: rel(v) for k, v in files.items()}, "body": body}
    (out / "request.json").write_text(json.dumps(plan, indent=2) + "\n")
    return plan


def send(plan: dict, poll_s: float = 3.0, timeout_s: float = 1200) -> dict:
    key = api_key()
    bal = _request("GET", f"{BASE}/account/balance", key)
    if float(bal.get("balance", 0)) <= 0:
        raise SystemExit(f"Tripo API balance is {bal.get('balance')} credits: top up at developers.tripo3d.ai (Pricing) first")
    out = paths.asset_dir(plan["car"]) / "tripo" / plan["mode"]
    tokens = {k: upload(paths.REPO / v, key) for k, v in plan["files"].items()}
    body = dict(plan["body"])
    body["inputs"] = [{view: {"file_token": tokens[view]}} for view in tokens]
    task_id = _request("POST", plan["endpoint"], key, json.dumps(body).encode(), "application/json")["task_id"]
    (out / "task_id.txt").write_text(task_id + "\n")
    t0 = time.time()
    while True:
        status = _request("GET", f"{BASE}/tasks/{task_id}", key)
        state = status.get("status")
        if state == "success":
            break
        if state in ("failed", "cancelled", "banned", "expired"):
            (out / "task.json").write_text(json.dumps(status, indent=2))
            raise SystemExit(f"Tripo task {task_id} ended as {state}: see {out / 'task.json'}")
        if time.time() - t0 > timeout_s:
            raise SystemExit(f"Tripo task {task_id} still {state} after {timeout_s:.0f}s (id saved in task_id.txt)")
        time.sleep(poll_s)
    (out / "task.json").write_text(json.dumps(status, indent=2))
    saved = {}
    for name, url in (status.get("output") or {}).items():
        if isinstance(url, str) and url.startswith("http"):
            ext = Path(url.split("?")[0]).suffix or ".bin"
            dest = out / f"{name}{ext}"
            urllib.request.urlretrieve(url, dest)
            saved[name] = str(dest)
    return {"task_id": task_id, "saved": saved, "credits": status.get("credits_consumed"),
            "seconds": round(time.time() - t0)}
