import * as THREE from 'three';
import type { TrackFrame } from '../types';
import { Geo, basis, box, prism } from './geo.ts';
import { col, newFrame, rng, smooth, v3, type FrameAt, type Span } from './kit.ts';

// The Touge's mountain (tracks/touge.ts): a landform the course builds round its mountain roads - support 'cut' (a road
// cut into the mountainside: no embankment, road.ts) and 'tunnel' - drawn into the props: the terrain (a heightfield fitted
// to the roads: their heights blended across the faces between them, falling away beyond, covering the tunnel, kept
// under every road and under the jump's flight), dry-stone retaining walls and parapets along the cut roads (a bridge
// keeps its parapet alone, the village its houses: tracks/riviera.ts), the tunnel's dark tube, its light strips and its
// stone portals, and the Riviera's slopes: pale limestone where they're steep, dry grass and the maquis, olives,
// cypresses, umbrella pines and scrub. Flat-shaded vertex colours like the rest of the props.

export interface MountainRange { kind: string; s0: number; s1: number }
export interface MountainOpts { tunnelH: number; seed: number }
/** What the dressing asks of the mountain (tracks/riviera.ts): the ground's height at (x, z), and the nearest road's
 *  edge from there (d: u beyond it, < 0 on the road; y: that road's height). */
export interface Land {
  hAt(x: number, z: number): number;
  road(x: number, z: number): { d: number; y: number };
}

const ROCK = [col('#cdc4ae'), col('#d8cfbb'), col('#c0b69e')];
const GRASS = [col('#a59f60'), col('#b0a868'), col('#999456')];
const SCRUB = [col('#6d7a42'), col('#5f6c3a'), col('#7b864c')];
const SOIL = col('#b39a6e'), WALL = [col('#cdbf9f'), col('#bbad8f'), col('#d6caae')], CAP = col('#e6dcc6');
const TUBE = col('#2b2724'), TUBE2 = col('#24211e'), PORTAL = col('#c9bb9b'), PORTAL2 = col('#b3a585');
/** The tunnel's light strips: past white (the props are lit, not emissive - an HDR colour reads as a lamp after the
 *  tone mapping, whatever light falls on it). */
const LAMP = new THREE.Color(4.6, 4.1, 3.1);
const OLIVE = [col('#8f9a68'), col('#9aa574'), col('#86915f')], CYPRESS = [col('#2f4b2c'), col('#35532f'), col('#2a4428')];
const PINE = [col('#4d6a33'), col('#567438'), col('#46602f')], MAQUIS = [col('#5b6b35'), col('#4e5e2f'), col('#6a783e')];
const BARK = col('#6e5a45');

