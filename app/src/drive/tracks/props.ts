import * as THREE from 'three';
import type { TrackFrame } from '../types';
import { BASE, LIP, OUT, STRIP, W, col, hardOf, newFrame, rng, v3, type FrameAt } from './kit.ts';
import { BLUE, HOLE, PAINT, RUBBER, STRAW, STRAW_TOP, YELLOW, Geo, basis, box, prism, runs } from './geo.ts';

// The props along the lap that aren't supports: tyre walls and hay bales at the edges (every course), and the set
// dressing a course's props hook (Course.props) picks from - the start gates, the arches over a big jump's lip, the
// checkpoint arches.

/** Calls place(s, len) every ~`pitch` u along the line `off(f)` u to `side` of the centre line, over each run of
 *  frames where `pred` holds: s is the element's centre, len its share of the line (the pitch, stretched a little so
 *  each run ends on a whole element). */
function lineUp(frames: TrackFrame[], frameAt: FrameAt, ds: number, side: number, pred: (f: TrackFrame) => boolean,
  off: (f: TrackFrame) => number, pitch: number, place: (s: number, len: number) => void) {
  const f = newFrame(), a = v3(), b = v3();
  for (const [r0, r1] of runs(frames, ds, pred)) {
    const len: number[] = [0];
    frameAt(r0, f);
    a.copy(f.p).addScaledVector(f.right, side * off(f));
    for (let s = r0 + ds; s <= r1 + 1e-6; s += ds) {
      frameAt(s, f);
      b.copy(f.p).addScaledVector(f.right, side * off(f));
      len.push(len[len.length - 1] + a.distanceTo(b));
      a.copy(b);
    }
    const total = len[len.length - 1], n = Math.floor(total / pitch);
    if (n < 1) continue;
    const step = total / n;
    for (let k = 0, j = 0; k < n; k++) {
      const want = (k + 0.5) * step;
      while (j < len.length - 2 && len[j + 1] < want) j++;
      const u = (want - len[j]) / Math.max(1e-6, len[j + 1] - len[j]);
      place(r0 + (j + u) * ds, step);
    }
  }
}

/** Tyre stacks along the asphalt's barriers (3 high, the top tyre painted alternately white and red; just the painted
 *  tyre on the inside of a corner, so the apex stays open) and hay bales along the dirt's barriers and at the far edge
 *  of every grass verge. */
export function barriers(G: Geo, frames: TrackFrame[], frameAt: FrameAt, ds: number) {
  const f = newFrame(), m = new THREE.Matrix4(), rot = new THREE.Matrix4(), p = v3(), r = rng(23), c = new THREE.Color(), ct = new THREE.Color();
  let tyres = 0, bales = 0;
  for (const side of [-1, 1]) {
    lineUp(frames, frameAt, ds, side, (g) => g.surface === 'asphalt' && g.edge === 'barrier', (g) => g.width / 2 + 0.6, 1.12, (s) => {
      frameAt(s, f);
      p.copy(f.p).addScaledVector(f.right, side * (f.width / 2 + 0.6));
      const inside = f.kappa * side > 1 / 100, tall = inside ? 0 : 0.72, yaw = Math.atan2(f.t.z, f.t.x);
      const paint = PAINT[tyres % 2];
      if (tall) prism(G, p.x, p.z, p.y - 0.06, p.y + tall, 0.55, 6, RUBBER, null, yaw);
      prism(G, p.x, p.z, tall ? p.y + tall : p.y - 0.06, p.y + tall + 0.36, 0.55, 6, paint, paint, yaw, HOLE);
      tyres++;
    });
    const bale = (s: number, d: number, len: number) => {
      frameAt(s, f);
      f.p.addScaledVector(f.right, side * d);
      const k = 0.86 + 0.24 * r(), hh = 0.8 + 0.08 * r();
      c.copy(STRAW).multiplyScalar(k);
      ct.copy(STRAW_TOP).multiplyScalar(k);
      basis(f, m).multiply(rot.makeRotationY((r() - 0.5) * 0.08));
      box(G, m, [0, hh / 2, 0], [len - 0.32, hh, 1.04], c, ct);
      bales++;
    };
    lineUp(frames, frameAt, ds, side, (g) => g.surface === 'dirt' && g.edge === 'barrier', (g) => g.width / 2 + 0.55, 2.3, (s, len) => bale(s, frameAt(s, f).width / 2 + 0.55, len));
    lineUp(frames, frameAt, ds, side, (g) => g.edge === 'grass' && g.surface !== 'plastic', (g) => hardOf(g) + 0.55, 2.5, (s, len) => bale(s, hardOf(frameAt(s, f)) + 0.55, len));
  }
  return { tyres, bales };
}

