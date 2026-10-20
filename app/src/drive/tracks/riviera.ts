import * as THREE from 'three';
import type { TrackFrame } from '../types';
import { Geo, basis, box, prism } from './geo.ts';
import { col, newFrame, rng, v3, type FrameAt } from './kit.ts';
import { bicone, cypress, olive, tri, umbrella, type Land, type MountainRange } from './mountain.ts';

// The Touge's Riviera (tracks/touge.ts), drawn into the props over its mountain (tracks/mountain.ts): the village - pastel
// houses under terracotta roofs lining its street on both sides and filling the braid's islands, shutters, balconies
// and bougainvillea, the piazza's fountain on its island and the church's bell tower over it - the stone bridges'
// arches, the cliffside gallery's arcade before the tunnel, the cypress avenue, the seafront's palms, lamps and beach
// umbrellas, and villas dotted over the slopes. Each where the course's ranges say (support kinds 'village', 'isle',
// 'plaza', 'bridge', 'gallery', 'avenue', 'seafront'), and all of it off every other road: nothing stands over a road.

export interface Isle { s0: number; s1: number; nose: number; tail: number; half: number }

const WALLS = ['#e8c27a', '#e9a07e', '#f0d9a8', '#d9826a', '#e7b9a4', '#f3eadb', '#d7a86e', '#c9d1b4', '#b3c9d3', '#f2c59a'].map(col);
const ROOF = [col('#b8552f'), col('#c4643a'), col('#a94a2a')], ROOF2 = col('#8f3d24');
const SHUTTER = [col('#4f7a52'), col('#5f7f90'), col('#3f6a5a'), col('#7a5a3a')], DOOR = col('#5a3b26'), SILL = col('#efe6d4');
const STONE = [col('#cdbf9f'), col('#bfb192'), col('#d8ccb0')], STONE_CAP = col('#e6dcc6');
const BOUG = [col('#d62f78'), col('#e0458a'), col('#c22468'), col('#ea6aa6')], LEAF = col('#3f6a34');
const WATER = col('#4fa3c4'), BRONZE = col('#8a7a5a');
const PALM = [col('#5f8a3a'), col('#6c9640'), col('#557c34')], PALM_TRUNK = col('#8a7458');
const BRELLA = [[col('#e8423a'), col('#f4f1ea')], [col('#2f72c8'), col('#f4f1ea')], [col('#f2b632'), col('#f4f1ea')], [col('#2e9a8c'), col('#f4f1ea')]];
const LAMP_POST = col('#3a3f44'), LAMP_GLASS = col('#fff2cc');

