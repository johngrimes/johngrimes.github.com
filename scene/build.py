"""Builds, renders and exports the laboratory scene behind the CV.

The scene is a simplified model of an overgrown laboratory under a ribbed
glass dome: a central tree, two timber-topped benches, a shelving wall,
foreground plants and greenery hanging from the ceiling. Every surface is
grey; colour comes afterwards, when each pixel's shade and distance are
mapped onto the page's paper and ink colours for the light and dark schemes.

Run from the repository root (needs Blender 5.2 and libwebp's cwebp):

    blender -b --factory-startup -P scene/build.py -- [--samples N] [--post-only]

--post-only skips rendering and reuses the EXR passes in scene/out/, which is
useful when tuning the palette.

Outputs, all under background/assets/:

- light/ and dark/: layer-0.webp (farthest) to layer-4.webp (nearest), the
  depth slices for the layered variant, and colour.webp, the whole scene in
  one image for the depth variant and the still fallbacks.
- depth.webp: per-pixel disparity for the depth variant.
- scene.glb: the model and camera for the glTF variant.
- scene.json: the manifest the variants read (geometry of the frame, motion,
  fog and palette).

Author: John Grimes
"""

import argparse
import itertools
import json
import math
import random
import shutil
import subprocess
import sys
from pathlib import Path

import bmesh
import bpy
import numpy as np
import OpenImageIO as oiio
from mathutils import Euler, Matrix, Vector, noise

ROOT = Path(__file__).resolve().parent.parent
ASSETS = ROOT / "background" / "assets"
WORK = ROOT / "scene" / "out"

# The displayed frame is 16:9 and WIDTH pixels wide. Renders add a margin of
# OVERSCAN frame widths on every side, so layers can shift that far without
# exposing an edge.
WIDTH = 2400
ASPECT = 16 / 9
OVERSCAN = 0.03

# A 16 mm lens on a 36 mm frame: the focal length in frame widths, so that a
# point at lateral offset X and depth Z projects to u = FOCAL * X / Z.
LENS = 16.0
FOCAL = LENS / 36.0

# Depths in metres along the camera axis. FAR stands in for infinity; NEAR is
# the nearest depth the depth map encodes.
NEAR = 2.0
FAR = 100.0

# The largest shift of any part of the image at full pointer offset, in frame
# widths. It must stay within OVERSCAN.
SHIFT = 0.025

# Representative depth of each layer, nearest first. Most of the scene lies
# between the foreground plants (about 3 m) and the tree (about 15 m); the
# middle layer sits at the benches, the focal plane.
LAYER_DEPTHS = [3.2, 4.6, 7.5, 13.0, FAR]

# Fog: distance (m) at which the scene starts to fade into the paper, and at
# which it has gone entirely.
FOG_START = 7.0
FOG_END = 55.0

# Exposure applied to the linear render before it becomes a 0-1 shade.
EXPOSURE = 1.6

# Strength of the uniform white sky and of the sun (W/m²).
SKY = 1.1
SUN = 3.0

# Palette. PAPER and MUTED mirror --paper and --muted in style.css. Each
# scheme draws the scene along a line from its paper towards TOWARDS, and
# stops where muted text would fall to CONTRAST against it. CONTRAST sits
# above the WCAG AA minimum of 4.5 to absorb compression error, and
# check_legible proves it did. WEIGHTS gives the share of that range used by
# fully shadowed and fully lit surfaces.
PAPER = {"light": "#fbf8f3", "dark": "#171513"}
MUTED = {"light": "#5f5850", "dark": "#a89f93"}
TOWARDS = {"light": "#3b3026", "dark": "#efe6d8"}
WEIGHTS = {"light": {"shadow": 1.0, "lit": 0.12}, "dark": {"shadow": 0.1, "lit": 0.6}}
CONTRAST = 5.0

# Room layout (m). The camera stands near the origin looking along +y.
CEILING = 6.8
DOME = {"cx": -1.0, "cy": 12.5, "rx": 6.2, "ry": 9.0, "height": 2.8}
LEFT_WALL = -9.5
VAULT_FOOT = 8.0
VAULT_TOP = 3.8
BACK_WALL = 34.0
CAMERA = {"location": (0.3, -1.2, 1.65), "pitch": 8.0}
FOCUS_POINT = (2.8, 6.5, 0.95)

rng = random.Random(11)


# ---------------------------------------------------------------------------
# Mesh helpers
# ---------------------------------------------------------------------------


def to_object(name, bm, material, smooth=False):
    """Turns a bmesh into a linked mesh object with one material.

    Args:
        name: Object and mesh name.
        bm: The bmesh, which is freed.
        material: Material to assign.
        smooth: Whether to shade faces smoothly.

    Returns:
        The new object.
    """
    bmesh.ops.recalc_face_normals(bm, faces=bm.faces)
    mesh = bpy.data.meshes.new(name)
    bm.to_mesh(mesh)
    bm.free()
    mesh.polygons.foreach_set("use_smooth", [smooth] * len(mesh.polygons))
    mesh.materials.append(material)
    obj = bpy.data.objects.new(name, mesh)
    bpy.context.scene.collection.objects.link(obj)
    return obj


def transform(location, scale=(1, 1, 1), rotation=(0, 0, 0)):
    """Builds a location, rotation (Euler XYZ, radians) and scale matrix."""
    return (
        Matrix.Translation(location)
        @ Euler(rotation).to_matrix().to_4x4()
        @ Matrix.Diagonal((*scale, 1))
    )


