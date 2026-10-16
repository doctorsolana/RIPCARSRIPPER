import * as THREE from 'three';
import type { TrackFrame, TrackSplit } from '../types';
import { BASE, LIP, newFrame, rng, v3, type FrameAt, type Range, type Span } from './kit.ts';
import { BLUE, BLUE2, GREY, METAL, ORANGE, STONE, STONE2, TIMBER, WOOD, Geo, basis, beam, box, column, prism } from './geo.ts';

// What holds the raised track up, by kind along s (Path.support): the built-in kinds below, any course can use; a
// course adds its own kinds through Course.supports (the Sky Tower's spire: tracks/sky.ts).

/** The built-in support kinds (a course's own kinds are any other name, with a hook in Course.supports). */
export type Support = 'tower' | 'trestle' | 'scaffold' | 'pillar' | 'loop' | 'rig' | 'pylons' | 'stilts' | 'climb' | (string & {});

/** A course's own support kind: draws into G over sp, and pushes the centre-line points it stands under to posts. */
export type SupportHook = (G: Geo, frameAt: FrameAt, sp: Range<Support>, o: { tags: Span[]; frames: TrackFrame[]; posts: [number, number][]; inGap: (s: number, pad: number) => boolean }) => void;

/** A support's footprint on the ground (centre, unit axis along the track, half extents along / across, top height).
 *  The outdoor supports are open frames, so none is listed today (userData.stacks = []); `posts` carries them. */
export interface Stack { x: number; z: number; ax: number; az: number; hx: number; hz: number; h: number }

/** Outdoor supports under the raised plastic, by kind along s: the wooden start tower under the gate, wooden trestles
 *  (A-frames) under the drop, galvanised scaffolding under the kicker and its landing, tall scaffold towers under the
 *  big jump's ramps, stone pillars under the climb, and two scaffold poles holding the loop - and track 2's: the Sky
 *  Tower's toy stilts under the wide decks, the pylons and the climb's rig; its scaffolds are painted `metal` (the toy's
 *  blue). `start`: the start line's s (the start tower's middle bent); a kind not built in is the course's own (`hooks`).
 *  Returns the world-shadow hints: `posts` are the centre-line points over each support. */
