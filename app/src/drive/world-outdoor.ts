import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { mergeVertices } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { Track, TrackFrame, VehicleState } from './types';

// The outdoor world of the drive page: a sunny meadow round any course (roads and orange plastic set pieces), made
// entirely in code (no asset files) and drawn in at most 15 calls (the scenery's CHUNKS area chunks, the pond and the
// banner are frustum-culled: what the camera looks away from is not drawn):
//   ground   one square (the pond cut out): tiling grass detail x non-repeating noise patches x a painted map
//            (~1.4 u/px) of baked sun shadows (the track's own meshes, trees, rocks), ambient occlusion, worn grass and
//            dirt round the course's footprint (the roads' verges and banks are the track's), the start yard, run-off
//            outside tight bends and the pond's trodden shore
//   scenery  flat-shaded, vertex-coloured meshes in CHUNKS area chunks (k-means on the items, weighted by their
//            triangles): groves of round / pine / poplar / blossom trees, rocks, bushes, flowers and grass tufts, the
//            pond's banks, reeds, lily pads and stones, the big jump's pennants and the banner's scaffold towers. Trees
//            get cheaper with distance from the course and the grass gathers along it, where the camera goes (~41k
//            triangles on any course). Canopies, grass, reeds and pennants sway in the vertex shader
//   pond     by the big jump (track tag 'bigjump', the 'gap' it flies): a long, bent pond, as big as fits under the
//            flight (or beside it, where a road takes the ground below) clear of everything on the ground; its water
//            2.4 u down, in rings shaded by depth, with sky fresnel, drifting ripples and sun glints
//   banner   RIPCARS on a board on scaffold towers off to the side of the landing, facing the flight (a canvas
//            texture, unlit, printed both sides)
//   hills    two low-poly rings (green hills, snow-capped mountains) that follow the car like a skybox
//            layer, hazed by distance and less with height (the haze sits in the valleys)
//   sky      inverted sphere: vertical gradient + sun glow, drawn last among the opaques on the far plane
//            so it only fills what nothing else covered
//   clouds   one mesh of billboard quads on the sky (a code-painted atlas), drifting slowly
//   shadow   the car's blob shadow on the track surface (or the ground, or the pond), faded with height
// Sky, clouds and fog are display colours that skip tone mapping, so the horizon is exactly the colour the
// fog fades the world into; the lit world goes through the caller's AgX. Lights: a warm sun, a sky/grass
// hemisphere and a dim RoomEnvironment PMREM so the paint has something to reflect. No shadow maps.
// Everything is keyed to track.frames and the track's meshes, so it fits any course, and the layout is seeded
// (identical every load). The course's ground footprint is the track's userData.footprint where it gives one (surface,
// verge, barrier strip and bank, per frame), else width / 2 + shoulder (or the rails, or a barrier). Nothing stands on
// it (props keep KEEP u beyond it, trees further), and trees keep off the sight lines across every bend: the chase
// camera always sees the road ahead.

export interface World {
  update(state: VehicleState, dt: number): void;
}

const DEG = Math.PI / 180;

const LOOK = {
  zenith: '#2a6fcb',
  sky: '#5ba6ec',
  horizon: '#d4e5ea', // = the fog colour
  warm: '#f1e9d6', // a thin warm haze just above the horizon
  glow: '#fff0cc', // round the sun
  sun: '#fff0da',
  sunIntensity: 2.4,
  sunElevation: 50, // deg
  sunFrom: [-90, 130] as const, // plan direction toward the sun (x, z): high front-left in world terms
  hemiSky: '#b8dcff',
  hemiGround: '#6f9446',
  hemiIntensity: 0.7,
  envIntensity: 0.35,
  fogNear: 150,
  fogFar: 900,
};
const KEEP = 4; // u: props keep this far beyond the course's footprint
const RAIL = 0.3; // u the plastic's rails reach beyond its driving surface (footprint fallback)
const BARRIER = 1.6; // u a barrier (tyre wall, hay bales) may reach beyond the surface edge (footprint fallback)
const LIFT = 0.3; // u: track parts lower than this over the meadow lie on it and cast nothing
const SEED = 0x51ced;
const GRASS_TILE = 5.5; // u per repeat of the grass detail texture
const SHADOW_SIZE = [5, 2.6]; // u, car blob shadow quad (length, width): its dark core covers the ~4.2 x 1.9 car footprint
const NEAR = 60, MID = 160; // u beyond the course's footprint: tree detail tiers (full, cheaper, cheapest)
/** Scenery budget: trees per detail tier, the rest by count. */
const CAP = { trees: [170, 200, 240], bushes: 90, rocks: 80, flowers: 520, tufts: 1300 };
const CHUNKS = 8; // the scenery's area chunks (draw calls at most; the ones out of view are culled)

// ---- small helpers --------------------------------------------------------------------------------
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

