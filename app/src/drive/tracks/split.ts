import * as THREE from 'three';
import type { TrackFrame, TrackSplit } from '../types';
import { BASE, DEG, RAIL, col, newFrame, smooth, v3, type FrameAt } from './kit.ts';
import type { Geo } from './geo.ts';

// A lane split: over a stretch of the track its full width is two lanes, left and right, either side of an island - a
// gap between two separate orange channels, so you see the ground through it - that opens from a point and closes to
// one. The sim stays one centre line with a width: a car takes a lane as it reaches the island's point (by the side
// it's on) and keeps it to the far end; the island's faces are walls to it like any rail (arcade.ts), and each lane
// can leave the deck on its own - its own kicker over a gap onto a landing, that lane's tags alone (Span.lane) - by
// lifting its surface over the deck (`lift`: what the car drives on there, and the lane's channel). Path.split lays
// one (tracks/path.ts); the builder draws the two channels, their supports and the island's noses (tracks/build.ts).

/** A lane's jump (deg, u): `at` u into the split a kicker eases up to `lip` deg over lipLen, the gap's virtual surface
 *  eases on to the landing's `land` deg over `gap` u, the landing holds that and eases flat over `out` - the hold is
 *  solved so the lane comes back down exactly onto the deck. */
export interface LaneJump { at: number; lip: number; lipLen: number; gap: number; land: number; out: number }

/** A split as the layout records it (path s; settle remaps s0 and s1): the island's points `nose` and `tail` u into it,
 *  its half-width `half` once open and the wedge's opening rate at the point (`slope`, d half-width / ds), a lane's
 *  own width `lane` (its line runs down the middle of that, off the island; wider is a catch tray outward), and each
 *  lane's pitch profile (knots [u, rad], smoothstep between: none, flat on the deck). */
export interface SplitDef {
  s0: number;
  s1: number;
  nose: number;
  tail: number;
  half: number;
  slope: number;
  lane: number;
  lanes: [u: number, pitch: number][][];
}

/** A car takes its lane where the island (its wedge carried on past the point) is REACH u short of the centre line. */
export const REACH = 1.5;

/** Pitch (rad) and its rate along u over smoothstepped knots (flat before the first and after the last). */
function pitchAt(k: [number, number][], u: number, out: { th: number; dth: number }) {
  out.th = 0;
  out.dth = 0;
  if (!k.length || u <= k[0][0]) return out;
  for (let i = 0; i < k.length - 1; i++) {
    const [u0, a] = k[i], [u1, b] = k[i + 1];
    if (u >= u1) continue;
    const x = (u - u0) / (u1 - u0);
    out.th = a + (b - a) * smooth(x);
    out.dth = ((b - a) * 6 * x * (1 - x)) / (u1 - u0);
    return out;
  }
  out.th = k[k.length - 1][1];
  return out;
}

const DU = 0.05; // u: the lanes' height tables
/** Height over the deck along a lane (every DU from u = 0 to len): the integral of tan(pitch). */
function heights(k: [number, number][], len: number) {
  const n = Math.ceil(len / DU) + 1, h = new Float64Array(n), q = { th: 0, dth: 0 };
  for (let i = 1; i < n; i++) {
    const a = (i - 1) * DU, f = (u: number) => Math.tan(pitchAt(k, u, q).th);
    h[i] = h[i - 1] + (DU / 6) * (f(a) + 4 * f(a + DU / 2) + f(a + DU));
  }
  return h;
}

/** A lane's knots for its jump, the landing's hold solved so it ends back on the deck; with the kicker and gap spans
 *  (u into the split). */
export function laneJump(J: LaneJump) {
  const lip = J.lip * DEG, land = J.land * DEG, u1 = J.at + J.lipLen, u2 = u1 + J.gap;
  const knots = (hold: number): [number, number][] => [[J.at, 0], [u1, lip], [u2, land], [u2 + hold, land], [u2 + hold + J.out, 0]];
  const end = (hold: number) => { const k = knots(hold), h = heights(k, k[4][0] + 1); return h[h.length - 1]; };
  const h0 = end(0), hold = h0 / -Math.tan(land);
  if (!(hold >= 0)) throw new Error(`laneJump: the landing can't come back down to the deck (rise ${h0.toFixed(2)})`);
  return { knots: knots(hold), hold, kicker: [J.at, u1], gap: [u1, u2], end: u2 + hold + J.out };
}