def box(bm, centre, size, rotation=(0, 0, 0)):
    """Adds an axis-aligned (before rotation) box of the given full size."""
    bmesh.ops.create_cube(bm, size=1, matrix=transform(centre, size, rotation))


def cylinder(bm, base, radius, height, segments=16, top_radius=None):
    """Adds an upright cylinder or cone standing on base."""
    x, y, z = base
    bmesh.ops.create_cone(
        bm,
        cap_ends=True,
        segments=segments,
        radius1=radius,
        radius2=radius if top_radius is None else top_radius,
        depth=height,
        matrix=Matrix.Translation((x, y, z + height / 2)),
    )


def disc(bm, centre, radius, segments=32):
    """Adds a flat, horizontal disc."""
    bmesh.ops.create_circle(
        bm,
        cap_ends=True,
        segments=segments,
        radius=radius,
        matrix=Matrix.Translation(centre),
    )


def blob(bm, centre, radius, squash=(1, 1, 1), subdivisions=2, roughness=0.35):
    """Adds a lumpy sphere, the unit of all foliage."""
    result = bmesh.ops.create_icosphere(
        bm,
        subdivisions=subdivisions,
        radius=1,
        matrix=transform(centre, [radius * s for s in squash]),
    )
    seed = Vector((rng.random(), rng.random(), rng.random())) * 50
    for vert in result["verts"]:
        direction = (vert.co - Vector(centre)).normalized()
        bump = noise.noise(vert.co * 1.7 + seed)
        vert.co += direction * radius * roughness * bump


def cluster(bm, centre, spread, count, size, subdivisions=1):
    """Adds a clump of small blobs inside an ellipsoid, flatter than it is
    wide, which reads as a mass of leaves rather than a single lump."""
    centre = Vector(centre)
    for _ in range(count):
        offset = Vector([rng.gauss(0, 0.5) for _ in range(3)])
        offset.z *= 0.55
        if offset.length > 1:
            offset.normalize()
        blob(
            bm,
            centre + offset * spread,
            size * rng.uniform(0.6, 1.15),
            (1.15, 1.15, 0.8),
            subdivisions,
            0.45,
        )


def tube(bm, points, radii, sides=8):
    """Adds a capped tube through points, with a radius at each point.

    Frames are carried along the path by projecting the previous normal onto
    each new cross-section, which keeps the tube from twisting.
    """
    points = [Vector(p) for p in points]
    angles = [2 * math.pi * k / sides for k in range(sides)]
    rings = []
    normal = None
    for i, point in enumerate(points):
        tangent = (
            points[min(i + 1, len(points) - 1)] - points[max(i - 1, 0)]
        ).normalized()
        if normal is None:
            up = Vector((0, 0, 1)) if abs(tangent.z) < 0.9 else Vector((1, 0, 0))
            normal = tangent.cross(up).normalized()
        else:
            normal = (normal - tangent * normal.dot(tangent)).normalized()
        binormal = tangent.cross(normal)
        rings.append(
            [
                bm.verts.new(
                    point + radii[i] * (math.cos(a) * normal + math.sin(a) * binormal)
                )
                for a in angles
            ]
        )
    for near, far in itertools.pairwise(rings):
        for k in range(sides):
            bm.faces.new((near[k], near[(k + 1) % sides], far[(k + 1) % sides], far[k]))
    bm.faces.new(list(reversed(rings[0])))
    bm.faces.new(rings[-1])


def rounded_prism(bm, centre, width, depth, radius, bottom, top, segments=8):
    """Adds a prism whose footprint is a rectangle with rounded corners."""
    cx, cy = centre
    hx, hy = width / 2 - radius, depth / 2 - radius
    outline = []
    for corner, (sx, sy) in enumerate(((1, 1), (-1, 1), (-1, -1), (1, -1))):
        for k in range(segments + 1):
            a = (corner + k / segments) * math.pi / 2
            outline.append(
                (
                    cx + sx * hx + radius * math.cos(a),
                    cy + sy * hy + radius * math.sin(a),
                )
            )
    low = [bm.verts.new((x, y, bottom)) for x, y in outline]
    high = [bm.verts.new((x, y, top)) for x, y in outline]
    bm.faces.new(list(reversed(low)))
    bm.faces.new(high)
    count = len(outline)
    for k in range(count):
        bm.faces.new((low[k], low[(k + 1) % count], high[(k + 1) % count], high[k]))


def material(name, shade, roughness=0.8, emission=0.0):
    """Creates a grey material.

    Args:
        name: Material name.
        shade: Grey albedo, 0-1.
        roughness: Principled BSDF roughness.
        emission: Emission strength; zero for none.

    Returns:
        The material.
    """
    mat = bpy.data.materials.new(name)
    if hasattr(mat, "use_nodes") and not mat.use_nodes:
        mat.use_nodes = True
    bsdf = mat.node_tree.nodes["Principled BSDF"]
    bsdf.inputs["Base Color"].default_value = (shade, shade, shade, 1)
    bsdf.inputs["Roughness"].default_value = roughness
    if emission:
        bsdf.inputs["Emission Color"].default_value = (1, 1, 1, 1)
        bsdf.inputs["Emission Strength"].default_value = emission
    mat.diffuse_color = (shade, shade, shade, 1)
    return mat


# ---------------------------------------------------------------------------
# Scene
# ---------------------------------------------------------------------------


def dome_height(x, y):
    """Height of the dome surface above (x, y); the ceiling outside it."""
    d = DOME
    r = ((x - d["cx"]) / d["rx"]) ** 2 + ((y - d["cy"]) / d["ry"]) ** 2
    return CEILING + d["height"] * math.sqrt(max(0.0, 1 - r))