export function supports(G: Geo, frameAt: FrameAt, sup: Range<Support>[], tags: Span[], metal: THREE.Color = METAL, frames: TrackFrame[] = [],
  start = 0, hooks: Record<string, SupportHook> = {}, split?: TrackSplit) {
  const f = newFrame(), m = new THREE.Matrix4(), a = v3(), b = v3(), r = rng(29);
  const posts: [number, number][] = [];
  const bottom = (h: TrackFrame) => h.p.y - BASE * h.up.y; // underside of the channel
  const out = (h: TrackFrame) => h.width / 2 + LIP; // outer face of its rails
  const gaps = tags.filter((t) => t.tag === 'gap');
  const side = (h: TrackFrame, sg: number, d: number, down: number, o: THREE.Vector3) => o.copy(h.p).addScaledVector(h.right, sg * d).addScaledVector(h.up, -down);
  const UP = v3(0, 1, 0);
  for (const sp of sup) {
    const inside = gaps.filter((g) => g.s0 > sp.s0 && g.s1 < sp.s1); // the gaps this support spans (none stands in one)
    const inGap = (s: number, pad: number) => inside.some((g) => s > g.s0 - pad && s < g.s1 + pad);
    if (sp.kind === 'tower') {
      // Four bents of chunky posts, headers under the channel, stringers along it, girts and X-braces between.
      const S = [sp.s0 + 1, start, (start + sp.s1 - 0.5) / 2, sp.s1 - 0.5];
      const tops: THREE.Vector3[][] = [];
      for (const s of S) {
        frameAt(s, f);
        const top = bottom(f) - 0.62;
        const row: THREE.Vector3[] = [];
        for (const sg of [-1, 1]) {
          side(f, sg, out(f) + 0.55, 0, a);
          box(G, m.makeTranslation(a.x, (top - 0.2) / 2, a.z), [0, 0, 0], [0.9, top + 0.2, 0.9], WOOD, TIMBER);
          row.push(v3(a.x, top, a.z));
        }
        tops.push(row);
        box(G, basis(f, m), [0, -BASE - 0.32, 0], [0.75, 0.6, 2 * out(f) + 2.3], TIMBER);
        posts.push([f.p.x, f.p.z]);
      }
      frameAt((sp.s0 + sp.s1) / 2, f);
      for (const sg of [-1, 1]) box(G, basis(f, m), [0, -BASE - 0.12, sg * 2.4], [sp.s1 - sp.s0, 0.22, 0.5], TIMBER); // stringers
      for (let i = 0; i < S.length - 1; i++) for (const k of [0, 1]) {
        const p0 = tops[i][k], p1 = tops[i + 1][k];
        for (const y of [p0.y * 0.36, p0.y * 0.72]) beam(G, a.set(p0.x, y, p0.z), b.set(p1.x, y, p1.z), 0.32, 0.4, v3(0, 1, 0), TIMBER);
        beam(G, a.set(p0.x, 0.2, p0.z), b.set(p1.x, p1.y - 0.4, p1.z), 0.3, 0.3, v3(0, 1, 0), WOOD);
        beam(G, a.set(p1.x, 0.2, p1.z), b.set(p0.x, p0.y - 0.4, p0.z), 0.3, 0.3, v3(0, 1, 0), WOOD);
      }
      for (const row of tops) beam(G, a.set(row[0].x, row[0].y * 0.5, row[0].z), b.set(row[1].x, row[1].y * 0.5, row[1].z), 0.32, 0.4, v3(0, 1, 0), TIMBER);
    } else if (sp.kind === 'trestle') {
      for (let s = sp.s0 + 3; s < sp.s1; s += 8) {
        frameAt(s, f);
        const H = bottom(f) - 0.45;
        if (H < 0.9) continue;
        box(G, basis(f, m), [0, -BASE - 0.22, 0], [0.55, 0.44, 2 * out(f) + 1.3], TIMBER);
        const feet: THREE.Vector3[] = [], heads: THREE.Vector3[] = [];
        for (const sg of [-1, 1]) {
          const head = side(f, sg, out(f) + 0.25, BASE + 0.4, v3());
          const foot = side(f, sg, out(f) + 0.8 + 0.12 * H, 0, v3());
          foot.y = -0.2;
          beam(G, foot, head, 0.42, 0.42, f.t, WOOD);
          feet.push(foot);
          heads.push(head);
        }
        for (const k of H > 6 ? [0.3, 0.7] : [0.45]) {
          a.lerpVectors(feet[0], heads[0], k);
          b.lerpVectors(feet[1], heads[1], k);
          beam(G, a, b, 0.3, 0.3, f.t, TIMBER);
        }
        posts.push([f.p.x, f.p.z]);
      }
    } else if (sp.kind === 'scaffold') {
      let prev: THREE.Vector3[] | null = null, prevS = -99, flip = 1;
      const at: number[] = [];
      for (let s = sp.s0 + 3; s < sp.s1; s += 7) at.push(s);
      for (const g of inside) at.push(g.s0 - 0.7, g.s1 + 0.7);
      at.sort((x, y) => x - y);
      for (const s of at) {
        if (inGap(s, 0.6)) continue;
        frameAt(s, f);
        const H = bottom(f) - 0.3;
        if (H < 0.7) { prev = null; continue; }
        box(G, basis(f, m), [0, -BASE - 0.15, 0], [0.3, 0.3, 2 * out(f) + 0.9], metal);
        const tops: THREE.Vector3[] = [];
        for (const sg of [-1, 1]) {
          const top = side(f, sg, out(f) + 0.3, BASE + 0.15, v3());
          const foot = v3(top.x, -0.2, top.z);
          beam(G, foot, top, 0.24, 0.24, f.t, metal);
          box(G, m.makeTranslation(foot.x, -0.1, foot.z), [0, 0, 0], [0.7, 0.2, 0.7], metal); // base plate
          tops.push(top);
        }
        if (prev && s - prevS < 9) {
          for (let k = 0; k < 2; k++) {
            const h0 = Math.min(prev[k].y, tops[k].y) * 0.5;
            beam(G, a.set(prev[k].x, h0, prev[k].z), b.set(tops[k].x, h0, tops[k].z), 0.18, 0.18, v3(0, 1, 0), metal);
            if (flip > 0) beam(G, a.set(prev[k].x, 0.2, prev[k].z), b.set(tops[k].x, tops[k].y - 0.3, tops[k].z), 0.16, 0.16, v3(0, 1, 0), metal);
            else beam(G, a.set(tops[k].x, 0.2, tops[k].z), b.set(prev[k].x, prev[k].y - 0.3, prev[k].z), 0.16, 0.16, v3(0, 1, 0), metal);
          }
          flip = -flip;
        }
        prev = tops;
        prevS = s;
        posts.push([f.p.x, f.p.z]);
      }
    } else if (sp.kind === 'rig') {
      // The big jump's tall scaffold: bents every ~6 u - a standard each side (and one under the middle of the wide
      // landing ramp), a transom under the channel - with ledgers every 4 u of height and a diagonal per bay along
      // each side, X-braces across every bent over 5 u tall; a bent 3 u in from each edge of the gap pairs with the one
      // at the edge into a tower, braced on all four faces.
      const at: number[] = [];
      for (let s = sp.s0 + 5; s < sp.s1 - 3; s += 6) at.push(s);
      for (const g of inside) at.push(g.s0 - 0.6, g.s0 - 3.6, g.s1 + 0.6, g.s1 + 3.6);
      at.sort((x, y) => x - y);
      const tower = (s: number) => inside.some((g) => (s > g.s0 - 4 && s < g.s0) || (s > g.s1 && s < g.s1 + 4));
      let prev: { s: number; tops: THREE.Vector3[] } | null = null, flip = 1;
      for (const s of at) {
        if (inGap(s, 0.5) || (prev && s - prev.s < 2.4 && !(tower(s) && tower(prev.s)))) continue;
        frameAt(s, f);
        if (bottom(f) < 1.1) {
          prev = null;
          continue;
        }
        const o = out(f) + 0.25;
        box(G, basis(f, m), [0, -BASE - 0.17, 0], [0.34, 0.34, 2 * o + 0.8], metal); // transom
        const tops: THREE.Vector3[] = [];
        // a standard each side, one under the middle of a wide deck - and on track 2's widest (past 16 u) one every ~10 u
        const n = f.width > 16.5 ? Math.max(3, Math.round(o / 6.5) + 1) : f.width > 10 ? 3 : 2;
        for (let i = 0; i < n; i++) {
          const d = -o + (2 * o * i) / (n - 1);
          const top = side(f, 1, d, BASE + 0.34, v3()), foot = v3(top.x, -0.2, top.z);
          beam(G, foot, top, 0.26, 0.26, f.t, metal);
          box(G, m.makeTranslation(foot.x, -0.1, foot.z), [0, 0, 0], [0.75, 0.2, 0.75], metal); // base plate
          tops.push(top);
        }
        // X-braces across the bent, between neighbouring standards, ~5 u of height each (the outer bays of a wider one)
        for (let i = 0; i < tops.length - 1; i++) {
          if (i > 0 && i < tops.length - 2) continue;
          const p0 = tops[i], p1 = tops[i + 1], hTop = Math.min(p0.y, p1.y) - 0.4, n = Math.floor(hTop / 5);
          for (let k = 0; k < n; k++) {
            const y0 = 0.3 + (k * (hTop - 0.3)) / n, y1 = 0.3 + ((k + 1) * (hTop - 0.3)) / n;
            beam(G, a.set(p0.x, y0, p0.z), b.set(p1.x, y1, p1.z), 0.14, 0.14, f.t, metal);
            beam(G, a.set(p0.x, y1, p0.z), b.set(p1.x, y0, p1.z), 0.14, 0.14, f.t, metal);
          }
        }
        if (prev && s - prev.s < 8.5 && prev.tops.length === tops.length) {
          const both = tower(s) && tower(prev.s);
          for (let k = 0; k < tops.length; k++) {
            if (k > 0 && k < tops.length - 1 && !both) continue; // the middle lines only brace the towers
            const p0 = prev.tops[k], p1 = tops[k], hTop = Math.min(p0.y, p1.y) - 0.5;
            for (let y = 4; y < hTop; y += 4) beam(G, a.set(p0.x, y, p0.z), b.set(p1.x, y, p1.z), 0.16, 0.16, UP, metal); // ledgers
            if (both) {
              // a tower: X-braced, ~5 u of height each
              const n = Math.max(1, Math.floor(hTop / 5));
              for (let i = 0; i < n; i++) {
                const y0 = 0.3 + (i * (hTop - 0.3)) / n, y1 = 0.3 + ((i + 1) * (hTop - 0.3)) / n;
                beam(G, a.set(p0.x, y0, p0.z), b.set(p1.x, y1, p1.z), 0.14, 0.14, UP, metal);
                beam(G, a.set(p0.x, y1, p0.z), b.set(p1.x, y0, p1.z), 0.14, 0.14, UP, metal);
              }
            } else if (flip > 0) beam(G, a.set(p0.x, 0.3, p0.z), b.set(p1.x, p1.y - 0.4, p1.z), 0.15, 0.15, UP, metal);
            else beam(G, a.set(p1.x, 0.3, p1.z), b.set(p0.x, p0.y - 0.4, p0.z), 0.15, 0.15, UP, metal);
          }
          flip = -flip;
        }
        prev = { s, tops };
        posts.push([f.p.x, f.p.z]);
      }
    } else if (sp.kind === 'pillar') {
      for (let s = sp.s0 + 8; s < sp.s1 - 2; s += 11) {
        frameAt(s, f);
        if (bottom(f) < 1.1) continue;
        box(G, basis(f, m), [0, -BASE - 0.2, 0], [1.5, 0.4, 2 * out(f) + 0.7], STONE2);
        const top = f.p.y - (BASE + 0.25) * f.up.y, yaw = Math.atan2(f.t.z, f.t.x), k = 0.92 + 0.14 * r();
        prism(G, f.p.x, f.p.z, -0.1, top, 0.72, 8, STONE.clone().multiplyScalar(k), STONE.clone().multiplyScalar(k), yaw);
        box(G, m.makeRotationY(-yaw).setPosition(f.p.x, 0.25, f.p.z), [0, 0, 0], [2, 0.7, 2], STONE2);
        posts.push([f.p.x, f.p.z]);
      }
    } else if (sp.kind === 'pylons') pylons(G, frameAt, sp, posts);
    else if (sp.kind === 'stilts') {
      // (a split's lanes stand on their own stilts: tracks/build.ts)
      stilts(G, frameAt, sp, split ? (s, pad) => inGap(s, pad) || (s > split.nose - 2 && s < split.tail + 2) : inGap, posts, frames);
    }
    else if (sp.kind === 'climb') climbRig(G, frameAt, sp, frames, posts);
    else if (sp.kind === 'loop') {
      // Two poles hold the loop at its front and back (outside the channel), clamped to its base.
      for (const u of [0.25, 0.75]) {
        frameAt(sp.s0 + (sp.s1 - sp.s0) * u, f);
        a.copy(f.p).addScaledVector(f.up, -(BASE + 0.32));
        beam(G, v3(a.x, -0.2, a.z), v3(a.x, a.y + 0.6, a.z), 0.4, 0.4, f.right, metal);
        box(G, basis(f, m), [0, -BASE - 0.15, 0], [0.9, 0.3, 2 * out(f) + 0.5], metal);
        box(G, m.makeTranslation(a.x, -0.05, a.z), [0, 0, 0], [1.2, 0.3, 1.2], metal);
        posts.push([a.x, a.z]);
      }
    } else if (hooks[sp.kind]) hooks[sp.kind](G, frameAt, sp, { tags, frames, posts, inGap });
    else console.warn(`track: no support of kind '${sp.kind}'`);
  }
  return { posts };
}