function rngOf(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hash3(x: number, y: number, s: number) {
  let h = Math.imul(x | 0, 0x27d4eb2d) ^ Math.imul(y | 0, 0x165667b1) ^ Math.imul(s | 0, 0x9e3779b1);
  h = Math.imul(h ^ (h >>> 15), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

/** Value noise in 0..1; with a period p > 0 the lattice wraps (tileable textures). */
function vnoise(x: number, y: number, s: number, p = 0) {
  const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
  const ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
  const wx0 = p ? ((ix % p) + p) % p : ix, wy0 = p ? ((iy % p) + p) % p : iy;
  const wx1 = p ? (wx0 + 1) % p : ix + 1, wy1 = p ? (wy0 + 1) % p : iy + 1;
  const a = hash3(wx0, wy0, s), b = hash3(wx1, wy0, s), c = hash3(wx0, wy1, s), d = hash3(wx1, wy1, s);
  return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
}

function fbm(x: number, y: number, s: number, octaves: number, p = 0) {
  let v = 0, amp = 0.5, n = 0, f = 1;
  for (let i = 0; i < octaves; i++) {
    v += amp * vnoise(x * f, y * f, s + i * 31, p * f);
    n += amp;
    amp *= 0.5;
    f *= 2;
  }
  return v / n;
}

function canvas(w: number, h = w) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

const col = (hex: string) => new THREE.Color(hex);
/** A display colour for the unlit sky shader (sRGB components, not the linear working space). */
const display = (hex: string) => new THREE.Color(hex).convertLinearToSRGB();

/** Indices of the convex hull of n points (flat x, z pairs), counter-clockwise (positive area in x, z). */
function hull(p: number[], n: number) {
  const ix = Array.from({ length: n }, (_, i) => i).sort((a, b) => p[2 * a] - p[2 * b] || p[2 * a + 1] - p[2 * b + 1]);
  const cross = (o: number, a: number, b: number) =>
    (p[2 * a] - p[2 * o]) * (p[2 * b + 1] - p[2 * o + 1]) - (p[2 * a + 1] - p[2 * o + 1]) * (p[2 * b] - p[2 * o]);
  const lo: number[] = [], hi: number[] = [];
  for (const i of ix) {
    while (lo.length > 1 && cross(lo[lo.length - 2], lo[lo.length - 1], i) <= 0) lo.pop();
    lo.push(i);
  }
  for (let j = ix.length - 1; j >= 0; j--) {
    while (hi.length > 1 && cross(hi[hi.length - 2], hi[hi.length - 1], ix[j]) <= 0) hi.pop();
    hi.push(ix[j]);
  }
  lo.pop();
  hi.pop();
  return lo.concat(hi);
}

/** Raises mask pixels (n x n) whose centres the triangle covers to at least `val`; coordinates are map-local world
 *  units, scaled by k px/u. `grow` px widens it (conservative cover: a post thinner than a pixel still casts a line).
 *  Returns whether it drew (not edge-on). */
function fillTri(mask: Uint8Array, n: number, k: number, ax: number, az: number, bx: number, bz: number, qx: number, qz: number, val = 1, grow = 0) {
  ax *= k, az *= k, bx *= k, bz *= k, qx *= k, qz *= k;
  const area = (bx - ax) * (qz - az) - (bz - az) * (qx - ax);
  if (area > -1e-6 && area < 1e-6) return false;
  if (area < 0) [bx, bz, qx, qz] = [qx, qz, bx, bz];
  // each edge function is |edge| x the signed distance to it: allow -grow px of distance
  const gab = -grow * Math.hypot(bx - ax, bz - az), gbq = -grow * Math.hypot(qx - bx, qz - bz), gqa = -grow * Math.hypot(ax - qx, az - qz);
  const x0 = Math.max(0, Math.ceil(Math.min(ax, bx, qx) - grow - 0.5)), x1 = Math.min(n - 1, Math.floor(Math.max(ax, bx, qx) + grow - 0.5));
  const y0 = Math.max(0, Math.ceil(Math.min(az, bz, qz) - grow - 0.5)), y1 = Math.min(n - 1, Math.floor(Math.max(az, bz, qz) + grow - 0.5));
  for (let y = y0; y <= y1; y++) {
    const py = y + 0.5, row = y * n;
    for (let x = x0; x <= x1; x++) {
      const px = x + 0.5;
      if ((bx - ax) * (py - az) - (bz - az) * (px - ax) >= gab && (qx - bx) * (py - bz) - (qz - bz) * (px - bx) >= gbq &&
        (ax - qx) * (py - qz) - (az - qz) * (px - qx) >= gqa && mask[row + x] < val) mask[row + x] = val;
    }
  }
  return true;
}

/** Footprint fallback: u from the centre line to the outer edge of what the course drives on at f (surface + verge),
 *  plus its rails or barrier. */
const edgeOf = (f: TrackFrame) => f.width / 2 + (f.edge === 'grass' ? f.shoulder || 0 : f.edge === 'barrier' ? BARRIER : RAIL);

// ---- merged, indexed geometry --------------------------------------------------------------------
interface Tpl { p: ArrayLike<number>; i: ArrayLike<number>; n: number }

function tplOf(g: THREE.BufferGeometry): Tpl {
  g.deleteAttribute('normal');
  g.deleteAttribute('uv');
  const m = mergeVertices(g, 1e-3);
  const p = m.getAttribute('position').array;
  return { p, i: m.getIndex()!.array, n: p.length / 3 };
}

const C = new THREE.Color(); // paint callbacks write the vertex colour here
/** Colours vertex k of a template (local coords before jitter/scale) into C; returns its sway weight. */
type Paint = (lx: number, ly: number, lz: number, k: number) => number;

class Mesher {
  readonly pos: number[] = [];
  readonly col: number[] = [];
  readonly sway: number[] = [];
  readonly idx: number[] = [];
  /** Where each item starts: plan anchor x, z, first vertex, first index (chunks() keeps an item whole). */
  readonly items: number[] = [];

  /** Starts an item (a tree, a rock, a tuft...) anchored at (x, z): what is added up to the next one belongs to it. */
  item(x: number, z: number) {
    this.items.push(x, z, this.pos.length / 3, this.idx.length);
  }

  /** Template -> radial jitter -> scale -> rotate about y -> translate. */
  add(t: Tpl, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry: number, jit: number, seed: number, paint: Paint) {
    const base = this.pos.length / 3, c = Math.cos(ry), s = Math.sin(ry);
    for (let k = 0; k < t.n; k++) {
      let lx = t.p[3 * k], ly = t.p[3 * k + 1], lz = t.p[3 * k + 2];
      const sw = paint(lx, ly, lz, k);
      if (jit) {
        const j = 1 + jit * (hash3(k, seed, 1) * 2 - 1);
        lx *= j;
        lz *= j;
        ly *= 1 + jit * (hash3(k, seed, 2) * 2 - 1);
      }
      const wx = lx * sx, wy = ly * sy, wz = lz * sz;
      this.pos.push(x + wx * c + wz * s, y + wy, z - wx * s + wz * c);
      this.col.push(C.r, C.g, C.b);
      this.sway.push(sw);
    }
    for (let k = 0; k < t.i.length; k++) this.idx.push(base + t.i[k]);
  }

  /** A vertex for hand-built strips (the pond's banks); returns its index. */
  vert(x: number, y: number, z: number, c: THREE.Color, sway = 0) {
    this.pos.push(x, y, z);
    this.col.push(c.r, c.g, c.b);
    this.sway.push(sway);
    return this.pos.length / 3 - 1;
  }

  /** A quad over four vertices (in order round it), wound to face along (nx, ny, nz). */
  quad(a: number, b: number, c: number, d: number, nx: number, ny: number, nz: number) {
    const P = this.pos, ux = P[3 * b] - P[3 * a], uy = P[3 * b + 1] - P[3 * a + 1], uz = P[3 * b + 2] - P[3 * a + 2];
    const wx = P[3 * c] - P[3 * a], wy = P[3 * c + 1] - P[3 * a + 1], wz = P[3 * c + 2] - P[3 * a + 2];
    if ((uy * wz - uz * wy) * nx + (uz * wx - ux * wz) * ny + (ux * wy - uy * wx) * nz >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }

  /** A triangle over three vertices, wound to face up (+y). */
  up(a: number, b: number, c: number) {
    const P = this.pos, ux = P[3 * b] - P[3 * a], uz = P[3 * b + 2] - P[3 * a + 2], wx = P[3 * c] - P[3 * a], wz = P[3 * c + 2] - P[3 * a + 2];
    if (uz * wx - ux * wz >= 0) this.idx.push(a, b, c); // (b - a) x (c - a) has y = uz wx - ux wz
    else this.idx.push(a, c, b);
  }

  /** A square beam w u thick from a to b, open ended (poles, rungs and braces of the props). */
  beam(ax: number, ay: number, az: number, bx: number, by: number, bz: number, w: number, c: THREE.Color) {
    const dx = bx - ax, dy = by - ay, dz = bz - az, l = Math.hypot(dx, dy, dz), hl = Math.hypot(dx, dz);
    // u: level and square to the beam (any level axis for an upright), v = t x u
    const ux = hl > 1e-6 * l ? -dz / hl : 1, uz = hl > 1e-6 * l ? dx / hl : 0, tx = dx / l, ty = dy / l, tz = dz / l;
    const vx = ty * uz, vy = tz * ux - tx * uz, vz = -ty * ux, h = w / 2, b = this.pos.length / 3;
    for (const [p, q] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
      const ox = (ux * p + vx * q) * h, oy = vy * q * h, oz = (uz * p + vz * q) * h;
      this.pos.push(ax + ox, ay + oy, az + oz, bx + ox, by + oy, bz + oz);
      this.col.push(c.r, c.g, c.b, c.r, c.g, c.b);
      this.sway.push(0, 0);
    }
    // side k joins corners k and k + 1 (vertex 2k at a, 2k + 1 at b); wound so it faces out
    for (let k = 0; k < 4; k++) {
      const i = b + 2 * k, j = b + 2 * ((k + 1) % 4), P = this.pos;
      const ex = P[3 * j] - P[3 * i], ey = P[3 * j + 1] - P[3 * i + 1], ez = P[3 * j + 2] - P[3 * i + 2];
      const nx = ey * dz - ez * dy, ny = ez * dx - ex * dz, nz = ex * dy - ey * dx; // (j - i) x (b - a)
      const mx = P[3 * i] + P[3 * j] - 2 * ax, my = P[3 * i + 1] + P[3 * j + 1] - 2 * ay, mz = P[3 * i + 2] + P[3 * j + 2] - 2 * az;
      if (nx * mx + ny * my + nz * mz > 0) this.idx.push(i, j, j + 1, i, j + 1, i + 1);
      else this.idx.push(i, j + 1, j, i, i + 1, j + 1);
    }
  }

  /** A two-sided triangle (grass blade / stem): base colour at a and b, tip colour at c. */
  blade(ax: number, ay: number, az: number, bx: number, by: number, bz: number, cx: number, cy: number, cz: number, base: THREE.Color, tip: THREE.Color, tipSway: number) {
    const i = this.pos.length / 3;
    this.pos.push(ax, ay, az, bx, by, bz, cx, cy, cz);
    this.col.push(base.r, base.g, base.b, base.r, base.g, base.b, tip.r, tip.g, tip.b);
    this.sway.push(0, 0, tipSway);
    this.idx.push(i, i + 1, i + 2, i, i + 2, i + 1);
  }

  /** The items split into up to k area chunks, one geometry each: weighted k-means on the items' anchors (weight = their
   *  triangles), so the dense stretches along the course fall into compact areas that frustum culling drops whenever
   *  the camera looks away. Seeded by farthest points (no dice), so the split is the same on every load. */
  chunks(k: number): THREE.BufferGeometry[] {
    const it = this.items, n = it.length / 4, nv = this.pos.length / 3, ni = this.idx.length;
    const tris = (i: number) => ((i + 1 < n ? it[4 * i + 7] : ni) - it[4 * i + 3]) / 3;
    const C: number[] = [];
    let sx = 0, sz = 0, sw = 0;
    for (let i = 0; i < n; i++) (sx += it[4 * i] * tris(i)), (sz += it[4 * i + 1] * tris(i)), (sw += tris(i));
    C.push(sx / Math.max(1, sw), sz / Math.max(1, sw));
    const d2 = new Float64Array(n).fill(Infinity);
    while (C.length < 2 * Math.min(k, n)) {
      const cx = C[C.length - 2], cz = C[C.length - 1];
      let best = -1, bi = 0;
      for (let i = 0; i < n; i++) {
        d2[i] = Math.min(d2[i], (it[4 * i] - cx) ** 2 + (it[4 * i + 1] - cz) ** 2);
        if (d2[i] * tris(i) > best) (best = d2[i] * tris(i)), (bi = i);
      }
      C.push(it[4 * bi], it[4 * bi + 1]);
    }
    const K = C.length / 2, of = new Int32Array(n), acc = new Float64Array(3 * K);
    const nearest = (x: number, z: number) => {
      let best = Infinity, bc = 0;
      for (let c = 0; c < K; c++) {
        const d = (C[2 * c] - x) ** 2 + (C[2 * c + 1] - z) ** 2;
        if (d < best) (best = d), (bc = c);
      }
      return bc;
    };
    for (let pass = 0; pass < 24; pass++) {
      acc.fill(0);
      for (let i = 0; i < n; i++) {
        const c = (of[i] = nearest(it[4 * i], it[4 * i + 1])), w = tris(i);
        acc[3 * c] += it[4 * i] * w;
        acc[3 * c + 1] += it[4 * i + 1] * w;
        acc[3 * c + 2] += w;
      }
      for (let c = 0; c < K; c++) if (acc[3 * c + 2] > 0) (C[2 * c] = acc[3 * c] / acc[3 * c + 2]), (C[2 * c + 1] = acc[3 * c + 1] / acc[3 * c + 2]);
    }
    for (let i = 0; i < n; i++) of[i] = nearest(it[4 * i], it[4 * i + 1]);
    const out: THREE.BufferGeometry[] = [];
    for (let c = 0; c < K; c++) {
      let cv = 0, ci = 0;
      for (let i = 0; i < n; i++) if (of[i] === c) (cv += (i + 1 < n ? it[4 * i + 6] : nv) - it[4 * i + 2]), (ci += 3 * tris(i));
      if (!ci) continue;
      const P = new Float32Array(3 * cv), Q = new Float32Array(3 * cv), S = new Float32Array(cv), I = cv > 65535 ? new Uint32Array(ci) : new Uint16Array(ci);
      let v = 0, x = 0;
      for (let i = 0; i < n; i++) {
        if (of[i] !== c) continue;
        const v0 = it[4 * i + 2], v1 = i + 1 < n ? it[4 * i + 6] : nv, i0 = it[4 * i + 3], i1 = i + 1 < n ? it[4 * i + 7] : ni;
        for (let j = v0; j < v1; j++, v++) {
          P[3 * v] = this.pos[3 * j];
          P[3 * v + 1] = this.pos[3 * j + 1];
          P[3 * v + 2] = this.pos[3 * j + 2];
          Q[3 * v] = this.col[3 * j];
          Q[3 * v + 1] = this.col[3 * j + 1];
          Q[3 * v + 2] = this.col[3 * j + 2];
          S[v] = this.sway[j];
        }
        const shift = v - (v1 - v0) - v0;
        for (let j = i0; j < i1; j++) I[x++] = this.idx[j] + shift;
      }
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.BufferAttribute(P, 3));
      g.setAttribute('color', new THREE.BufferAttribute(Q, 3));
      g.setAttribute('aSway', new THREE.BufferAttribute(S, 1));
      g.setIndex(new THREE.BufferAttribute(I, 1));
      g.computeBoundingSphere();
      g.boundingSphere!.radius += 0.5; // the wind sways tips up to ~0.25 u
      out.push(g);
    }
    return out;
  }
}

// ---- shader patches -----------------------------------------------------------------------------
// Radial fog (per pixel, from vViewPosition): no haze swimming when the camera yaws, and correct across
// the huge ground triangles. `atten` scales it (the hills thin it with height).
const radialFog = (atten = '1.0') => /* glsl */ `
#ifdef USE_FOG
  float fogFactor = smoothstep( fogNear, fogFar, length( vViewPosition ) ) * ( ${atten} );
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, fogFactor );
#endif`;

// ---- textures -----------------------------------------------------------------------------------
/** Top-down grass: mottled base + thousands of short blade strokes, seamless. */
function grassTexture(rnd: () => number, aniso: number) {
  const N = 512, c = canvas(N), g = c.getContext('2d')!;
  g.fillStyle = '#5b9a3b';
  g.fillRect(0, 0, N, N);
  const wrapped = (x: number, y: number, r: number, draw: (x: number, y: number) => void) => {
    for (const ox of [-N, 0, N]) for (const oy of [-N, 0, N]) {
      if (x + ox + r < 0 || x + ox - r > N || y + oy + r < 0 || y + oy - r > N) continue;
      draw(x + ox, y + oy);
    }
  };
  for (let i = 0; i < 90; i++) {
    const x = rnd() * N, y = rnd() * N, r = 14 + rnd() * 50, light = rnd() < 0.5;
    wrapped(x, y, r, (px, py) => {
      const gr = g.createRadialGradient(px, py, 0, px, py, r);
      gr.addColorStop(0, light ? 'rgba(160,205,95,0.22)' : 'rgba(28,78,22,0.22)');
      gr.addColorStop(1, 'rgba(0,0,0,0)');
      g.fillStyle = gr;
      g.fillRect(px - r, py - r, 2 * r, 2 * r);
    });
  }
  const greens = ['#2f6a22', '#3c7a29', '#4a8a30', '#579938', '#66a83f', '#78b748', '#8cc555', '#a2d066'];
  g.lineCap = 'round';
  for (let pass = 0; pass < 2; pass++) {
    for (let ci = 0; ci < greens.length; ci++) {
      g.strokeStyle = greens[ci];
      g.lineWidth = pass ? 1.2 : 2.2;
      g.beginPath();
      const n = pass ? 1100 : 650;
      for (let i = 0; i < n; i++) {
        const x = rnd() * N, y = rnd() * N, a = rnd() * Math.PI * 2, len = 3 + rnd() * (pass ? 9 : 6);
        const dx = Math.cos(a) * len, dy = Math.sin(a) * len;
        wrapped(x, y, len, (px, py) => {
          g.moveTo(px, py);
          g.lineTo(px + dx, py + dy);
        });
      }
      g.stroke();
    }
  }
  // clover-ish specks
  for (let i = 0; i < 260; i++) {
    const x = rnd() * N, y = rnd() * N, r = 1 + rnd() * 1.6;
    g.fillStyle = rnd() < 0.5 ? '#2c6420' : '#9fd16a';
    wrapped(x, y, r, (px, py) => {
      g.beginPath();
      g.arc(px, py, r, 0, Math.PI * 2);
      g.fill();
    });
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = aniso;
  return t;
}

/** Tileable noise: r, g = soft fbm patches (two seeds), b = fine grain. Linear data. */
function noiseTexture() {
  const N = 128, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = x / N, v = y / N, i = (y * N + x) * 4;
      const r = fbm(u * 4, v * 4, 11, 4, 4), gg = fbm(u * 8, v * 8, 23, 4, 8);
      const b = 0.55 * vnoise(u * 32, v * 32, 37, 32) + 0.45 * hash3(x, y, 5);
      d[i] = clamp((r - 0.5) * 1.9 + 0.5, 0, 1) * 255;
      d[i + 1] = clamp((gg - 0.5) * 1.9 + 0.5, 0, 1) * 255;
      d[i + 2] = b * 255;
      d[i + 3] = 255;
    }
  }
  const t = new THREE.DataTexture(d, N, N);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** 2 x 2 atlas of puffy cumulus, flat-bottomed, shaded darker underneath. Straight alpha, white rgb
 *  everywhere (no dark fringes when filtered). Row 0 = the cloud's base. */
function cloudAtlas(rnd: () => number) {
  const W = 512, H = 256, CW = 256, CH = 128, d = new Uint8Array(W * H * 4);
  for (let cell = 0; cell < 4; cell++) {
    const ox = (cell % 2) * CW, oy = (cell >> 1) * CH, base = CH * 0.2;
    const puffs: number[] = [];
    const n = 6 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) {
      const u = (i + 0.5) / n, bell = Math.sin(Math.PI * u);
      const r = CH * (0.13 + 0.2 * bell * (0.75 + 0.5 * rnd()));
      puffs.push(CW * (0.13 + 0.74 * u + (rnd() - 0.5) * 0.05), base + r * (0.45 + 0.3 * rnd()), r);
    }
    for (let i = 0; i < 3; i++) {
      const u = 0.3 + 0.4 * rnd(), r = CH * (0.14 + 0.1 * rnd());
      puffs.push(CW * u, base + CH * (0.3 + 0.12 * rnd()), r);
    }
    for (let y = 0; y < CH; y++) {
      for (let x = 0; x < CW; x++) {
        let f = 0;
        for (let i = 0; i < puffs.length; i += 3) {
          const dx = x - puffs[i], dy = y - puffs[i + 1], r = puffs[i + 2];
          const q = 1 - (dx * dx + dy * dy) / (r * r);
          if (q > 0) f += q * q;
        }
        const a = smooth(0.12, 0.42, f) * smooth(base - 2, base + 9, y);
        const sh = 0.8 + 0.2 * Math.sqrt(clamp((y - base) / (CH * 0.5), 0, 1)) + 0.04 * clamp(f - 0.6, 0, 1);
        const i4 = ((oy + y) * W + ox + x) * 4;
        d[i4] = clamp(255 * sh * 0.96, 0, 255);
        d[i4 + 1] = clamp(255 * sh * 0.98, 0, 255);
        d[i4 + 2] = clamp(255 * sh * 1.02, 0, 255);
        d[i4 + 3] = 255 * a;
      }
    }
  }
  const t = new THREE.DataTexture(d, W, H);
  t.colorSpace = THREE.SRGBColorSpace;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

/** The big jump's banner (4:1): RIPCARS in the app's display face on charcoal, orange bands, chequered ends. Redrawn
 *  once the web font has loaded (Impact stands in until then). */
function bannerTexture(aniso: number) {
  const c = canvas(1024, 256), g = c.getContext('2d')!;
  const draw = () => {
    g.fillStyle = '#16171c';
    g.fillRect(0, 0, 1024, 256);
    g.fillStyle = '#ff6b00';
    g.fillRect(0, 0, 1024, 22);
    g.fillRect(0, 234, 1024, 22);
    g.fillStyle = '#f4f4f2';
    for (const x0 of [0, 928]) for (let i = 0; i < 4; i++) for (let j = 0; j < 7; j++) if ((i + j) % 2 === 0) g.fillRect(x0 + i * 24, 22 + j * 30, 24, 30);
    g.fillStyle = '#ffffff';
    g.font = 'italic 176px Anton, Impact, "Arial Black", sans-serif';
    g.textAlign = 'center';
    g.textBaseline = 'middle';
    g.fillText('RIPCARS', 512, 134, 740);
  };
  draw();
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = aniso;
  document.fonts?.load('176px Anton').then(() => {
    draw();
    t.needsUpdate = true;
  }, () => {});
  return t;
}

/** Soft rounded-rectangle falloff for the car's blob shadow (alpha only). */
function blobTexture() {
  const N = 64, d = new Uint8Array(N * N * 4);
  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const u = Math.abs((x + 0.5) / (N / 2) - 1), v = Math.abs((y + 0.5) / (N / 2) - 1);
      const r = Math.pow(u ** 4 + v ** 4, 1 / 4); // squircle: a car-shaped rounded rectangle
      d[(y * N + x) * 4 + 3] = 255 * Math.pow(1 - smooth(0.45, 1, r), 1.4);
    }
  }
  const t = new THREE.DataTexture(d, N, N);
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.needsUpdate = true;
  return t;
}

// ---- scenery records ----------------------------------------------------------------------------
type Kind = 0 | 1 | 2 | 3; // round, pine, poplar, blossom
const ROUND = 0, PINE = 1, POPLAR = 2, BLOSSOM = 3;
/** tier: 0 near (full detail), 1 mid, 2 far (cheapest) */
interface Tree { x: number; z: number; kind: Kind; tier: number; trunkH: number; trunkR: number; cr: number; ch: number; rot: number; seed: number; leaf: THREE.Color; bark: THREE.Color }
interface Rock { x: number; z: number; r: number; sy: number; sz: number; rot: number; seed: number; fine: boolean; col: THREE.Color }
interface Bush { x: number; z: number; r: number; rot: number; seed: number; leaf: THREE.Color }
/** The big jump's pond: centre, unit long axis (ux, uz), semi-axes, harmonics on the rim (amplitude, phase per POND_HARM),
 *  and the bend of its long axis (the ends sit bend x a off to the side). */
interface Pond { x: number; z: number; ux: number; uz: number; a: number; b: number; h: number[]; bend: number }
const POND_HARM = [2, 3, 5];
const POND_DEPTH = 2.4; // u from the meadow down to the pond's water
const POND_CLEAR = 2.5; // u its rim keeps from the course's footprint (the flight's aside)

const LEAF = [
  ['#4c8a2b', '#5a9b31', '#6aab38', '#3f7d2c', '#7cb53f', '#8dbf3c'], // round
  ['#2c6435', '#336f3a', '#285b33', '#3b7a3c'], // pine
  ['#5b9a34', '#69a83a', '#4f8d33'], // poplar
  ['#f28bb8', '#f5a3c7', '#ee7fae', '#f7c35c'], // blossom
];
const BARK = ['#6b4a2f', '#5e4029', '#7a5636'];
const ROCK = ['#9b968e', '#8b8780', '#a59f94', '#8f8a84'];
const BUSH = ['#3f7d2c', '#4a8a30', '#356f28', '#5a9634'];
const FLOWER = ['#ffffff', '#ffd23f', '#ff6fae', '#a36cf0', '#ff4f4f', '#ff9d3a', '#6aa8ff'];
// Pine tiers per detail tier: [base, height, radius] as fractions of the crown height / radius, bottom tier first.
const PINE_TIERS = [
  [[0, 0.42, 1], [0.26, 0.42, 0.73], [0.52, 0.42, 0.46]],
  [[0, 0.5, 1], [0.36, 0.62, 0.62]],
  [[0, 0.98, 0.9]],
];

export function buildWorld(scene: THREE.Scene, renderer: THREE.WebGLRenderer, track: Track): World {
  const tStart = performance.now();
  const root = new THREE.Group();
  root.name = 'world-outdoor';
  scene.add(root);
  const rnd = rngOf(SEED);
  const R = (a: number, b: number) => a + (b - a) * rnd();
  const pick = <T>(a: T[]) => a[Math.floor(rnd() * a.length) % a.length];
  const gauss = () => Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
  const expo = (mean: number) => -Math.log(1 - rnd() * 0.999) * mean;

  // ---- the course ---------------------------------------------------------------------------------
  const F = track.frames, N = F.length;
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity, minY = Infinity;
  for (const f of F) {
    const p = f.p;
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.z < minZ) minZ = p.z;
    if (p.z > maxZ) maxZ = p.z;
    if (p.y < minY) minY = p.y;
  }
  if (!N) minX = maxX = minZ = maxZ = minY = 0;
  // Just under the lowest point of the course: the meadow meets the feet of the supports and the lowest road.
  const groundY = Math.min(0, minY - 0.3);
  const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
  const span = Math.max(maxX - minX, maxZ - minZ, 100);
  const worldR = span / 2 + 300; // scenery radius round the course's centre

  // Samples ~1 u apart: centre (x, y, z), the footprint's half-width (horizontal u), horizontal tangent (right =
  // (-tz, tx)), signed curvature, the clear margin a raised section keeps below it (open views from up there), and the
  // surface.
  const foot = (track.object.userData as { footprint?: ArrayLike<number> }).footprint;
  const ds = N > 1 ? F[1].s - F[0].s : 0.5, stride = Math.max(1, Math.round(1 / Math.max(1e-3, ds))), sds = stride * ds;
  const SX: number[] = [], SY: number[] = [], SZ: number[] = [], SE: number[] = [], STX: number[] = [], STZ: number[] = [];
  const SK: number[] = [], SV: number[] = [], SS: TrackFrame['surface'][] = [], SF: boolean[] = [];
  // The big jump's flight: the gap(s) between its launch lip and its landing ramp, where nothing stands under the line.
  const jump = track.tags.find((g) => g.tag === 'bigjump');
  const flights = jump ? track.tags.filter((g) => g.tag === 'gap' && g.s0 >= jump.s0 - 1 && g.s1 <= jump.s1 + 1) : [];
  for (let i = 0; i < N; i += stride) {
    const f = F[i];
    SF.push(flights.some((g) => f.s > g.s0 + 1 && f.s < g.s1 - 1));
    let rx = f.right.x, rz = f.right.z;
    const rl = Math.hypot(rx, rz);
    if (rl > 1e-3) (rx /= rl), (rz /= rl);
    else (rx = -f.t.z), (rz = f.t.x); // never in practice (right is level enough even in a loop)
    SX.push(f.p.x);
    SY.push(f.p.y);
    SZ.push(f.p.z);
    SE.push(foot && foot.length === N ? foot[i] : edgeOf(f) * Math.max(rl, 0.3));
    STX.push(rz);
    STZ.push(-rx);
    SK.push(f.kappa);
    SV.push(clamp((f.p.y - groundY - 3) * 1.2, 0, 14));
    SS.push(f.surface);
  }
  const M = SX.length;
  let reach = 0;
  for (let k = 0; k < M; k++) reach = Math.max(reach, SE[k] + SV[k]);

  const cellKey = (i: number, j: number) => (i + 32768) * 65536 + (j + 32768);
  const gridOf = (xs: number[], zs: number[], cell: number) => {
    const g = new Map<number, number[]>();
    for (let k = 0; k < xs.length; k++) {
      const key = cellKey(Math.floor(xs[k] / cell), Math.floor(zs[k] / cell));
      const l = g.get(key);
      if (l) l.push(k);
      else g.set(key, [k]);
    }
    return g;
  };
  const NEAR_EXACT = 16; // u beyond the footprint within which edgeDist is exact
  const CELL = Math.ceil(reach + NEAR_EXACT), QCELL = 16;
  const cgrid = gridOf(SX, SZ, CELL);

  /** Horizontal distance from (x, z) to the edge of the course's footprint (negative on it); `view` adds the margin
   *  raised sections keep clear, `solid` leaves out the big jump's flight (only what stands on the ground counts).
   *  Exact within NEAR_EXACT u, coarse beyond (solid: just some distance >= NEAR_EXACT, enough for a keep-out test). */
  function edgeDist(x: number, z: number, view = false, solid = false) {
    const i0 = Math.floor(x / CELL), j0 = Math.floor(z / CELL);
    let best = Infinity;
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const l = cgrid.get(cellKey(i, j));
        if (!l) continue;
        for (const k of l) {
          if (solid && SF[k]) continue;
          const d = Math.hypot(SX[k] - x, SZ[k] - z) - SE[k] - (view ? SV[k] : 0);
          if (d < best) best = d;
        }
      }
    }
    if (best < NEAR_EXACT || solid) return best;
    for (let k = 0; k < M; k += 4) {
      const d = Math.hypot(SX[k] - x, SZ[k] - z) - SE[k] - (view ? SV[k] : 0);
      if (d < best) best = d;
    }
    return best;
  }

  // Sight lines: chords from every 4 u of the lap to the points 12, 24 and 40 u further on. Trees and big rocks keep
  // off them, which keeps the inside of every bend open (the chase camera looks across it at the road ahead).
  const QX: number[] = [], QZ: number[] = [];
  for (let k = 0; k < M; k += 4) {
    for (const ahead of [12, 24, 40]) {
      const k2 = (k + Math.round(ahead / sds)) % M, km = (k + Math.round(ahead / sds / 2)) % M;
      const ax = SX[k], az = SZ[k], bx = SX[k2], bz = SZ[k2];
      if (Math.hypot((ax + bx) / 2 - SX[km], (az + bz) / 2 - SZ[km]) < 2) continue; // a straight: the keep-out has it
      const n = Math.ceil(ahead / 3);
      for (let i = 1; i < n; i++) {
        QX.push(ax + ((bx - ax) * i) / n);
        QZ.push(az + ((bz - az) * i) / n);
      }
    }
  }
  const qgrid = gridOf(QX, QZ, QCELL);
  /** Distance to the nearest sight line, capped at QCELL. */
  function sightDist(x: number, z: number) {
    const i0 = Math.floor(x / QCELL), j0 = Math.floor(z / QCELL);
    let best = QCELL * QCELL;
    for (let i = i0 - 1; i <= i0 + 1; i++) {
      for (let j = j0 - 1; j <= j0 + 1; j++) {
        const l = qgrid.get(cellKey(i, j));
        if (!l) continue;
        for (const k of l) {
          const dx = QX[k] - x, dz = QZ[k] - z, d2 = dx * dx + dz * dz;
          if (d2 < best) best = d2;
        }
      }
    }
    return Math.sqrt(best);
  }

  // ---- sun, sky light, environment, fog -------------------------------------------------------
  const el = LOOK.sunElevation * DEG, sunH = new THREE.Vector2(...LOOK.sunFrom).normalize();
  const sunDir = new THREE.Vector3(sunH.x * Math.cos(el), Math.sin(el), sunH.y * Math.cos(el));

  const sun = new THREE.DirectionalLight(LOOK.sun, LOOK.sunIntensity);
  sun.position.set(cx, groundY, cz).addScaledVector(sunDir, 500);
  sun.target.position.set(cx, groundY, cz);
  root.add(sun, sun.target, new THREE.HemisphereLight(LOOK.hemiSky, LOOK.hemiGround, LOOK.hemiIntensity));

  const pmrem = new THREE.PMREMGenerator(renderer);
  const room = new RoomEnvironment();
  scene.environment = pmrem.fromScene(room, 0.04).texture;
  scene.environmentIntensity = LOOK.envIntensity;
  room.dispose();
  pmrem.dispose();
  scene.fog = new THREE.Fog(LOOK.horizon, LOOK.fogNear, LOOK.fogFar);

  const aniso = Math.min(8, renderer.capabilities.getMaxAnisotropy());
  const uTime = { value: 0 };

  // ---- occupancy (props never overlap each other or the track's structures) -------------------
  const OCC = 12;
  const occ = new Map<number, number[]>(), occR: number[] = [];
  const isFree = (x: number, z: number, r: number) => {
    const i0 = Math.floor(x / OCC), j0 = Math.floor(z / OCC);
    for (let i = i0 - 2; i <= i0 + 2; i++) {
      for (let j = j0 - 2; j <= j0 + 2; j++) {
        const l = occ.get(cellKey(i, j));
        if (!l) continue;
        for (const k of l) {
          const dx = occR[k] - x, dz = occR[k + 1] - z, rr = occR[k + 2] + r;
          if (dx * dx + dz * dz < rr * rr) return false;
        }
      }
    }
    return true;
  };
  const occupy = (x: number, z: number, r: number) => {
    const key = cellKey(Math.floor(x / OCC), Math.floor(z / OCC));
    const l = occ.get(key);
    if (l) l.push(occR.length);
    else occ.set(key, [occR.length]);
    occR.push(x, z, Math.min(r, OCC));
  };

  // ---- the track's own meshes: shadows, occlusion, footprints ----------------------------------
  // Generic, so it fits whatever the track builds (the raised plastic, supports, towers, barriers): every triangle
  // standing more than LIFT u off the ground and turned to the sun is projected along the sun onto the ground, and
  // every one turned up dims the sky light under its plan. Instances of an instanced mesh (posts, beams, tyres, bales)
  // cast their oriented boxes, plenty at the map's ~1.4 u/px, mark occlusion where they stand and claim their
  // footprint. Triangles are rasterized into coverage masks (pixel centres, the sun's at 2x and averaged down): the
  // union of any number of them, no double darkening, a few ms where canvas paths take ~0.5 s.
  const MN = 1024, MS = clamp(span + 760, 900, 2400), mx0 = cx - MS / 2, mz0 = cz - MS / 2, mk = MN / MS;
  const SUN_N = 2 * MN, SKY_N = MN >> 2, ks = SUN_N / MS, ka = SKY_N / MS;
  const sunMask = new Uint8Array(SUN_N * SUN_N), lowMask = new Uint8Array(SKY_N * SKY_N), highMask = new Uint8Array(SKY_N * SKY_N);
  const feet: number[] = []; // x, z, r: where an instance stands on the ground
  let castTris = 0;
  const tCast = performance.now();
  {
    const tri = (mask: Uint8Array, n: number, k: number, ax: number, az: number, bx: number, bz: number, qx: number, qz: number) => {
      if (fillTri(mask, n, k, ax, az, bx, bz, qx, qz, 1, mask === sunMask ? 0.5 : 0)) castTris++;
    };
    const poly = (mask: Uint8Array, n: number, k: number, p: number[], cnt: number) => {
      const h = hull(p, cnt);
      for (let i = 2; i < h.length; i++) tri(mask, n, k, p[2 * h[0]], p[2 * h[0] + 1], p[2 * h[i - 1]], p[2 * h[i - 1] + 1], p[2 * h[i]], p[2 * h[i] + 1]);
    };
    /** Where the sun throws the point (x, y, z) on the meadow, map-local, into out[o], out[o + 1]. */
    const sunAt = (x: number, y: number, z: number, out: number[] | Float32Array, o: number) => {
      const t = Math.max(0, y - groundY) / sunDir.y;
      out[o] = x - sunDir.x * t - mx0;
      out[o + 1] = z - sunDir.z * t - mz0;
    };
    const v = new THREE.Vector3(), im = new THREE.Matrix4(), corner = new Array<number>(24), sp = new Array<number>(16), pp = new Array<number>(16);
    track.object.updateMatrixWorld(true);
    track.object.traverseVisible((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = (Array.isArray(mesh.material) ? mesh.material[0] : mesh.material) as THREE.Material;
      if (!mat || mat.transparent || mat.polygonOffset || !mat.depthWrite) return; // decals and effects cast nothing
      const g = mesh.geometry, pos = g.getAttribute('position');
      if (!pos) return;
      const inst = mesh as THREE.InstancedMesh;
      if (inst.isInstancedMesh) {
        if (!g.boundingBox) g.computeBoundingBox();
        const bb = g.boundingBox!;
        for (let n = 0; n < inst.count; n++) {
          inst.getMatrixAt(n, im);
          im.premultiply(mesh.matrixWorld);
          let top = -Infinity, bot = Infinity, mx = 0, mz = 0;
          for (let c = 0; c < 8; c++) {
            v.set(c & 1 ? bb.max.x : bb.min.x, c & 2 ? bb.max.y : bb.min.y, c & 4 ? bb.max.z : bb.min.z).applyMatrix4(im);
            corner[3 * c] = v.x;
            corner[3 * c + 1] = v.y;
            corner[3 * c + 2] = v.z;
            top = Math.max(top, v.y);
            bot = Math.min(bot, v.y);
            mx += v.x / 8;
            mz += v.z / 8;
          }
          if (top - groundY < LIFT) continue;
          let rad = 0;
          for (let c = 0; c < 8; c++) {
            sunAt(corner[3 * c], corner[3 * c + 1], corner[3 * c + 2], sp, 2 * c);
            pp[2 * c] = corner[3 * c] - mx0;
            pp[2 * c + 1] = corner[3 * c + 2] - mz0;
            rad = Math.max(rad, Math.hypot(corner[3 * c] - mx, corner[3 * c + 2] - mz));
          }
          poly(sunMask, SUN_N, ks, sp, 8);
          poly(top - groundY < 8 ? lowMask : highMask, SKY_N, ka, pp, 8);
          if (bot - groundY < 0.6) {
            feet.push(mx, mz, rad);
            occupy(mx, mz, rad);
          }
        }
        return;
      }
      // A solid's shadow is that of its faces turned to the sun, its plan that of its faces turned up: half the work.
      const idx = g.getIndex()?.array, nv = pos.count, nt = idx ? idx.length / 3 : nv / 3;
      const flip = (mesh.matrixWorld.determinant() < 0) !== (mat.side === THREE.BackSide) ? -1 : 1, both = mat.side === THREE.DoubleSide;
      const W = new Float32Array(nv * 3), above = new Float32Array(nv), S = new Float32Array(nv * 2), done = new Uint8Array(nv);
      for (let i = 0; i < nv; i++) {
        v.fromBufferAttribute(pos, i).applyMatrix4(mesh.matrixWorld);
        W[3 * i] = v.x;
        W[3 * i + 1] = v.y;
        W[3 * i + 2] = v.z;
        above[i] = v.y - groundY;
      }
      const shade = (i: number) => {
        if (!done[i]) (done[i] = 1), sunAt(W[3 * i], W[3 * i + 1], W[3 * i + 2], S, 2 * i);
      };
      for (let t = 0; t < nt; t++) {
        const a = idx ? idx[3 * t] : 3 * t, b = idx ? idx[3 * t + 1] : 3 * t + 1, c = idx ? idx[3 * t + 2] : 3 * t + 2;
        const hi = Math.max(above[a], above[b], above[c]);
        if (hi < LIFT) continue;
        const ux = W[3 * b] - W[3 * a], uy = W[3 * b + 1] - W[3 * a + 1], uz = W[3 * b + 2] - W[3 * a + 2];
        const wx = W[3 * c] - W[3 * a], wy = W[3 * c + 1] - W[3 * a + 1], wz = W[3 * c + 2] - W[3 * a + 2];
        const nx = (uy * wz - uz * wy) * flip, ny = (uz * wx - ux * wz) * flip, nz = (ux * wy - uy * wx) * flip;
        if (both || nx * sunDir.x + ny * sunDir.y + nz * sunDir.z > 0) {
          shade(a), shade(b), shade(c);
          tri(sunMask, SUN_N, ks, S[2 * a], S[2 * a + 1], S[2 * b], S[2 * b + 1], S[2 * c], S[2 * c + 1]);
        }
        if (both || ny > 0) tri(hi < 8 ? lowMask : highMask, SKY_N, ka, W[3 * a] - mx0, W[3 * a + 2] - mz0, W[3 * b] - mx0, W[3 * b + 2] - mz0, W[3 * c] - mx0, W[3 * c + 2] - mz0);
      }
    });
  }
  const castMs = Math.round(performance.now() - tCast);

  // ---- the big jump's pond --------------------------------------------------------------------
  // A pond by the big jump: long and gently bent like a stretch of river, as wide and then as long as fits clear of
  // everything on the ground (roads, verges, banks, the ramps and their scaffolding) - under the flight, lying across it,
  // where there is room; else beside it (the jump may clear a road, which leaves none). The rim is an ellipse with a few
  // harmonics, its long axis bent into a shallow arc; the same function cuts the meadow (a hole in the ground mesh),
  // shapes the banks and the water and keeps the scatter out.
  let pond: Pond | null = null;
  const rp = [0, 0];
  /** Plan point of the pond's rim at polar angle th (its own axes: x along its length), into rp. */
  const rimAt = (P: Pond, th: number) => {
    let r = 1;
    for (let i = 0; i < POND_HARM.length; i++) r += P.h[2 * i] * Math.cos(POND_HARM[i] * th + P.h[2 * i + 1]);
    const lx = P.a * r * Math.cos(th), lz = P.b * r * Math.sin(th) + (P.bend * lx * lx) / P.a;
    rp[0] = P.x + P.ux * lx - P.uz * lz;
    rp[1] = P.z + P.uz * lx + P.ux * lz;
    return rp;
  };
  /** Whether (x, z) lies inside the pond's rim grown by `grow` u (along the ray from its middle, before the bend). */
  const inPond = (x: number, z: number, grow = 0) => {
    if (!pond) return false;
    const P = pond, dx = x - P.x, dz = z - P.z, lx = dx * P.ux + dz * P.uz, lz = dz * P.ux - dx * P.uz - (P.bend * lx * lx) / P.a;
    const l = Math.hypot(lx, lz);
    if (l > 1.4 * P.a + grow) return false; // the harmonics add at most a third
    const th = Math.atan2(lz / P.b, lx / P.a);
    let r = 1;
    for (let i = 0; i < POND_HARM.length; i++) r += P.h[2 * i] * Math.cos(POND_HARM[i] * th + P.h[2 * i + 1]);
    return l < r * Math.hypot(P.a * Math.cos(th), P.b * Math.sin(th)) + grow;
  };
  const flight = flights.length ? flights.reduce((a, b) => (b.s1 - b.s0 > a.s1 - a.s0 ? b : a)) : null; // the longest
  if (flight) {
    const prnd = rngOf(SEED ^ 0x7f4a7c15); // its own stream: the pond's shape never shifts the meadow's dice
    const h = POND_HARM.flatMap((_, i) => [(0.1 - 0.025 * i) * (0.6 + 0.4 * prnd()), prnd() * Math.PI * 2]);
    const bend = (prnd() < 0.5 ? -1 : 1) * (0.1 + 0.1 * prnd());
    const g = flight, A = track.frameAt(g.s0).p, B = track.frameAt(g.s1).p, FL = Math.max(1, Math.hypot(B.x - A.x, B.z - A.z));
    const fx = (B.x - A.x) / FL, fz = (B.z - A.z) / FL;
    // Where the ground is taken round the jump: a 1 u mask of every solid footprint (grown by POND_CLEAR).
    const half = Math.ceil(FL / 2 + 150), gn = 2 * half + 1, gx0 = (A.x + B.x) / 2 - half, gz0 = (A.z + B.z) / 2 - half;
    const taken = new Uint8Array(gn * gn);
    for (let k = 0; k < M; k++) {
      if (SF[k]) continue;
      const r = SE[k] + POND_CLEAR, i0 = Math.max(0, Math.floor(SX[k] - r - gx0)), i1 = Math.min(gn - 1, Math.ceil(SX[k] + r - gx0));
      const j0 = Math.max(0, Math.floor(SZ[k] - r - gz0)), j1 = Math.min(gn - 1, Math.ceil(SZ[k] + r - gz0));
      for (let j = j0; j <= j1; j++) {
        for (let i = i0; i <= i1; i++) if ((gx0 + i - SX[k]) ** 2 + (gz0 + j - SZ[k]) ** 2 < r * r) taken[j * gn + i] = 1;
      }
    }
    const free = (x: number, z: number) => {
      const i = Math.round(x - gx0), j = Math.round(z - gz0);
      return i >= 0 && j >= 0 && i < gn && j < gn && !taken[j * gn + i];
    };
    const pond0: Pond = { x: 0, z: 0, ux: 1, uz: 0, a: 1, b: 1, h, bend };
    const fits = () => {
      for (let i = 0; i < 64; i++) {
        rimAt(pond0, (i / 64) * Math.PI * 2);
        if (!free(rp[0], rp[1])) return false;
      }
      return true;
    };
    /** The largest x in [lo, hi] for which set(x) fits (bisection; lo - 1 if not even lo does). */
    const largest = (lo: number, hi: number, set: (x: number) => void) => {
      set(lo);
      if (!fits()) return lo - 1;
      for (let i = 0; i < 6; i++) {
        const mid = (lo + hi) / 2;
        set(mid);
        if (fits()) lo = mid;
        else hi = mid;
      }
      return lo;
    };
    // Candidates on a lattice along the jump (the gap's line, from beside the launch tower to beside the landing ramp)
    // and out to either side. A pond scores its area, less the further it lies from under the flight's second half and
    // the landing (where the camera looks down on it in the air).
    let best = 0;
    for (const u of [0.5, 0.32, 0.68, 0.1, 0.9, -0.3, 1.3, -0.7, 1.7, 2.2]) {
      for (const d of [0, 16, -16, 28, -28, 42, -42, 58, -58]) {
        const x = A.x + (B.x - A.x) * u - fz * d, z = A.z + (B.z - A.z) * u + fx * d;
        if (!free(x, z)) continue;
        const off = Math.hypot(d, FL * Math.max(0, 0.3 - u, u - 1.6)); // from the flight's plan line, 0.3 to 1.6 x A -> B
        for (const rot of [0, 0.5, -0.5, Math.PI / 2]) {
          const ca = Math.cos(rot), sa = Math.sin(rot); // rot 0: the long axis square across the flight
          Object.assign(pond0, { x, z, ux: -fz * ca - fx * sa, uz: fx * ca - fz * sa });
          const b = largest(6, clamp(0.36 * FL, 6, 36), (v) => ((pond0.b = v), (pond0.a = 2 * v)));
          if (b < 6) continue;
          pond0.b = b;
          pond0.a = largest(2 * b, 90, (v) => (pond0.a = v));
          const score = (pond0.a * b) / (1 + (off / 36) ** 2);
          if (score > best) (best = score), (pond = { ...pond0 });
        }
      }
    }
  }
  // The rim as a polygon (~2.2 u sides, counter-clockwise in x, z): the ground's hole and the banks' top edge.
  const rim: number[] = [];
  if (pond) {
    const n = Math.max(48, Math.round((2 * Math.PI * Math.hypot(pond.a, pond.b)) / Math.SQRT2 / 2.2));
    for (let i = 0; i < n; i++) rim.push(...rimAt(pond, (i / n) * Math.PI * 2));
  }
  // Spectator dressing (the course's footprint, the flight's included, keeps them clear): pennants on poles lining both
  // sides of the jump on the meadow, from the run-up to the end of the landing, and a banner on two scaffold towers
  // off to the side past the landing's start, facing the flight.
  const flags: number[] = []; // x, z, pole height, colour index
  let banner: { x: number; z: number; ux: number; uz: number; w: number; y0: number; h: number } | null = null;
  if (flight && jump) {
    const g = flight, L = track.length, fr = track.frameAt(jump.s0);
    let wide = 0; // the flight's footprint half-width
    for (let k = 0; k < M; k++) if (SF[k]) wide = Math.max(wide, SE[k]);
    for (let s = jump.s0 - 48, c = 0; s <= jump.s1; s += 12) {
      track.frameAt(s, fr);
      // further out where the deck runs low, so the chase camera never brushes a pennant at its own height
      const k = Math.round((((s % L) + L) % L) / sds) % M, rl = Math.hypot(fr.right.x, fr.right.z) || 1;
      const off = Math.max(SE[k], SF[k] ? wide : 0) + KEEP + 2.5 + 0.6 * clamp(12 - (fr.p.y - groundY), 0, 12);
      for (const side of [-1, 1]) {
        const x = fr.p.x + (fr.right.x / rl) * off * side, z = fr.p.z + (fr.right.z / rl) * off * side;
        if (inPond(x, z, 2.5) || edgeDist(x, z) < KEEP + 1 || !isFree(x, z, 1)) continue;
        flags.push(x, z, 8 + 1.5 * hash3(Math.round(s), side, 61), c++ % 4);
        occupy(x, z, 1.2);
      }
    }
    const f0 = track.frameAt(g.s0 - 6), f1 = track.frameAt(g.s1 + 6), fl = Math.hypot(f1.p.x - f0.p.x, f1.p.z - f0.p.z);
    const fx = (f1.p.x - f0.p.x) / fl, fz = (f1.p.z - f0.p.z) / fl;
    // The banner: 26 u wide, its board 6.5 to 13 u up, off to the side past the landing's start (or as near as is free),
    // facing the middle of the flight.
    const mx = (f0.p.x + f1.p.x) / 2, mz = (f0.p.z + f1.p.z) / 2;
    place: for (const along of [10, 24, 40, -4, 60, -20]) {
      for (const out of [20, 30, 42, 56, 70]) {
        for (const side of [1, -1]) {
          const x0 = f1.p.x + fx * along - fz * (wide + KEEP + out) * side, z0 = f1.p.z + fz * along + fx * (wide + KEEP + out) * side;
          const nl = Math.hypot(mx - x0, mz - z0), nx = (mx - x0) / nl, nz = (mz - z0) / nl; // faces the flight's middle
          const B = { x: x0, z: z0, ux: nz, uz: -nx, w: 26, y0: groundY + 6.5, h: 6.5 }; // u: its reading direction
          const spots: number[] = [];
          for (let e = -14; e <= 14; e += 3.5) spots.push(B.x + B.ux * e, B.z + B.uz * e);
          for (const e of [-11, 11]) spots.push(B.x + B.ux * e - nx * 1.2, B.z + B.uz * e - nz * 1.2); // its towers
          let ok = true;
          for (let i = 0; i < spots.length && ok; i += 2) ok = edgeDist(spots[i], spots[i + 1]) > KEEP + 2 && !inPond(spots[i], spots[i + 1], 3) && isFree(spots[i], spots[i + 1], 2);
          if (!ok) continue;
          banner = B;
          for (let i = 0; i < spots.length; i += 2) occupy(spots[i], spots[i + 1], 2.5);
          for (let e = 8; e < Math.min(40, nl - 10); e += 8) occupy(B.x + nx * e, B.z + nz * e, 6); // nothing grows in front of it
          break place;
        }
      }
    }
  }

  // ---- scatter --------------------------------------------------------------------------------
  const trees: Tree[] = [], rocks: Rock[] = [], bushes: Bush[] = [];
  const tierN = [0, 0, 0];
  const dirt: number[] = []; // x, z, r: bare patches (the start yard, run-off outside tight bends) where nothing grows
  const onDirt = (x: number, z: number) => {
    for (let i = 0; i < dirt.length; i += 3) if (Math.hypot(x - dirt[i], z - dirt[i + 1]) < dirt[i + 2]) return true;
    return false;
  };
  const pt = [0, 0];
  /** A point d u beyond the course's footprint at sample k, on a random side (jittered by +-2 u), into pt. */
  const beside = (k: number, d: number) => {
    const off = (rnd() < 0.5 ? -1 : 1) * (SE[k] + d);
    pt[0] = SX[k] - STZ[k] * off + R(-2, 2);
    pt[1] = SZ[k] + STX[k] * off + R(-2, 2);
    return pt;
  };
  const kAt = (u: number) => Math.min(M - 1, Math.floor(u * M));
  const inDisc = (rMin: number, rMax: number) => {
    const a = rnd() * Math.PI * 2, r = Math.sqrt(R((rMin / rMax) ** 2, 1)) * rMax;
    pt[0] = cx + Math.cos(a) * r;
    pt[1] = cz + Math.sin(a) * r;
    return pt;
  };

  // bare ground: the yard under the start gate, run-off outside the tight road bends
  for (const g of track.tags) {
    if (g.tag !== 'gate') continue;
    for (let s = g.s0; s <= g.s1; s += 6) {
      const f = F[Math.round(s / ds) % N];
      dirt.push(f.p.x + R(-3, 3), f.p.z + R(-3, 3), R(9, 13));
    }
  }
  for (let k = 0; k < M; k += 6) {
    if (SS[k] === 'plastic' || Math.abs(SK[k]) < 1 / 40) continue;
    const off = -Math.sign(SK[k]) * (SE[k] + R(2.5, 5)); // the outside
    dirt.push(SX[k] - STZ[k] * off, SZ[k] + STX[k] * off, R(2.5, 4.5));
  }

  /** Places a tree if the spot is free and clear of the course and its sight lines; returns its tier, or -1. */
  function tryTree(x: number, z: number, kind: Kind, scale: number, nearOk = true) {
    const s = scale * R(0.85, 1.15);
    // [trunk height, trunk radius, canopy radius, canopy height (0 = from the radius)] per kind
    const dims = kind === PINE ? [R(1.2, 2.2), R(0.35, 0.5), R(2.8, 4.2), R(10, 16)]
      : kind === POPLAR ? [R(1.3, 2.2), 0.38, R(1.9, 2.6), R(9, 13)]
      : kind === BLOSSOM ? [R(2.2, 3.2), R(0.32, 0.45), R(2.8, 4), 0]
      : [R(2.5, 4.2), R(0.38, 0.58), R(3.2, 5.4), 0];
    const trunkH = dims[0] * s, trunkR = dims[1] * s, cr = dims[2] * s;
    const ch = dims[3] ? dims[3] * s : cr * R(1.45, 1.9);
    const reach = kind === ROUND || kind === BLOSSOM ? cr * 1.2 : cr;
    const ed = edgeDist(x, z, true);
    if (ed < KEEP + 3 + reach || sightDist(x, z) < reach + 2.5 || inPond(x, z, reach + 3)) return -1;
    const tier = ed < NEAR ? 0 : ed < MID ? 1 : 2;
    if ((!tier && !nearOk) || tierN[tier] >= CAP.trees[tier] || !isFree(x, z, cr * 0.7)) return -1;
    tierN[tier]++;
    const leaf = col(pick(LEAF[kind])).offsetHSL(R(-0.015, 0.015), R(-0.05, 0.05), R(-0.04, 0.04));
    trees.push({ x, z, kind, tier, trunkH, trunkR, cr, ch, rot: R(0, Math.PI * 2), seed: Math.floor(rnd() * 1e9), leaf, bark: col(pick(BARK)) });
    occupy(x, z, cr * 0.7);
    return tier;
  }

  // Groves (each mostly one kind), most of them along the course where the camera passes, bushes round their edges.
  // The course's groves take their stretch of the lap in shuffled order and a share of the near trees each, so the
  // near-tree budget spreads round the whole lap.
  const groves: number[] = [];
  const G1 = M ? Math.round(clamp(track.length / 50, 20, 48)) : 0, G2 = 16, nearEach = Math.ceil(CAP.trees[0] / Math.max(1, G1)) + 1;
  const slot = Array.from({ length: G1 }, (_, i) => i);
  for (let i = G1 - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [slot[i], slot[j]] = [slot[j], slot[i]];
  }
  for (let g = 0; g < G1 + G2; g++) {
    let ok = false;
    for (let a = 0; a < 30 && !ok; a++) {
      if (g < G1) beside(kAt((slot[g] + rnd()) / G1), 16 + expo(30));
      else inDisc(0, worldR);
      ok = edgeDist(pt[0], pt[1]) > 14;
    }
    if (!ok) continue;
    const gx = pt[0], gz = pt[1], far = edgeDist(gx, gz) > MID;
    const mood = rnd(), n = 4 + Math.floor(rnd() * (far ? 14 : 8)), spread = R(8, 18);
    groves.push(gx, gz, spread);
    let placed = 0, near = 0;
    for (let k = 0; k < n * 4 && placed < n; k++) {
      const q = rnd();
      const kind: Kind = mood < 0.38 ? (q < 0.88 ? PINE : ROUND)
        : mood < 0.8 ? (q < 0.72 ? ROUND : q < 0.88 ? POPLAR : q < 0.95 ? PINE : BLOSSOM)
        : (q < 0.4 ? ROUND : q < 0.65 ? POPLAR : q < 0.8 ? BLOSSOM : PINE);
      const tier = tryTree(gx + gauss() * spread, gz + gauss() * spread, kind, far ? 1.25 : 1, near < nearEach);
      if (tier >= 0) placed++;
      if (tier === 0) near++;
    }
  }
  // lone trees in the meadows
  for (let k = 0; k < 70; k++) {
    inDisc(0, worldR);
    const q = rnd();
    tryTree(pt[0], pt[1], q < 0.55 ? ROUND : q < 0.75 ? POPLAR : q < 0.88 ? BLOSSOM : PINE, 1);
  }
  // a looser tree line framing the far meadow
  for (let k = 0; k < 170; k++) {
    inDisc(span / 2 + 110, worldR + 60);
    const q = rnd();
    tryTree(pt[0], pt[1], q < 0.5 ? PINE : q < 0.85 ? ROUND : POPLAR, 1.3);
  }

  function tryBush(x: number, z: number) {
    const r = R(1.1, 2.1);
    if (bushes.length >= CAP.bushes || edgeDist(x, z) < KEEP + r || onDirt(x, z) || inPond(x, z, r + 1.5) || !isFree(x, z, r * 0.8)) return;
    bushes.push({ x, z, r, rot: R(0, Math.PI * 2), seed: Math.floor(rnd() * 1e9), leaf: col(pick(BUSH)).offsetHSL(0, 0, R(-0.03, 0.03)) });
    occupy(x, z, r * 0.8);
  }
  for (let g = 0; g < groves.length; g += 3) {
    if (edgeDist(groves[g], groves[g + 1]) > MID) continue; // too far to see
    const n = 2 + Math.floor(rnd() * 3);
    for (let k = 0; k < n; k++) {
      const a = rnd() * Math.PI * 2, d = groves[g + 2] * R(1.3, 2.1);
      tryBush(groves[g] + Math.cos(a) * d, groves[g + 1] + Math.sin(a) * d);
    }
  }
  for (let k = 0; k < 50 && M; k++) {
    beside(kAt(rnd()), KEEP + 2 + expo(14));
    tryBush(pt[0], pt[1]);
  }

  let fine = 0; // big rocks near the course get the finer shape
  function tryRock(x: number, z: number, r: number, big: boolean) {
    if (rocks.length >= CAP.rocks) return false;
    const ed = edgeDist(x, z);
    if (ed < KEEP + r * 1.2 + (big ? 4 : 0) || (big && sightDist(x, z) < r + 1) || onDirt(x, z) || inPond(x, z, r + 1.5) || !isFree(x, z, r)) return false;
    const f = big && ed < NEAR && fine < 6;
    if (f) fine++;
    rocks.push({ x, z, r, sy: R(0.5, 0.85), sz: R(0.75, 1.15), rot: R(0, Math.PI * 2), seed: Math.floor(rnd() * 1e9), fine: f, col: col(pick(ROCK)).offsetHSL(R(-0.02, 0.02), 0, R(-0.04, 0.04)) });
    occupy(x, z, r);
    return true;
  }
  for (let k = 0; k < 12; k++) {
    inDisc(40, worldR * 0.85);
    tryRock(pt[0], pt[1], R(2.6, 6), true);
  }
  for (let k = 0; k < 16; k++) {
    if (M && k % 2) beside(kAt(rnd()), KEEP + 4 + expo(25));
    else inDisc(0, worldR * 0.75);
    const x = pt[0], z = pt[1], n = 2 + Math.floor(rnd() * 4);
    for (let i = 0; i < n; i++) tryRock(x + gauss() * 3.5, z + gauss() * 3.5, R(0.5, 1.9), rnd() < 0.3);
  }
  for (let k = 0; k < 50; k++) {
    if (M && k % 2) beside(kAt(rnd()), KEEP + 1 + expo(20));
    else inDisc(0, worldR * 0.7);
    tryRock(pt[0], pt[1], R(0.4, 1.3), false);
  }

  // Flowers and tufts gather along the course (where they are seen), just beyond its footprint, in patches and clumps.
  const flowers: number[] = []; // x, z, colour index, size
  const tufts: number[] = []; // x, z, scale
  for (let p = 0; p < 46 && M; p++) {
    beside(kAt((p + rnd()) / 46), 3 + expo(12));
    const px = pt[0], pz = pt[1], main = Math.floor(rnd() * FLOWER.length), n = 8 + Math.floor(rnd() * 14), pr = R(2.5, 7);
    for (let i = 0; i < n && flowers.length < CAP.flowers * 4; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * pr, x = px + Math.cos(a) * r, z = pz + Math.sin(a) * r;
      const sz = R(0.8, 1.2), c = rnd() < 0.72 ? main : Math.floor(rnd() * 2);
      if (edgeDist(x, z) < 2.5 || onDirt(x, z) || inPond(x, z, 1.5)) continue;
      flowers.push(x, z, c, sz);
    }
  }
  const tuft = (x: number, z: number, s: number, minEdge: number) => {
    if (tufts.length < CAP.tufts * 3 && edgeDist(x, z) > minEdge && !onDirt(x, z) && !inPond(x, z, 1)) tufts.push(x, z, s);
  };
  for (let c = 0; c < 190 && M; c++) {
    beside(kAt((c + rnd()) / 190), 1.5 + expo(9));
    const px = pt[0], pz = pt[1], n = 3 + Math.floor(rnd() * 6), pr = R(1.2, 3.5);
    for (let i = 0; i < n; i++) {
      const a = rnd() * Math.PI * 2, r = Math.sqrt(rnd()) * pr;
      tuft(px + Math.cos(a) * r, pz + Math.sin(a) * r, R(0.7, 1.3), 1.5);
    }
  }
  for (const t of trees) {
    if (t.tier || rnd() < 0.4) continue;
    for (let i = 0; i < 3; i++) {
      const a = rnd() * Math.PI * 2, r = t.trunkR + R(0.4, 2.6);
      tuft(t.x + Math.cos(a) * r, t.z + Math.sin(a) * r, R(0.8, 1.4), 1.5);
    }
  }
  for (const r of rocks) {
    if (edgeDist(r.x, r.z) > NEAR) continue;
    for (let i = 0; i < 3; i++) {
      const a = rnd() * Math.PI * 2, d = r.r * R(0.9, 1.4);
      tuft(r.x + Math.cos(a) * d, r.z + Math.sin(a) * d, R(0.7, 1.2), 1.5);
    }
  }

  // ---- ground map: sun visibility (r), sky visibility (g), dirt (b) ----------------------------
  const macro = canvas(MN), gm = macro.getContext('2d')!;
  gm.fillStyle = '#ffff00';
  gm.fillRect(0, 0, MN, MN);
  const shadow = canvas(MN), gsh = shadow.getContext('2d')!;
  const occl = canvas(MN), gao = occl.getContext('2d')!;
  const SH = '20,255,255', AO = '255,105,255', DIRT = '0,0,255';
  const sunOff = 1 / Math.tan(el); // shadow length per unit height
  const blob = (g: CanvasRenderingContext2D, x: number, z: number, r: number, rgb: string, a: number, stretch = 1) => {
    const pr = Math.max(r * mk, 0.8);
    g.save();
    g.translate((x - mx0) * mk, (z - mz0) * mk);
    if (stretch !== 1) {
      g.rotate(Math.atan2(sunH.y, sunH.x));
      g.scale(stretch, 1);
    }
    const gr = g.createRadialGradient(0, 0, 0, 0, 0, pr);
    gr.addColorStop(0, `rgba(${rgb},${a})`);
    gr.addColorStop(0.5, `rgba(${rgb},${a * 0.8})`);
    gr.addColorStop(1, `rgba(${rgb},0)`);
    g.fillStyle = gr;
    g.beginPath();
    g.arc(0, 0, pr, 0, Math.PI * 2);
    g.fill();
    g.restore();
  };
  /** Shadow of a disc of radius r at height h above the ground point (x, z). */
  const castDisc = (x: number, z: number, h: number, r: number, a = 0.9) =>
    blob(gsh, x - sunH.x * h * sunOff, z - sunH.y * h * sunOff, r, SH, a, 1 / Math.sin(el));
  // Bare and worn ground: the start yard and the run-off (blobs), then bands round the course's footprint, rasterized
  // into masks so they follow any course: worn grass beside the roads (dirt thrown up beside the dirt, a little where
  // the plastic lies on the meadow; half resolution, scaled up soft), and a touch of occlusion where the banks meet the
  // meadow. The inner parts of the bands lie under the track's own meshes.
  gm.globalCompositeOperation = 'lighter';
  for (let i = 0; i < dirt.length; i += 3) blob(gm, dirt[i], dirt[i + 1], dirt[i + 2] * 1.25, DIRT, dirt[i + 2] > 6 ? 0.55 : 0.3);
  /** The pond's rim as a closed canvas path (map pixels). */
  const rimPath = (g: CanvasRenderingContext2D) => {
    g.beginPath();
    for (let i = 0; i < rim.length; i += 2) g.lineTo((rim[i] - mx0) * mk, (rim[i + 1] - mz0) * mk);
    g.closePath();
  };
  if (rim.length) { // a trodden, muddy shore round the pond
    rimPath(gm);
    gm.lineJoin = 'round';
    gm.strokeStyle = `rgba(${DIRT},0.3)`;
    gm.lineWidth = 4.5 * mk;
    gm.stroke();
  }
  {
    const WN = MN >> 1, kw = WN / MS, wear = new Uint8Array(WN * WN), toe = new Uint8Array(MN * MN);
    const band = (mask: Uint8Array, n: number, k: number, a: number, b: number, out: number, val: number) => {
      const oa = SE[a] + out, ob = SE[b] + out;
      const lax = SX[a] + STZ[a] * oa - mx0, laz = SZ[a] - STX[a] * oa - mz0, rax = SX[a] - STZ[a] * oa - mx0, raz = SZ[a] + STX[a] * oa - mz0;
      const lbx = SX[b] + STZ[b] * ob - mx0, lbz = SZ[b] - STX[b] * ob - mz0, rbx = SX[b] - STZ[b] * ob - mx0, rbz = SZ[b] + STX[b] * ob - mz0;
      fillTri(mask, n, k, lax, laz, rax, raz, rbx, rbz, val);
      fillTri(mask, n, k, lax, laz, rbx, rbz, lbx, lbz, val);
    };
    for (let a = 0; a < M; a++) {
      const b = (a + 1) % M, surf = SS[a];
      if (surf === 'plastic' && Math.min(SY[a], SY[b]) - groundY > 1.6) continue; // up on its supports
      band(wear, WN, kw, a, b, 2.5, surf === 'dirt' ? 150 : surf === 'asphalt' ? 64 : 52);
      band(toe, MN, mk, a, b, 0.9, 1);
    }
    const wc = canvas(WN), gwc = wc.getContext('2d')!, img = gwc.createImageData(WN, WN), wd = img.data;
    for (let i = 0; i < WN * WN; i++) if (wear[i]) (wd[4 * i + 2] = 255), (wd[4 * i + 3] = wear[i]);
    gwc.putImageData(img, 0, 0);
    gm.drawImage(wc, 0, 0, MN, MN);
    const tc = canvas(MN), gtc = tc.getContext('2d')!, ti = gtc.createImageData(MN, MN), td = ti.data;
    for (let i = 0; i < MN * MN; i++) if (toe[i]) (td[4 * i] = td[4 * i + 2] = 255), (td[4 * i + 1] = 105), (td[4 * i + 3] = 46);
    gtc.putImageData(ti, 0, 0);
    gao.drawImage(tc, 0, 0);
  }
  gm.globalCompositeOperation = 'source-over';
  // the track's own shadows (2x coverage averaged down) and occlusion (quarter resolution, scaled up: soft)
  {
    const img = gsh.createImageData(MN, MN), px = img.data;
    for (let y = 0; y < MN; y++) {
      for (let x = 0; x < MN; x++) {
        const i = 2 * y * SUN_N + 2 * x, cov = sunMask[i] + sunMask[i + 1] + sunMask[i + SUN_N] + sunMask[i + SUN_N + 1];
        if (!cov) continue;
        const o = 4 * (y * MN + x);
        px[o] = 20, px[o + 1] = px[o + 2] = 255, px[o + 3] = 51 * cov; // 0.8 at full cover
      }
    }
    const cast = canvas(MN);
    cast.getContext('2d')!.putImageData(img, 0, 0);
    gsh.drawImage(cast, 0, 0);
    const soft = canvas(SKY_N), gso = soft.getContext('2d')!, sky = gso.createImageData(SKY_N, SKY_N), sd = sky.data;
    for (let i = 0; i < SKY_N * SKY_N; i++) {
      const a = Math.max(lowMask[i] * 0.42, highMask[i] * 0.18);
      if (a) (sd[4 * i] = sd[4 * i + 2] = 255), (sd[4 * i + 1] = 105), (sd[4 * i + 3] = 255 * a);
    }
    gso.putImageData(sky, 0, 0);
    gao.drawImage(soft, 0, 0, MN, MN);
  }
  for (let i = 0; i < feet.length; i += 3) blob(gao, feet[i], feet[i + 1], feet[i + 2] * 1.6 + 0.6, AO, 0.45);
  for (const t of trees) {
    blob(gao, t.x, t.z, t.cr * 1.35, AO, 0.75);
    castDisc(t.x, t.z, t.trunkH * 0.5, t.trunkR * 1.6, 0.7);
    if (t.kind === PINE) {
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.18, t.cr * 0.9);
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.42, t.cr * 0.62);
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.66, t.cr * 0.36);
    } else if (t.kind === POPLAR) {
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.28, t.cr * 0.85);
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.52, t.cr);
      castDisc(t.x, t.z, t.trunkH + t.ch * 0.76, t.cr * 0.75);
    } else castDisc(t.x, t.z, t.trunkH + t.ch * 0.5, t.cr * 1.12);
  }
  for (const r of rocks) {
    blob(gao, r.x, r.z, r.r * 1.7, AO, 0.6);
    castDisc(r.x, r.z, r.r * r.sy * 0.4, r.r * 0.9, 0.6);
  }
  for (const b of bushes) {
    blob(gao, b.x, b.z, b.r * 1.8, AO, 0.6);
    castDisc(b.x, b.z, b.r * 0.4, b.r, 0.6);
  }
  if (rim.length) { // the banks shade the meadow's edge a little
    rimPath(gao);
    gao.lineJoin = 'round';
    gao.strokeStyle = `rgba(${AO},0.3)`;
    gao.lineWidth = 3 * mk;
    gao.stroke();
  }
  gm.globalCompositeOperation = 'multiply';
  gm.drawImage(occl, 0, 0);
  gm.drawImage(shadow, 0, 0);
  gm.globalCompositeOperation = 'source-over';
  gm.strokeStyle = '#ffff00'; // neutral rim: the map clamps to its edge texels beyond MS
  gm.lineWidth = 4;
  gm.strokeRect(0, 0, MN, MN);
  const macroTex = new THREE.CanvasTexture(macro);
  macroTex.flipY = false;
  macroTex.anisotropy = Math.min(4, aniso);

  const grassTex = grassTexture(rnd, aniso);
  const noiseTex = noiseTexture();
  const groundMat = new THREE.MeshLambertMaterial({ color: 0xffffff });
  groundMat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, {
      uGrass: { value: grassTex },
      uNoise: { value: noiseTex },
      uMacro: { value: macroTex },
      uMacroXf: { value: new THREE.Vector4(mx0, mz0, 1 / MS, 1 / MS) },
      uLush: { value: new THREE.Color(0.95, 1.08, 0.82) }, // multipliers on the grass texture
      uDry: { value: new THREE.Color(1.3, 1.12, 0.62) },
      uDirt: { value: col('#c8975c') },
    });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying vec3 vWPos;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvWPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', `#include <common>