def build_shell(mats):
    """Floor, walls, the ceiling with its elliptical opening, and the dome."""
    d = DOME
    bm = bmesh.new()
    bmesh.ops.create_grid(
        bm, x_segments=1, y_segments=1, size=60, matrix=Matrix.Translation((0, 20, 0))
    )
    to_object("Floor", bm, mats["floor"])

    bm = bmesh.new()
    box(bm, (LEFT_WALL - 0.1, 12, CEILING / 2), (0.2, 50, CEILING))
    box(bm, ((LEFT_WALL + VAULT_FOOT) / 2, BACK_WALL, CEILING / 2), (18, 0.2, CEILING))
    to_object("Walls", bm, mats["wall"])

    # Ceiling: a ring between the dome's ellipse and a large rectangle, built
    # from rays out of the ellipse's centre.
    bm = bmesh.new()
    segments = 128
    inner, outer = [], []
    for k in range(segments):
        a = 2 * math.pi * k / segments
        dx, dy = d["rx"] * math.cos(a), d["ry"] * math.sin(a)
        inner.append(bm.verts.new((d["cx"] + dx, d["cy"] + dy, CEILING)))
        limits = []
        if dx > 1e-9:
            limits.append((VAULT_TOP - d["cx"]) / dx)
        if dx < -1e-9:
            limits.append((LEFT_WALL - d["cx"]) / dx)
        if dy > 1e-9:
            limits.append((BACK_WALL - d["cy"]) / dy)
        if dy < -1e-9:
            limits.append((-12 - d["cy"]) / dy)
        t = min(limits)
        outer.append(bm.verts.new((d["cx"] + dx * t, d["cy"] + dy * t, CEILING)))
    for k in range(segments):
        j = (k + 1) % segments
        bm.faces.new((inner[k], inner[j], outer[j], outer[k]))
    to_object("Ceiling", bm, mats["ceiling"])

    # Organic bands around the opening and one sweeping across it.
    bm = bmesh.new()
    for scale, drop, radius in ((1.0, 0.0, 0.32), (1.32, 0.12, 0.42)):
        loop = [
            (
                d["cx"] + scale * d["rx"] * math.cos(2 * math.pi * k / 96),
                d["cy"] + scale * d["ry"] * math.sin(2 * math.pi * k / 96),
                CEILING - drop,
            )
            for k in range(97)
        ]
        tube(bm, loop, [radius] * len(loop), sides=10)
    sweep = []
    for k in range(41):
        t = k / 40
        x = d["cx"] - d["rx"] * 1.05 + 2.1 * d["rx"] * t
        y = d["cy"] - d["ry"] * 0.55 + d["ry"] * 0.9 * t
        sweep.append((x, y, dome_height(x, y) + 0.25))
    tube(bm, sweep, [0.3] * len(sweep), sides=10)
    to_object("Bands", bm, mats["ceiling"], smooth=True)

    # Ribs: a spine along the dome, ribs across it and two diagonals.
    bm = bmesh.new()
    spine = [
        (d["cx"], y, dome_height(d["cx"], y))
        for y in np.linspace(d["cy"] - d["ry"], d["cy"] + d["ry"], 40)
    ]
    tube(bm, spine, [0.09] * len(spine))
    for f in (-0.75, -0.5, -0.25, 0.0, 0.25, 0.5, 0.75):
        y = d["cy"] + f * d["ry"]
        half = d["rx"] * math.sqrt(1 - f * f)
        rib = [
            (x, y, dome_height(x, y))
            for x in np.linspace(d["cx"] - half, d["cx"] + half, 30)
        ]
        tube(bm, rib, [0.08] * len(rib))
    for angle in (0.6, -0.6):
        ends = np.linspace(-1, 1, 36)
        rib = []
        for s in ends:
            x = d["cx"] + s * d["rx"] * math.cos(angle)
            y = d["cy"] + s * d["ry"] * math.sin(angle)
            rib.append((x, y, dome_height(x, y)))
        tube(bm, rib, [0.07] * len(rib))
    to_object("Ribs", bm, mats["steel"], smooth=True)


def build_vault(mats):
    """The glazed vault down the right side: arched ribs and mullions."""
    bm = bmesh.new()
    span = VAULT_FOOT - VAULT_TOP

    def arch_point(y, t):
        return (VAULT_TOP + span * math.cos(t), y, CEILING * math.sin(t))

    ys = np.arange(-3.0, BACK_WALL, 2.6)
    for y in ys:
        tube(
            bm, [arch_point(y, t) for t in np.linspace(0, math.pi / 2, 24)], [0.09] * 24
        )
    for t in (0.18, 0.45, 0.75, 1.1):
        line = [arch_point(y, t) for y in (ys[0], ys[-1])]
        tube(bm, line, [0.045, 0.045])
    box(bm, (VAULT_FOOT, 15, 0.2), (0.5, 40, 0.4))
    to_object("Vault", bm, mats["steel"], smooth=True)

    # Outside: a stone wall and trees, seen through the glazing.
    bm = bmesh.new()
    box(bm, (14, 15, 1.8), (1.2, 50, 3.6))
    to_object("Stone", bm, mats["wall"])
    # Crowns of trees outside: beyond the vault, and further off, above the
    # dome.
    bm = bmesh.new()
    for _ in range(16):
        crown = (rng.uniform(16, 28), rng.uniform(2, 40), rng.uniform(5, 10))
        cluster(bm, crown, rng.uniform(2.2, 3.4), 30, 0.55)
    for _ in range(9):
        crown = (rng.uniform(-16, 6), rng.uniform(22, 40), rng.uniform(13, 17))
        cluster(bm, crown, rng.uniform(2.5, 3.5), 30, 0.6)
    to_object("Outside", bm, mats["leaf_far"], smooth=True)