/** Blue lattice pylons under tall plastic (track 2's plunge): a slim column every ~16 u under the centre line, a
 *  transom across the floor on top of each; posts (stilts) where it runs low. */
export function pylons(G: Geo, frameAt: FrameAt, sp: Range<Support>, posts: [number, number][]) {
  const f = newFrame(), m = new THREE.Matrix4();
  for (let s = sp.s0 + 6; s < sp.s1 - 4; s += 16) {
    frameAt(s, f);
    // on a slope the column's level top would poke through the floor ahead: it stops short by its footprint's fall,
    // and the transom deepens to meet it
    const sink = 2.2 * Math.SQRT2 * (Math.abs(f.t.y) / Math.max(0.3, Math.sqrt(1 - f.t.y * f.t.y))), deep = 0.6 + sink;
    const top = f.p.y - (BASE + deep) * f.up.y;
    if (top < 2) continue;
    box(G, basis(f, m), [0, -BASE - deep / 2, 0], [1.2, deep, f.width + 2 * LIP + 0.8], BLUE2);
    column(G, f.p.x, f.p.z, 2.2, 0, top, 6, BLUE, BLUE2, Math.atan2(f.t.z, f.t.x));
    posts.push([f.p.x, f.p.z]);
  }
}

/** Toy stilts under the wide raised plastic: every ~9 u of s a transom under the floor and blue posts across it (one
 *  every ~8 u of its width, the edges included) down to the meadow, an X-brace between neighbours on the tall ones.
 *  Where the course passes underneath (track 2's dive under the deck) no post stands on it: the deck spans it. */
