"""SDF -> clean triangle mesh: marching cubes, volume-preserving smoothing, decimation."""
import fast_simplification
import numpy as np
import trimesh
from skimage import measure

from .hull import Body


def surface(body: Body, target_faces: int = 90_000, smooth_iters: int = 6) -> trimesh.Trimesh:
    g = body.grid
    verts, faces, _, _ = measure.marching_cubes(body.sdf, level=0.0, spacing=(g.h, g.h, g.h), allow_degenerate=False)
    mesh = trimesh.Trimesh(verts + g.origin, faces, process=True)
    if mesh.volume < 0:
        mesh.invert()
    # keep the car, drop specks the hull may leave around thin parts
    parts = mesh.split(only_watertight=False)
    if len(parts) > 1:
        biggest = max(p.area for p in parts)
        mesh = trimesh.util.concatenate([p for p in parts if p.area > biggest * 0.002])
    # Taubin: removes voxel stair-steps without shrinking. trimesh subtracts nu on the odd passes,
    # so nu is positive (a negative nu would turn it into a shrinking Laplacian).
    trimesh.smoothing.filter_taubin(mesh, lamb=0.5, nu=0.53, iterations=smooth_iters)
    if len(mesh.faces) > target_faces:
        v, f = fast_simplification.simplify(
            mesh.vertices.astype(np.float32), mesh.faces.astype(np.int32), target_count=target_faces, agg=5
        )
        mesh = trimesh.Trimesh(v, f, process=True)
    mesh.remove_unreferenced_vertices()
    mesh.fix_normals()
    if mesh.volume < 0:  # decimation can leave the whole surface inside-out; fix_normals can't always tell
        mesh.invert()
    return mesh
