"""Blender (headless) cleanup of a generated mesh (e.g. Tripo FBX) into a web-ready GLB.

    Blender -b --python ripcars/blender_clean.py -- <in.fbx|glb> <out.glb> <report.json> [texture_px]

Run by `ripcars clean`. Steps:
  1. import, join everything into one mesh
  2. weld seams (merge vertices closer than 0.05% of the car length), drop loose verts/edges and
     zero-area faces
  3. optional (argv[5] == "1"): delete faces no ray from outside can reach. Off by default - generated
     meshes have inside-out and doubled faces that make the test remove visible floor pieces
  4. orient into the RIPCARS frame: nose +x, up +z here (+y after glTF export), right side -y here,
     overall length 4, wheels on the ground, centred
  5. shrink textures to texture_px (default 1024) and export GLB with JPEG textures
"""
import json
import math
import sys

import bmesh
import bpy
from mathutils import Vector
from mathutils.bvhtree import BVHTree

argv = sys.argv[sys.argv.index("--") + 1:]
src, dst, report_path = argv[0], argv[1], argv[2]
tex_px = int(argv[3]) if len(argv) > 3 else 1024
dissolve_deg = float(argv[4]) if len(argv) > 4 else 0.0  # merge near-flat faces (0 = off)
drop_hidden = len(argv) > 5 and argv[5] == "1"  # off by default: on Tripo meshes it punched holes in the floor
# final per-axis scale + offset in the app's (glTF, y-up) frame, from fitting to the sheet: "sx,sy,sz,tx,ty"
fit = [float(v) for v in argv[6].split(",")] if len(argv) > 6 and argv[6] else None

bpy.ops.wm.read_factory_settings(use_empty=True)
if src.lower().endswith(".fbx"):
    bpy.ops.import_scene.fbx(filepath=src)
else:
    bpy.ops.import_scene.gltf(filepath=src)

meshes = [o for o in bpy.data.objects if o.type == "MESH"]
for o in bpy.data.objects:
    o.select_set(o in meshes)
bpy.context.view_layer.objects.active = meshes[0]
if len(meshes) > 1:
    bpy.ops.object.join()
obj = bpy.context.view_layer.objects.active
bpy.ops.object.transform_apply(location=True, rotation=True, scale=True)


def stats(o):
    me = o.data
    sides = {}
    for p in me.polygons:
        sides[len(p.vertices)] = sides.get(len(p.vertices), 0) + 1
    tris = sum(n - 2 for n in (len(p.vertices) for p in me.polygons))
    bm = bmesh.new()
    bm.from_mesh(me)
    open_edges = sum(1 for e in bm.edges if e.is_boundary)
    seen, islands = set(), 0
    for f in bm.faces:
        if f.index in seen:
            continue
        islands += 1
        stack = [f]
        while stack:
            g = stack.pop()
            if g.index in seen:
                continue
            seen.add(g.index)
            stack.extend(h for e in g.edges for h in e.link_faces if h.index not in seen)
    bm.free()
    return {"verts": len(me.vertices), "faces": len(me.polygons), "quads": sides.get(4, 0), "tris_faces": sides.get(3, 0),
            "triangles": tris, "open_edges": open_edges, "pieces": islands}


before = stats(obj)
dims = obj.dimensions.copy()
length = max(dims)

# --- 2. weld and tidy -------------------------------------------------------------------------------
bm = bmesh.new()
bm.from_mesh(obj.data)
bmesh.ops.remove_doubles(bm, verts=bm.verts, dist=length * 0.0005)
bmesh.ops.dissolve_degenerate(bm, dist=length * 0.0001, edges=bm.edges)
loose_v = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose_v, context="VERTS")
loose_e = [e for e in bm.edges if not e.link_faces]
bmesh.ops.delete(bm, geom=loose_e, context="EDGES")
bm.to_mesh(obj.data)
obj.data.update()

# --- 3. hidden faces --------------------------------------------------------------------------------
bm.faces.ensure_lookup_table()
bvh = BVHTree.FromBMesh(bm)
golden = math.pi * (3 - math.sqrt(5))
dirs = []
n = 96
for i in range(n):  # evenly spread directions on the sphere
    y = 1 - (i / (n - 1)) * 2
    r = math.sqrt(max(0.0, 1 - y * y))
    dirs.append(Vector((math.cos(golden * i) * r, y, math.sin(golden * i) * r)))