/** The split the car, the camera and the meshes ask (Track.split), from its def (settled s) and the track's frames. */
export function makeSplit(def: SplitDef, frameAt: FrameAt): TrackSplit {
  const len = def.s1 - def.s0, { half, slope, nose, tail } = def;
  const tabs = def.lanes.map((k) => (k.length ? heights(k, len) : null));
  const q = { th: 0, dth: 0 }, f = newFrame();
  const back = (Math.atanh(REACH / half) * half) / slope; // u before the point where a car takes its lane
  /** The island's half-width u into the split, and its rate. */
  const isle = (u: number) => half * Math.tanh((slope * Math.min(u - nose, tail - u)) / half);
  return {
    s0: def.s0 + nose - back,
    s1: def.s0 + tail + back,
    nose: def.s0 + nose,
    tail: def.s0 + tail,
    island(s: number) {
      const u = s - def.s0;
      return u < 0 || u > len ? -Infinity : isle(u);
    },
    slope(s: number) {
      const u = s - def.s0;
      if (u < 0 || u > len) return 0;
      const sg = u - nose < tail - u ? 1 : -1, c = Math.cosh((slope * Math.min(u - nose, tail - u)) / half);
      return (sg * slope) / (c * c);
    },
    centre(s: number) {
      const u = s - def.s0, e = u < 0 || u > len ? 0 : Math.max(0, isle(u));
      return e + Math.min(frameAt(s, f).width / 2 - e, def.lane) / 2;
    },
    lift(lane: number, s: number, out: { h: number; th: number; dth: number }) {
      const i = lane < 0 ? 0 : 1, k = def.lanes[i], h = tabs[i], u = s - def.s0;
      if (!h || u <= k[0][0] || u >= k[k.length - 1][0]) return false;
      const x = u / DU, j = Math.floor(x);
      out.h = h[j] + (h[j + 1] - h[j]) * (x - j);
      pitchAt(k, u, q);
      out.th = q.th;
      out.dth = q.dth;
      return true;
    },
  };
}

/** A lane's own frames (for its channel and supports): centred on the lane, as wide as it is, lifted onto its jump. */
export function laneFrames(frameAt: FrameAt, sp: TrackSplit, lane: -1 | 1): FrameAt {
  const q = { h: 0, th: 0, dth: 0 }, t = v3();
  return (s: number, o: TrackFrame = newFrame()) => {
    frameAt(s, o);
    const e = Math.max(0, sp.island(s)), W = o.width / 2;
    o.p.addScaledVector(o.right, (lane * (e + W)) / 2);
    o.width = W - e;
    if (sp.lift(lane, s, q)) {
      const c = Math.cos(q.th), sn = Math.sin(q.th);
      o.p.addScaledVector(o.up, q.h);
      t.copy(o.t);
      o.t.multiplyScalar(c).addScaledVector(o.up, sn);
      o.up.multiplyScalar(c).addScaledVector(t, -sn);
      o.kappaN -= q.dth * c;
    }
    return o;
  };
}

/** The island's two points: where the lanes' inner rails meet, a wedge as tall as the rails (and a little over),
 *  orange with a yellow-and-black striped nose, its faces on the rails' (the walls'). Drawn into the channel's mesh
 *  (its plastic, untoned: tracks/build.ts). */
export function islandNoses(G: Geo, frameAt: FrameAt, sp: TrackSplit) {
  const f = newFrame(), p = v3(), nr = v3(), orange = col('#ff6b00'), yellow = col('#ffc21a'), black = col('#1d1d1f'), shade = col('#000');
  const top = RAIL + 0.2, LEN = 9, STEP = 0.5;
  for (const [s0, dir] of [[sp.nose, 1], [sp.tail, -1]] as const) {
    // the wedge: a ring of 6 points (bottom, side, top each side) every STEP u back from the point
    const rings: number[] = [];
    for (let x = 0; x <= LEN + 1e-6; x += STEP) {
      const s = s0 + dir * x, e = Math.max(0.02, sp.island(s));
      frameAt(s, f);
      const c = x < 2.2 ? (Math.floor(x / 0.55) % 2 ? black : yellow) : shade.copy(orange).multiplyScalar(0.9);
      rings.push(G.n);
      for (const [d, y, nx, ny] of [[-e, -BASE, -1, 0], [-e, top, -1, 0], [-e, top, 0, 1], [e, top, 0, 1], [e, top, 1, 0], [e, -BASE, 1, 0]]) {
        nr.copy(f.right).multiplyScalar(nx).addScaledVector(f.up, ny);
        G.v(p.copy(f.p).addScaledVector(f.right, d).addScaledVector(f.up, y), nr, c);
      }
    }
    for (let r = 0; r < rings.length - 1; r++) {
      const A = rings[r], B = rings[r + 1];
      for (const k of [0, 2, 4]) {
        frameAt(s0 + dir * (r + 0.5) * STEP, f);
        nr.copy(f.right).multiplyScalar(k === 0 ? -1 : k === 4 ? 1 : 0).addScaledVector(f.up, k === 2 ? 1 : 0);
        G.quad(A + k, A + k + 1, B + k + 1, B + k, nr);
      }
    }
    // the back of the wedge (where the island's gap opens), a plate
    const E = rings[rings.length - 1];
    frameAt(s0 + dir * LEN, f);
    nr.copy(f.t).multiplyScalar(dir);
    G.quad(E, E + 1, E + 4, E + 5, nr);
  }
}