/** The start gate at s (the start line): a checkered line across the channel's floor and an arch with a checkered
 *  banner over it. */
export function gate(G: Geo, frameAt: FrameAt, s: number) {
  const f = frameAt(s), m = basis(f, new THREE.Matrix4()), white = col('#f4f4f2'), black = col('#1a1a1c'), red = col('#d62d20');
  box(G, m, [0, 0.015, 0], [1.6, 0.02, 2 * W], white);
  for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2) box(G, m, [-0.4 + j * 0.8, 0.02, -W + 0.5 + i], [0.8, 0.022, 1], black);
  for (const sg of [-1, 1]) box(G, m, [0, 3.6, sg * (OUT + 0.55)], [0.9, 7.7, 0.9], red);
  const span = 2 * OUT + 2.2;
  box(G, m, [0, 6.7, 0], [0.4, 1.8, span], white);
  for (const sx of [-1, 1]) for (let i = 0; i < 8; i++) for (let j = 0; j < 2; j++)
    if ((i + j) % 2) box(G, m, [sx * 0.205, 6.25 + j * 0.9, -span / 2 + (i + 0.5) * (span / 8)], [0.012, 0.9, span / 8], black);
}

/** The arch over a big jump's lip: two red posts standing up from the scaffold beside the channel, a banner across
 *  them in flame bands (red, orange, yellow) with a black rim, in a level frame (the ramp is steep). */
export function launchArch(G: Geo, frameAt: FrameAt, s: number) {
  const f = frameAt(s), t = v3(f.t.x, 0, f.t.z).normalize(), up = v3(0, 1, 0), r = v3().crossVectors(t, up);
  const m = new THREE.Matrix4().makeBasis(t, up, r).setPosition(f.p.x, f.p.y, f.p.z);
  const red = col('#d62d20'), black = col('#1a1a1c'), span = 2 * OUT + 2.4, y0 = -BASE - 0.4, top = 9.4;
  for (const sg of [-1, 1]) box(G, m, [0, (y0 + top) / 2, sg * (span / 2 - 0.45)], [0.9, top - y0, 0.9], red, red, 2);
  box(G, m, [0, top - 1.25, 0], [0.42, 2.5, span - 1.8], black, black, 2);
  const bands = [col('#e23a1e'), col('#ff7a00'), col('#ffc21a')];
  for (let i = 0; i < 3; i++) box(G, m, [0, top - 1.95 + i * 0.7, 0], [0.5, 0.66, span - 2.1], bands[i], bands[i], 0);
}

/** Track 2's start: the checkered line across the whole deck, an arch over it, and the grid - a white bracket painted
 *  in front of each slot (userData.grid). */