/** Draws the Riviera into G. `ranges`: the course's support ranges; `isles`: the braid's islands (path s, as split.ts). */
export function riviera(G: Geo, frameAt: FrameAt, frames: TrackFrame[], land: Land, ranges: MountainRange[], isles: Isle[], seed: number) {
  const kind = (k: string) => ranges.filter((r) => r.kind === k);
  const R = rng(seed), rnd = (a: number, b: number) => a + (b - a) * R(), pick = <T>(xs: T[]) => xs[Math.floor(R() * xs.length) % xs.length];
  const L = frames[frames.length - 1].s + (frames[1].s - frames[0].s);
  // every road's centre line in a plan grid: a spot is clear when no road (but the ones it's beside: `own`) lies within
  const QC = 12, qkey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096), grid = new Map<number, TrackFrame[]>();
  for (let i = 0; i < frames.length; i += 4) {
    const f = frames[i], k = qkey(Math.floor(f.p.x / QC), Math.floor(f.p.z / QC));
    (grid.get(k) ?? grid.set(k, []).get(k)!).push(f);
  }
  const lapD = (a: number, b: number) => { const d = Math.abs(a - b) % L; return Math.min(d, L - d); };
  /** Whether nothing of the lap (bar the stretch within `own` u of s) comes within r u of (x, z) - nor anything at all
   *  that runs above y0 there (a deck overhead). */
  const clear = (x: number, z: number, r: number, s: number, own: number, y1 = Infinity) => {
    const n = Math.ceil((r + 14) / QC), i0 = Math.floor(x / QC), j0 = Math.floor(z / QC);
    for (let i = i0 - n; i <= i0 + n; i++) for (let j = j0 - n; j <= j0 + n; j++) {
      for (const f of grid.get(qkey(i, j)) ?? []) {
        const d = Math.hypot(f.p.x - x, f.p.z - z) - f.width / 2;
        if (d < r && (lapD(f.s, s) > own || f.p.y > y1)) return false;
      }
    }
    return true;
  };
  const f = newFrame(), m = new THREE.Matrix4();

  /** A house: its footprint centred at (x, z), w along `yaw` (rad, from +x toward +z) by d across, ground floor at y0,
   *  `storeys` 3.1 u each, a gable roof along its length, shutters on the face toward (fx, fz) and its back. */
  const house = (x: number, z: number, yaw: number, w: number, d: number, y0: number, base: number, storeys: number, fx: number, fz: number, wall = pick(WALLS)) => {
    const H = storeys * 3.1 + 0.5, top = y0 + H;
    m.makeRotationY(-yaw).setPosition(x, 0, z);
    box(G, m, [0, (top + base) / 2, 0], [w, top - base, d], wall, wall, 1);
    box(G, m, [0, top + 0.12, 0], [w + 0.3, 0.24, d + 0.3], SILL, SILL, 2); // the eaves' band
    // the roof: two slopes and two gable ends (an overhang all round)
    const rh = Math.min(w, d) * 0.28, rx = w / 2 + 0.45, rz = d / 2 + 0.55, ry = top + 0.24, c = Math.cos(-yaw), s = Math.sin(-yaw);
    const at = (lx: number, ly: number, lz: number) => v3(x + lx * c + lz * s, ly, z - lx * s + lz * c);
    const ridgeAlong = w >= d, rf = pick(ROOF);
    const P = ridgeAlong
      ? [at(-rx, ry, -rz), at(rx, ry, -rz), at(rx, ry, rz), at(-rx, ry, rz), at(-rx, ry + rh, 0), at(rx, ry + rh, 0)]
      : [at(-rx, ry, -rz), at(rx, ry, -rz), at(rx, ry, rz), at(-rx, ry, rz), at(0, ry + rh, -rz), at(0, ry + rh, rz)];
    const cy = ry + rh * 0.3;
    if (ridgeAlong) {
      quad4(G, P[0], P[1], P[5], P[4], x, cy, z, rf); quad4(G, P[3], P[2], P[5], P[4], x, cy, z, rf);
      tri(G, P[0], P[3], P[4], x, cy, z, ROOF2); tri(G, P[1], P[2], P[5], x, cy, z, ROOF2);
    } else {
      quad4(G, P[0], P[3], P[5], P[4], x, cy, z, rf); quad4(G, P[1], P[2], P[5], P[4], x, cy, z, rf);
      tri(G, P[0], P[1], P[4], x, cy, z, ROOF2); tri(G, P[3], P[2], P[5], x, cy, z, ROOF2);
    }
    // shutters (closed against the afternoon) on the front and back faces, a door on the front's ground floor
    const nx = s, nz = c; // (the house's local +z in the world)
    const front = nx * fx + nz * fz > 0 ? 1 : -1, sh = pick(SHUTTER), cols = Math.max(1, Math.floor(w / 2.8));
    for (const face of [front, -front]) {
      for (let k = 0; k < storeys; k++) {
        for (let i = 0; i < cols; i++) {
          const lx = -w / 2 + (i + 0.5) * (w / cols), ly = y0 + 1.5 + k * 3.1;
          if (k === 0 && face === front && i === Math.floor(cols / 2)) { box(G, m, [lx, y0 + 1.1, face * (d / 2 + 0.05)], [1.3, 2.3, 0.2], DOOR, DOOR, 1); continue; }
          if (k === 0 && face !== front) continue;
          box(G, m, [lx, ly, face * (d / 2 + 0.06)], [1.15, 1.6, 0.18], sh, sh, 1);
        }
      }
      if (storeys > 1 && face === front && R() < 0.45) box(G, m, [0, y0 + 3.0, face * (d / 2 + 0.55)], [Math.min(w - 1, 4), 0.25, 1.1], SILL, SILL, 2); // a balcony
    }
    if (R() < 0.45) { // bougainvillea up a corner and over the door
      const lx = (R() < 0.5 ? -1 : 1) * (w / 2 - 0.5), lz = front * (d / 2 + 0.45), q = at(lx, 0, lz);
      for (let k = 0; k < 3; k++) boug(q.x, y0 + 0.8 + k * 1.5, q.z, 1);
      if (storeys > 1) { const e = at(lx * 0.45, 0, lz); boug(e.x, y0 + 3.4, e.z, 1.2); }
    }
  };

  /** A clump of bougainvillea (magenta over a little green) at (x, y, z). */
  function boug(x: number, y: number, z: number, s: number) {
    for (let k = 0; k < 6; k++) {
      const a = R() * 6.28, o = R() * 0.7 * s;
      bicone(G, x + Math.cos(a) * o, y + rnd(-0.5, 0.5) * s, z + Math.sin(a) * o, rnd(0.5, 0.75) * s, 0.28 * s, 0.24 * s, 6, k < 5 ? pick(BOUG) : LEAF, R() * 6);
    }
  }

  // ---- the village street: both sides, a row of houses (alleys between, a garden wall now and then)
  for (const rg of kind('village')) {
    for (const sg of [-1, 1]) {
      let s = rg.s0 + 2;
      while (s < rg.s1 - 6) {
        const w = rnd(6.5, 10.5), d = rnd(7, 10.5), sc = s + w / 2;
        frameAt(sc, f);
        const hw = f.width / 2, off = hw + 1.3 + d / 2;
        const x = f.p.x + f.right.x * sg * off, z = f.p.z + f.right.z * sg * off;
        const yaw = Math.atan2(f.t.z, f.t.x);
        const ok = clear(x, z, Math.hypot(w, d) / 2 + 1.5, sc, 30) && Math.abs(f.right.y) < 0.1;
        if (ok) {
          const ground = Math.min(land.hAt(x, z), f.p.y) - 1.5;
          house(x, z, yaw, w, d, f.p.y, ground, 2 + (R() < 0.45 ? 1 : 0), -f.right.x * sg, -f.right.z * sg);
          s += w + (R() < 0.3 ? rnd(2, 4) : 0.4);
        } else s += 3;
      }
    }
  }
  // ---- the braid's islands: a block of houses down each long one, the fountain on the piazza's
  for (const I of isles) {
    const full0 = I.s0 + I.nose + 6, full1 = I.s0 + I.tail - 6;
    for (let s = I.s0 + I.nose + 0.8; s < I.s0 + I.tail - 0.8; s += 1.6) { // its kerb, round its edge (the lanes' walls)
      frameAt(s, f);
      const u = s - I.s0, e = I.half * Math.tanh((0.6 * Math.min(u - I.nose, I.tail - u)) / I.half);
      if (e < 0.4) continue;
      for (const sg of [-1, 1]) box(G, basis(f, m), [0, 0.12, sg * (e - 0.25)], [1.62, 0.36, 0.5], STONE[(Math.round(s) & 1) + 1], STONE_CAP, 1);
    }
    if (I.half < 5) { // the piazza's fountain: a round basin, its water, a column and a bowl
      frameAt((I.s0 + I.s1) / 2, f);
      const r0 = Math.min(I.half - 0.5, 3.4);
      prism(G, f.p.x, f.p.z, f.p.y - 1, f.p.y + 0.85, r0, 12, STONE[0], STONE_CAP);
      prism(G, f.p.x, f.p.z, f.p.y + 0.5, f.p.y + 0.7, r0 - 0.35, 12, WATER, WATER);
      prism(G, f.p.x, f.p.z, f.p.y + 0.7, f.p.y + 2.6, 0.38, 6, STONE[1], STONE_CAP);
      prism(G, f.p.x, f.p.z, f.p.y + 2.4, f.p.y + 2.75, 1.25, 8, STONE[0], WATER);
      bicone(G, f.p.x, f.p.y + 3.05, f.p.z, 0.35, 0.7, 0.2, 5, BRONZE);
      continue;
    }
    for (let s = full0; s < full1 - 4; ) {
      const w = Math.min(full1 - s, rnd(8, 12)), sc = s + w / 2;
      frameAt(sc, f);
      const d = 2 * I.half - 1.4, yaw = Math.atan2(f.t.z, f.t.x);
      house(f.p.x, f.p.z, yaw, w, d, f.p.y, f.p.y - 1.2, 2 + (R() < 0.5 ? 1 : 0), f.right.x, f.right.z);
      s += w + 0.3;
    }
    for (const se of [I.s0 + I.nose + 3, I.s0 + I.tail - 3]) { // a planter and a cypress at each point
      frameAt(se, f);
      prism(G, f.p.x, f.p.z, f.p.y - 0.5, f.p.y + 0.6, 1.1, 8, STONE[2], col('#6a5a40'));
      cypress(G, f.p.x, f.p.y + 0.6, f.p.z, 0.7, R() * 6, col('#33502e'));
    }
  }
  // ---- the church on the piazza: a nave beside it, its bell tower at the corner - the village's landmark
  for (const rg of kind('plaza')) {
    const sc = (rg.s0 + rg.s1) / 2;
    for (const sg of [-1, 1]) {
      frameAt(sc, f);
      const hw = f.width / 2, yaw = Math.atan2(f.t.z, f.t.x);
      const off = hw + 2 + 7, x = f.p.x + f.right.x * sg * off, z = f.p.z + f.right.z * sg * off;
      if (!clear(x, z, 12, sc, 40)) continue;
      const ground = Math.min(land.hAt(x, z), f.p.y) - 1.5;
      house(x, z, yaw, 16, 12, f.p.y, ground, 3, -f.right.x * sg, -f.right.z * sg, col('#efe2c8')); // the nave
      const tx = f.p.x + f.right.x * sg * (hw + 4) + f.t.x * 10, tz = f.p.z + f.right.z * sg * (hw + 4) + f.t.z * 10;
      m.makeRotationY(-yaw).setPosition(tx, 0, tz);
      const T = f.p.y + 19;
      box(G, m, [0, (T + ground) / 2, 0], [4.6, T - ground, 4.6], col('#e9d7b4'), STONE_CAP, 1); // the tower
      for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) box(G, m, [a * 1.9, T + 2.1, b * 1.9], [0.8, 4.2, 0.8], col('#e9d7b4'), col('#e9d7b4'), 0); // the belfry's piers
      box(G, m, [0, T + 1.0, 0], [1.4, 1.6, 1.4], BRONZE, BRONZE, 2); // the bell
      box(G, m, [0, T + 4.35, 0], [5.0, 0.4, 5.0], STONE_CAP, STONE_CAP, 2);
      const c = v3(tx, T + 4.55, tz), apex = v3(tx, T + 8.6, tz), cs = [[-1, -1], [1, -1], [1, 1], [-1, 1]].map(([a, b]) => v3(tx + 2.5 * (a * Math.cos(yaw) - b * Math.sin(yaw)), T + 4.55, tz + 2.5 * (a * Math.sin(yaw) + b * Math.cos(yaw))));
      for (let k = 0; k < 4; k++) tri(G, cs[k], cs[(k + 1) % 4], apex, c.x, c.y, c.z, ROOF[k % 2]);
      break;
    }
  }

  // ---- the stone bridges: stone piers where the ground under them is clear (never on a road), and between them, on
  // both faces, the spandrels down to an arch - kept high over a road passing under
  for (const rg of kind('bridge')) {
    const n = Math.max(1, Math.round((rg.s1 - rg.s0) / 14)), bay = (rg.s1 - rg.s0) / n, piers: number[] = [];
    for (let k = 0; k <= n; k++) {
      const s = rg.s0 + k * bay;
      frameAt(s, f);
      const under = f.p.y - 1.4, gy = land.hAt(f.p.x, f.p.z);
      if (under - gy < 1.2 || !clear(f.p.x, f.p.z, f.width / 2 + 2, s, 12)) continue;
      box(G, basis(f, m), [0, (gy - 1 - f.p.y - 1.4) / 2, 0], [2.6, -1.4 - (gy - 1 - f.p.y), f.width + 1.8], STONE[k % 3], STONE_CAP, 0);
      piers.push(s);
    }
    if (!piers.length || piers[0] > rg.s0 + 1) piers.unshift(rg.s0);
    if (piers[piers.length - 1] < rg.s1 - 1) piers.push(rg.s1);
    for (let k = 0; k < piers.length - 1; k++) {
      const a0 = piers[k] + 1.3, a1 = piers[k + 1] - 1.3, B = a1 - a0, ne = Math.max(4, Math.round(B / 1.5));
      for (let e = 0; e < ne; e++) {
        const u = (e + 0.5) / ne, s = a0 + u * B;
        frameAt(s, f);
        for (const sg of [-1, 1]) {
          const fx = f.p.x + f.right.x * sg * (f.width / 2), fz = f.p.z + f.right.z * sg * (f.width / 2);
          const soffit = f.p.y - 1.4, gy = land.hAt(fx, fz), spring = Math.max(gy + 0.3, soffit - Math.min(7, B * 0.42));
          let low = spring + (soffit - 0.35 - spring) * Math.sqrt(Math.max(0, 1 - (2 * u - 1) ** 2));
          const rd = land.road(fx, fz); // (a road under the face: the arch keeps 5.4 u over it)
          if (rd.d < 1.2 && rd.y < soffit - 1) low = Math.max(low, Math.min(soffit - 0.3, rd.y + 5.4));
          const depth = soffit - low;
          if (depth < 0.15) continue;
          box(G, basis(f, m), [0, -1.4 - depth / 2, sg * (f.width / 2 - 0.1)], [B / ne + 0.04, depth, 0.9], STONE[(k + e) % 3], STONE_CAP, 2);
          box(G, basis(f, m), [0, -1.4 - depth + 0.3, sg * (f.width / 2 + 0.05)], [B / ne + 0.04, 0.6, 1.25], STONE_CAP, STONE_CAP, 2); // the arch ring
        }
      }
    }
  }
  // ---- the gallery: an arcade on the open side of the road cut into the cliff - slim columns, round arches under a
  // stone beam - and its roof back to the rock (the cliff's shaded wall under it)
  for (const rg of kind('gallery')) {
    frameAt((rg.s0 + rg.s1) / 2, f);
    const side = (sg: number) => land.hAt(f.p.x + f.right.x * sg * (f.width / 2 + 8), f.p.z + f.right.z * sg * (f.width / 2 + 8));
    const lo = side(1) < side(-1) ? 1 : -1, n = Math.max(2, Math.round((rg.s1 - rg.s0) / 7)), bay = (rg.s1 - rg.s0) / n;
    for (let k = 0; k <= n; k++) {
      const s = rg.s0 + k * bay;
      frameAt(s, f);
      basis(f, m);
      const hw = f.width / 2, gy = Math.min(-1, land.hAt(f.p.x + f.right.x * lo * (hw + 1.3), f.p.z + f.right.z * lo * (hw + 1.3)) - f.p.y - 1);
      box(G, m, [0, (7.6 + gy) / 2, lo * (hw + 1.3)], [1.0, 7.6 - gy, 1.0], STONE[1], STONE_CAP, 0); // a column
      box(G, m, [0, 7.75, lo * (hw + 1.3)], [1.5, 0.3, 1.5], STONE_CAP, STONE_CAP, 2); // its capital
      if (k === n) break;
      const mid = bay / 2;
      box(G, m, [mid, 8.15, lo * (hw + 1.3)], [bay + 1.1, 0.8, 1.3], STONE[2], STONE_CAP, 2); // the beam
      for (const [u, y, h, w] of [[0.18, 7.0, 1.4, 0.24], [0.5, 7.45, 0.5, 0.42], [0.82, 7.0, 1.4, 0.24]]) box(G, m, [u * bay, y, lo * (hw + 1.3)], [w * bay, h, 0.9], STONE[2], STONE[2], 2); // its arch
      box(G, m, [mid, 8.75, 0], [bay + 0.05, 0.5, 2 * hw + 4.2], STONE[0], STONE_CAP, 2); // the roof
      box(G, m, [mid, 4.2, -lo * (hw + 1.0)], [bay + 0.05, 8.6, 1.0], col('#9f9478'), STONE_CAP, 0); // the cliff's wall, in its shade
    }
  }
  // ---- the avenue: cypresses down both sides
  for (const rg of kind('avenue')) for (let s = rg.s0 + 3; s < rg.s1; s += 7) {
    frameAt(s, f);
    for (const sg of [-1, 1]) {
      const off = f.width / 2 + 3, x = f.p.x + f.right.x * sg * off, z = f.p.z + f.right.z * sg * off;
      if (clear(x, z, 2, s, 20)) cypress(G, x, Math.min(land.hAt(x, z), f.p.y + 0.3), z, rnd(0.85, 1.1), R() * 6, pick([col('#2f4b2c'), col('#35532f')]));
    }
  }
  // ---- the seafront: palms along the promenade (sea side), lamps on the land side, umbrellas on the beach
  for (const rg of kind('seafront')) {
    for (let s = rg.s0 + 5; s < rg.s1 - 2; s += 13) {
      frameAt(s, f);
      const sea = f.right.z > 0 ? 1 : -1; // (the sea is +z)
      const hw = f.width / 2, x = f.p.x + f.right.x * sea * (hw + 3.2), z = f.p.z + f.right.z * sea * (hw + 3.2);
      if (clear(x, z, 2, s, 20)) palm(G, x, f.p.y - 0.2, z, rnd(0.9, 1.15), R() * 6, R);
      if ((Math.round(s / 13) & 1) === 0) {
        const lx = f.p.x - f.right.x * sea * (hw + 1.4), lz = f.p.z - f.right.z * sea * (hw + 1.4);
        if (clear(lx, lz, 1, s, 20)) lamp(G, lx, f.p.y, lz);
      }
      for (let k = 0; k < 2; k++) { // umbrellas on the sand beyond the promenade
        const o = hw + rnd(6.5, 10.5), bx = f.p.x + f.right.x * sea * o + f.t.x * rnd(-5, 5), bz = f.p.z + f.right.z * sea * o + f.t.z * rnd(-5, 5);
        if (R() < 0.7 && clear(bx, bz, 2.5, s, 20)) brolly(G, bx, f.p.y - 0.6, bz, pick(BRELLA), R() * 6);
      }
    }
  }
  // ---- villas over the slopes: a house on a level spot well off the roads, a cypress or an olive by it
  let villas = 0;
  for (let t = 0; t < 4000 && villas < 14; t++) {
    const f0 = frames[Math.floor(R() * frames.length)], a = R() * Math.PI * 2, dd = rnd(16, 40);
    const x = f0.p.x + Math.cos(a) * dd, z = f0.p.z + Math.sin(a) * dd, h = land.hAt(x, z);
    if (h < 3 || land.road(x, z).d < 9 || !clear(x, z, 12, -1e6, -1)) continue;
    let flat = true;
    for (const [ox, oz] of [[-6, -6], [6, -6], [6, 6], [-6, 6]]) if (Math.abs(land.hAt(x + ox, z + oz) - h) > 2.4) flat = false;
    if (!flat) continue;
    const yaw = R() * Math.PI, w = rnd(9, 12), d = rnd(8, 10);
    house(x, z, yaw, w, d, h + 0.3, h - 2.5, R() < 0.5 ? 2 : 1, Math.cos(a), Math.sin(a));
    const tx = x + Math.cos(yaw + 1.2) * (w / 2 + 3), tz = z + Math.sin(yaw + 1.2) * (w / 2 + 3);
    if (land.road(tx, tz).d > 4) (R() < 0.6 ? cypress : olive)(G, tx, land.hAt(tx, tz), tz, rnd(0.8, 1.05), R() * 6, R() < 0.6 ? col('#2f4b2c') : col('#8f9a68'));
    if (R() < 0.5) {
      const ux = x - Math.cos(yaw) * (w / 2 + 4), uz = z - Math.sin(yaw) * (w / 2 + 4);
      if (land.road(ux, uz).d > 6) umbrella(G, ux, land.hAt(ux, uz), uz, rnd(0.8, 1), R() * 6, col('#4d6a33'));
    }
    villas++;
  }
}

