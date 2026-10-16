import type { TrackFrame } from '../types';
import type { Course } from './course.ts';
import { BASE, DEG, KIT, OUT, STRIP, hardOf, newFrame, smooth, v3, type Key, type Style } from './kit.ts';
import type { Path } from './path.ts';

// From a course's layout to its frame table: the closure solve (the two free straights that close the lap exactly -
// position, tangent and up), the ground clearance and humps (settle), and the resample every 0.5 u. Style keys along s
// give every frame its width, surface, edge and verge: width and verge blend between keys, surface and edge switch at
// them, and every change keeps the hard limit (width / 2 + verge) continuous.

/** Style at s from the sorted keys (width and verge blend between keys; surface and edge come from the key at or
 *  before s). The lap wraps: before the first key the last one holds. */
export function styler(keys: Key[], L: number) {
  return (s: number, out: Style) => {
    let lo = 0, hi = keys.length - 1;
    if (s < keys[0].s) lo = hi;
    else {
      while (hi - lo > 1) { const m = (lo + hi) >> 1; if (keys[m].s <= s) lo = m; else hi = m; }
      if (keys[hi].s <= s) lo = hi;
    }
    const a = keys[lo], b = keys[(lo + 1) % keys.length];
    const sb = b.s + (lo + 1 === keys.length ? L : 0), sa = a.s - (s < a.s ? L : 0);
    const u = sb - sa > 1e-6 ? smooth(Math.min(1, Math.max(0, (s - sa) / (sb - sa)))) : 0;
    out.surface = a.surface;
    out.edge = a.edge;
    out.width = a.width + (b.width - a.width) * u;
    out.shoulder = a.shoulder + (b.shoulder - a.shoulder) * u;
    return out;
  };
}

/** Ground clearance and the dirt's humps. A banked turn tips one edge of its cross-section (the channel's base, or the
 *  road's verge) toward the meadow: lift the centre line just enough to keep that edge above it, spread out (dilate 24 u,
 *  then two 24 u box filters) so the lift is gentle and never a launch crest. The humps go on top. Then s, t and up are
 *  recomputed from the lifted points, and everything keyed along s moves with the (slightly longer) arc length. With
 *  `wide` the plastic's edge is where its width puts it (track 2's wide decks); without, the channel's (the meadow's
 *  plastic is never banked wide, and its numbers stay exactly as they were). */
function settle(P: Path, wide = false) {
  const d = P.d, n = d.length / 10, L = d[(n - 1) * 10], G = Math.round(L / 0.5), h = L / G;
  const bad = P.keys.findIndex((k, i) => i > 0 && k.s < P.keys[i - 1].s - 1e-6);
  if (bad > 0) console.warn(`track: style changes overlap (a key at s ${P.keys[bad].s.toFixed(1)} before one at ${P.keys[bad - 1].s.toFixed(1)})`);
  const keys = [...P.keys].sort((a, b) => a.s - b.s), style = styler(keys, L), st: Style = { ...keys[0] };
  const need = new Float32Array(G).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = i * 10, tx = d[o + 4], tz = d[o + 6], ux = d[o + 7], uy = d[o + 8], uz = d[o + 9];
    const ry = Math.abs(tz * ux - tx * uz); // |(t x up).y|
    style(d[o], st);
    const low = st.surface === 'plastic' ? 0.05 + (wide ? st.width / 2 + KIT.lip : OUT) * ry + BASE * uy : 0.15 + (hardOf(st) + STRIP[st.edge]) * ry;
    const k = Math.round(d[o] / h) % G;
    need[k] = Math.max(need[k], low - d[o + 2]);
  }
  const R = Math.round(12 / h), Wn = 2 * R + 1;
  /** Max over the window [k - R, k + R] of the closed lap: a sliding-window maximum over a deque of candidate cells
   *  (O(G)). Cell j + R enters as the window centre reaches j. */
  const dilate = (src: Float32Array) => {
    const out = new Float32Array(G), q = new Int32Array(G + Wn);
    let head = 0, tail = 0;
    for (let j = -2 * R; j < G; j++) {
      const v = src[(j + R + G) % G];
      while (tail > head && src[(q[tail - 1] + G) % G] <= v) tail--;
      q[tail++] = j + R;
      while (q[head] < j - R) head++;
      if (j >= 0) out[j] = src[(q[head] + G) % G];
    }
    return out;
  };
  /** Mean over the same window (a running sum, O(G)). */
  const blur = (src: Float32Array) => {
    const out = new Float32Array(G);
    let a = 0;
    for (let j = -R; j <= R; j++) a += src[(j + G) % G];
    for (let k = 0; k < G; k++) {
      out[k] = a / Wn;
      a += src[(k + R + 1) % G] - src[(k - R + G) % G];
    }
    return out;
  };
  let lift = need.map((x) => Math.max(0, x));
  if (lift.some((x) => x > 0)) lift = blur(blur(dilate(dilate(lift)))); // dilate 24 u, then smooth
  for (const b of P.humps) {
    const len = b.s1 - b.s0, m = Math.max(1, Math.round(len / b.wave));
    for (let k = Math.ceil(b.s0 / h); k * h < b.s1; k++) lift[k % G] += b.amp * 0.5 * (1 - Math.cos((2 * Math.PI * m * (k * h - b.s0)) / len));
  }
  const at = (s: number) => { const u = s / h, k = Math.floor(u), a = u - k; return lift[k % G] * (1 - a) + lift[(k + 1) % G] * a; };
  const olds = new Float64Array(n);
  for (let i = 0; i < n; i++) { olds[i] = d[i * 10]; d[i * 10 + 2] += at(d[i * 10]); }
  for (let i = 1; i < n; i++) { const o = i * 10, q = o - 10; d[o] = d[q] + Math.hypot(d[o + 1] - d[q + 1], d[o + 2] - d[q + 2], d[o + 3] - d[q + 3]); }
  const t = v3(), up = v3();
  const tans = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = (i === 0 ? n - 2 : i - 1) * 10, b = (i === n - 1 ? 1 : i + 1) * 10;
    t.set(d[b + 1] - d[a + 1], d[b + 2] - d[a + 2], d[b + 3] - d[a + 3]).normalize();
    tans[i * 3] = t.x; tans[i * 3 + 1] = t.y; tans[i * 3 + 2] = t.z;
  }
  for (let i = 0; i < n; i++) {
    const o = i * 10;
    t.set(tans[i * 3], tans[i * 3 + 1], tans[i * 3 + 2]);
    up.set(d[o + 7], d[o + 8], d[o + 9]);
    up.addScaledVector(t, -up.dot(t)).normalize();
    d[o + 4] = t.x; d[o + 5] = t.y; d[o + 6] = t.z; d[o + 7] = up.x; d[o + 8] = up.y; d[o + 9] = up.z;
  }
  const remap = (s: number) => {
    let lo = 0, hi = n - 1;
    while (hi - lo > 1) { const m = (lo + hi) >> 1; if (olds[m] <= s) lo = m; else hi = m; }
    const a = (s - olds[lo]) / Math.max(1e-9, olds[hi] - olds[lo]);
    return d[lo * 10] + (d[hi * 10] - d[lo * 10]) * a;
  };
  for (const g of P.tags) { g.s0 = remap(g.s0); g.s1 = remap(g.s1); }
  for (const g of P.sup) { g.s0 = remap(g.s0); g.s1 = remap(g.s1); }
  for (const g of P.splits) { g.s0 = remap(g.s0); g.s1 = remap(g.s1); }
  for (const k of keys) k.s = remap(Math.min(k.s, L));
  P.keys = keys;
}

