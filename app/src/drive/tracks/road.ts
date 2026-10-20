import * as THREE from 'three';
import type { TrackFrame } from '../types';
import { KIT, STRIP, col, hardOf, newFrame, rng, smooth, v3, type FrameAt } from './kit.ts';
import { Geo, runs, stations } from './geo.ts';

// The road: asphalt, dirt, mown verges, embankments and curbs under one shader, with its painted textures.

export const GROUND = -0.3; // embankments run just under the meadow (y = 0), so no seam shows
/** A bridge's deck (roadGeometry's `bridge`): how deep its concrete fascia hangs under the road, its colours. */
export const BRIDGE = { depth: 1.4, face: col('#c8ba9a'), dark: col('#978a6e') }; // (dressed stone: the Touge's decks and cut roads)
const ROAD_TILE = 16; // u of road per texture repeat

/** A tileable value noise lattice (period p cells) sampled at (x, y) in cell units, 0..1. */
function lattice(seed: number, p: number) {
  const r = rng(seed), g = new Float32Array(p * p).map(() => r());
  return (x: number, y: number) => {
    const ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy, ux = smooth(fx), uy = smooth(fy);
    const at = (i: number, j: number) => g[(((j % p) + p) % p) * p + (((i % p) + p) % p)];
    const a = at(ix, iy), b = at(ix + 1, iy), c = at(ix, iy + 1), d = at(ix + 1, iy + 1);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  };
}

/** An sRGB texture painted per pixel by fn(x, y) -> [r, g, b] (0..255); repeats along v, mipmapped. */
function paint(w: number, h: number, fn: (x: number, y: number, out: number[]) => void, wrapU = false) {
  const d = new Uint8Array(w * h * 4), c = [0, 0, 0];
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    fn(x, y, c);
    const o = (y * w + x) * 4;
    d[o] = Math.max(0, Math.min(255, c[0]));
    d[o + 1] = Math.max(0, Math.min(255, c[1]));
    d[o + 2] = Math.max(0, Math.min(255, c[2]));
    d[o + 3] = 255;
  }
  const t = new THREE.DataTexture(d, w, h);
  t.colorSpace = THREE.SRGBColorSpace;
  t.wrapS = wrapU ? THREE.RepeatWrapping : THREE.ClampToEdgeWrapping;
  t.wrapT = THREE.RepeatWrapping;
  t.magFilter = THREE.LinearFilter;
  t.minFilter = THREE.LinearMipmapLinearFilter;
  t.generateMipmaps = true;
  t.anisotropy = 8;
  t.needsUpdate = true;
  return t;
}

/** Asphalt across the 12 u road (u) and 16 u along it (v): fine grain, darker tyre lines, white edge lines inset 0.3 u
 *  and a dashed centre line (4 u dashes). */
function asphaltTexture() {
  const W2 = 128, H2 = 256, pu = W2 / KIT.road, pv = H2 / ROAD_TILE, r = rng(3), blot = lattice(5, 8), fine = lattice(6, 32);
  return paint(W2, H2, (x, y, c) => {
    const d = (x + 0.5) / pu - KIT.road / 2, v = (y + 0.5) / pv, ad = Math.abs(d);
    let k = 62 + 16 * (blot((x / W2) * 8, (y / H2) * 8) - 0.5) + 10 * (fine((x / W2) * 32, (y / H2) * 32) - 0.5) + 18 * (r() - 0.5);
    if (r() < 0.04) k += 26 * r(); // stone chips
    k -= 7 * Math.exp(-(((ad - 2.6) / 0.9) ** 2)); // tyre lines
    let line = 0;
    if (ad > KIT.road / 2 - 0.62 && ad < KIT.road / 2 - 0.3) line = 1;
    if (ad < 0.14 && v % 8 < 4) line = 1;
    if (line) k = 214 + 22 * (r() - 0.5) - 30 * Math.max(0, fine((x / W2) * 32 + 9, (y / H2) * 32) - 0.7);
    c[0] = k; c[1] = k + 2; c[2] = k + 6;
  });
}

