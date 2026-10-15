import * as THREE from 'three';
import type { TrackFrame } from '../types';
import { DEG, col, hardOf, newFrame, v3, type FrameAt } from './kit.ts';

// Hand-built geometry for the track's meshes: growable vertex arrays (Geo), boxes / beams / prisms / lattice columns
// in vertex colours, the runs of the lap where something holds and the ring stations along them, and the split of the
// props into area chunks so the camera only draws the ones in view. And the props' palette.

/** Growable vertex arrays for hand-built geometry. */
export class Geo {
  pos: number[] = []; nor: number[] = []; col: number[] = []; uv: number[] = []; idx: number[] = []; extra: number[] = [];
  get n() { return this.pos.length / 3; }
  v(p: THREE.Vector3, nr: THREE.Vector3, c: number | THREE.Color, u = 0, w = 0, e = 0) {
    this.pos.push(p.x, p.y, p.z);
    this.nor.push(nr.x, nr.y, nr.z);
    if (typeof c === 'number') this.col.push(c, c, c);
    else this.col.push(c.r, c.g, c.b);
    this.uv.push(u, w);
    this.extra.push(e);
  }
  /** Two triangles over 4 verts already pushed (a b c d in order); flips the winding to face along `nr`. */
  quad(a: number, b: number, c: number, d: number, nr: THREE.Vector3) {
    const P = this.pos, e1 = v3().set(P[3 * b] - P[3 * a], P[3 * b + 1] - P[3 * a + 1], P[3 * b + 2] - P[3 * a + 2]);
    const e2 = v3().set(P[3 * c] - P[3 * a], P[3 * c + 1] - P[3 * a + 1], P[3 * c + 2] - P[3 * a + 2]);
    if (e1.cross(e2).dot(nr) >= 0) this.idx.push(a, b, c, a, c, d);
    else this.idx.push(a, c, b, a, d, c);
  }
  build(o: { color?: boolean; uv?: string; extra?: string } = {}) {
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(this.pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(this.nor, 3));
    if (o.color !== false) g.setAttribute('color', new THREE.Float32BufferAttribute(this.col, 3));
    if (o.uv) g.setAttribute(o.uv, new THREE.Float32BufferAttribute(this.uv, 2));
    if (o.extra) g.setAttribute(o.extra, new THREE.Float32BufferAttribute(this.extra, 1));
    g.setIndex(new THREE.BufferAttribute(new Uint32Array(this.idx), 1));
    g.computeBoundingSphere();
    return g;
  }
}

/** Runs of the closed lap where `pred` holds, as [s0, s1] (s1 > s0, and s1 may pass L where a run wraps). */
export function runs(frames: TrackFrame[], ds: number, pred: (f: TrackFrame) => boolean): [number, number][] {
  const N = frames.length, out: [number, number][] = [];
  let i0 = frames.findIndex((f) => !pred(f));
  if (i0 < 0) return [[0, N * ds]];
  let a = -1;
  for (let k = 1; k <= N; k++) {
    const i = i0 + k, on = pred(frames[i % N]);
    if (on && a < 0) a = i;
    if (!on && a >= 0) { out.push([a * ds, (i - 1) * ds]); a = -1; }
  }
  return out;
}

/** Ring positions along [s0, s1]: every frame, thinned where nothing changes (<= `gap` u apart, <= `deg` of turn, width
 *  and limits steady); `dense(s)` forces every frame. With `twist` (deg) a ring also comes every `twist` of roll about
 *  the tangent (a bank easing in or out): a ring-to-ring band of a wide deck is then a twisted quad, and each of its
 *  triangles bulges off the true surface by ~ width / 4 x the twist - on 16-24 u decks at the turn's 4 deg, past the
 *  0.25 u slab, so the underside poked up through the floor in dark slivers (track 2's banked turns). */