/** Draws the mountain into G. `ranges`: the course's support ranges; `gaps`: the jump's flight (kept clear). */
export function mountain(G: Geo, frameAt: FrameAt, frames: TrackFrame[], ranges: MountainRange[], gaps: Span[], o: MountainOpts): Land {
  const inR = (rs: MountainRange[] | Span[], s: number) => rs.some((r) => s >= r.s0 && s <= r.s1);
  const kind = (k: string) => ranges.filter((r) => r.kind === k);
  const cuts = kind('cut'), tunnels = kind('tunnel'), bridges = kind('bridge'), village = kind('village');
  // samples every ~4 u: the mountain roads (heights to fit), the tunnel (to cover), every road (to keep the ground under)
  type S = { x: number; z: number; y: number; hw: number; tx: number; tz: number; end: number };
  const road: S[] = [], tube: S[] = [], keep: S[] = [];
  const step = Math.max(1, Math.round(4 / (frames[1].s - frames[0].s)));
  let seaZ = -Infinity; // the coast: the course's southern edge (its seafront), the sea beyond it (world-outdoor.ts)
  for (const f of frames) seaZ = Math.max(seaZ, f.p.z + f.width / 2);
  const sample = (f: TrackFrame, end = 0) => {
    const tl = Math.hypot(f.t.x, f.t.z) || 1;
    return { x: f.p.x, z: f.p.z, y: f.p.y, hw: f.width / 2, tx: f.t.x / tl, tz: f.t.z / tl, end };
  };
  for (const rg of tunnels) { // (the tube from mouth to mouth, every ~4 u)
    const n = Math.max(1, Math.round((rg.s1 - rg.s0) / 4));
    for (let k = 0; k <= n; k++) tube.push(sample(frameAt(rg.s0 + ((rg.s1 - rg.s0) * k) / n, newFrame()), k === 0 ? -1 : k === n ? 1 : 0));
  }
  for (let i = 0; i < frames.length; i += step) {
    const f = frames[i], smp = sample(f);
    if (inR(tunnels, f.s)) continue;
    if (inR(gaps, f.s)) { keep.push({ ...smp, y: f.p.y - 5 }); continue; } // (under the flight: well clear)
    keep.push(smp);
    if (inR(cuts, f.s)) road.push(smp);
  }
  // the roads (and the tube) in a plan grid, for the nearest-edge queries
  const QC = 16, qkey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096), qgrid = new Map<number, S[]>();
  for (const p of [...keep, ...tube]) {
    const k = qkey(Math.floor(p.x / QC), Math.floor(p.z / QC));
    (qgrid.get(k) ?? qgrid.set(k, []).get(k)!).push(p);
  }
  const near = { d: 0, y: 0 };
  const roadAt = (x: number, z: number) => {
    const i0 = Math.floor(x / QC), j0 = Math.floor(z / QC);
    near.d = Infinity;
    near.y = 0;
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const p of qgrid.get(qkey(i, j)) ?? []) {
        const d = Math.hypot(x - p.x, z - p.z) - p.hw;
        if (d < near.d) (near.d = d), (near.y = p.y);
      }
    }
    return near;
  };
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  for (const p of [...road, ...tube]) { x0 = Math.min(x0, p.x); x1 = Math.max(x1, p.x); z0 = Math.min(z0, p.z); z1 = Math.max(z1, p.z); }
  const PAD = 70, CELL = 4;
  x0 -= PAD; x1 += PAD; z0 -= PAD; z1 += PAD;
  const NX = Math.ceil((x1 - x0) / CELL) + 1, NZ = Math.ceil((z1 - z0) / CELL) + 1;
  const r = rng(o.seed), lat = new Float32Array(17 * 17).map(() => r());
  const noise = (x: number, z: number) => { // smooth value noise, ~40 u cells, 0..1
    const u = x / 40, w = z / 40, i = Math.floor(u), j = Math.floor(w), fu = smooth(u - i), fw = smooth(w - j);
    const at = (a: number, b: number) => lat[(((b % 17) + 17) % 17) * 17 + (((a % 17) + 17) % 17)];
    return at(i, j) + (at(i + 1, j) - at(i, j)) * fu + (at(i, j + 1) - at(i, j)) * fw + (at(i, j) - at(i + 1, j) - at(i, j + 1) + at(i + 1, j + 1)) * fu * fw;
  };
  /** The ground's height at (x, z), and the distance to the nearest mountain road's edge. */
  const raw = (x: number, z: number) => {
    let sw = 0, sy = 0, dmin = Infinity;
    for (const p of road) {
      const d = Math.hypot(x - p.x, z - p.z), e = Math.max(0, d - p.hw);
      dmin = Math.min(dmin, e);
      const w = 1 / (d * d + 30);
      sw += w; sy += w * p.y;
    }
    let h = sy / sw - 0.85 * Math.max(0, dmin - 10) + 6 * (noise(x * 2.3, z * 2.3) - 0.5) * smooth(Math.min(1, dmin / 14));
    for (const p of tube) {
      const d = Math.hypot(x - p.x, z - p.z);
      h = Math.max(h, p.y + o.tunnelH + 4 - 0.6 * Math.max(0, d - p.hw - 6));
    }
    for (const p of keep) {
      const d = Math.hypot(x - p.x, z - p.z);
      if (d > 60) continue;
      h = Math.min(h, p.y - 0.4 + (d <= p.hw + 2.4 ? 0 : 1.4 * (d - p.hw - 2.4))); // (a flat verge first: the 4 u grid's blend never laps onto the road's edge)
    }
    // ... but never into the tunnel: over its tube (its mouths aside: the roads outside them have the ground) the rock
    // stays over its crown, whatever road runs near
    for (const p of tube) {
      const dx = x - p.x, dz = z - p.z, along = dx * p.tx + dz * p.tz, lat = Math.abs(dx * p.tz - dz * p.tx);
      if (lat > p.hw + 2.5 || along > (p.end > 0 ? 0 : 2.6) || along < (p.end < 0 ? 0 : -2.6)) continue;
      h = Math.max(h, p.y + o.tunnelH + 1.5);
    }
    h = Math.min(h, 0.3 + 1.2 * (seaZ - z)); // (down to the sea past the seafront)
    const edge = Math.min(x - x0, x1 - x, z - z0, z1 - z);
    return { h: h * smooth(Math.min(1, edge / 30)), dmin };
  };
  const H = new Float32Array(NX * NZ), D = new Float32Array(NX * NZ);
  for (let j = 0; j < NZ; j++) for (let i = 0; i < NX; i++) {
    const q = raw(x0 + i * CELL, z0 + j * CELL);
    H[j * NX + i] = q.h;
    D[j * NX + i] = q.dmin;
  }
  const hAt = (x: number, z: number) => {
    const u = Math.max(0, Math.min(NX - 1.001, (x - x0) / CELL)), w = Math.max(0, Math.min(NZ - 1.001, (z - z0) / CELL));
    const i = Math.floor(u), j = Math.floor(w), fu = u - i, fw = w - j, k = j * NX + i;
    return H[k] * (1 - fu) * (1 - fw) + H[k + 1] * fu * (1 - fw) + H[k + NX] * (1 - fu) * fw + H[k + NX + 1] * fu * fw;
  };
  // ---- the terrain: two triangles a cell, each its own colour (limestone where steep, ochre soil by the roads, dry
  // grass and the maquis between)
  const a = v3(), b = v3(), c = v3(), nrm = v3(), e1 = v3(), e2 = v3(), UP = v3(0, 1, 0);
  const tri = (pa: THREE.Vector3, pb: THREE.Vector3, pc: THREE.Vector3, dm: number) => {
    e1.subVectors(pb, pa); e2.subVectors(pc, pa);
    nrm.crossVectors(e2, e1).normalize();
    if (nrm.y < 0) nrm.negate();
    const steep = Math.sqrt(1 - nrm.y * nrm.y) / Math.max(0.05, nrm.y), mx = (pa.x + pb.x + pc.x) / 3, mz = (pa.z + pb.z + pc.z) / 3;
    const n = noise(mx * 0.8, mz * 0.8), n2 = noise(mx * 6.7 + 50, mz * 6.7), pick = (arr: THREE.Color[]) => arr[Math.floor(n2 * arr.length * 0.999)];
    const colr = steep > 0.75 ? pick(ROCK) : dm < 2 ? SOIL : n > 0.5 ? pick(SCRUB) : pick(GRASS);
    const i0 = G.n;
    G.v(pa, nrm, colr); G.v(pb, nrm, colr); G.v(pc, nrm, colr);
    G.idx.push(i0, i0 + 2, i0 + 1);
  };
  /** Whether a cell lies in a tunnel's mouth (from just outside it to a few u in, over the tube): none there - the
   *  ground can't step from the road up over the crown within a cell, the tube's own mesh and its portal do. */
  const ends = tube.filter((p) => p.end !== 0);
  const inMouth = (x: number, z: number) => ends.some((p) => {
    const dx = x - p.x, dz = z - p.z, inward = -(dx * p.tx + dz * p.tz) * p.end, lat = Math.abs(dx * p.tz - dz * p.tx);
    return lat < p.hw + 1.5 && inward > -4.5 && inward < 5;
  });
  for (let j = 0; j < NZ - 1; j++) for (let i = 0; i < NX - 1; i++) {
    const k = j * NX + i, h00 = H[k], h10 = H[k + 1], h01 = H[k + NX], h11 = H[k + NX + 1];
    if (Math.max(h00, h10, h01, h11) < 0.15) continue;
    const X = x0 + i * CELL, Z = z0 + j * CELL, dm = Math.min(D[k], D[k + 1], D[k + NX], D[k + NX + 1]);
    if (inMouth(X + CELL / 2, Z + CELL / 2)) continue;
    a.set(X, h00, Z); b.set(X + CELL, h10, Z); c.set(X, h01, Z + CELL);
    tri(a, b, c, dm);
    a.set(X + CELL, h10, Z); b.set(X + CELL, h11, Z + CELL); c.set(X, h01, Z + CELL);
    tri(a, b, c, dm);
  }
  // ---- the cut roads' dry stone: a parapet along each edge, and a retaining wall down to the ground where it drops
  // away - a bridge keeps the parapet alone (its arches are its own: riviera.ts), the village its houses
  const f = newFrame(), m = new THREE.Matrix4(), q = v3();
  /** The top of the headroom kept over any road passing under (x, z) below height y (a road that crosses under this
   *  one: the helix's quarter over its first, a leg over a leg) - -Infinity when none does. A wall hung from the road
   *  above stops over it, like a bridge's fascia, never down through it. */
  const HEADROOM = 5.4;
  const under = (x: number, z: number, y: number) => {
    let lo = -Infinity;
    const i0 = Math.floor(x / QC), j0 = Math.floor(z / QC);
    for (let i = i0 - 1; i <= i0 + 1; i++) for (let j = j0 - 1; j <= j0 + 1; j++) {
      for (const p of qgrid.get(qkey(i, j)) ?? []) {
        if (p.y > y - 2 || Math.hypot(x - p.x, z - p.z) > p.hw + 3) continue;
        lo = Math.max(lo, p.y + HEADROOM);
      }
    }
    return lo;
  };
  let wi = 0;
  for (const rg of cuts) for (let s = rg.s0 + 1.5; s < rg.s1 - 1; s += 3) {
    if (inR(gaps, s) || inR(tunnels, s) || inR(village, s)) continue;
    frameAt(s, f);
    const deck = inR(bridges, s);
    for (const sg of [-1, 1]) {
      const off = f.width / 2 + 0.45;
      q.copy(f.p).addScaledVector(f.right, sg * (off + 1.5));
      const drop = deck ? 0 : Math.max(0, f.p.y - hAt(q.x, q.z));
      let bot = deck ? -0.2 : -Math.min(drop + 0.6, 40);
      const top = 0.75;
      q.copy(f.p).addScaledVector(f.right, sg * off); // (the wall's own line: any road under it?)
      const lo = under(q.x, q.z, f.p.y);
      if (f.p.y + bot < lo) bot = Math.min(-0.2, lo - f.p.y);
      box(G, basis(f, m), [0, (top + bot) / 2, sg * off], [3.05, top - bot, 0.9], WALL[wi++ % WALL.length], CAP, 0);
    }
  }
  // ---- the tunnel: a dark tube along it, two light strips under its crown, a stone portal at each end
  // (its walls' feet tucked in against the road's edge, down past its fascia: no slot to see the ground far below through)
  const ring = (w: number) => [[-(w - 0.55), -1.7], [-w, o.tunnelH - 3], [-w * 0.72, o.tunnelH - 0.9], [0, o.tunnelH], [w * 0.72, o.tunnelH - 0.9], [w, o.tunnelH - 3], [w - 0.55, -1.7]];
  for (const rg of tunnels) {
    const pts: THREE.Vector3[][] = [];
    for (let s = rg.s0 - 2; s <= rg.s1 + 2; s += 2) {
      frameAt(s, f);
      pts.push(ring(f.width / 2 + 0.6).map(([d, y]) => v3().copy(f.p).addScaledVector(f.right, d).addScaledVector(UP, y)));
    }
    for (let k = 0; k < pts.length - 1; k++) for (let e = 0; e < 6; e++) {
      const i0 = G.n, cl = (k >> 2) % 2 ? TUBE : TUBE2, P0 = pts[k][e], P1 = pts[k][e + 1], P2 = pts[k + 1][e + 1], P3 = pts[k + 1][e];
      e1.subVectors(P1, P0); e2.subVectors(P3, P0); nrm.crossVectors(e1, e2).normalize();
      G.v(P0, nrm, cl); G.v(P1, nrm, cl); G.v(P2, nrm, cl); G.v(P3, nrm, cl);
      G.idx.push(i0, i0 + 1, i0 + 2, i0, i0 + 2, i0 + 3, i0, i0 + 2, i0 + 1, i0, i0 + 3, i0 + 2); // (both faces)
    }
    for (let s = rg.s0 + 3; s < rg.s1 - 2; s += 4) { // the light strips: a bar every 4 u along each side of the crown
      frameAt(s, f);
      for (const sg of [-1, 1]) box(G, basis(f, m), [0, o.tunnelH - 1.05, sg * f.width * 0.17], [3.2, 0.22, 0.7], LAMP, LAMP, 2);
    }
    for (const [s, dir] of [[rg.s0, -1], [rg.s1, 1]]) { // the portals: a dressed-stone arch round the mouth, a headwall
      frameAt(s, f);
      const pr = ring(f.width / 2 + 0.6);
      basis(f, m);
      for (let e = 0; e < pr.length - 1; e++) { // the arch's voussoirs, in its ring's segments, set out from the tube
        const [d0, y0] = pr[e], [d1, y1] = pr[e + 1], dm = (d0 + d1) / 2, ym = (y0 + y1) / 2, len = Math.hypot(d1 - d0, y1 - y0);
        const nx = -(y1 - y0) / len, ny = (d1 - d0) / len; // (outward in the portal's plane)
        const ang = Math.atan2(y1 - y0, d1 - d0);
        const mm = new THREE.Matrix4().copy(m).multiply(new THREE.Matrix4().makeTranslation(dir * 0.8, ym + ny * 0.9, dm + nx * 0.9)).multiply(new THREE.Matrix4().makeRotationX(-ang));
        box(G, mm, [0, 0, 0], [2.2, 1.6, len + 0.5], e % 2 ? PORTAL : PORTAL2, PORTAL, 2);
      }
      const w = f.width / 2 + 0.6;
      box(G, m, [dir * 0.6, o.tunnelH + 3.4, 0], [1.6, 4.4, 2 * w + 7], PORTAL2, CAP, 1); // the headwall, its cornice
      box(G, m, [dir * 0.9, o.tunnelH + 5.7, 0], [2.2, 0.6, 2 * w + 8], CAP, CAP, 2);
      for (const sg of [-1, 1]) box(G, m, [dir * 0.6, (o.tunnelH + 1.2) / 2, sg * (w + 2.6)], [1.6, o.tunnelH + 1.2, 3], PORTAL2, CAP, 1); // its wings
    }
  }
  // ---- the slopes' trees, clear of every road and the tunnel's mouths: olives, cypresses, umbrella pines, the maquis
  const tr = rng(o.seed + 7), mouths: THREE.Vector3[] = [];
  for (const rg of tunnels) for (const s of [rg.s0, rg.s1]) mouths.push(frameAt(s, f).p.clone());
  const free = (x: number, z: number, clear: number) => {
    if (roadAt(x, z).d < clear) return false;
    for (const p of mouths) if (Math.hypot(x - p.x, z - p.z) < 22) return false;
    return Math.abs(hAt(x + 2, z) - hAt(x - 2, z)) < 2.6 && Math.abs(hAt(x, z + 2) - hAt(x, z - 2)) < 2.6;
  };
  const counts = [0, 0, 0, 0], caps = [170, 80, 55, 320];
  for (let t = 0; t < 9000 && counts.some((n, i) => n < caps[i]); t++) {
    const x = x0 + PAD * 0.4 + tr() * (x1 - x0 - PAD * 0.8), z = z0 + PAD * 0.4 + tr() * (z1 - z0 - PAD * 0.8), h = hAt(x, z);
    if (h < 1.2) continue;
    const pick = tr(), sort = pick < 0.34 ? 0 : pick < 0.5 ? 1 : pick < 0.62 ? 2 : 3;
    if (counts[sort] >= caps[sort] || !free(x, z, sort === 3 ? 3 : 6)) continue;
    const sz = 0.8 + tr() * 0.45, rot = tr() * 6.28, shade = 0.88 + tr() * 0.24;
    if (sort === 0) olive(G, x, h, z, sz, rot, OLIVE[Math.floor(tr() * 3)].clone().multiplyScalar(shade));
    else if (sort === 1) cypress(G, x, h, z, sz, rot, CYPRESS[Math.floor(tr() * 3)].clone().multiplyScalar(shade));
    else if (sort === 2) umbrella(G, x, h, z, sz, rot, PINE[Math.floor(tr() * 3)].clone().multiplyScalar(shade));
    else bicone(G, x, h + 0.25 * sz, z, (0.9 + tr() * 0.7) * sz, 0.9 * sz, 0.35, 5, MAQUIS[Math.floor(tr() * 3)].clone().multiplyScalar(shade), rot);
    counts[sort]++;
  }
  return { hAt, road: (x, z) => ({ ...roadAt(x, z) }) };
}