/** Packed dirt across the 11 u track and 16 u along: two darker ruts, pebbles, grass creeping in at the edges. */
function dirtTexture() {
  const W2 = 128, H2 = 256, pu = W2 / KIT.dirt, r = rng(9), blot = lattice(11, 8), fine = lattice(12, 32), streak = lattice(13, 64);
  return paint(W2, H2, (x, y, c) => {
    const d = (x + 0.5) / pu - KIT.dirt / 2, ad = Math.abs(d), u = x / W2, v = y / H2;
    let k = 1 + 0.16 * (blot(u * 8, v * 8) - 0.5) + 0.1 * (fine(u * 32, v * 32) - 0.5) + 0.14 * (r() - 0.5);
    const rut = Math.exp(-(((ad - 2.3) / 0.65) ** 2));
    k *= 1 - 0.17 * rut + 0.05 * rut * (streak(u * 8, v * 64) - 0.5);
    let R = 150 * k, G2 = 112 * k, B2 = 72 * k;
    if (r() < 0.035) { const s = r() < 0.6 ? 1.35 : 0.65; R *= s; G2 *= s; B2 *= s; } // pebbles
    const edge = Math.max(0, Math.min(1, (ad - (KIT.dirt / 2 - 0.9)) / 0.9)) * (0.6 + 0.4 * fine(u * 32 + 5, v * 32));
    c[0] = R + (88 - R) * edge * 0.55; c[1] = G2 + (118 - G2) * edge * 0.55; c[2] = B2 + (52 - B2) * edge * 0.55;
  });
}

/** Tileable grass for the verges and banks (world-planar, ~4.3 u per repeat): mottled base and short blade strokes. */
function grassTexture() {
  const N2 = 128, r = rng(17), blot = lattice(19, 4), d = new Float32Array(N2 * N2 * 3);
  for (let y = 0; y < N2; y++) for (let x = 0; x < N2; x++) {
    const k = 1 + 0.18 * (blot((x / N2) * 4, (y / N2) * 4) - 0.5) + 0.12 * (r() - 0.5), o = (y * N2 + x) * 3;
    d[o] = 91 * k; d[o + 1] = 154 * k; d[o + 2] = 59 * k;
  }
  const greens = [[47, 106, 34], [60, 122, 41], [74, 138, 48], [87, 153, 56], [102, 168, 63], [120, 183, 72], [140, 197, 85]];
  for (let b = 0; b < 2600; b++) {
    const g = greens[Math.floor(r() * greens.length)], x0 = r() * N2, y0 = r() * N2, a = r() * Math.PI * 2, len = 2 + r() * 5;
    for (let t = 0; t <= len; t += 0.5) {
      const x = Math.floor(x0 + Math.cos(a) * t + N2) % N2, y = Math.floor(y0 + Math.sin(a) * t + N2) % N2, o = (y * N2 + x) * 3;
      d[o] = g[0]; d[o + 1] = g[1]; d[o + 2] = g[2];
    }
  }
  return paint(N2, N2, (x, y, c) => { const o = (y * N2 + x) * 3; c[0] = d[o]; c[1] = d[o + 1]; c[2] = d[o + 2]; }, true);
}

/** One Lambert material for the whole road mesh. aSurf picks the look per vertex: 0..1 asphalt..dirt (blended, with a
 *  ragged edge where they meet), 2 the mown verge (stripes across every 4 u), 3 the rough bank, 4 the vertex colour alone
 *  (curbs). aUv is (across 0..1, along s / 16) on the road and (out, s) on the verge; the grass is world-planar. */
export function roadMaterial() {
  const tA = asphaltTexture(), tD = dirtTexture(), tG = grassTexture();
  const mat = new THREE.MeshLambertMaterial({ vertexColors: true, polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 2 });
  mat.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, { tAsphalt: { value: tA }, tDirt: { value: tD }, tGrass: { value: tG } });
    sh.vertexShader = sh.vertexShader
      .replace('#include <common>', '#include <common>\nattribute float aSurf;\nattribute vec2 aUv;\nvarying float vSurf;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadPos;')
      .replace('#include <begin_vertex>', '#include <begin_vertex>\nvSurf = aSurf;\nvRoadUv = aUv;')
      .replace('#include <project_vertex>', '#include <project_vertex>\nvRoadPos = ( modelMatrix * vec4( transformed, 1.0 ) ).xyz;');
    sh.fragmentShader = sh.fragmentShader
      .replace('#include <common>', '#include <common>\nuniform sampler2D tAsphalt, tDirt, tGrass;\nvarying float vSurf;\nvarying vec2 vRoadUv;\nvarying vec3 vRoadPos;')
      .replace('#include <map_fragment>', /* glsl */ `
vec3 cA = texture2D( tAsphalt, vRoadUv ).rgb;
vec3 cD = texture2D( tDirt, vRoadUv ).rgb;
vec3 cG = texture2D( tGrass, vRoadPos.xz * 0.23 ).rgb;
float ragged = texture2D( tGrass, vRoadPos.xz * 0.06 ).g;
vec3 road = mix( cA, cD, clamp( vSurf * 1.8 - 0.4 + ( ragged - 0.45 ) * 1.6, 0.0, 1.0 ) );
float stripe = smoothstep( 0.45, 0.55, abs( fract( vRoadUv.y * 0.125 ) - 0.5 ) * 2.0 );
vec3 verge = cG * mix( vec3( 0.74, 0.84, 0.7 ), vec3( 1.12, 1.16, 0.98 ), stripe );
vec3 bank = cG * vec3( 0.82, 0.9, 0.72 );
diffuseColor.rgb *= vSurf < 1.5 ? road : vSurf < 2.5 ? verge : vSurf < 3.5 ? bank : vec3( 1.0 );`);
  };
  mat.customProgramCacheKey = () => 'track-road';
  return mat;
}