export function stations(frameAt: FrameAt, s0: number, s1: number, ds: number, dense: (s: number) => boolean = () => false, deg = 2.5, gap = 3, twist?: number) {
  const cand: number[] = [s0];
  for (let s = Math.ceil(s0 / ds + 1e-6) * ds; s < s1 - 1e-6; s += ds) cand.push(s);
  cand.push(s1);
  const keep = [s0], a = newFrame(), b = newFrame(), cos = Math.cos(deg * DEG), roll = twist ? Math.sin(twist * DEG) : 0;
  // (with `twist`, track 2's wide decks: also a ring wherever the floor between two would stand off the true surface
  // by more than SAG / SAG_FLAT)
  const mid = twist ? newFrame() : null;
  const sag = (sa: number, sb: number) => {
    frameAt((sa + sb) / 2, mid!);
    let worst = 0;
    // the middles of the chords (the two rings' points at the same offset: the edges, the centre) and of the floor quad's
    // diagonals (a twist bulges those) against the surface there, along its normal
    for (const [xa, xb] of [[-0.5, -0.5], [0, 0], [0.5, 0.5], [-0.5, 0.5], [0.5, -0.5]]) {
      const w = mid!.width * (xa + xb) * 0.5, ka = a.width * xa, kb = b.width * xb;
      const dx = 0.5 * (a.p.x + a.right.x * ka + b.p.x + b.right.x * kb) - mid!.p.x - mid!.right.x * w;
      const dy = 0.5 * (a.p.y + a.right.y * ka + b.p.y + b.right.y * kb) - mid!.p.y - mid!.right.y * w;
      const dz = 0.5 * (a.p.z + a.right.z * ka + b.p.z + b.right.z * kb) - mid!.p.z - mid!.right.z * w;
      worst = Math.max(worst, Math.abs(dx * mid!.up.x + dy * mid!.up.y + dz * mid!.up.z));
    }
    return worst;
  };
  const tol = (x: TrackFrame, y: TrackFrame) => (Math.max(Math.abs(x.right.y), Math.abs(y.right.y)) > STEEP ? SAG : SAG_FLAT);
  frameAt(s0, a);
  let ha = hardOf(a);
  for (let i = 1; i < cand.length; i++) {
    frameAt(cand[i], b);
    const hb = hardOf(b);
    if (i === cand.length - 1 || dense(cand[i]) || cand[i] - keep[keep.length - 1] >= gap || a.t.dot(b.t) < cos || a.up.dot(b.up) < cos ||
      Math.abs(hb - ha) > 0.2 || Math.abs(a.width - b.width) > 0.1 || a.edge !== b.edge || a.surface !== b.surface ||
      (roll && Math.abs(a.right.dot(b.up)) > roll) || (mid && sag(keep[keep.length - 1], cand[i]) > tol(a, b))) {
      keep.push(cand[i]);
      frameAt(cand[i], a);
      ha = hb;
    }
  }
  return keep;
}

/** u: the most track 2's wide floor may stand off the true surface between two rings (mid-chord and mid-diagonal) on a
 *  bank past STEEP deg - the wall ride, its band a 70 deg cone, its entry sweeping the outer edge up 25 u: the skid
 *  marks (0.012 u up, lifted there: fx.ts) and the blob shadow were buried under its chords - and elsewhere SAG_FLAT. */
const SAG = 0.012, SAG_FLAT = 0.03, STEEP = Math.sin(35 * DEG);

export const basis = (f: TrackFrame, m: THREE.Matrix4) => m.makeBasis(f.t, f.up, f.right).setPosition(f.p);

/** A box in a local frame (x along t, y up, z right): centre c, size s. `top` colours the +y face. `ends` picks the
 *  y faces drawn: 1 = just the top (nothing sees under the props), 2 = both, 0 = neither (a beam's ends are buried). */
export function box(G: Geo, m: THREE.Matrix4, c: number[], s: number[], side: THREE.Color, top = side, ends = 1) {
  const n3 = new THREE.Matrix3().getNormalMatrix(m), p = v3(), nr = v3();
  for (let ax = 0; ax < 3; ax++) for (const sg of [-1, 1]) {
    if (ax === 1 && (ends === 0 || (sg < 0 && ends === 1))) continue;
    const u = (ax + 1) % 3, w = (ax + 2) % 3, i = G.n;
    nr.set(0, 0, 0).setComponent(ax, sg).applyMatrix3(n3).normalize();
    for (const [a, b] of [[-1, -1], [1, -1], [1, 1], [-1, 1]]) {
      p.set(0, 0, 0).setComponent(ax, c[ax] + (sg * s[ax]) / 2).setComponent(u, c[u] + (a * s[u]) / 2).setComponent(w, c[w] + (b * s[w]) / 2);
      G.v(p.applyMatrix4(m), nr, ax === 1 && sg > 0 ? top : side);
    }
    G.quad(i, i + 1, i + 2, i + 3, nr);
  }
}