uniform sampler2D uGrass, uNoise, uMacro;
uniform vec4 uMacroXf;
uniform vec3 uLush, uDry, uDirt;
varying vec3 vWPos;`)
      .replace('#include <map_fragment>', /* glsl */ `
vec2 wp = vWPos.xz;
vec4 mac = texture2D( uMacro, ( wp - uMacroXf.xy ) * uMacroXf.zw );
vec3 grass = texture2D( uGrass, wp * ${(1 / GRASS_TILE).toFixed(5)} ).rgb;
vec4 n1 = texture2D( uNoise, wp * 0.0058 );
vec4 n2 = texture2D( uNoise, vec2( 0.8 * wp.x - 0.6 * wp.y, 0.6 * wp.x + 0.8 * wp.y ) * 0.0091 + 0.37 );
float patchv = 0.5 * ( n1.r + n2.g );
vec3 tint = mix( uLush, uDry, smoothstep( 0.45, 0.75, patchv ) ) * ( 0.8 + 0.36 * smoothstep( 0.15, 0.85, n2.r ) );
tint *= 1.0 - 0.14 * smoothstep( 0.5, 0.15, n1.g ); // darker, lusher hollows
float grain = texture2D( uNoise, wp * 0.29 ).b;
float worn = mac.b * ( 0.55 + 0.9 * texture2D( uNoise, wp * 0.047 ).r ); // worn in patches, not a smooth smear
vec3 dirt = uDirt * ( 0.78 + 0.44 * grain );
diffuseColor.rgb *= mix( grass * tint, dirt, smoothstep( 0.08, 0.8, worn ) );`)
      .replace('#include <lights_fragment_end>', `#include <lights_fragment_end>