eps = length * 1e-4
hidden = []
for f in (bm.faces if drop_hidden else []):
    c = f.calc_center_median()
    # sample the centre and points 80% of the way to each corner: a face counts as visible if any of
    # them can see out, so partly hidden faces (deep in a grille, behind a tyre) are kept
    pts = [c] + [c.lerp(v.co, 0.8) for v in f.verts]
    seen_from_outside = False
    for pt in pts:
        for d in dirs:  # every direction: generated meshes have some faces wound inside-out
            hit = bvh.ray_cast(pt + d * eps, d, length * 4)
            if hit[0] is None:  # escapes the model: visible from direction d
                seen_from_outside = True
                break
        if seen_from_outside:
            break
    if not seen_from_outside:
        hidden.append(f)
removed_hidden = len(hidden)
bmesh.ops.delete(bm, geom=hidden, context="FACES")
loose_v = [v for v in bm.verts if not v.link_faces]
bmesh.ops.delete(bm, geom=loose_v, context="VERTS")
bm.to_mesh(obj.data)
bm.free()
obj.data.update()

# --- 3b. merge near-flat faces into bigger ones, never across UV seams or materials --------------------
dissolved = 0
if dissolve_deg > 0:
    n0 = len(obj.data.polygons)
    bm = bmesh.new()
    bm.from_mesh(obj.data)
    bmesh.ops.dissolve_limit(bm, angle_limit=math.radians(dissolve_deg), verts=bm.verts, edges=bm.edges,
                             delimit={"UV", "MATERIAL", "SEAM", "SHARP"})
    bmesh.ops.triangulate(bm, faces=[f for f in bm.faces if len(f.verts) > 4])  # no n-gons: stay quads + tris
    bm.to_mesh(obj.data)
    bm.free()
    obj.data.update()
    dissolved = n0 - len(obj.data.polygons)

# --- 4. orient, size, ground ------------------------------------------------------------------------
# Blender is z-up; glTF export turns it into y-up with -y(blender) -> +z(gltf). Our frame wants the
# nose at +x and the car's right side at +z (gltf), i.e. -y here. Tripo exports the nose along +x.
d = obj.dimensions
if d.y > d.x:  # car lies along y: turn it to x
    obj.rotation_euler = (0, 0, math.pi / 2)
    bpy.ops.object.transform_apply(rotation=True)
s = 4.0 / obj.dimensions.x
obj.scale = (s, s, s)
bpy.ops.object.transform_apply(scale=True)
xs = [v.co.x for v in obj.data.vertices]
ys = [v.co.y for v in obj.data.vertices]
zs = [v.co.z for v in obj.data.vertices]
off = Vector(((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2, min(zs)))
for v in obj.data.vertices:
    v.co -= off
obj.data.update()
if fit:  # glTF (x, y, z) = blender (x, z, -y)
    sx, sy, sz, tx, ty = fit
    for v in obj.data.vertices:
        v.co.x = v.co.x * sx + tx
        v.co.y = v.co.y * sz
        v.co.z = v.co.z * sy + ty
    obj.data.update()
obj.name = obj.data.name = "generated"  # not "body": the app's glass split is for its own bakes only

# --- 5. textures + export ---------------------------------------------------------------------------
for img in bpy.data.images:
    if img.size[0] > tex_px:
        img.scale(tex_px, tex_px)
after = stats(obj)
bpy.ops.export_scene.gltf(filepath=dst, export_format="GLB", export_image_format="JPEG", export_jpeg_quality=86,
                          use_selection=False, export_apply=True, export_yup=True)
json.dump({"before": before, "after": after, "hidden_faces_removed": removed_hidden, "sheet_fit": fit, "flat_faces_merged": dissolved,
           "source_dimensions": [round(v, 4) for v in dims], "texture_px": tex_px}, open(report_path, "w"), indent=2)
print("CLEAN", json.dumps({"before": before, "after": after, "hidden_faces_removed": removed_hidden}))