/** Builds the closed centre line and its frame table (no meshes; tracks/build.ts adds those). */
export function framesOf(course: Course) {
  const lay = course.layout;
  const base = lay(0, 0);
  const [a, b] = base.free, ex = -base.pose.x, ez = -base.pose.z, det = a.x * b.z - a.z * b.x;
  const A = (ex * b.z - ez * b.x) / det, B = (a.x * ez - a.z * ex) / det;
  if (!(A > 2 && B > 2)) console.warn(`track: closure straights A=${A.toFixed(1)} B=${B.toFixed(1)} too short`);
  const P = lay(A, B);
  const turned = P.pose.yaw / DEG;
  settle(P, course.wide);
  const d = P.d, n = d.length / 10, L = d[(n - 1) * 10];
  const N = Math.round(L / 0.5), ds = L / N;
  const style = styler(P.keys, L);
  const frames: TrackFrame[] = [];
  const pb = v3();
  for (let i = 0, j = 0; i < N; i++) {
    const s = i * ds;
    while (j < n - 2 && d[(j + 1) * 10] <= s) j++;
    const o = j * 10, q = o + 10, u = (s - d[o]) / (d[q] - d[o]);
    const f = newFrame();
    f.s = s;
    f.p.set(d[o + 1], d[o + 2], d[o + 3]).lerp(pb.set(d[q + 1], d[q + 2], d[q + 3]), u);
    f.t.set(d[o + 4], d[o + 5], d[o + 6]).lerp(pb.set(d[q + 4], d[q + 5], d[q + 6]), u).normalize();
    f.up.set(d[o + 7], d[o + 8], d[o + 9]).lerp(pb.set(d[q + 7], d[q + 8], d[q + 9]), u);
    f.up.addScaledVector(f.t, -f.up.dot(f.t)).normalize();
    f.right.crossVectors(f.t, f.up).normalize();
    style(s, f);
    frames.push(f);
  }
  const dt = v3();
  for (let i = 0; i < N; i++) {
    const f = frames[i];
    dt.subVectors(frames[(i + 1) % N].t, frames[(i + N - 1) % N].t).divideScalar(2 * ds);
    f.kappa = dt.dot(f.right);
    f.kappaN = -dt.dot(f.up);
  }
  const e = (n - 1) * 10;
  const seam = {
    pos: Math.hypot(d[e + 1] - d[1], d[e + 2] - d[2], d[e + 3] - d[3]),
    tan: Math.hypot(d[e + 4] - d[4], d[e + 5] - d[5], d[e + 6] - d[6]),
    up: Math.hypot(d[e + 7] - d[7], d[e + 8] - d[8], d[e + 9] - d[9]),
  };
  let minDot = 1;
  for (let i = 0; i < N; i++) minDot = Math.min(minDot, frames[i].up.dot(frames[(i + 1) % N].up));
  if (minDot <= 0.99) console.warn(`track: neighbouring up vectors diverge (min dot ${minDot.toFixed(4)})`);
  if (seam.pos > 1e-3 || seam.tan > 1e-4 || seam.up > 1e-4) console.warn('track: lap does not close', seam);
  return { frames, L, N, ds, tags: P.tags, sup: P.sup, keys: P.keys, splits: P.splits, seam, minDot, free: { A, B }, turned };
}