/** A box spanning the segment a -> b (its long axis), cross-section w x d, `along` hinting its second axis. Its ends
 *  are left open: they sit in a post, the ground or under the track. */
export function beam(G: Geo, a: THREE.Vector3, b: THREE.Vector3, w: number, d: number, along: THREE.Vector3, c: THREE.Color) {
  const y = v3().subVectors(b, a), len = y.length();
  y.divideScalar(len);
  const z = v3().crossVectors(along, y);
  if (z.lengthSq() < 1e-6) z.set(1, 0, 0).cross(y);
  z.normalize();
  const x = v3().crossVectors(y, z);
  const m = new THREE.Matrix4().makeBasis(x, y, z).setPosition(v3().addVectors(a, b).multiplyScalar(0.5));
  box(G, m, [0, 0, 0], [w, len, d], c, c, 0);
}

/** An n-sided prism standing on y = y0 .. y1 at (x, z) (radius r): sides and a top cap (unless `top` is null). With
 *  `hole` the cap dishes down to a centre of that colour (the hole in a tyre). */
export function prism(G: Geo, x: number, z: number, y0: number, y1: number, r: number, n: number, c: THREE.Color, top: THREE.Color | null, rot = 0, hole?: THREE.Color) {
  const p = v3(), nr = v3();
  for (let k = 0; k < n; k++) {
    const a0 = rot + (k / n) * 2 * Math.PI, a1 = rot + ((k + 1) / n) * 2 * Math.PI, am = (a0 + a1) / 2, i = G.n;
    nr.set(Math.cos(am), 0, Math.sin(am));
    G.v(p.set(x + r * Math.cos(a0), y0, z + r * Math.sin(a0)), nr, c);
    G.v(p.set(x + r * Math.cos(a1), y0, z + r * Math.sin(a1)), nr, c);
    G.v(p.set(x + r * Math.cos(a1), y1, z + r * Math.sin(a1)), nr, c);
    G.v(p.set(x + r * Math.cos(a0), y1, z + r * Math.sin(a0)), nr, c);
    G.quad(i, i + 1, i + 2, i + 3, nr);
  }
  if (!top) return;
  const i = G.n;
  nr.set(0, 1, 0);
  for (let k = 0; k < n; k++) G.v(p.set(x + r * Math.cos(rot + (k / n) * 2 * Math.PI), y1, z + r * Math.sin(rot + (k / n) * 2 * Math.PI)), nr, top);
  if (hole) {
    G.v(p.set(x, y1 - 0.06, z), nr, hole);
    for (let k = 0; k < n; k++) G.idx.push(i + n, i + ((k + 1) % n), i + k);
  } else for (let k = 1; k < n - 1; k++) G.idx.push(i, i + k + 1, i + k);
}

/** A square lattice column centred on (x, z), half-width hw, from y0 to y1: corner posts, a girt every `storey` u and
 *  an X-brace per face and storey (yaw turns it). */
export function column(G: Geo, x: number, z: number, hw: number, y0: number, y1: number, storey: number, c: THREE.Color, c2: THREE.Color, yaw = Math.PI / 4) {
  const UP = v3(0, 1, 0), a = v3(), b = v3(), corners: [number, number][] = [];
  for (let i = 0; i < 4; i++) {
    const ang = yaw + Math.PI / 4 + (i * Math.PI) / 2;
    corners.push([x + Math.cos(ang) * hw * Math.SQRT2, z + Math.sin(ang) * hw * Math.SQRT2]);
  }
  const n = Math.max(1, Math.round((y1 - y0) / storey)), dy = (y1 - y0) / n, post = Math.max(0.5, hw * 0.16);
  for (const [cx, cz] of corners) beam(G, a.set(cx, y0 - 0.2, cz), b.set(cx, y1, cz), post, post, v3(1, 0, 0), c);
  for (let i = 0; i < 4; i++) {
    const [x0, z0] = corners[i], [x1, z1] = corners[(i + 1) % 4];
    for (let k = 0; k <= n; k++) {
      const y = y0 + k * dy;
      if (k > 0) beam(G, a.set(x0, y, z0), b.set(x1, y, z1), post * 0.7, post * 0.7, UP, c);
      if (k < n) {
        beam(G, a.set(x0, y, z0), b.set(x1, y + dy, z1), post * 0.45, post * 0.45, UP, c2);
        beam(G, a.set(x1, y, z1), b.set(x0, y + dy, z0), post * 0.45, post * 0.45, UP, c2);
      }
    }
  }
}