def grow(wood, leaves, start, direction, length, radius, depth, leaf_size):
    """Grows a branching tree recursively, with foliage at the tips."""
    start = Vector(start)
    direction = Vector(direction).normalized()
    end = start + direction * length
    bend = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), 0)) * length * 0.08
    points = [
        start.lerp(end, t) + bend * math.sin(math.pi * t) for t in (0, 0.35, 0.7, 1)
    ]
    tube(wood, points, [radius, radius * 0.9, radius * 0.8, radius * 0.7], sides=7)
    if depth == 0:
        cluster(leaves, end, leaf_size, rng.randint(12, 16), leaf_size * 0.24)
        return
    for _ in range(rng.randint(2, 3)):
        spread = Vector((rng.uniform(-1, 1), rng.uniform(-1, 1), rng.uniform(0.2, 0.9)))
        grow(
            wood,
            leaves,
            end,
            (direction + spread * 0.9).normalized(),
            length * rng.uniform(0.62, 0.78),
            radius * 0.62,
            depth - 1,
            leaf_size,
        )


def build_plants(mats):
    """The central tree, smaller trees, shrubs, potted plants and greenery
    hanging from the ceiling."""
    wood, leaves = bmesh.new(), bmesh.new()
    grow(wood, leaves, (-0.8, 14.5, 0), (0.08, -0.05, 1), 3.4, 0.36, 3, 1.15)
    grow(wood, leaves, (0.7, 10.9, 0), (0.1, 0, 1), 1.7, 0.09, 2, 0.45)
    grow(wood, leaves, (-5.5, 19.0, 0), (0, 0, 1), 2.2, 0.15, 2, 0.8)
    grow(wood, leaves, (-7.6, 5.2, 0.45), (0, 0, 1), 0.9, 0.05, 2, 0.35)

    # Bonsai-like shrubs in the planter at front right, and shrubs at left.
    for x in (3.9, 4.8, 5.8):
        grow(
            wood,
            leaves,
            (x, 3.0, 0.55),
            (rng.uniform(-0.3, 0.3), 0, 1),
            0.5,
            0.04,
            2,
            0.3,
        )
    for x, y in ((-4.9, 4.4), (-6.6, 8.0), (-3.8, 21.0), (5.6, 16.0)):
        grow(wood, leaves, (x, y, 0.5), (0, 0, 1), 0.6, 0.05, 2, 0.4)
    to_object("Wood", wood, mats["wood"], smooth=True)
    to_object("Leaves", leaves, mats["leaf"], smooth=True)

    # Greenery spilling over the dome's rim and the ceiling at top left,
    # with vines hanging down.
    hang, vines = bmesh.new(), bmesh.new()
    d = DOME
    for k in range(46):
        a = rng.uniform(0.35 * math.pi, 1.45 * math.pi)
        scale = rng.uniform(1.02, 1.4)
        x = d["cx"] + scale * d["rx"] * math.cos(a)
        y = d["cy"] + scale * d["ry"] * math.sin(a)
        if y < 2:
            continue
        cluster(hang, (x, y, CEILING - 0.2), 0.7, 10, 0.16)
        if k % 2 == 0:
            top = Vector((x, y, CEILING - 0.3))
            drop = rng.uniform(0.8, 2.6)
            sway = Vector((rng.uniform(-0.2, 0.2), rng.uniform(-0.2, 0.2), -drop))
            path = [top + sway * t for t in np.linspace(0, 1, 6)]
            tube(vines, path, [0.015] * len(path), sides=4)
            for point in path[1:]:
                blob(hang, point, rng.uniform(0.06, 0.11), subdivisions=1)
    for _ in range(12):
        x = rng.uniform(LEFT_WALL + 0.5, -4.0)
        y = rng.uniform(3.0, 8)
        cluster(hang, (x, y, CEILING - 0.25), 0.9, 12, 0.18)
    to_object("Hanging", hang, mats["leaf"], smooth=True)
    to_object("Vines", vines, mats["wood"])

    pots = bmesh.new()
    for x, y in ((-4.9, 4.4), (-6.6, 8.0), (-3.8, 21.0), (5.6, 16.0), (-7.6, 5.2)):
        cylinder(pots, (x, y, 0), 0.3, 0.5, top_radius=0.36)
    box(pots, (5.0, 3.0, 0.27), (3.0, 0.9, 0.55))
    to_object("Pots", pots, mats["pot"])


