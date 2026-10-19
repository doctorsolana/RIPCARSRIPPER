"""Parts of a generated mesh: the wheels, so the reveal can spin them.

Tripo exports one mesh, but builds it from separate pieces (faces connected through shared vertex
positions): the body, the wing, mirrors - and per wheel a tyre plus its rim disc and hub. A tyre is
the round piece at each corner that stands on the ground at the car's side; every piece centred
inside it (rim, hub, brake disc) turns with it. Off-centre parts inside the wheel, such as a brake
caliper, stay put, as on a real car.
"""
import numpy as np
from scipy import sparse
from scipy.sparse import csgraph


def pieces(V: np.ndarray, F: np.ndarray) -> np.ndarray:
    """Per face, the label of the connected piece it belongs to (vertices merged by position first,
    so UV seams don't cut a piece apart)."""
    key = np.round(V / (np.ptp(V, axis=0).max() * 1e-6)).astype(np.int64)
    _, inv = np.unique(key, axis=0, return_inverse=True)
    f = inv.ravel()[F]
    n = int(f.max()) + 1
    rows = np.concatenate([f[:, 0], f[:, 1], f[:, 2]])
    cols = np.concatenate([f[:, 1], f[:, 2], f[:, 0]])
    graph = sparse.coo_matrix((np.ones(len(rows)), (rows, cols)), shape=(n, n))
    _, label = csgraph.connected_components(graph, directed=False)
    return label[f[:, 0]]


def find_wheels(V: np.ndarray, F: np.ndarray) -> tuple[list[dict], str]:
    """The four wheels (model frame: nose +x, up +y, right side +z, ground y=0), each
    {name, centre, r, faces, pieces}, plus a note. All four or none: a half-spinning car is worse
    than a still one."""
    label = pieces(V, F)
    L, width = np.ptp(V[:, 0]), np.ptp(V[:, 2])
    xmid = (V[:, 0].min() + V[:, 0].max()) / 2
    parts = []
    for k in np.unique(label):
        faces = np.nonzero(label == k)[0]
        P = V[F[faces]].reshape(-1, 3)
        parts.append((k, faces, P.min(0), P.max(0)))

    def tyre_like(lo, hi):
        d, c = hi - lo, (lo + hi) / 2
        return (0.75 < d[0] / max(d[1], 1e-9) < 1.33  # round from the side
                and d[2] < 0.75 * d[0]                 # narrower than it is tall
                and 0.06 * L < d[1] < 0.3 * L          # wheel-sized
                and abs(c[2]) > 0.2 * width            # at the car's side
                and lo[1] < 0.2 * d[1])                # standing on the ground

    tyres = [(k, faces, lo, hi) for k, faces, lo, hi in parts if tyre_like(lo, hi)]
    corner = lambda t, axle, side: (((t[2][0] + t[3][0]) / 2 > xmid) == (axle == "front")
                                    and ((t[2][2] + t[3][2]) / 2 > 0) == (side == "right"))
    if any(not any(corner(t, a, s) for t in tyres) for a in ("front", "rear") for s in ("right", "left")):
        # A corner has no tyre of its own: the generator may have joined an axle's two tyres through the axle into
        # one piece (the Silvia's rear). Split such a piece at the centre line, leaving the axle's middle in the body.
        # Only then, so cars whose four tyres are found as before come out unchanged.
        for k, faces, lo, hi in list(parts):
            d = hi - lo
            if not (0.75 < d[0] / max(d[1], 1e-9) < 1.33 and 0.06 * L < d[1] < 0.3 * L and lo[1] < 0.2 * d[1]
                    and lo[2] < -0.2 * width and hi[2] > 0.2 * width):
                continue
            zc = V[F[faces]].mean(axis=1)[:, 2]
            for sign in (1, -1):
                half = faces[sign * zc > 0.2 * width]
                if len(half):
                    P = V[F[half]].reshape(-1, 3)
                    if tyre_like(P.min(0), P.max(0)):
                        tyres.append((k, half, P.min(0), P.max(0)))
    wheels = []
    for axle in ("front", "rear"):
        for side in ("right", "left"):
            here = [t for t in tyres if corner(t, axle, side)]
            if not here:
                return [], f"no tyre-shaped piece at the {axle} {side}: wheels left in the body"
            k, faces, lo, hi = max(here, key=lambda t: len(t[1]))  # the biggest one there
            r = float(max(hi[0] - lo[0], hi[1] - lo[1]) / 2)
            if lo[1] - V[:, 1].min() > 0.25 * r:  # a rim off the ground taken for the tyre (the LB-ER34 JBK59): r is
                r = float((lo[1] + hi[1]) / 2 - V[:, 1].min())  # the hub's height, so the tyre around it joins below
                # and the app seats the car on the tyre, not the rim (it put the tyres 0.08 into the road)
            wheels.append({"name": f"wheel_{axle}_{side}", "piece": k, "faces": faces, "centre": (lo + hi) / 2, "r": r})
    radii = np.array([w["r"] for w in wheels])
    if radii.max() > 1.35 * radii.min():
        return [], f"tyres of very different sizes ({np.round(radii, 3).tolist()}): wheels left in the body"
    for w in wheels:  # the rest of each wheel: pieces centred in its tyre and inside it
        c, r = w["centre"], w["r"]
        extra = [faces for k, faces, lo, hi in parts
                 if k != w["piece"] and np.hypot(*((lo + hi)[:2] / 2 - c[:2])) < 0.25 * r
                 and max(hi[0] - lo[0], hi[1] - lo[1]) / 2 <= 1.02 * r and abs((lo[2] + hi[2]) / 2 - c[2]) < 0.8 * r]
        w["faces"] = np.concatenate([w["faces"], *extra])
        w["pieces"] = 1 + len(extra)
    return wheels, "four wheels: " + ", ".join(f"{w['name'].removeprefix('wheel_')} r {w['r']:.3f} ({w['pieces']} pieces)" for w in wheels)
