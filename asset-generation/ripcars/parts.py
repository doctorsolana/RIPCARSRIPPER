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
    wheels = []
    for axle in ("front", "rear"):
        for side in ("right", "left"):
            here = [t for t in tyres if ((t[2][0] + t[3][0]) / 2 > xmid) == (axle == "front")
                    and ((t[2][2] + t[3][2]) / 2 > 0) == (side == "right")]
            if not here:
                return [], f"no tyre-shaped piece at the {axle} {side}: wheels left in the body"
            k, faces, lo, hi = max(here, key=lambda t: len(t[1]))  # the biggest one there
            wheels.append({"name": f"wheel_{axle}_{side}", "piece": k, "faces": faces,
                           "centre": (lo + hi) / 2, "r": float(max(hi[0] - lo[0], hi[1] - lo[1]) / 2)})
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