def build_furniture(mats):
    """Benches, monitors, glassware, stools and the shelving wall."""
    body, tops, dark = bmesh.new(), bmesh.new(), bmesh.new()

    # Front bench: a large island with rounded ends, and a recess of bins.
    rounded_prism(body, (2.8, 6.5), 5.4, 2.0, 0.9, 0.0, 0.88)
    rounded_prism(tops, (2.8, 6.5), 6.0, 2.5, 1.15, 0.88, 0.95)
    for k, x in enumerate((1.2, 1.9, 2.6)):
        box(body, (x, 5.45, 0.32), (0.6, 0.1, 0.55 + 0.05 * k))
    # Rear bench.
    rounded_prism(body, (-2.3, 10.4), 4.6, 1.3, 0.35, 0.0, 0.86)
    rounded_prism(tops, (-2.3, 10.4), 5.0, 1.6, 0.45, 0.86, 0.93)
    # A far bench beyond the tree.
    rounded_prism(body, (-4.0, 17.5), 4.0, 1.4, 0.4, 0.0, 0.86)
    rounded_prism(tops, (-4.0, 17.5), 4.4, 1.7, 0.5, 0.86, 0.93)

    # Monitors, with their stands.
    screens = bmesh.new()
    for x, y in ((4.3, 7.2), (-1.7, 10.7)):
        box(dark, (x, y + 0.03, 1.32), (0.72, 0.04, 0.46))
        box(dark, (x, y + 0.1, 1.07), (0.06, 0.06, 0.25))
        box(dark, (x, y + 0.1, 0.96), (0.3, 0.2, 0.02))
        box(screens, (x, y, 1.32), (0.66, 0.01, 0.4))

    # Glassware and instruments on the benches.
    glass = bmesh.new()
    for _ in range(18):
        x, y = rng.uniform(0.6, 4.8), rng.uniform(5.9, 7.1)
        h = rng.uniform(0.12, 0.32)
        cylinder(glass, (x, y, 0.95), rng.uniform(0.03, 0.07), h, segments=10)
        cylinder(glass, (x, y, 0.95 + h), 0.02, 0.06, segments=8)
    for _ in range(10):
        x, y = rng.uniform(-4.2, -0.5), rng.uniform(10.0, 10.9)
        cylinder(
            glass,
            (x, y, 0.93),
            rng.uniform(0.03, 0.06),
            rng.uniform(0.1, 0.25),
            segments=10,
        )
    cylinder(dark, (2.0, 6.4, 0.95), 0.015, 1.1, segments=8)
    box(dark, (2.2, 6.4, 1.6), (0.4, 0.03, 0.03))
    box(body, (3.2, 6.0, 1.02), (0.5, 0.35, 0.14))

    # Stools.
    for x, y in ((4.9, 8.2), (5.7, 7.6), (-4.4, 3.0), (-5.1, 3.9)):
        disc(dark, (x, y, 0.02), 0.24)
        cylinder(dark, (x, y, 0.0), 0.025, 0.72, segments=8)
        cylinder(dark, (x, y, 0.72), 0.2, 0.08, segments=20)

    # Shelving wall at left: uprights, boards, then books and jars.
    shelf, books = bmesh.new(), [bmesh.new() for _ in range(3)]
    x0, x1, y, depth, height = -8.9, -5.7, 9.2, 0.45, 3.2
    for x in (x0, (x0 + x1) / 2, x1):
        box(shelf, (x, y, height / 2), (0.05, depth, height))
    levels = np.linspace(0.1, height, 7)
    for z in levels:
        box(shelf, ((x0 + x1) / 2, y, z), (x1 - x0, depth, 0.03))
    for z0, z1 in itertools.pairwise(levels):
        x = x0 + 0.05
        while x < x1 - 0.1:
            w = rng.uniform(0.04, 0.11)
            h = rng.uniform(0.55, 0.85) * (z1 - z0)
            target = books[rng.randrange(3)]
            if rng.random() < 0.2:
                cylinder(target, (x + w, y, z0 + 0.015), w, h * 0.7, segments=10)
                x += 2 * w + 0.03
            else:
                box(target, (x + w / 2, y, z0 + 0.015 + h / 2), (w, depth * 0.8, h))
                x += w + rng.uniform(0.0, 0.02)
            if rng.random() < 0.08:
                x += rng.uniform(0.1, 0.3)
    to_object("Shelf", shelf, mats["timber"])
    for k, target in enumerate(books):
        to_object(f"Books{k}", target, mats[f"book{k}"])

    to_object("BenchBodies", body, mats["bench"])
    to_object("BenchTops", tops, mats["timber"])
    to_object("Dark", dark, mats["steel"])
    to_object("Glass", glass, mats["glassware"])
    to_object("Screens", screens, mats["screen"])


def build_lights(mats):
    """Round ceiling lights and the sun and sky that light the room."""
    bm = bmesh.new()
    for x, y, r in (
        (-4.8, 4.2, 0.75),
        (3.0, 5.2, 0.6),
        (-6.5, 16.0, 0.5),
        (2.4, 20.0, 0.4),
    ):
        disc(bm, (x, y, CEILING - 0.03), r)
    to_object("Lamps", bm, mats["lamp"])

    world = bpy.data.worlds.new("Sky")
    if hasattr(world, "use_nodes") and not world.use_nodes:
        world.use_nodes = True
    background = world.node_tree.nodes["Background"]
    background.inputs["Color"].default_value = (1, 1, 1, 1)
    background.inputs["Strength"].default_value = SKY
    world.mist_settings.start = 0
    world.mist_settings.depth = FAR * 2
    world.mist_settings.falloff = "LINEAR"
    bpy.context.scene.world = world

    sun = bpy.data.lights.new("Sun", "SUN")
    sun.energy = SUN
    sun.angle = math.radians(4)
    obj = bpy.data.objects.new("Sun", sun)
    obj.rotation_euler = (math.radians(35), math.radians(-25), math.radians(15))
    bpy.context.scene.collection.objects.link(obj)