export function stilts(G: Geo, frameAt: FrameAt, sp: Range<Support>, inGap: (s: number, pad: number) => boolean, posts: [number, number][], frames: TrackFrame[] = []) {
  const f = newFrame(), m = new THREE.Matrix4(), a = v3(), b = v3(), UP = v3(0, 1, 0);
  // a post at (x, z) from y down: through the track below (elsewhere on the lap), 1.5 u clear of its rails?
  const under = (x: number, y: number, z: number, s: number) => frames.some((g) => g.p.y < y - 1 && Math.abs(g.s - s) > 40 &&
    Math.abs(g.p.x - x) < 40 && Math.abs(g.p.z - z) < 40 && Math.hypot(g.p.x - x, g.p.z - z) < g.width / 2 + LIP + 1.5);
  for (let s = sp.s0 + 4; s < sp.s1 - 2; s += 9) {
    if (inGap(s, 1)) continue;
    frameAt(s, f);
    const o = f.width / 2 + LIP, low = Math.min(f.p.y + f.right.y * o, f.p.y - f.right.y * o) - BASE * f.up.y;
    if (low < 0.9) continue;
    const n = Math.max(2, Math.ceil((2 * o) / 8) + 1), tops: THREE.Vector3[] = [];
    let span = false; // (a post left out: no brace across the track below)
    for (let i = 0; i < n; i++) {
      const d = -o + 0.2 + ((2 * o - 0.4) * i) / (n - 1);
      const top = v3().copy(f.p).addScaledVector(f.right, d).addScaledVector(f.up, -BASE - 0.4);
      if (top.y < 0.6) continue;
      if (under(top.x, top.y, top.z, s)) { span = true; continue; }
      if (!tops.length) box(G, basis(f, m), [0, -BASE - 0.2, 0], [0.5, 0.4, 2 * o + 0.6], BLUE2);
      beam(G, a.set(top.x, -0.2, top.z), top, 0.55, 0.55, f.t, BLUE);
      box(G, m.makeTranslation(top.x, -0.05, top.z), [0, 0, 0], [1, 0.3, 1], GREY);
      tops.push(top);
    }
    for (let i = 0; i < tops.length - 1 && !span; i++) {
      const p0 = tops[i], p1 = tops[i + 1], h = Math.min(p0.y, p1.y) - 0.5;
      if (h < 5) continue;
      beam(G, a.set(p0.x, 0.4, p0.z), b.set(p1.x, h, p1.z), 0.25, 0.25, UP, BLUE2);
      beam(G, a.set(p1.x, 0.4, p1.z), b.set(p0.x, h, p0.z), 0.25, 0.25, UP, BLUE2);
    }
    if (tops.length) posts.push([f.p.x, f.p.z]);
  }
}

