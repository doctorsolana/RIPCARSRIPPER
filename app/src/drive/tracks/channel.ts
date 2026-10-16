import * as THREE from 'three';
import { BASE, KIT, LIP, RAIL, W, col, newFrame, smooth, v3, type FrameAt, type Span } from './kit.ts';
import { Geo, basis, box, m4, rotY, stations } from './geo.ts';

// The plastic: the orange U-channel over each plastic run (with its blue connectors) and the booster pad.

const TAPER = 2.5; // u: rails ramp down to nothing where the plastic meets a road

/** The U-channel's cross-section at half-width w and rail height r: polylines (x along right, y along up) with a face
 *  normal and AO per point (inner corners darker). The ring has the same 16 points whatever w and r are. */
function profile(w: number, r: number) {
  const o = w + LIP;
  return [
    { pts: [[-o, r, 0.95], [-w, r, 0.95]], n: [0, 1] },
    { pts: [[-w, r, 0.9], [-w, 0, 0.5]], n: [1, 0] },
    { pts: [[-w, 0, 0.52], [-0.75 * w, 0, 0.86], [0, 0, 1], [0.75 * w, 0, 0.86], [w, 0, 0.52]], n: [0, 1] },
    { pts: [[w, 0, 0.5], [w, r, 0.9]], n: [-1, 0] },
    { pts: [[w, r, 0.95], [o, r, 0.95]], n: [0, 1] },
    { pts: [[o, r, 0.85], [o, -BASE, 0.55]], n: [1, 0] },
    { pts: [[o, -BASE, 0.45], [-o, -BASE, 0.45]], n: [0, -1] },
    { pts: [[-o, -BASE, 0.55], [-o, r, 0.85]], n: [-1, 0] },
  ] as { pts: [number, number, number][]; n: [number, number] }[];
}
const RING = profile(W, RAIL).reduce((a, g) => a + g.pts.length, 0);
/** deg of roll between the wide plastic's rings (track 2): its triangles stay within ~0.03 u of the true surface. */
const TWIST = Number((globalThis as any).__TWIST ?? 0.75);

/** The orange channel over each plastic run: its width follows the frames (the funnels where it meets a road flare to
 *  the road's width, the big jump's landing ramp is a wide catch tray), the rails ramp down to nothing at a road and
 *  end square at a gap, where a striped lip plate thickens the edge. The blue connectors every 17 u of s go in the same
 *  mesh (vertex colours; the material is white). */
export function channelGeometry(frameAt: FrameAt, plastic: [number, number][], L: number, ds: number, gaps: Span[], wideTabs = false,
  o: { bare?: number[]; more?: ChannelPart[]; extra?: (G: Geo) => void } = {}) {
  const G = new Geo(), more = o.more ?? [];
  let tabs = channelInto(G, frameAt, plastic, L, ds, gaps, wideTabs, o.bare ?? []);
  for (const m of more) tabs += channelInto(G, m.frameAt, m.runs, L, ds, m.gaps, wideTabs, m.bare);
  o.extra?.(G); // (more plastic in the same mesh: a split's island noses)
  return { geo: G.build(), tabs };
}

/** More channel in the same mesh: a split's lanes (tracks/split.ts) - their own frames, runs and gaps, and the s where
 *  a run ends `bare` (no taper, no cap: it carries straight on as other channel). */
export interface ChannelPart { frameAt: FrameAt; runs: [number, number][]; gaps: Span[]; bare: number[] }