def build_camera():
    """The camera, its depth of field, and the focus distance along its axis.

    Returns:
        The camera object and the focus depth in metres.
    """
    data = bpy.data.cameras.new("Camera")
    data.sensor_fit = "HORIZONTAL"
    data.sensor_width = 36.0 * (1 + 2 * OVERSCAN)
    data.lens = LENS
    camera = bpy.data.objects.new("Camera", data)
    camera.location = CAMERA["location"]
    camera.rotation_euler = (math.radians(90 + CAMERA["pitch"]), 0, 0)
    bpy.context.scene.collection.objects.link(camera)
    bpy.context.scene.camera = camera
    bpy.context.view_layer.update()

    axis = camera.matrix_world.to_3x3() @ Vector((0, 0, -1))
    focus = (Vector(FOCUS_POINT) - camera.matrix_world.translation).dot(axis)
    data.dof.use_dof = True
    data.dof.focus_distance = focus
    data.dof.aperture_fstop = 0.12
    return camera, focus


def build_scene():
    """Builds the whole scene from an empty file.

    Returns:
        The camera object and the focus depth in metres.
    """
    bpy.ops.wm.read_factory_settings(use_empty=True)
    mats = {
        "floor": material("Floor", 0.62, roughness=0.3),
        "wall": material("Wall", 0.7),
        "ceiling": material("Ceiling", 0.22),
        "steel": material("Steel", 0.14, roughness=0.5),
        "bench": material("Bench", 0.78),
        "timber": material("Timber", 0.5, roughness=0.6),
        "glassware": material("Glassware", 0.85, roughness=0.2),
        "screen": material("Screen", 0.9, emission=1.5),
        "lamp": material("Lamp", 1.0, emission=4.0),
        "wood": material("Wood", 0.22),
        "leaf": material("Leaf", 0.3),
        "leaf_far": material("LeafFar", 0.35),
        "pot": material("Pot", 0.55),
        "book0": material("Book0", 0.25),
        "book1": material("Book1", 0.5),
        "book2": material("Book2", 0.75),
    }
    build_shell(mats)
    build_vault(mats)
    build_plants(mats)
    build_furniture(mats)
    build_lights(mats)
    return build_camera()


# ---------------------------------------------------------------------------
# Rendering
# ---------------------------------------------------------------------------


def render_size():
    """Pixel size of every render: the frame plus OVERSCAN on each side."""
    margin = round(WIDTH * OVERSCAN)
    return WIDTH + 2 * margin, round(WIDTH / ASPECT) + 2 * margin


def configure_render(samples):
    """Sets up Cycles on the GPU with a mist pass and transparent film."""
    scene = bpy.context.scene
    scene.render.engine = "CYCLES"
    prefs = bpy.context.preferences.addons["cycles"].preferences
    prefs.compute_device_type = "METAL"
    prefs.get_devices()
    for device in prefs.devices:
        device.use = device.type == "METAL"
    scene.cycles.device = "GPU"
    scene.cycles.samples = samples
    scene.cycles.use_denoising = True
    scene.render.film_transparent = True
    scene.render.resolution_x, scene.render.resolution_y = render_size()
    scene.render.resolution_percentage = 100
    scene.render.image_settings.media_type = "MULTI_LAYER_IMAGE"
    scene.render.image_settings.color_depth = "32"
    bpy.context.view_layer.use_pass_mist = True


def render_pass(camera, name, clip_start, clip_end):
    """Renders the scene between two depths to scene/out/<name>.exr."""
    camera.data.clip_start = clip_start
    camera.data.clip_end = clip_end
    bpy.context.scene.render.filepath = str(WORK / f"{name}.exr")
    bpy.ops.render.render(write_still=True)


def slices():
    """Depth range rendered for each layer, nearest first.

    Layer k spans from the previous layer's depth to the next one's, so that
    the surfaces between two layers appear in both and can be blended.
    """
    bounds = [0.05, *LAYER_DEPTHS[:-1], FAR * 10, FAR * 10]
    return [(bounds[k], bounds[k + 2]) for k in range(len(LAYER_DEPTHS))]


def render_all(camera, samples):
    """Renders the whole scene and each depth slice."""
    WORK.mkdir(parents=True, exist_ok=True)
    configure_render(samples)
    render_pass(camera, "full", 0.05, FAR * 10)
    for k, (start, end) in enumerate(slices()):
        render_pass(camera, f"slice-{k}", start, end)
    camera.data.clip_start, camera.data.clip_end = 0.05, FAR * 10


# ---------------------------------------------------------------------------
# Post-processing
# ---------------------------------------------------------------------------


def hex_rgb(colour):
    """Parses #rrggbb into an array of 0-255 floats."""
    return np.array([int(colour[i : i + 2], 16) for i in (1, 3, 5)], dtype=float)


def relative_luminance(rgb):
    """WCAG 2 relative luminance of 0-255 sRGB values (last axis RGB)."""
    s = np.asarray(rgb, dtype=float) / 255
    linear = np.where(s <= 0.04045, s / 12.92, ((s + 0.055) / 1.055) ** 2.4)
    return linear @ np.array([0.2126, 0.7152, 0.0722])


def extreme(scheme):
    """The colour furthest from the paper that keeps muted text at CONTRAST.

    Walks from the paper towards TOWARDS[scheme] and returns the last colour
    at which the contrast with the muted text colour is still CONTRAST.
    """
    paper, towards = hex_rgb(PAPER[scheme]), hex_rgb(TOWARDS[scheme])
    muted = relative_luminance(hex_rgb(MUTED[scheme]))

    def contrast(t):
        lum = relative_luminance(paper + (towards - paper) * t)
        high, low = max(lum, muted), min(lum, muted)
        return (high + 0.05) / (low + 0.05)

    low, high = 0.0, 1.0
    for _ in range(40):
        mid = (low + high) / 2
        low, high = (mid, high) if contrast(mid) >= CONTRAST else (low, mid)
    return paper + (towards - paper) * low