reflectedLight.directDiffuse *= mac.r;
reflectedLight.indirectDiffuse *= mac.g * ( 0.7 + 0.3 * mac.r ); // a caster hides some sky too: shadows read on a sunny day`)
      .replace('#include <fog_fragment>', radialFog());
  };
  groundMat.customProgramCacheKey = () => 'world-outdoor-ground';
  const GS = Math.max(3200, span + 1400); // past the hills' foot (430 u) wherever the car goes
  // One square, with the pond cut out where there is one (its rim is the banks' top edge: no seam, no sliver).
  const groundShape = new THREE.Shape([[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => new THREE.Vector2((a * GS) / 2, (b * GS) / 2)));
  const hole: THREE.Vector2[] = [];
  for (let i = 0; i < rim.length; i += 2) hole.push(new THREE.Vector2(rim[i] - cx, cz - rim[i + 1])); // shape y = -z
  if (hole.length) groundShape.holes.push(new THREE.Path(hole));
  const ground = new THREE.Mesh(new THREE.ShapeGeometry(groundShape).rotateX(-Math.PI / 2), groundMat);
  ground.position.set(cx, groundY, cz);
  ground.name = 'ground';
  root.add(ground);

  // ---- scenery: one merged, flat-shaded mesh ---------------------------------------------------
  // Detail by distance from the course: canopies ICO1 near, ICO0 (+ a lump) further; pines lose tiers, trunks sides.
  const ICO0 = tplOf(new THREE.IcosahedronGeometry(1, 0));
  const ICO1 = tplOf(new THREE.IcosahedronGeometry(1, 1));
  const PYR = tplOf(new THREE.ConeGeometry(1, 1, 4, 1, true).translate(0, 0.5, 0)); // flower heads (seen from above)
  const TRUNK = [5, 4, 3].map((n) => tplOf(new THREE.CylinderGeometry(0.62, 1, 1, n, 1, true).translate(0, 0.5, 0)));
  const CONE = [7, 6, 6].map((n) => tplOf(new THREE.ConeGeometry(1, 1, n, 1, true).translate(0, 0.5, 0))); // open: the base hides in the tier below
  const m = new Mesher();
  for (const t of trees) {
    m.item(t.x, t.z);
    const by = groundY - 0.3;
    const into = t.ch * (t.kind === PINE ? 0.55 : 0.3); // the trunk runs up into the canopy
    m.add(TRUNK[t.tier], t.x, by, t.z, t.trunkR, t.trunkH + 0.3 + into, t.trunkR, t.rot, 0, 0, (_x, ly) => {
      C.copy(t.bark).multiplyScalar(0.55 + 0.55 * ly);
      return 0.12 * ly * ly;
    });
    const leaf = (base: number, span2: number, swayBase: number): Paint => (_x, ly, _z, k) => {
      const v = 0.5 + 0.5 * ly;
      C.copy(t.leaf).multiplyScalar(base + span2 * v + 0.12 * (hash3(k, t.seed, 5) - 0.5));
      return swayBase + (1 - swayBase) * v;
    };
    const top = by + 0.3 + t.trunkH;
    if (t.kind === PINE) {
      const tiers = PINE_TIERS[t.tier];
      tiers.forEach(([b0, h, r], i) => {
        const v = tiers.length > 1 ? i / (tiers.length - 1) : 0.5;
        m.add(CONE[t.tier], t.x, top + b0 * t.ch, t.z, t.cr * r, t.ch * h, t.cr * r, t.rot + i * 1.3, 0.07, t.seed + i, leaf(0.5 + v * 0.16, 0.5, 0.25 + v * 0.5));
      });
    } else if (t.kind === POPLAR) {
      m.add(t.tier ? ICO0 : ICO1, t.x, top + t.ch * 0.5, t.z, t.cr, t.ch * 0.5, t.cr, t.rot, 0.12, t.seed, leaf(0.55, 0.55, 0.3));
    } else {
      const cy = top + t.ch * 0.5, paint = leaf(0.58, 0.55, 0.35);
      m.add(t.tier ? ICO0 : ICO1, t.x, cy, t.z, t.cr, t.ch * 0.5, t.cr, t.rot, 0.15, t.seed, paint);
      if (t.tier < 2) { // a lump on the canopy
        const a = t.rot + 0.6, rr = t.cr * R(0.5, 0.62);
        m.add(ICO0, t.x + Math.cos(a) * t.cr * 0.62, cy - t.ch * R(0.05, 0.18), t.z + Math.sin(a) * t.cr * 0.62, rr, rr * 0.9, rr, a, 0.2, t.seed + 7, paint);
      }
    }
  }
  const MOSS = col('#6f8f3a');
  for (const r of rocks) {
    m.item(r.x, r.z);
    m.add(r.fine ? ICO1 : ICO0, r.x, groundY - r.r * r.sy * 0.3, r.z, r.r, r.r * r.sy, r.r * r.sz, r.rot, r.fine ? 0.22 : 0.3, r.seed, (_x, ly, _z, k) => {
      C.copy(r.col).multiplyScalar(0.62 + 0.42 * (0.5 + 0.5 * ly) + 0.14 * (hash3(k, r.seed, 9) - 0.5));
      if (ly > 0.5 && hash3(k, r.seed, 4) < 0.65) C.lerp(MOSS, 0.45);
      return 0;
    });
  }
  for (const b of bushes) {
    m.item(b.x, b.z);
    const paint: Paint = (_x, ly, _z, k) => {
      const v = 0.5 + 0.5 * ly;
      C.copy(b.leaf).multiplyScalar(0.55 + 0.55 * v + 0.12 * (hash3(k, b.seed, 5) - 0.5));
      return 0.15 + 0.3 * v;
    };
    m.add(ICO0, b.x, groundY + b.r * 0.3, b.z, b.r, b.r * 0.72, b.r, b.rot, 0.2, b.seed, paint);
    const a = b.rot, rr = b.r * 0.65;
    m.add(ICO0, b.x + Math.cos(a) * b.r * 0.75, groundY + rr * 0.25, b.z + Math.sin(a) * b.r * 0.75, rr, rr * 0.75, rr, a, 0.22, b.seed + 1, paint);
  }
  const stemC = col('#4f8a2e'), stemTip = col('#5f9a36');
  const flowerC = FLOWER.map(col);
  for (let i = 0; i < flowers.length; i += 4) {
    const x = flowers[i], z = flowers[i + 1], s = flowers[i + 3], h = 0.32 + 0.22 * s, y = groundY;
    const fc = flowerC[flowers[i + 2]];
    m.item(x, z);
    m.blade(x - 0.03, y, z, x + 0.03, y, z, x, y + h, z, stemC, stemTip, 0.5);
    m.add(PYR, x, y + h - 0.05 * s, z, 0.17 * s, 0.14 * s, 0.17 * s, i, 0, 0, (_x, ly) => {
      C.copy(fc).multiplyScalar(0.85 + 0.25 * ly);
      return 0.5;
    });
  }
  const tuftBase = col('#356a22'), tuftTips = ['#8cc455', '#9fce5a', '#7db84a', '#b4d468'].map(col);
  for (let i = 0; i < tufts.length; i += 3) {
    const x = tufts[i], z = tufts[i + 1], s = tufts[i + 2], y = groundY;
    const tip = tuftTips[Math.floor(hash3(i, 3, 1) * tuftTips.length) % tuftTips.length];
    const a0 = hash3(i, 1, 1) * Math.PI * 2;
    m.item(x, z);
    for (let k = 0; k < 3; k++) {
      const a = a0 + (k / 3) * Math.PI * 2 + hash3(i, k, 2) * 0.8, lean = 0.25 + 0.3 * hash3(i, k, 3);
      const h = s * (0.55 + 0.45 * hash3(i, k, 4)), w = 0.1 * s;
      const ca = Math.cos(a), sa = Math.sin(a);
      const bx = x + ca * 0.08, bz = z + sa * 0.08;
      m.blade(bx - sa * w, y, bz + ca * w, bx + sa * w, y, bz - ca * w, bx + ca * lean * h, y + h, bz + sa * lean * h, tuftBase, tip, 1);
    }
  }

  // ---- the pond: banks, reeds, lily pads and stones in the scenery; the water is a mesh of its own --------------
  // The bank from the rim inward: the meadow's grassy lip drops a little, a steep face of earth (or rock) falls to a
  // gentler foot of mud just above the waterline, and on under the water, which hides the rest. Its width, rockiness
  // and grassiness wander round the rim, and the face is roughed up (no two stretches alike).
  let water: THREE.Mesh | null = null;
  if (pond) {
    const P = pond, n = rim.length / 2, waterY = groundY - POND_DEPTH;
    const prnd = rngOf(SEED ^ 0x2545f491), PR = (a: number, b: number) => a + (b - a) * prnd();
    const NX = new Float32Array(n), NZ = new Float32Array(n), BW = new Float32Array(n), RK = new Float32Array(n), GR = new Float32Array(n);
    // the bank's rings per rim point: u inward from the rim and height above the water
    const RINGS = 5, OFF = new Float32Array(n * RINGS), HY = new Float32Array(n * RINGS);
    let area = 0; // the rim's winding: the inside is to the left of travel when it is counter-clockwise (area > 0)
    for (let i = 0; i < n; i++) area += rim[2 * i] * rim[(2 * i + 3) % (2 * n)] - rim[(2 * i + 2) % (2 * n)] * rim[2 * i + 1];
    const inward = area > 0 ? 1 : -1;
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n, tx = rim[2 * b] - rim[2 * a], tz = rim[2 * b + 1] - rim[2 * a + 1], tl = Math.hypot(tx, tz) || 1;
      NX[i] = (-tz / tl) * inward;
      NZ[i] = (tx / tl) * inward;
      BW[i] = Math.min(0.2 * P.b, 1.6 + 2.6 * vnoise((i / n) * 7, 0.5, 71, 7)); // the bank's width below the lip (u)
      RK[i] = vnoise((i / n) * 9, 3.5, 83, 9); // rockiness
      GR[i] = vnoise((i / n) * 5, 6.5, 97, 5); // grass growing down to the water
      const steep = 0.3 + 0.25 * RK[i]; // where the face ends (fraction of the bank)
      const o = [0, 0.4, 0.4 + steep * BW[i] + 0.3 * (hash3(i, 1, 43) - 0.5), 0.4 + BW[i], 1.8 + BW[i]];
      const y = [POND_DEPTH, POND_DEPTH - 0.32 - 0.1 * hash3(i, 2, 43), 0.55 * POND_DEPTH + 0.35 * (hash3(i, 3, 43) - 0.5), 0.22, -0.9];
      for (let j = 0; j < RINGS; j++) (OFF[i * RINGS + j] = o[j]), (HY[i * RINGS + j] = y[j]);
    }
    // Round the pond's ends the rings would cross: a point's rings shrink to fit the rim's radius of curvature there
    // (the least over its neighbours), so the bank just steepens.
    const RC = new Float32Array(n), SC = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = (i + n - 1) % n, b = (i + 1) % n;
      const e1x = rim[2 * i] - rim[2 * a], e1z = rim[2 * i + 1] - rim[2 * a + 1], e2x = rim[2 * b] - rim[2 * i], e2z = rim[2 * b + 1] - rim[2 * i + 1];
      const turn = Math.atan2(e1x * e2z - e1z * e2x, e1x * e2x + e1z * e2z) * inward; // > 0 where the rim curves round the water
      RC[i] = turn > 1e-4 ? (Math.hypot(e1x, e1z) + Math.hypot(e2x, e2z)) / 2 / turn : Infinity;
    }
    for (let i = 0; i < n; i++) {
      let r = Infinity;
      for (let d = -4; d <= 4; d++) r = Math.min(r, RC[(i + d + n) % n]);
      SC[i] = Math.min(1, (0.85 * r) / OFF[i * RINGS + RINGS - 1]);
      for (let j = 0; j < RINGS; j++) OFF[i * RINGS + j] *= SC[i];
    }
    const lip = col('#5f9a3b'), earth = col('#6f7436'), mud = col('#5b4a33'), deep = col('#3a3226'), stone = col('#8f8a80'), wet = col('#66625b');
    const c = new THREE.Color(), SEG = 12;
    for (let i0 = 0; i0 < n; i0 += SEG) { // in arcs, so the chunks can share it out
      const i1 = Math.min(i0 + SEG, n), im = (i0 + i1) >> 1, vs: number[] = [];
      m.item(rim[2 * im], rim[2 * im + 1]);
      for (let i = i0; i <= i1; i++) {
        const k = i % n, rock = smooth(0.5, 0.68, RK[k]), green = smooth(0.5, 0.68, GR[k]) * (1 - rock);
        for (let j = 0; j < RINGS; j++) {
          if (j === 0) c.copy(lip);
          else if (j === 1) c.copy(earth).lerp(lip, green);
          else if (j === 2) c.copy(earth).lerp(stone, rock).lerp(lip, green * 0.7);
          else if (j === 3) c.copy(mud).lerp(wet, rock).lerp(earth, green * 0.6);
          else c.copy(deep);
          c.multiplyScalar(0.9 + 0.2 * hash3(k, j, 41));
          const o = OFF[k * RINGS + j];
          vs.push(m.vert(rim[2 * k] + NX[k] * o, waterY + HY[k * RINGS + j], rim[2 * k + 1] + NZ[k] * o, c));
        }
      }
      for (let i = 0; i < i1 - i0; i++) {
        for (let j = 0; j < RINGS - 1; j++) {
          const a = vs[RINGS * i + j], b = vs[RINGS * i + j + 1], cc = vs[RINGS * (i + 1) + j + 1], d = vs[RINGS * (i + 1) + j];
          m.up(a, b, cc);
          m.up(a, cc, d);
        }
      }
    }
    /** Height of the bank above the water at u inward from rim point k. */
    const bankY = (k: number, o: number) => {
      for (let j = 1; j < RINGS; j++) {
        const o0 = OFF[k * RINGS + j - 1], o1 = OFF[k * RINGS + j];
        if (o <= o1) return HY[k * RINGS + j - 1] + ((HY[k * RINGS + j] - HY[k * RINGS + j - 1]) * (o - o0)) / Math.max(1e-3, o1 - o0);
      }
      return HY[k * RINGS + RINGS - 1];
    };
    const rockPaint = (base: THREE.Color, seed: number): Paint => (_x, ly, _z, k) => {
      C.copy(base).multiplyScalar(0.62 + 0.42 * (0.5 + 0.5 * ly) + 0.14 * (hash3(k, seed, 9) - 0.5));
      if (ly > 0.5 && hash3(k, seed, 4) < 0.5) C.lerp(MOSS, 0.4);
      return 0;
    };
    // Stones on the rocky stretches of the bank, and a few boulders out in the water.
    for (let i = 0; i < n; i += 2) {
      if (prnd() > smooth(0.35, 0.65, RK[i]) * 0.75) continue;
      const r = PR(0.5, 1.6), o = (0.4 + BW[i] * PR(0.2, 1.1)) * SC[i], sy = PR(0.55, 0.85), seed = Math.floor(prnd() * 1e9);
      const x = rim[2 * i] + NX[i] * o, z = rim[2 * i + 1] + NZ[i] * o;
      m.item(x, z);
      m.add(ICO0, x, waterY + bankY(i, o) - r * sy * 0.25, z, r, r * sy, r * PR(0.8, 1.2), PR(0, 6.3), 0.3, seed, rockPaint(col(ROCK[seed % ROCK.length]), seed));
    }
    for (let q = 0, tries = 0; q < 3 && tries < 30; tries++) {
      const k = Math.floor(prnd() * n), o = (0.4 + BW[k]) * SC[k] + PR(3, 9), r = PR(1.1, 2.1), seed = Math.floor(prnd() * 1e9);
      const x = rim[2 * k] + NX[k] * o, z = rim[2 * k + 1] + NZ[k] * o;
      if (!inPond(x, z, -(BW[k] + 3))) continue;
      m.item(x, z);
      m.add(ICO0, x, waterY - r * 0.3, z, r, r * PR(0.6, 0.8), r * PR(0.8, 1.2), PR(0, 6.3), 0.28, seed, rockPaint(col(ROCK[seed % ROCK.length]), seed));
      q++;
    }
    // Reeds in clumps along the shore, standing in the shallows; some carry a cattail.
    const reed = col('#4d7a2c'), reedTip = col('#a9c25e'), cattail = col('#5e3b22'), HEAD = tplOf(new THREE.OctahedronGeometry(1, 0));
    for (let q = 5 + Math.floor(prnd() * 4); q > 0; q--) {
      const i0 = Math.floor(prnd() * n), len = 5 + Math.floor(prnd() * 10);
      m.item(rim[2 * i0], rim[2 * i0 + 1]);
      for (let t = 0; t < len; t++) {
        const k = (i0 + t) % n, tall = 1 - 0.6 * Math.abs(t / len - 0.5);
        for (let e = 0; e < 4; e++) {
          const o = (0.4 + BW[k] + PR(-0.3, 1.4)) * SC[k], along = PR(-1.3, 1.3), h = PR(1.6, 3.2) * tall, a = PR(0, Math.PI * 2), lean = PR(0.04, 0.2);
          const x = rim[2 * k] + NX[k] * o - NZ[k] * along, z = rim[2 * k + 1] + NZ[k] * o + NX[k] * along, ca = Math.cos(a), sa = Math.sin(a), w = 0.09;
          m.blade(x - sa * w, waterY - 0.25, z + ca * w, x + sa * w, waterY - 0.25, z - ca * w, x + ca * lean * h, waterY + h, z + sa * lean * h, reed, reedTip, 0.9);
          if (prnd() < 0.3) m.add(HEAD, x + ca * lean * h * 0.8, waterY + h * 0.8, z + sa * lean * h * 0.8, 0.13, 0.36, 0.13, a, 0, 0, () => (C.copy(cattail), 0.72));
        }
      }
    }
    // Lily pads (a few in bloom) in sheltered patches near the shore.
    const PAD = tplOf(new THREE.CircleGeometry(1, 7).rotateX(-Math.PI / 2));
    const padC = ['#3f7f32', '#4c8c36', '#5a9a3c'].map(col), bloom = ['#f6f1ea', '#f7a8c8'].map(col);
    for (let q = 0; q < 3; q++) {
      const k = Math.floor(prnd() * n), o = (0.4 + BW[k]) * SC[k] + PR(2, 6), px = rim[2 * k] + NX[k] * o, pz = rim[2 * k + 1] + NZ[k] * o;
      m.item(px, pz);
      for (let e = 4 + Math.floor(prnd() * 6); e > 0; e--) {
        const x = px + PR(-3, 3), z = pz + PR(-3, 3), r = PR(0.45, 0.9), pc = padC[e % 3], bc = bloom[e % 2], flower = prnd() < 0.25;
        if (!inPond(x, z, -(BW[k] + 1.4))) continue; // open water only
        m.add(PAD, x, waterY + 0.03, z, r, 1, r, PR(0, 6.3), 0.12, e, () => (C.copy(pc), 0.04));
        if (flower) m.add(PYR, x + r * 0.2, waterY + 0.04, z, 0.2, 0.16, 0.2, e, 0, 0, (_x, ly) => (C.copy(bc).multiplyScalar(0.85 + 0.25 * ly), 0.04));
      }
    }

    // The water: rings from the shore (under the bank's foot) in to the middle, aDepth 0 -> 1 for the shading. The
    // inner rings are the shore's, shrunk toward the middle before the bend (so they nest).
    const FR = [1, 0.84, 0.6, 0.32], DP = [0, 0.3, 0.65, 0.92], wp: number[] = [], wd: number[] = [], wi: number[] = [];
    for (let r = 0; r < FR.length; r++) {
      for (let i = 0; i < n; i++) {
        const o = (0.55 + BW[i]) * SC[i], dx = rim[2 * i] + NX[i] * o - P.x, dz = rim[2 * i + 1] + NZ[i] * o - P.z;
        const lx = (dx * P.ux + dz * P.uz) * FR[r], bent = (P.bend * lx * lx) / P.a;
        const lz = (dz * P.ux - dx * P.uz - (P.bend * lx * lx) / (P.a * FR[r] * FR[r])) * FR[r] + bent;
        wp.push(P.x + P.ux * lx - P.uz * lz, waterY, P.z + P.uz * lx + P.ux * lz);
        wd.push(DP[r]);
      }
    }
    wp.push(P.x, waterY, P.z);
    wd.push(1);
    const upTri = (a: number, b: number, q: number) => {
      const ux = wp[3 * b] - wp[3 * a], uz = wp[3 * b + 2] - wp[3 * a + 2], vx = wp[3 * q] - wp[3 * a], vz = wp[3 * q + 2] - wp[3 * a + 2];
      if (uz * vx - ux * vz >= 0) wi.push(a, b, q);
      else wi.push(a, q, b);
    };
    for (let r = 0; r < FR.length; r++) {
      for (let i = 0; i < n; i++) {
        const a = r * n + i, b = r * n + ((i + 1) % n);
        if (r + 1 === FR.length) upTri(a, b, FR.length * n);
        else (upTri(a, b, b + n), upTri(a, b + n, a + n));
      }
    }
    const wg = new THREE.BufferGeometry();
    wg.setAttribute('position', new THREE.Float32BufferAttribute(wp, 3));
    wg.setAttribute('aDepth', new THREE.Float32BufferAttribute(wd, 1));
    wg.setIndex(wi);
    wg.computeBoundingSphere();
    const waterMat = new THREE.ShaderMaterial({
      uniforms: {
        ...THREE.UniformsUtils.clone(THREE.UniformsLib.fog),
        uTime, uNoise: { value: noiseTex }, uSunDir: { value: sunDir },
        uShallow: { value: col('#4f8a7c') }, uDeep: { value: col('#174a63') },
        uSkyLo: { value: col(LOOK.horizon) }, uSkyHi: { value: col(LOOK.sky) }, uSun: { value: col(LOOK.glow) },
      },
      vertexShader: /* glsl */ `
attribute float aDepth;
varying float vDepth;
varying vec3 vWPos, vViewPosition;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vWPos = wp.xyz;
  vDepth = aDepth;
  vec4 mv = viewMatrix * wp;
  vViewPosition = -mv.xyz;
  gl_Position = projectionMatrix * mv;
}`,
      fragmentShader: /* glsl */ `
uniform float uTime;
uniform sampler2D uNoise;
uniform vec3 uSunDir, uShallow, uDeep, uSkyLo, uSkyHi, uSun;
uniform vec3 fogColor;
uniform float fogNear, fogFar;
varying float vDepth;
varying vec3 vWPos, vViewPosition;
// ripples: two drifting layers of the meadow's soft noise
float ripple( vec2 p ) {
  return texture2D( uNoise, p * 0.09 + uTime * vec2( 0.011, 0.006 ) ).r + 0.55 * texture2D( uNoise, p * 0.21 + uTime * vec2( -0.008, 0.013 ) ).g;
}
void main() {
  vec2 p = vWPos.xz;
  const float e = 0.3;
  vec3 n = normalize( vec3( ripple( p - vec2( e, 0.0 ) ) - ripple( p + vec2( e, 0.0 ) ), 6.0 * e, ripple( p - vec2( 0.0, e ) ) - ripple( p + vec2( 0.0, e ) ) ) );
  vec3 v = normalize( cameraPosition - vWPos ), r = reflect( -v, n );
  float fres = 0.03 + 0.97 * pow( 1.0 - max( dot( n, v ), 0.0 ), 5.0 );
  vec3 body = mix( uShallow, uDeep, smoothstep( 0.0, 0.9, vDepth ) );
  vec3 c = mix( body, mix( uSkyLo, uSkyHi, smoothstep( 0.0, 0.5, r.y ) ), fres );
  c += uSun * 1.1 * pow( max( dot( r, uSunDir ), 0.0 ), 600.0 ); // glints
  c = mix( c, uShallow * 1.25, 0.4 * ( 1.0 - smoothstep( 0.0, 0.2, vDepth ) ) ); // the shallows by the shore
  gl_FragColor = vec4( c, 1.0 );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  gl_FragColor.rgb = mix( gl_FragColor.rgb, fogColor, smoothstep( fogNear, fogFar, length( vViewPosition ) ) );
}`,
      fog: true,
    });
    water = new THREE.Mesh(wg, waterMat);
    water.name = 'pond';
    root.add(water);
  }

  // ---- spectator dressing: pennants on poles, the banner's scaffold towers and board ------------------------------
  const enamel = col('#ecebe6'), pennant = ['#ff6b00', '#2f72f0', '#ffd23f', '#f4f4f2'].map(col);
  const windX = 0.8, windZ = 0.6; // the pennants stream downwind
  for (let i = 0; i < flags.length; i += 4) {
    const x = flags[i], z = flags[i + 1], top = groundY + flags[i + 2], fc = pennant[flags[i + 3]];
    m.item(x, z);
    m.beam(x, groundY - 0.2, z, x, top + 0.3, z, 0.16, enamel);
    m.blade(x, top, z, x, top - 1.5, z, x + windX * 3.4, top - 0.85, z + windZ * 3.4, fc, fc, 1);
  }
  let bannerFace: THREE.Mesh | null = null;
  if (banner) {
    const B = banner, nx = -B.uz, nz = B.ux, top = B.y0 + B.h, metal = col('#b4bac2');
    for (const e of [-1, 1]) { // a 2 u square scaffold tower under each end
      const tx = B.x + B.ux * e * (B.w / 2 - 2), tz = B.z + B.uz * e * (B.w / 2 - 2);
      const cs = [[1, 1], [-1, 1], [-1, -1], [1, -1]].map(([p, q]) => [tx + B.ux * p - nx * (q + 1.2), tz + B.uz * p - nz * (q + 1.2)]);
      m.item(tx, tz);
      for (const [px, pz] of cs) m.beam(px, groundY - 0.2, pz, px, top + 0.4, pz, 0.2, metal);
      for (let y = groundY + 1.2; y < top; y += 2.6) for (let k = 0; k < 4; k++) m.beam(cs[k][0], y, cs[k][1], cs[(k + 1) % 4][0], y, cs[(k + 1) % 4][1], 0.13, metal);
      for (const k of [0, 2]) { // X braces on its front and back faces
        const a = cs[k], b = cs[(k + 1) % 4];
        m.beam(a[0], groundY + 1.2, a[1], b[0], top - 0.4, b[1], 0.11, metal);
        m.beam(b[0], groundY + 1.2, b[1], a[0], top - 0.4, a[1], 0.11, metal);
      }
    }
    // the board's frame; the board is printed on both faces (its own mesh: two quads, each reading left to right)
    const hw = B.w / 2;
    m.item(B.x, B.z);
    for (const [p0, y0, p1, y1] of [[-1, B.y0, 1, B.y0], [-1, top, 1, top], [-1, B.y0, -1, top], [1, B.y0, 1, top]])
      m.beam(B.x + B.ux * p0 * hw, y0, B.z + B.uz * p0 * hw, B.x + B.ux * p1 * hw, y1, B.z + B.uz * p1 * hw, 0.3, enamel);
    const bp: number[] = [], buv: number[] = [];
    for (const side of [1, -1]) { // front (facing n), then back
      const o = side > 0 ? 0.02 : -0.06;
      for (const [p, q] of [[-1, 0], [1, 0], [1, 1], [-1, 1]]) {
        bp.push(B.x + B.ux * p * side * hw + nx * o, B.y0 + q * B.h, B.z + B.uz * p * side * hw + nz * o);
        buv.push((p + 1) / 2, q);
      }
    }
    const bg = new THREE.BufferGeometry();
    bg.setAttribute('position', new THREE.Float32BufferAttribute(bp, 3));
    bg.setAttribute('uv', new THREE.Float32BufferAttribute(buv, 2));
    bg.setIndex([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7]);
    bg.computeBoundingSphere();
    bannerFace = new THREE.Mesh(bg, new THREE.MeshBasicMaterial({ map: bannerTexture(aniso), toneMapped: false }));
    bannerFace.name = 'banner';
    root.add(bannerFace);
  }

  const sceneryMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  sceneryMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = uTime;
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSway;\nuniform float uTime;')
      .replace('#include <begin_vertex>', /* glsl */ `#include <begin_vertex>
{
  // wind: a slow gust front rolls across the meadow, each plant flutters on its own phase
  float ph = dot( position.xz, vec2( 0.13, 0.09 ) );
  float gust = 0.55 + 0.45 * sin( uTime * 0.55 - dot( position.xz, vec2( 0.018, 0.011 ) ) );
  float w = ( sin( uTime * 1.9 + ph ) + 0.45 * sin( uTime * 3.4 + ph * 1.7 ) ) * gust * aSway;
  transformed.x += w * 0.16;
  transformed.z += w * 0.09;
}`);
    sh.fragmentShader = sh.fragmentShader.replace('#include <fog_fragment>', radialFog());
  };
  sceneryMat.customProgramCacheKey = () => 'world-outdoor-scenery';
  const scenery = new THREE.Group();
  scenery.name = 'scenery';
  m.chunks(CHUNKS).forEach((g, i) => {
    const chunk = new THREE.Mesh(g, sceneryMat); // frustum-culled by its bounding sphere
    chunk.name = `scenery-${i}`;
    scenery.add(chunk);
  });
  root.add(scenery);

  // ---- far layer: sky, hills, clouds (follows the car, like a skybox) ------------------------
  const farLayer = new THREE.Group();
  farLayer.name = 'far';
  farLayer.position.set(cx, groundY, cz);
  root.add(farLayer);

  const skyMat = new THREE.ShaderMaterial({
    uniforms: {
      uZenith: { value: display(LOOK.zenith) },
      uSky: { value: display(LOOK.sky) },
      uHorizon: { value: display(LOOK.horizon) },
      uWarm: { value: display(LOOK.warm) },
      uGlow: { value: display(LOOK.glow) },
      uSunDir: { value: sunDir },
    },
    vertexShader: /* glsl */ `
varying vec3 vDir;
void main() {
  vec4 wp = modelMatrix * vec4( position, 1.0 );
  vDir = wp.xyz - cameraPosition;
  gl_Position = projectionMatrix * viewMatrix * wp;
  gl_Position.z = gl_Position.w; // on the far plane: only fills what nothing else covered
}`,
    fragmentShader: /* glsl */ `
uniform vec3 uZenith, uSky, uHorizon, uWarm, uGlow, uSunDir;
varying vec3 vDir;
void main() {
  vec3 d = normalize( vDir );
  float h = d.y;
  vec3 c = mix( uHorizon, uSky, smoothstep( 0.0, 0.3, h ) );
  c = mix( c, uZenith, smoothstep( 0.22, 0.95, h ) );
  c = mix( c, uWarm, 0.5 * smoothstep( 0.0, 0.025, h ) * ( 1.0 - smoothstep( 0.025, 0.11, h ) ) );
  float sd = max( dot( d, uSunDir ), 0.0 );
  c += uGlow * ( 0.2 * pow( sd, 6.0 ) + 0.45 * pow( sd, 90.0 ) );
  c = mix( c, vec3( 1.0 ), smoothstep( 0.9991, 0.9995, sd ) );
  c += ( fract( sin( dot( gl_FragCoord.xy, vec2( 12.9898, 78.233 ) ) ) * 43758.5453 ) - 0.5 ) / 255.0; // no banding
  gl_FragColor = vec4( c, 1.0 );
}`,
    side: THREE.BackSide,
    depthWrite: false,
    fog: false,
    toneMapped: false,
  });
  // Coarse is exact: the shader colours by the view ray, which any point of a face along that ray gives alike.
  const sky = new THREE.Mesh(new THREE.SphereGeometry(600, 16, 8), skyMat);
  sky.name = 'sky';
  sky.renderOrder = 1e6; // after every opaque: early-z skips what is covered
  sky.frustumCulled = false;
  farLayer.add(sky);

  // hills (green, close) and mountains (hazy, snow-capped) as two rings round the camera
  const hp: number[] = [], hc: number[] = [], hi: number[] = [];
  const ring = (rows: number[], prof: number[], seg: number, peak: (a: number) => number, seed: number, paint: (h: number, H: number, i: number, j: number) => void) => {
    const base = hp.length / 3;
    for (let j = 0; j < rows.length; j++) {
      for (let i = 0; i < seg; i++) {
        const a = (i / seg) * Math.PI * 2;
        const a2 = a + (j ? (hash3(i, j, seed + 1) - 0.5) * ((Math.PI * 2) / seg) * 0.6 : 0);
        const r = rows[j] * (j ? 1 + 0.06 * (hash3(i, j, seed) * 2 - 1) : 1);
        const H = peak(a), h = j ? H * prof[j] * (0.8 + 0.4 * hash3(i, j, seed + 2)) : -3;
        hp.push(Math.cos(a2) * r, h, Math.sin(a2) * r);
        paint(h, H, i, j);
        hc.push(C.r, C.g, C.b);
      }
    }
    for (let j = 0; j < rows.length - 1; j++) {
      for (let i = 0; i < seg; i++) {
        const i1 = (i + 1) % seg, A = base + j * seg + i, B = base + j * seg + i1, Cc = base + (j + 1) * seg + i1, D = base + (j + 1) * seg + i;
        hi.push(A, B, Cc, A, Cc, D);
      }
    }
  };
  const circ = (a: number, k: number, s: number, oct: number) => fbm(Math.cos(a) * k + 50, Math.sin(a) * k + 50, s, oct);
  const hillGreen = [col('#5f9440'), col('#6fa246'), col('#7aa94c')], hillForest = col('#3f7234'), hillDry = col('#a3ad5c');
  ring([430, 470, 520, 585, 650, 715, 780], [0, 0.22, 0.52, 0.84, 1, 0.82, 0.5], 128, (a) => 16 + 70 * Math.pow(circ(a, 3.2, 101, 4), 1.6), 7, (h, _H, i, j) => {
    const n = fbm(i * 0.17, j * 0.6, 202, 3);
    C.copy(hillGreen[(i + j) % 3]);
    if (n > 0.56) C.lerp(hillForest, 0.85);
    else if (n < 0.3) C.lerp(hillDry, 0.35);
    C.multiplyScalar(0.9 + 0.2 * hash3(i, j, 9) + h * 0.0015);
  });
  const mtnGrass = col('#628a5e'), rock = col('#6f84a8'), snow = col('#eef3fa');
  ring([810, 860, 915, 975, 1035, 1080], [0, 0.42, 0.8, 1, 0.74, 0.4], 168, (a) => {
    const r = 1 - Math.abs(2 * circ(a, 4.5, 303, 5) - 1);
    return 25 + 95 * r * r * r;
  }, 11, (h, _H, i, j) => {
    const t = h / 120 + 0.1 * (hash3(i, j, 13) - 0.5);
    C.copy(t > 0.8 ? snow : t > 0.22 ? rock : mtnGrass);
    if (t > 0.22 && t <= 0.8) C.lerp(mtnGrass, clamp((0.36 - t) * 4, 0, 1));
    C.multiplyScalar(0.92 + 0.16 * hash3(i, j, 17));
  });
  const hillGeo = new THREE.BufferGeometry();
  hillGeo.setAttribute('position', new THREE.Float32BufferAttribute(hp, 3));
  hillGeo.setAttribute('color', new THREE.Float32BufferAttribute(hc, 3));
  hillGeo.setIndex(hi);
  hillGeo.computeBoundingSphere();
  const hillMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  hillMat.onBeforeCompile = (sh) => {
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nvarying float vHillY;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvHillY = position.y;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vHillY;')
      .replace('#include <fog_fragment>', radialFog('1.0 - 0.45 * smoothstep( 0.0, 70.0, vHillY )')); // haze sits in the valleys
  };
  hillMat.customProgramCacheKey = () => 'world-outdoor-hills';
  const hills = new THREE.Mesh(hillGeo, hillMat);
  hills.name = 'hills';
  hills.frustumCulled = false;
  farLayer.add(hills);

  // clouds: billboard quads parked on a sphere round the camera, each facing it, flat base down
  const NC = 24, cp: number[] = [], cuv: number[] = [], cc: number[] = [], ci: number[] = [];
  const horizon = col(LOOK.horizon), white = new THREE.Color(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const cpos = new THREE.Vector3(), cr = new THREE.Vector3(), cu = new THREE.Vector3();
  for (let i = 0; i < NC; i++) {
    const a = ((i + R(0.1, 0.9)) / NC) * Math.PI * 2, e = (2.5 + 17 * rnd() ** 1.6) * DEG, d = R(960, 1060);
    const w = R(150, 320) * (1 - 0.3 * (e / (20 * DEG))), h = w * R(0.4, 0.5);
    cpos.set(Math.cos(e) * Math.cos(a), Math.sin(e), Math.cos(e) * Math.sin(a)).multiplyScalar(d);
    cr.crossVectors(up, cpos).normalize();
    cu.crossVectors(cpos, cr).normalize();
    const b = cp.length / 3, cell = i % 4, u0 = (cell % 2) * 0.5, v0 = (cell >> 1) * 0.5, flip = rnd() < 0.5;
    for (const [sx, sy] of [[-0.5, -0.5], [0.5, -0.5], [0.5, 0.5], [-0.5, 0.5]]) {
      cp.push(cpos.x + cr.x * sx * w + cu.x * sy * h, cpos.y + cr.y * sx * w + cu.y * sy * h, cpos.z + cr.z * sx * w + cu.z * sy * h);
      cuv.push(u0 + ((flip ? -sx : sx) + 0.5) * 0.5, v0 + (sy + 0.5) * 0.5);
    }
    C.copy(white).lerp(horizon, 0.45 * (1 - smooth(4 * DEG, 18 * DEG, e)));
    for (let k = 0; k < 4; k++) cc.push(C.r, C.g, C.b);
    ci.push(b, b + 1, b + 2, b, b + 2, b + 3);
  }
  const cloudGeo = new THREE.BufferGeometry();
  cloudGeo.setAttribute('position', new THREE.Float32BufferAttribute(cp, 3));
  cloudGeo.setAttribute('uv', new THREE.Float32BufferAttribute(cuv, 2));
  cloudGeo.setAttribute('color', new THREE.Float32BufferAttribute(cc, 3));
  cloudGeo.setIndex(ci);
  const clouds = new THREE.Mesh(cloudGeo, new THREE.MeshBasicMaterial({
    map: cloudAtlas(rnd), vertexColors: true, transparent: true, depthWrite: false, fog: false, toneMapped: false,
    side: THREE.DoubleSide, forceSinglePass: true,
  }));
  clouds.name = 'clouds';
  clouds.frustumCulled = false;
  farLayer.add(clouds);

  // ---- the car's blob shadow --------------------------------------------------------------------
  const blobMat = new THREE.MeshBasicMaterial({
    color: 0x000000, map: blobTexture(), transparent: true, opacity: 0.6, depthWrite: false, fog: false,
    polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -4, side: THREE.DoubleSide, forceSinglePass: true,
  });
  const blobShadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2), blobMat);
  blobShadow.name = 'car-shadow';
  blobShadow.matrixAutoUpdate = false;
  blobShadow.frustumCulled = false;
  blobShadow.renderOrder = -1; // under the skid marks and smoke
  blobShadow.visible = false;
  root.add(blobShadow);

  const tris = (g: THREE.BufferGeometry) => (g.index ? g.index.count : g.getAttribute('position').count) / 3;
  let pondClear = Infinity; // how far the pond's rim keeps from the course's solid footprint (u)
  for (let i = 0; i < rim.length; i += 2) pondClear = Math.min(pondClear, edgeDist(rim[i], rim[i + 1], false, true));
  root.userData.counts = { trees: trees.length, treeTiers: tierN, rocks: rocks.length, bushes: bushes.length, flowers: flowers.length / 4, tufts: tufts.length / 3 };
  root.userData.stats = {
    ms: Math.round(performance.now() - tStart),
    tris: {
      ground: tris(ground.geometry), hills: tris(hillGeo), sky: tris(sky.geometry), clouds: tris(cloudGeo),
      scenery: scenery.children.map((c) => tris((c as THREE.Mesh).geometry)), // per chunk
      pond: water ? tris(water.geometry) : 0,
    },
    pond: pond && { x: +pond.x.toFixed(1), z: +pond.z.toFixed(1), ux: +pond.ux.toFixed(3), uz: +pond.uz.toFixed(3), a: +pond.a.toFixed(1), b: +pond.b.toFixed(1), bend: +pond.bend.toFixed(2), clear: +pondClear.toFixed(1) },
    flags: flags.length / 4, banner: !!banner,
    castTris, castMs,
  };

  const boosterTime = track.object.userData.boosterTime as { value: number } | undefined; // the pads' chevrons
  const WORLD_UP = new THREE.Vector3(0, 1, 0);
  const d = new THREE.Vector3(), n = new THREE.Vector3(), fw = new THREE.Vector3(), rt = new THREE.Vector3(), at = new THREE.Vector3();
  let time = 0;

  function update(state: VehicleState, dt: number) {
    time += Math.min(dt, 0.1);
    uTime.value = time;
    if (boosterTime) boosterTime.value += dt;
    const P = state.position;
    farLayer.position.set(P.x, groundY, P.z);
    clouds.rotation.y = time * 0.004;

    // blob shadow: on the track surface (or its verge) under the car, else on the ground (or the pond's water)
    const floor = inPond(P.x, P.z) ? groundY - POND_DEPTH : groundY;
    let h = P.y - floor;
    n.copy(WORLD_UP);
    at.set(P.x, floor, P.z);
    if (N) {
      const hit = track.nearest(P, state.trackS, 25);
      const f = hit.frame;
      d.copy(P).sub(f.p);
      const lat = d.dot(f.right), hs = d.dot(f.up);
      const reach = f.width / 2 + (f.edge === 'grass' ? f.shoulder || 0 : 0) + 0.8;
      if (Math.abs(lat) < reach && hs > -0.6 && hs < 14 && track.tagAt(hit.s) !== 'gap') {
        h = Math.max(0, hs);
        n.copy(f.up);
        at.copy(P).addScaledVector(n, -hs);
      }
    }
    const fade = 1 - smooth(0.2, 9, h);
    if (fade <= 0.01) {
      blobShadow.visible = false;
      return;
    }
    blobShadow.visible = true;
    blobMat.opacity = 0.72 * fade;
    fw.set(1, 0, 0).applyQuaternion(state.quaternion);
    fw.addScaledVector(n, -fw.dot(n));
    if (fw.lengthSq() < 1e-6) fw.set(0, 0, 1).applyQuaternion(state.quaternion).cross(n);
    fw.normalize();
    rt.crossVectors(fw, n);
    const grow = 1 + 0.06 * h;
    at.addScaledVector(n, 0.04);
    fw.multiplyScalar(SHADOW_SIZE[0] * grow);
    rt.multiplyScalar(SHADOW_SIZE[1] * grow);
    blobShadow.matrix.makeBasis(fw, n, rt).setPosition(at);
    blobShadow.matrixWorldNeedsUpdate = true;
  }

  return { update };
}