function channelInto(G: Geo, frameAt: FrameAt, plastic: [number, number][], L: number, ds: number, gaps: Span[], wideTabs: boolean, bare: number[]) {
  const f = newFrame(), p = v3(), nr = v3(), orange = col(KIT.color), c = new THREE.Color();
  const isBare = (s: number) => bare.some((b) => Math.abs(b - s) < 1e-6);
  const pieces: { s0: number; s1: number; road0: boolean; road1: boolean }[] = [];
  for (const [a, b] of plastic) {
    // the gaps inside this run (in its own s, which may pass L), in order: the run is split at each
    const cut = gaps.map((g) => (g.s0 >= a ? g : { ...g, s0: g.s0 + L, s1: g.s1 + L })).filter((g) => g.s0 >= a && g.s1 <= b).sort((x, y) => x.s0 - y.s0);
    const open = a > 0 || b < L; // the run starts and ends at a road (not the whole lap)
    let s0 = a, road0 = open;
    for (const g of cut) {
      pieces.push({ s0, s1: g.s0, road0, road1: false });
      s0 = g.s1;
      road0 = false;
    }
    pieces.push({ s0, s1: b, road0, road1: cut.length ? true : open });
  }
  const yellow = col('#ffc21a'), black = col('#1d1d1f');
  for (const pc of pieces) {
    const closed = !pc.road0 && !pc.road1 && pc.s1 - pc.s0 >= L - 1e-6;
    const bare0 = bare.length > 0 && isBare(pc.s0), bare1 = bare.length > 0 && isBare(pc.s1);
    if (bare0) pc.road0 = false;
    if (bare1) pc.road1 = false;
    const near = (s: number) => (pc.road0 && s - pc.s0 < TAPER) || (pc.road1 && pc.s1 - s < TAPER);
    // (track 2's long wide decks: a ring every 4 deg of turn or 5 u, the channel's look at a lighter count - and every
    // TWIST deg of roll, so a bank easing in keeps the floor true)
    const st = wideTabs ? stations(frameAt, pc.s0, pc.s1, ds, near, 4, 5, TWIST) : stations(frameAt, pc.s0, pc.s1, ds, near);
    const count = closed ? st.length - 1 : st.length;
    const base = G.n;
    for (let r = 0; r < count; r++) {
      const s = st[r];
      frameAt(s, f);
      let k = 1;
      if (pc.road0) k = Math.min(k, (s - pc.s0) / TAPER);
      if (pc.road1) k = Math.min(k, (pc.s1 - s) / TAPER);
      for (const g of profile(f.width / 2, RAIL * smooth(Math.max(0, Math.min(1, k))))) {
        nr.copy(f.right).multiplyScalar(g.n[0]).addScaledVector(f.up, g.n[1]);
        for (const [x, y, ao] of g.pts) G.v(p.copy(f.p).addScaledVector(f.right, x).addScaledVector(f.up, y), nr, c.copy(orange).multiplyScalar(ao));
      }
    }
    const prof = profile(W, RAIL);
    for (let r = 0; r < (closed ? count : count - 1); r++) {
      const A = base + r * RING, B = base + ((r + 1) % count) * RING;
      let o = 0;
      for (const g of prof) {
        for (let k = 0; k < g.pts.length - 1; k++) G.idx.push(A + o + k, A + o + k + 1, B + o + k + 1, A + o + k, B + o + k + 1, B + o + k);
        o += g.pts.length;
      }
    }
    // End caps: at a road just the slab (its rails are gone). At a gap - a lip, or the edge of a landing - both rails end
    // square in yellow and a plate thickens the slab, its face striped yellow and black.
    for (const [s, sign, road] of [[pc.s0, -1, pc.road0], [pc.s1, 1, pc.road1]] as const) {
      if (closed) break;
      if (sign < 0 ? bare0 : bare1) continue;
      frameAt(s, f);
      nr.copy(f.t).multiplyScalar(sign);
      const w = f.width / 2, o = w + LIP, quad = (x0: number, x1: number, y0: number, y1: number, cc: THREE.Color, a = 0) => {
        const i = G.n;
        for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]]) G.v(p.copy(f.p).addScaledVector(f.right, x).addScaledVector(f.up, y).addScaledVector(f.t, a), nr, cc);
        G.quad(i, i + 1, i + 2, i + 3, nr);
      };
      if (road) {
        quad(-o, o, -BASE, 0, c.copy(orange).multiplyScalar(0.8));
        continue;
      }
      quad(-o, -w, 0, RAIL, yellow);
      quad(w, o, 0, RAIL, yellow);
      const deep = 0.75, n = Math.max(6, Math.round(o / 0.55)) * 2; // the plate under the slab, striped across its face
      for (let i = 0; i < n; i++) quad(-o + (2 * o * i) / n, -o + (2 * o * (i + 1)) / n, -deep, 0, i % 2 ? black : yellow, sign * 0.004);
      box(G, basis(f, m4).multiply(rotY(sign < 0 ? Math.PI : 0)), [-0.45, -(deep + BASE) / 2, 0], [0.9, deep - BASE, 2 * o], c.copy(orange).multiplyScalar(0.62), c, 2);
    }
  }
  // Blue connectors every 17 u of s wherever the channel is its plain 8 u: under the floor, poking out of both sides below
  // the rails (seen from beside and below), with a clip over each rail's top. Never on the floor: a band across it,
  // passing under the chase camera, flashed big and blue at the bottom of the frame.
  const blue = col('#2f72f0').multiplyScalar(1.05), m = new THREE.Matrix4();
  const inPiece = (s: number) => pieces.some((pc) => (s >= pc.s0 + 3 && s <= pc.s1 - 3) || (s + L >= pc.s0 + 3 && s + L <= pc.s1 - 3));
  let tabs = 0;
  const fa = newFrame(), fb = newFrame();
  for (let s = 0; s < L - 2; s += KIT.tabEvery) {
    frameAt(s, f);
    if (f.surface !== 'plastic' || (!wideTabs && Math.abs(f.width - KIT.width) > 0.01) || !inPiece(s)) continue;
    if (gaps.some((g) => s > g.s0 - 1.5 && s < g.s1 + 1.5)) continue;
    // (a tab is a flat box in one frame: where a wide deck twists - a bank easing in - its far ends would rise through
    // the floor, so none there)
    if (wideTabs && Math.abs(frameAt(s - 0.5, fa).right.dot(frameAt(s + 0.5, fb).up)) * (f.width / 2 + LIP) > 0.05) continue;
    basis(f, m);
    const w = wideTabs ? f.width / 2 : W, o = w + LIP; // (track 2: wherever the plastic is, as wide as it is)
    box(G, m, [0, -BASE - 0.1, 0], [0.7, 0.36, 2 * o + 0.6], blue, blue, 2);
    for (const sg of [-1, 1]) box(G, m, [0, RAIL + 0.025, sg * (w + LIP / 2)], [0.4, 0.07, LIP + 0.12], blue);
    tabs++;
  }
  return tabs;
}