def read_exr(name):
    """Reads a render's colour, alpha and axial depth.

    Returns:
        Unpremultiplied linear grey (H, W), alpha (H, W), Euclidean distance
        (H, W) and depth along the camera axis (H, W), all float arrays.
    """
    # Blender writes each pass as a separate part of the EXR, which OIIO
    # presents as subimages. Channels are keyed as "<pass>.<channel>".
    path = str(WORK / f"{name}.exr")
    channels = {}
    for subimage in range(oiio.ImageBuf(path).nsubimages):
        buf = oiio.ImageBuf(path, subimage, 0)
        pixels = buf.get_pixels(oiio.FLOAT)
        for i, full_name in enumerate(buf.spec().channelnames):
            channels[full_name.split(".", 1)[1]] = pixels[..., i]

    alpha = channels["Combined.A"]
    grey = (
        0.2126 * channels["Combined.R"]
        + 0.7152 * channels["Combined.G"]
        + 0.0722 * channels["Combined.B"]
    )
    grey = np.where(alpha > 1e-4, grey / np.maximum(alpha, 1e-4), 0)
    # Samples that miss everything count as mist 1, so at the blurred edge of
    # an object the pixel's mist mixes the object with the empty background.
    # Removing the background's share leaves the object's own distance, as
    # unpremultiplying does for its colour.
    mist = channels["Mist.Z"]
    mist = np.where(alpha > 1e-3, (mist - (1 - alpha)) / np.maximum(alpha, 1e-3), 1)
    distance = np.clip(mist, 0, 1) * FAR * 2

    # Mist measures straight-line distance; parallax and the slices use depth
    # along the camera axis, which is shorter towards the edges of the frame.
    height, width = alpha.shape
    u = (np.arange(width) + 0.5 - width / 2) / WIDTH
    v = (np.arange(height) + 0.5 - height / 2) / WIDTH
    uu, vv = np.meshgrid(u, v)
    depth = distance / np.sqrt(1 + (uu / FOCAL) ** 2 + (vv / FOCAL) ** 2)
    return grey, alpha, distance, depth


def ink(grey, distance, scheme):
    """How far each pixel moves from the paper towards the scheme's extreme.

    Shade comes from the render's brightness, through the sRGB curve so that
    it is perceptually even. Fog then fades the scene into the paper with
    distance.
    """
    linear = np.clip(grey * EXPOSURE, 0, 1)
    shade = np.where(
        linear <= 0.0031308, 12.92 * linear, 1.055 * linear ** (1 / 2.4) - 0.055
    )
    t = np.clip((distance - FOG_START) / (FOG_END - FOG_START), 0, 1)
    presence = 1 - t * t * (3 - 2 * t)
    w = WEIGHTS[scheme]
    return presence * (w["shadow"] + (w["lit"] - w["shadow"]) * shade)


def colourise(grey, distance, scheme):
    """Maps shade and distance onto the scheme's palette as 0-255 RGB."""
    paper = hex_rgb(PAPER[scheme])
    amount = ink(grey, distance, scheme)[..., None]
    return paper + (extreme(scheme) - paper) * amount


def write_webp(path, pixels, lossless=False):
    """Encodes 0-255 pixels (H, W, C) as WebP via a PNG and cwebp.

    Returns:
        The pixels as decoded from the written file, as uint8, so callers can
        check what the browser will actually show.
    """
    data = np.clip(np.rint(pixels), 0, 255).astype(np.uint8)
    png = WORK / (path.stem + ".png")
    spec = oiio.ImageSpec(data.shape[1], data.shape[0], data.shape[2], oiio.UINT8)
    spec.attribute("oiio:UnassociatedAlpha", 1)
    out = oiio.ImageOutput.create(str(png))
    out.open(str(png), spec)
    out.write_image(data)
    out.close()
    quality = (
        ["-lossless", "-exact"]
        if lossless
        # -exact keeps the colour bled into transparent pixels (see bleed),
        # which cwebp would otherwise flatten.
        else ["-q", "88", "-alpha_q", "100", "-m", "6", "-sharp_yuv", "-exact"]
    )
    path.parent.mkdir(parents=True, exist_ok=True)
    subprocess.run(["cwebp", "-quiet", *quality, str(png), "-o", str(path)], check=True)
    decoded = WORK / (path.stem + ".decoded.png")
    subprocess.run(["dwebp", "-quiet", str(path), "-o", str(decoded)], check=True)
    config = oiio.ImageSpec()
    config.attribute("oiio:UnassociatedAlpha", 1)
    return oiio.ImageBuf(str(decoded), 0, 0, config).get_pixels(oiio.UINT8)


def check_legible(pixels, scheme, name):
    """Stops the build if muted text would fall below WCAG AA contrast (4.5)
    against any visible pixel of an encoded image.

    Lossy compression can move pixels slightly off the palette, which is why
    CONTRAST sits above 4.5; this check proves the margin was enough.
    """
    rgb = pixels[..., :3].reshape(-1, 3)
    if pixels.shape[2] == 4:
        rgb = rgb[pixels[..., 3].reshape(-1) > 0]
    muted = relative_luminance(hex_rgb(MUTED[scheme]))
    lum = relative_luminance(rgb)
    ratio = (np.maximum(lum, muted) + 0.05) / (np.minimum(lum, muted) + 0.05)
    if ratio.min() < 4.5:
        sys.exit(f"{name}: muted text contrast falls to {ratio.min():.3f}")
    print(f"{name}: lowest muted text contrast {ratio.min():.3f}")


