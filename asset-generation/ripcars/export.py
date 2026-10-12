"""Write the car as a compact GLB: textured body + four wheel pivots (spin about local +z).

Model frame: nose +x, up +y, the car's right side +z, ground at y = 0, overall length 4.0.
Nodes: body; wheel_{rear,front}_{right,left} (pivot at the hub, local +z points out of the car),
each with a tyre mesh and a face disc carrying the sheet's own drawing of that wheel.
"""
import io

import cv2
import numpy as np
import trimesh
from PIL import Image
from trimesh.visual.material import PBRMaterial
from trimesh.visual.texture import TextureVisuals

from . import wheels as wh


def _jpeg(rgb: np.ndarray, quality: int) -> Image.Image:
    """A PIL image trimesh will embed as JPEG at our quality (it re-saves JPEG-format images)."""
    buf = io.BytesIO()
    Image.fromarray(rgb).save(buf, format="JPEG", quality=quality, optimize=True)
    buf.seek(0)
    img = Image.open(buf)
    img.load()
    img.save = (lambda fp, format=None, **kw: Image.Image.save(img, fp, format="JPEG", quality=quality, optimize=True))
    return img


def _material(name, texture=None, colour=(1, 1, 1), metallic=0.0, roughness=0.5, mr_texture=None):
    return PBRMaterial(name=name, baseColorTexture=texture, baseColorFactor=[*colour, 1.0],
                       metallicFactor=metallic, roughnessFactor=roughness, metallicRoughnessTexture=mr_texture)


def write(path, body_verts, body_normals, body_faces, body_uv_topleft, texture_rgb, wheels: list, rim_images: dict,
          material_rgb=None, quality: int = 86) -> dict:
    """material_rgb: glTF metallicRoughness map (G = roughness, B = metalness) - where the glass is."""
    scene = trimesh.Scene()
    uv = body_uv_topleft.copy()
    uv[:, 1] = 1.0 - uv[:, 1]  # trimesh stores bottom-left UVs and flips them back for glTF
    mr = None
    if material_rgb is not None:  # two values only: a small PNG at half size is plenty
        h, w = material_rgb.shape[:2]
        mr = Image.fromarray(cv2.resize(material_rgb, (w // 2, h // 2), interpolation=cv2.INTER_NEAREST))
    paint = _material("paint", _jpeg(texture_rgb, quality), metallic=1.0 if mr else 0.1, roughness=1.0 if mr else 0.5,
                      mr_texture=mr)
    body = trimesh.Trimesh(body_verts, body_faces, vertex_normals=body_normals, process=False,
                           visual=TextureVisuals(uv=uv, material=paint))
    scene.add_geometry(body, node_name="body", geom_name="body")

    rubber = _material("tyre", colour=(0.045, 0.045, 0.05), roughness=0.9)
    for w in wheels:
        width = w["z_outer"] - w["z_inner"]
        zc = w["side"] * (w["z_outer"] + w["z_inner"]) / 2
        pivot = np.eye(4)
        if w["side"] < 0:  # local +z must point out of the car on the left too
            pivot[:3, :3] = trimesh.transformations.rotation_matrix(np.pi, [0, 1, 0])[:3, :3]
        pivot[:3, 3] = [w["x"], w["y"], zc]
        scene.graph.update(frame_from=scene.graph.base_frame, frame_to=w["name"], matrix=pivot)

        tyre = wh.tyre_mesh(w["r"], width, segments=28)
        tyre.visual = TextureVisuals(material=rubber)
        scene.add_geometry(tyre, node_name=f"{w['name']}_tyre", geom_name=f"{w['name']}_tyre", parent_node_name=w["name"])

        dv, df, duv = wh.face_disc(w["r"] * 0.995, segments=28)
        dv[:, 2] = width / 2 * 0.985
        rim = _jpeg(cv2.resize(rim_images["right" if w["side"] > 0 else "left"][w["name"].split("_")[1]], (256, 256),
                               interpolation=cv2.INTER_AREA), quality)
        face = trimesh.Trimesh(dv, df, process=False, visual=TextureVisuals(uv=duv, material=_material(
            f"{w['name']}_face", rim, metallic=0.25, roughness=0.45)))
        scene.add_geometry(face, node_name=f"{w['name']}_face", geom_name=f"{w['name']}_face", parent_node_name=w["name"])

    data = scene.export(file_type="glb", include_normals=True)
    with open(path, "wb") as fh:
        fh.write(data)
    tris = sum(len(g.faces) for g in scene.geometry.values())
    return {"bytes": len(data), "triangles": int(tris)}