/** The rig of track 2's climb (up the wall, over the top, the half roll and the right-hander after it): a lattice tower
 *  behind each place the track stands on its side - the wall, and the roll - as tall as what it carries, with an arm
 *  from it to the back of the slab every ~6 u wherever the track faces sideways or down (a clamp across the back), and
 *  posts down to the meadow under it where it's the right way up - but never onto the track below (the pads' strip
 *  that the roll crosses over). */
export function climbRig(G: Geo, frameAt: FrameAt, sp: Range<Support>, frames: TrackFrame[], posts: [number, number][]) {
  const f = newFrame(), m = new THREE.Matrix4(), a = v3(), b = v3(), UP = v3(0, 1, 0), HW = 3.2;
  const back = (h: TrackFrame, o: THREE.Vector3) => o.copy(h.p).addScaledVector(h.up, -BASE - 0.35);
  // the towers: behind the slab where it stands on its side (|up.y| < 0.15), one per stretch of that, 2.5 u clear of it
  const towers: { x: number; z: number; top: number }[] = [];
  let run: number[] = [];
  // ground under (x, z) taken by the track elsewhere (a low stretch more than 30 u along the lap from s), `pad` u clear?
  const taken = (x: number, z: number, s: number, pad = 1.5) =>
    frames.some((g) => g.p.y < 4 && Math.abs(g.s - s) > 30 && Math.hypot(g.p.x - x, g.p.z - z) < g.width / 2 + LIP + pad);
  const flush = () => {
    if (!run.length) return;
    const s = run[Math.floor(run.length / 2)];
    frameAt(s, f);
    // (stepped further out while its footprint would stand on the track below: the roll passes over the pads' strip)
    const out = v3(f.up.x, 0, f.up.z).normalize().negate();
    back(f, a).addScaledVector(out, HW + 2.5);
    for (let k = 0; k < 40 && taken(a.x, a.z, s, HW * Math.SQRT2 + 2); k++) a.addScaledVector(out, 1);
    towers.push({ x: a.x, z: a.z, top: 0 });
    run = [];
  };
  for (let s = sp.s0; s < sp.s1; s += 1) {
    frameAt(s, f);
    if (Math.abs(f.up.y) < 0.15 && Math.hypot(f.up.x, f.up.z) > 0.9) run.push(s);
    else flush();
  }
  flush();
  const arms: [THREE.Vector3, number][] = [];
  for (let s = sp.s0 + 3; s < sp.s1 - 2; s += 6) {
    frameAt(s, f);
    const p = back(f, v3());
    if (f.up.y > 0.55) {
      // right way up: a transom across the floor and a post at each edge (and the middle on wide), down to the meadow
      const o = f.width / 2 + LIP, low = Math.min(f.p.y + f.right.y * o, f.p.y - f.right.y * o) - BASE * f.up.y;
      if (low < 0.9) continue;
      const feet: THREE.Vector3[] = [];
      for (const d of f.width > 16 ? [-o + 0.3, 0, o - 0.3] : [-o + 0.3, o - 0.3]) {
        const top = v3().copy(f.p).addScaledVector(f.right, d).addScaledVector(f.up, -BASE - 0.4);
        if (top.y < 0.6 || taken(top.x, top.z, s)) continue;
        feet.push(top);
      }
      if (!feet.length) continue;
      box(G, basis(f, m), [0, -BASE - 0.2, 0], [0.5, 0.4, 2 * o + 0.6], BLUE2);
      for (const top of feet) {
        beam(G, a.set(top.x, -0.2, top.z), top, 0.6, 0.6, f.t, BLUE);
        box(G, m.makeTranslation(top.x, -0.05, top.z), [0, 0, 0], [1, 0.3, 1], GREY);
      }
      posts.push([f.p.x, f.p.z]);
      continue;
    }
    // on its side or upside down: an arm from the nearest tower (to its face, level) to a clamp across the slab's back
    let best = -1, bd = 1e9;
    towers.forEach((t, i) => { const dd = Math.hypot(t.x - p.x, t.z - p.z); if (dd < bd) (bd = dd), (best = i); });
    if (best < 0 || bd > 40) continue;
    const t = towers[best];
    t.top = Math.max(t.top, p.y + 3);
    box(G, basis(f, m), [0, -BASE - 0.2, 0], [0.7, 0.4, f.width + 2 * LIP - 0.2], BLUE2, BLUE2, 2);
    arms.push([p, best]);
  }
  for (const t of towers) {
    if (t.top <= 0) continue;
    column(G, t.x, t.z, HW, 0, t.top, 6, BLUE, BLUE2);
    box(G, m.makeTranslation(t.x, t.top + 0.3, t.z), [0, 0, 0], [2 * HW + 1.2, 0.6, 2 * HW + 1.2], ORANGE, BLUE2, 2);
    posts.push([t.x, t.z]);
  }
  for (const [p, i] of arms) {
    const t = towers[i], dx = p.x - t.x, dz = p.z - t.z, k = HW / Math.max(Math.abs(dx), Math.abs(dz), 1e-6);
    b.set(t.x + dx * Math.min(1, k), p.y, t.z + dz * Math.min(1, k));
    beam(G, b, p, 0.7, 0.7, UP, BLUE);
  }
}