def bleed(rgb, visible, paper, steps=16):
    """Spreads the colour of visible pixels into the transparent pixels around
    them, and fills the rest with paper.

    Transparent pixels are never shown, but lossy compression rings where
    their colour jumps, and the ringing reaches visible pixels at the edge.
    Carrying the edge colour outwards moves the jump out of reach.
    """
    rgb = np.where(visible[..., None], rgb, 0.0)
    filled = visible.copy()
    for _ in range(steps):
        total = np.zeros_like(rgb)
        count = np.zeros(filled.shape)
        for shift in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            neighbour = np.roll(filled, shift, axis=(0, 1))
            total += np.roll(rgb, shift, axis=(0, 1)) * neighbour[..., None]
            count += neighbour
        grow = ~filled & (count > 0)
        rgb[grow] = total[grow] / count[grow][:, None]
        filled |= grow
    rgb[~filled] = paper
    return rgb


def disparity_ramp(depth, near, far):
    """Weight falling from 1 at depth near to 0 at depth far, linear in 1/z."""
    inverse = 1 / np.maximum(depth, 1e-3)
    return np.clip((inverse - 1 / far) / (1 / near - 1 / far), 0, 1)


def post_process(focus):
    """Turns the EXR passes into the background assets and the manifest."""
    grey, alpha, distance, depth = read_exr("full")
    for scheme, paper_hex in PAPER.items():
        paper = hex_rgb(paper_hex)
        colour = paper + (colourise(grey, distance, scheme) - paper) * alpha[..., None]
        path = ASSETS / scheme / "colour.webp"
        check_legible(write_webp(path, colour), scheme, f"{scheme}/colour.webp")

    disparity = disparity_ramp(np.where(alpha > 0.5, depth, FAR), NEAR, FAR)
    write_webp(
        ASSETS / "depth.webp",
        (disparity * 255)[..., None].repeat(3, axis=2),
        lossless=True,
    )

    count = len(LAYER_DEPTHS)
    for k in range(count):
        grey, alpha, distance, depth = read_exr(f"slice-{k}")
        if k == count - 1:
            # The farthest layer is opaque: everything beyond it is paper.
            weight = np.ones_like(alpha)
        else:
            weight = np.where(
                depth <= LAYER_DEPTHS[k],
                1.0,
                disparity_ramp(depth, LAYER_DEPTHS[k], LAYER_DEPTHS[k + 1]),
            )
        for scheme, paper_hex in PAPER.items():
            paper = hex_rgb(paper_hex)
            colour = colourise(grey, distance, scheme)
            if k == count - 1:
                rgb = paper + (colour - paper) * alpha[..., None]
                layer = np.dstack([rgb, np.full(alpha.shape, 255.0)])
            else:
                a = alpha * weight
                rgb = bleed(colour, np.rint(a * 255) > 0, paper)
                layer = np.dstack([rgb, a * 255])
            # Files are numbered farthest first.
            name = f"{scheme}/layer-{count - 1 - k}.webp"
            check_legible(write_webp(ASSETS / name, layer), scheme, name)

    nearest = min(LAYER_DEPTHS[0], NEAR)
    baseline = SHIFT / (FOCAL * max(1 / nearest - 1 / focus, 1 / focus - 1 / FAR))
    manifest = {
        "aspect": ASPECT,
        "overscan": OVERSCAN,
        "focal": FOCAL,
        "focus": round(focus, 3),
        "baseline": round(baseline, 4),
        "near": NEAR,
        "far": FAR,
        "layers": [{"depth": d} for d in reversed(LAYER_DEPTHS)],
        "fog": {"start": FOG_START, "end": FOG_END},
        "exposure": EXPOSURE,
        "lighting": {"sky": SKY, "sun": SUN},
        "palette": {
            scheme: {
                "paper": PAPER[scheme],
                "extreme": "#{:02x}{:02x}{:02x}".format(
                    *np.rint(extreme(scheme)).astype(int)
                ),
                **WEIGHTS[scheme],
            }
            for scheme in PAPER
        },
    }
    (ASSETS / "scene.json").write_text(json.dumps(manifest, indent=2) + "\n")


def export_gltf():
    """Exports the model, camera and sun to scene.glb for the glTF variant."""
    ASSETS.mkdir(parents=True, exist_ok=True)
    bpy.ops.export_scene.gltf(
        filepath=str(ASSETS / "scene.glb"),
        export_format="GLB",
        export_cameras=True,
        export_lights=True,
        export_apply=True,
        export_texcoords=False,
        export_yup=True,
        # Keep Blender's light strengths as they are, so the glTF variant
        # can read the sun's direction and relative strength directly.
        export_import_convert_lighting_mode="RAW",
    )


def main():
    """Parses arguments after `--`, then builds, renders and exports."""
    argv = sys.argv[sys.argv.index("--") + 1 :] if "--" in sys.argv else []
    parser = argparse.ArgumentParser(prog="build.py")
    parser.add_argument("--samples", type=int, default=256)
    parser.add_argument("--post-only", action="store_true")
    args = parser.parse_args(argv)
    if shutil.which("cwebp") is None:
        sys.exit("cwebp not found: install libwebp")

    camera, focus = build_scene()
    if not args.post_only:
        render_all(camera, args.samples)
        export_gltf()
    post_process(focus)


if __name__ == "__main__":
    main()