export const m4 = new THREE.Matrix4(), mr = new THREE.Matrix4();
/** A rotation about the local y axis (for boxes in a frame basis that should face the other way). */
export const rotY = (a: number) => mr.makeRotationY(a);

// ---- the palette -------------------------------------------------------------------------------------------------------

export const WOOD = col('#7d5030'), TIMBER = col('#9a6a40'), METAL = col('#a9b2bb'), STONE = col('#a29d94'), STONE2 = col('#8d887f');
export const RUBBER = col('#2b2a2c'), HOLE = col('#0d0d0d'), PAINT = [col('#f1efe9'), col('#d6302a')], STRAW = col('#d8b65c'), STRAW_TOP = col('#e9cd78');
export const BLUE = col('#2a63d4'), BLUE2 = col('#1f4fae'), ORANGE = col('#ff5a12'), YELLOW = col('#ffc21a'), GREY = col('#c4c8cc');

/** Area chunks of the props (~4k triangles each): a chase camera along the lap draws half of them on average. */
export const PROP_CHUNKS = 8;

/** Hand-built geometry split into k area chunks: k-means on the triangles' plan centroids, seeded by farthest points
 *  from the first triangle (the same every load), then each chunk keeps the vertices its triangles use. */
export function chunked(G: Geo, k: number): THREE.BufferGeometry[] {
  const P = G.pos, I = G.idx, nt = I.length / 3;
  const cx = new Float32Array(nt), cz = new Float32Array(nt);
  for (let t = 0; t < nt; t++) {
    const a = 3 * I[3 * t], b = 3 * I[3 * t + 1], c = 3 * I[3 * t + 2];
    cx[t] = (P[a] + P[b] + P[c]) / 3;
    cz[t] = (P[a + 2] + P[b + 2] + P[c + 2]) / 3;
  }
  const mx = [cx[0]], mz = [cz[0]], d2 = new Float32Array(nt).fill(Infinity);
  while (mx.length < k) {
    let bi = 0, bd = -1;
    for (let t = 0; t < nt; t++) {
      const dx = cx[t] - mx[mx.length - 1], dz = cz[t] - mz[mz.length - 1];
      d2[t] = Math.min(d2[t], dx * dx + dz * dz);
      if (d2[t] > bd) (bd = d2[t]), (bi = t);
    }
    mx.push(cx[bi]);
    mz.push(cz[bi]);
  }
  const lab = new Uint8Array(nt);
  for (let it = 0; it < 12; it++) {
    const sx = new Float64Array(k), sz = new Float64Array(k), n = new Float64Array(k);
    for (let t = 0; t < nt; t++) {
      let best = Infinity, bj = 0;
      for (let j = 0; j < k; j++) {
        const dx = cx[t] - mx[j], dz = cz[t] - mz[j], d = dx * dx + dz * dz;
        if (d < best) (best = d), (bj = j);
      }
      lab[t] = bj;
      sx[bj] += cx[t];
      sz[bj] += cz[t];
      n[bj]++;
    }
    for (let j = 0; j < k; j++) if (n[j]) (mx[j] = sx[j] / n[j]), (mz[j] = sz[j] / n[j]);
  }
  const out: THREE.BufferGeometry[] = [];
  const map = new Int32Array(G.n);
  for (let j = 0; j < k; j++) {
    const C = new Geo();
    map.fill(-1);
    for (let t = 0; t < nt; t++) {
      if (lab[t] !== j) continue;
      for (let e = 0; e < 3; e++) {
        const v = I[3 * t + e];
        if (map[v] < 0) {
          map[v] = C.n;
          C.pos.push(P[3 * v], P[3 * v + 1], P[3 * v + 2]);
          C.nor.push(G.nor[3 * v], G.nor[3 * v + 1], G.nor[3 * v + 2]);
          C.col.push(G.col[3 * v], G.col[3 * v + 1], G.col[3 * v + 2]);
        }
        C.idx.push(map[v]);
      }
    }
    if (C.idx.length) out.push(C.build());
  }
  return out;
}