/** The road ribbons over each non-plastic run (reaching 0.6 u under the plastic where they meet): per station, from
 *  the left: bank foot, bank top, the strip the bales or tyres stand on, the mown verge, the road, and the same mirrored.
 *  Plus red/white curbs on the inside of the asphalt's corners. Where `bridge(s)` holds the road is a deck on piers, not
 *  an embankment: in place of the bank a concrete fascia BRIDGE.depth deep, and a soffit under the deck (the road below
 *  it stays open). */
export function roadGeometry(frames: TrackFrame[], frameAt: FrameAt, ds: number, road: [number, number][], bridge?: (s: number) => boolean, shade?: (s: number) => number) {
  const G = new Geo(), f = newFrame(), p = v3(), q = v3(), n = v3(), h = v3(), a = v3(), N = frames.length;
  // dirt weight per frame, smoothed over +-6 u of road (not plastic) so the textures blend where asphalt and dirt meet
  const dirt = new Float32Array(N), K = Math.round(6 / ds);
  for (let i = 0; i < N; i++) {
    let sum = 0, cnt = 0;
    for (let j = -K; j <= K; j++) {
      const g = frames[(i + j + N) % N];
      if (g.surface !== 'plastic') { sum += g.surface === 'dirt' ? 1 : 0; cnt++; }
    }
    dirt[i] = cnt ? sum / cnt : 0;
  }
  const dirtAt = (s: number) => dirt[Math.round(s / ds) % N];
  const OVER = 0.6;
  for (const [r0, r1] of road) {
    const st = stations(frameAt, r0 - OVER, r1 + OVER, ds, undefined, 4);
    const base = G.n;
    for (const s of st) {
      frameAt(s, f);
      const e = f.width / 2, hard = hardOf(f), strip = STRIP[f.edge], dw = dirtAt(s), v = s / ROAD_TILE;
      for (const sg of [-1, 1]) {
        // bank: from the strip's outer edge down and out to just under the meadow
        p.copy(f.p).addScaledVector(f.right, sg * (hard + strip));
        h.set(f.right.x * sg, 0, f.right.z * sg).normalize();
        const deck = bridge?.(s) ?? false;
        const drop = p.y - GROUND, run = Math.max(0.8, drop * 1.8);
        if (deck) q.copy(p).addScaledVector(f.up, -BRIDGE.depth); // (a bridge: the fascia straight down)
        else {
          q.copy(p).addScaledVector(h, run);
          q.y = GROUND;
        }
        a.subVectors(q, p);
        if (deck) n.copy(h);
        else {
          n.crossVectors(a, f.t).multiplyScalar(sg).normalize();
          if (n.y < 0) n.negate();
        }
        const verts: [THREE.Vector3, THREE.Vector3, number | THREE.Color, number, number, number][] = [
          deck ? [q.clone(), n.clone(), BRIDGE.dark, 0, 0, 4] : [q.clone(), n.clone(), 0.62, 0, 0, 3],
          deck ? [p.clone(), n.clone(), BRIDGE.face, 0, 0, 4] : [p.clone(), n.clone(), 0.86, 0, 0, 3],
          [v3().copy(f.p).addScaledVector(f.right, sg * hard), f.up, 0.9, 0, 0, 3],
          [v3().copy(f.p).addScaledVector(f.right, sg * hard), f.up, 0.92, hard - e, s, 2],
          [v3().copy(f.p).addScaledVector(f.right, sg * e), f.up, 0.98, 0, s, 2],
          [v3().copy(f.p).addScaledVector(f.right, sg * e), f.up, 1, sg > 0 ? 1 : 0, v, dw],
        ];
        // the strip shares the bank-top vertex's position but faces up: re-emit it flat
        verts.splice(2, 0, deck ? [p.clone(), f.up, BRIDGE.face, 0, 0, 4] : [p.clone(), f.up, 0.86, 0, 0, 3]);
        if (sg > 0) verts.reverse();
        const sh = shade?.(s) ?? 1; // (in a tunnel: the daylight's out of it)
        for (const [pos, nor, ao, u, w, k] of verts) G.v(pos, nor, sh === 1 ? ao : typeof ao === 'number' ? ao * sh : ao.clone().multiplyScalar(sh), u, w, k);
      }
    }
    // per station (left to right): 0 foot, 1 bank top, 2 strip outer, 3 hard (bank), 4 hard (verge), 5 edge (verge),
    // 6 edge (road) | 7 edge (road), 8 edge (verge), 9 hard (verge), 10 hard (bank), 11 strip outer, 12 bank top, 13 foot
    const V = 14;
    for (let r = 0; r < st.length - 1; r++) {
      const A = base + r * V, B = A + V;
      frameAt(st[r], f);
      const sh0 = f.edge === 'grass' && f.shoulder > 0.02;
      frameAt(st[r + 1], f);
      const sh1 = f.edge === 'grass' && f.shoulder > 0.02;
      // (where a bridge meets the embankment the bank stops at its abutment, below: no bank face between the two)
      const cut = !!bridge && bridge(st[r]) !== bridge(st[r + 1]);
      const pairs = cut ? [[2, 3], [6, 7], [10, 11]] : [[0, 1], [2, 3], [6, 7], [10, 11], [12, 13]];
      if (sh0 || sh1) pairs.push([4, 5], [8, 9]);
      for (const [i, j] of pairs) G.idx.push(A + i, A + j, B + j, A + i, B + j, B + i);
      // a bridge's soffit: the fascias' feet joined under the deck (both faces: seen from the road below)
      if (bridge && bridge(st[r]) && bridge(st[r + 1])) G.idx.push(A, A + 13, B + 13, A, B + 13, B, A, B + 13, A + 13, A, B, B + 13);
    }
    // ... and where a bridge meets the embankment, its abutment: the embankment's cross-section closed in concrete
    if (bridge) for (let r = 0; r < st.length - 1; r++) {
      const d0 = bridge(st[r]), d1 = bridge(st[r + 1]);
      if (d0 === d1) continue;
      frameAt(d0 ? st[r + 1] : st[r], f);
      const hard = hardOf(f), strip = STRIP[f.edge], out: THREE.Vector3[] = [];
      for (const sg of [-1, 1]) {
        p.copy(f.p).addScaledVector(f.right, sg * (hard + strip));
        h.set(f.right.x * sg, 0, f.right.z * sg).normalize();
        q.copy(p).addScaledVector(h, Math.max(0.8, (p.y - GROUND) * 1.8));
        q.y = GROUND;
        const side = [q.clone(), p.clone(), v3().copy(f.p).addScaledVector(f.right, sg * hard)];
        out.push(...(sg < 0 ? side : side.reverse()));
      }
      const i0 = G.n;
      G.v(v3(f.p.x, GROUND, f.p.z), f.t, BRIDGE.face, 0, 0, 4);
      for (const o of out) G.v(o, f.t, BRIDGE.face, 0, 0, 4);
      for (let k = 1; k < out.length; k++) G.idx.push(i0, i0 + k, i0 + k + 1, i0, i0 + k + 1, i0 + k);
    }
  }
  // Curbs: red and white blocks on the inside of the asphalt's corners (radius under 70 u), sloping up to the edge.
  const red = col('#d8312a'), white = col('#f0eee8');
  let blocks = 0;
  const curve = runs(frames, ds, (g) => g.surface === 'asphalt' && Math.abs(g.kappa) > 1 / 70);
  for (const [c0, c1] of curve) {
    const sg = Math.sign(frameAt((c0 + c1) / 2, f).kappa);
    if (c1 - c0 < 6) continue;
    const s0 = c0 - 4, s1 = c1 + 4, nb = Math.max(2, Math.round((s1 - s0) / 1.6)), bl = (s1 - s0) / nb;
    for (let b = 0; b < nb; b++) {
      const c = b % 2 ? white : red, i = G.n;
      for (const s of [s0 + b * bl, s0 + (b + 1) * bl]) {
        frameAt(s, f);
        const e = f.width / 2;
        G.v(p.copy(f.p).addScaledVector(f.right, sg * (e - 1.15)).addScaledVector(f.up, 0.012), f.up, c, 0, 0, 4);
        G.v(p.copy(f.p).addScaledVector(f.right, sg * e).addScaledVector(f.up, 0.1), f.up, c, 0, 0, 4);
        G.v(p.copy(f.p).addScaledVector(f.right, sg * (e + 0.02)).addScaledVector(f.up, 0.1), n.copy(f.right).multiplyScalar(sg), c.clone().multiplyScalar(0.8), 0, 0, 4);
        G.v(p.copy(f.p).addScaledVector(f.right, sg * (e + 0.02)).addScaledVector(f.up, -0.03), n, c.clone().multiplyScalar(0.8), 0, 0, 4);
      }
      G.quad(i, i + 1, i + 5, i + 4, frameAt(s0 + (b + 0.5) * bl, f).up);
      G.quad(i + 2, i + 3, i + 7, i + 6, n.copy(f.right).multiplyScalar(sg));
      blocks++;
    }
  }
  return { geo: G.build({ uv: 'aUv', extra: 'aSurf' }), curbs: blocks };
}