// ---- the Riviera's trees (low poly, flat-shaded), standing on the ground at height h ------------------------------

/** An olive: a short trunk under a broad, grey-green crown. */
export function olive(G: Geo, x: number, h: number, z: number, s: number, rot: number, c: THREE.Color) {
  prism(G, x, z, h - 0.3, h + 1.7 * s, 0.32 * s, 5, BARK, null, rot);
  bicone(G, x, h + 2.5 * s, z, 2.6 * s, 1.5 * s, 0.9 * s, 7, c, rot);
}
/** A cypress: a dark green spire. */
export function cypress(G: Geo, x: number, h: number, z: number, s: number, rot: number, c: THREE.Color) {
  prism(G, x, z, h - 0.3, h + 0.9, 0.24 * s, 4, BARK, null, rot);
  bicone(G, x, h + 2.2 * s, z, 1.15 * s, 8.4 * s, 1.6 * s, 6, c, rot);
}
/** An umbrella pine: a tall bare trunk under a flat, spreading crown. */
export function umbrella(G: Geo, x: number, h: number, z: number, s: number, rot: number, c: THREE.Color) {
  prism(G, x, z, h - 0.3, h + 6.4 * s, 0.34 * s, 5, BARK, null, rot);
  bicone(G, x, h + 6.6 * s, z, 4.3 * s, 1.2 * s, 0.7 * s, 8, c, rot);
}