export function gateWide(G: Geo, frameAt: FrameAt, s: number, grid: { s: number; d: number }[]) {
  const f = frameAt(s), m = basis(f, new THREE.Matrix4()), white = col('#f4f4f2'), black = col('#1a1a1c'), red = col('#d62d20');
  const w = f.width / 2, o = w + LIP, cells = Math.round(2 * w);
  box(G, m, [0, 0.015, 0], [1.6, 0.02, 2 * w], white);
  for (let i = 0; i < cells; i++) for (let j = 0; j < 2; j++) if ((i + j) % 2) box(G, m, [-0.4 + j * 0.8, 0.02, -w + (2 * w * (i + 0.5)) / cells], [0.8, 0.022, (2 * w) / cells], black);
  // (the posts stand beside the deck, 42 u up: they reach down to a blue cross-beam under it that carries them)
  for (const sg of [-1, 1]) box(G, m, [0, 4.2 - 0.3, sg * (o + 0.6)], [1, 9 + 0.6, 1], red);
  box(G, m, [0, -BASE - 0.3, 0], [1.2, 0.66, 2 * o + 2.4], BLUE, BLUE, 2);
  const span = 2 * o + 2.2;
  box(G, m, [0, 8, 0], [0.45, 2, span], white);
  for (const sx of [-1, 1]) for (let i = 0; i < 12; i++) for (let j = 0; j < 2; j++)
    if ((i + j) % 2) box(G, m, [sx * 0.23, 7.5 + j * 1, -span / 2 + (i + 0.5) * (span / 12)], [0.012, 1, span / 12], black);
  const g = newFrame(), gm = new THREE.Matrix4();
  for (const slot of grid) {
    basis(frameAt(slot.s, g), gm);
    box(G, gm, [2.6, 0.015, slot.d], [0.25, 0.02, 2.4], white); // the line in front of the car
    for (const sd of [-1, 1]) box(G, gm, [2, 0.015, slot.d + sd * 1.15], [1.2, 0.02, 0.2], white);
  }
}

/** The arch over a wide lip (track 2's sky jump): as launchArch, spanning the deck. */
export function launchArchWide(G: Geo, frameAt: FrameAt, s: number) {
  const f = frameAt(s), t = v3(f.t.x, 0, f.t.z).normalize(), up = v3(0, 1, 0), r = v3().crossVectors(t, up);
  const m = new THREE.Matrix4().makeBasis(t, up, r).setPosition(f.p.x, f.p.y, f.p.z);
  const red = col('#d62d20'), black = col('#1a1a1c'), span = f.width + 2 * LIP + 2.4, y0 = -BASE - 0.4, top = 11;
  for (const sg of [-1, 1]) box(G, m, [0, (y0 + top) / 2, sg * (span / 2 - 0.45)], [0.9, top - y0, 0.9], red, red, 2);
  box(G, m, [0, top - 1.25, 0], [0.42, 2.5, span - 1.8], black, black, 2);
  const bands = [col('#e23a1e'), col('#ff7a00'), col('#ffc21a')];
  for (let i = 0; i < 3; i++) box(G, m, [0, top - 1.95 + i * 0.7, 0], [0.5, 0.66, span - 2.1], bands[i], bands[i], 0);
}

/** A checkpoint arch over the track at s (a Trackmania touch): two blue posts, a yellow-and-black banner. */
export function checkpoint(G: Geo, frameAt: FrameAt, s: number) {
  const f = frameAt(s), t = v3(f.t.x, 0, f.t.z).normalize(), up = v3(0, 1, 0), r = v3().crossVectors(t, up);
  const m = new THREE.Matrix4().makeBasis(t, up, r).setPosition(f.p.x, f.p.y, f.p.z);
  const half = f.width / 2 + (f.edge === 'grass' ? f.shoulder : 0) + 1.6, top = 8.5, black = col('#1a1a1c');
  // on a deck up in the air (the in-run's) the posts reach down to a cross-beam under it that carries them
  const high = f.p.y > 3, y0 = high ? -BASE - 0.7 : -0.4;
  for (const sg of [-1, 1]) box(G, m, [0, (top + y0) / 2, sg * half], [0.8, top - y0, 0.8], BLUE, BLUE, 2);
  if (high) box(G, m, [0, -BASE - 0.32, 0], [1, 0.76, 2 * half + 0.8], BLUE, BLUE, 2);
  box(G, m, [0, top - 0.8, 0], [0.4, 1.6, 2 * half + 0.8], black, black, 2);
  const k = Math.round(half / 1.2);
  for (const sx of [-1, 1]) for (let i = 0; i < 2 * k; i += 2) box(G, m, [sx * 0.21, top - 0.8, -half + ((i + 0.5) * half) / k], [0.012, 1.2, half / k], YELLOW);
}