/** A flat quad (a, b, c, d in order round it), facing away from (cx, cy, cz). */
function quad4(G: Geo, a: THREE.Vector3, b: THREE.Vector3, c: THREE.Vector3, d: THREE.Vector3, cx: number, cy: number, cz: number, cl: THREE.Color) {
  tri(G, a, b, c, cx, cy, cz, cl);
  tri(G, a, c, d, cx, cy, cz, cl);
}

/** A palm: a leaning, segmented trunk and a crown of drooping fronds. */
function palm(G: Geo, x: number, y: number, z: number, s: number, rot: number, R: () => number) {
  const lean = 0.08 + R() * 0.1, lx = Math.cos(rot) * lean, lz = Math.sin(rot) * lean;
  let px = x, pz = z, py = y;
  for (let k = 0; k < 4; k++) { // the trunk in four short prisms, leaning more toward the top
    const h = 2.1 * s, nx = px + lx * h * (1 + k * 0.4), nz = pz + lz * h * (1 + k * 0.4);
    prism(G, (px + nx) / 2, (pz + nz) / 2, py, py + h + 0.1, (0.36 - k * 0.04) * s, 5, PALM_TRUNK, null, rot);
    px = nx; pz = nz; py += h;
  }
  const top = v3(px, py, pz), c = PALM[Math.floor(R() * PALM.length)];
  for (let k = 0; k < 7; k++) { // the fronds: long blades drooping out
    const a = rot + (k / 7) * Math.PI * 2 + R() * 0.3, L = (3.6 + R() * 1.2) * s;
    const tip = v3(px + Math.cos(a) * L, py - 1.6 * s, pz + Math.sin(a) * L), mid = v3(px + Math.cos(a) * L * 0.5, py + 0.5 * s, pz + Math.sin(a) * L * 0.5);
    const w = 0.7 * s, sx = -Math.sin(a) * w, sz = Math.cos(a) * w;
    const l = v3(mid.x + sx, mid.y, mid.z + sz), rr = v3(mid.x - sx, mid.y, mid.z - sz);
    tri(G, top, l, tip, px, py - 3, pz, c);
    tri(G, top, tip, rr, px, py - 3, pz, c);
    tri(G, top, tip, l, px, py + 3, pz, c);
    tri(G, top, rr, tip, px, py + 3, pz, c);
  }
}

/** A street lamp: a dark post, a warm lantern. */
function lamp(G: Geo, x: number, y: number, z: number) {
  prism(G, x, z, y - 0.3, y + 4.2, 0.12, 5, LAMP_POST, null);
  prism(G, x, z, y + 4.1, y + 4.9, 0.32, 6, LAMP_GLASS, LAMP_POST);
}

/** A beach umbrella: a pole, a striped canopy. */
function brolly(G: Geo, x: number, y: number, z: number, cs: THREE.Color[], rot: number) {
  prism(G, x, z, y - 0.3, y + 2.5, 0.06, 4, cs[1], null);
  const n = 8, apex = v3(x, y + 3.1, z), r = 1.9;
  for (let k = 0; k < n; k++) {
    const t0 = rot + (k / n) * Math.PI * 2, t1 = rot + ((k + 1) / n) * Math.PI * 2;
    const a = v3(x + Math.cos(t0) * r, y + 2.35, z + Math.sin(t0) * r), b = v3(x + Math.cos(t1) * r, y + 2.35, z + Math.sin(t1) * r);
    tri(G, a, b, apex, x, y + 2, z, cs[k % 2]);
    tri(G, b, a, apex, x, y + 4, z, cs[k % 2]); // (its underside)
  }
}