/** A double cone: a ring of n points (radius r) at y, an apex hu above it and one hd below - a crown, a bush. */
export function bicone(G: Geo, x: number, y: number, z: number, r: number, hu: number, hd: number, n: number, c: THREE.Color, rot = 0) {
  const top = v3(x, y + hu, z), bot = v3(x, y - hd, z), pa = v3(), pb = v3(), dark = c.clone().multiplyScalar(0.82);
  for (let k = 0; k < n; k++) {
    const t0 = rot + (k / n) * Math.PI * 2, t1 = rot + ((k + 1) / n) * Math.PI * 2;
    pa.set(x + Math.cos(t0) * r, y, z + Math.sin(t0) * r);
    pb.set(x + Math.cos(t1) * r, y, z + Math.sin(t1) * r);
    tri(G, pa, pb, top, x, y, z, k % 2 ? c : dark);
    tri(G, pb, pa, bot, x, y, z, dark);
  }
}

/** One flat-shaded triangle, facing away from (cx, cy, cz) (a closed solid's inside point). */
export function tri(G: Geo, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, cx: number, cy: number, cz: number, cl: THREE.Color) {
  const e1 = T1.subVectors(b, a), e2 = T2.subVectors(c, a), nr = T3.crossVectors(e1, e2).normalize();
  const out = (a.x + b.x + c.x) / 3 - cx, outY = (a.y + b.y + c.y) / 3 - cy, outZ = (a.z + b.z + c.z) / 3 - cz;
  const i0 = G.n, flip = nr.x * out + nr.y * outY + nr.z * outZ < 0;
  if (flip) nr.negate();
  G.v(a, nr, cl); G.v(b, nr, cl); G.v(c, nr, cl);
  if (flip) G.idx.push(i0, i0 + 2, i0 + 1);
  else G.idx.push(i0, i0 + 1, i0 + 2);
}
const T1 = v3(), T2 = v3(), T3 = v3();