/** The booster pad's plate across the track (u). */
export const PAD_W = 6.6;
/** Booster pad: a dark plate with three chevrons (aPhase 0..2 drives the running-light pulse; -1 = static). */
export function boosterGeometry() {
  const G = new Geo(), up = v3(0, 1, 0), p = v3(), dark = col('#2a1408');
  const q = (pts: number[][], c: THREE.Color | number, ph: number, y: number) => {
    const i = G.n;
    for (const [x, z] of pts) G.v(p.set(x, y, z), up, c, 0, 0, ph);
    G.quad(i, i + 1, i + 2, i + 3, up);
  };
  q([[-4, -3.3], [4, -3.3], [4, 3.3], [-4, 3.3]], dark, -1, 0.025);
  const hot = col('#fff2a8'), warm = col('#ffae00');
  for (let c = 0; c < 3; c++) {
    const x = -2.6 + c * 2.6;
    for (const sz of [-1, 1]) {
      const i = G.n;
      for (const [px, pz, cc] of [[x + 1.1, 0, hot], [x + 0.2, 0, hot], [x - 1.6, 2.7 * sz, warm], [x - 0.7, 2.7 * sz, warm]] as const)
        G.v(p.set(px, 0.05, pz), up, cc, 0, 0, c);
      G.quad(i, i + 1, i + 2, i + 3, up);
    }
  }
  return G.build({ extra: 'aPhase' });
}
