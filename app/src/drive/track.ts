import * as THREE from 'three';
import type { Edge, Surface, Track, TrackFrame, TrackTag } from './types';

// The course: a twisty lap of country roads through the meadow - asphalt with mown grass verges, a loose dirt stretch -
// with the orange Hot Wheels plastic kept for the set pieces: the raised start gate and its drop, the kicker and gap jump
// on scaffolding, the BIG jump - a booster, a steep launch ramp on a tall scaffold tower, ~2.35 s of air over the road
// below, a long landing ramp - then a booster into the loop and a banked climb on stone pillars back up to the gate.
// About 70 analytic pieces, each with an authored yaw-rate / pitch / bank profile (never Frenet frames), are integrated
// into a dense centre line. Two free straights are solved so the lap closes exactly (position, tangent and up), and the
// line is resampled every 0.5 u into the frame table. Style keys along s give every frame its width, surface, edge and
// verge: width and verge blend between keys, surface and edge switch at them, and every change keeps the hard limit
// (width / 2 + verge) continuous. Units: the car is 4 u long. The meadow is y = 0 and ground-level surfaces sit at
// y = 0.3. Plan view: +x east, +z south. Positive yaw turns right (toward +z when heading +x), and right = cross(t, up).

export const TRACK_SPEC = {
  width: 8, rail: 0.8, lip: 0.25, base: 0.25, // plastic channel: floor width, rail height, rail thickness, floor thickness
  floorY: 0.3, gateY: 14, gateLen: 22, start: 8, // ground-level surfaces sit 0.3 above the meadow (y = 0); the gate is raised
  road: 12, dirt: 11, // road widths
  tabEvery: 17, // blue connectors on the plastic (and the audio's joint ticks) every 17 u of s
  color: '#ff6b00',
} as const;

// The jump, tuned against the arcade model (g = 24): the lip, a gap with no surface (the virtual surface's crest is all
// in the air), then the landing slope. 0.70 s of air at 42 u/s; from 34 to 54 u/s the car lands within ~14 deg of the
// slope, and even 24 u/s clears the gap (2D search, scratch jump.mjs).
export const JUMP = { lip: 8, lipLen: 6, gap: 14, land: -8, landHold: 6, landOut: 14 };

// The big jump, solved against the arcade model (g = 24; its launcher pulls a car on the launch ramp to the one speed
// whose arc lands best lined up with the landing ramp, and its nose follows the flight path until it levels to the ramp).
// A 30 deg lip 20 u up; a gap of 46 u (horizontal) to the landing deck's edge 4 u above the lip, its virtual surface a
// low crest; then the landing ramp: the deck eases over (to -4 deg over 34 u, to -32 deg over the next 20) and holds
// -32 deg for 12 u - a straight run comes down on that hold lined up with it (51 u/s, ~2.35 s of air, ~105 u across,
// 2-4 deg into the ramp wherever in its step it left the lip: PERFECT) - then sags to an -8 deg runway that catches the
// fast flights and flares onto the meadow. Every flight from 0.85 to 1.15 x that speed lands on the ramp: the slow ones
// on the deck (~22 deg into it), the fast ones on the runway (~32 deg); all ~22 u over the road below. Profile from a 2D
// search with the vehicle's ballistics, launcher and air attitude (scratch round3/track/search8.mjs).
export const BIG = {
  lip: 30, lipY: 20, sag: 28, // deg, u: the launch ramp's pitch at the lip and the lip's height; it eases up over `sag` u
  gapX: 46, gapY: 4, // u: the landing deck's edge, horizontally and vertically from the lip
  deck: [[34, -4], [20, -32], [12, -32], [14, -8]] as [number, number][], // [u, deg] pitch eases over the landing ramp ...
  runway: -8, flare: 14, // ... then the runway (solved to reach the meadow) and its flare to flat
  width: 16, // u: the landing ramp is a catch tray this wide, narrowing to the road's over its runway
  cross: 24, // u past the lip (horizontal): where the road below passes under the flight
};

const DEG = Math.PI / 180;
const STEP = 0.1; // dense integration step (u)
const FLARE = 12; // u: the plastic funnel between the channel (8 u) and a road
const GROW = 20; // u: a verge opens (or closes) over this
const CATCH = 12; // u: the jump's landing tray starts this wide
/** u a verge of `w` u takes to close: its far edge then meets a car on it at under ~14 deg, a glancing scrape. */
const CLOSE = (w: number) => Math.max(GROW, 6 * w);
const smooth = (u: number) => u * u * (3 - 2 * u);

interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; bank: number; k: number }
interface Span { tag: TrackTag; s0: number; s1: number }
interface Style { surface: Surface; edge: Edge; width: number; shoulder: number }
interface Key extends Style { s: number }
type Support = 'tower' | 'trestle' | 'scaffold' | 'pillar' | 'loop' | 'rig';
interface Range<T> { kind: T; s0: number; s1: number }

/** Height gained over a ramp of length len whose pitch eases 0 -> th (smoothstep). */
function rampRise(th: number, len: number) {
  if (len <= 0) return 0;
  const n = 64;
  let a = 0;
  for (let i = 0; i <= n; i++) a += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * Math.sin(th * smooth(i / n));
  return (a * len) / (3 * n);
}

/** How far a stretch of `len` u whose pitch eases a -> b (smoothstep, as Path.seg) runs along (x) and rises (y). */
function easeRun(a: number, b: number, len: number) {
  const n = 64;
  let x = 0, y = 0;
  for (let i = 0; i < n; i++) {
    const p = a + (b - a) * smooth((i + 0.5) / n);
    x += Math.cos(p);
    y += Math.sin(p);
  }
  return { x: (x * len) / n, y: (y * len) / n };
}

/** Bisection for a monotonic f on [lo, hi] with f(lo) <= target <= f(hi). */
function solve(f: (x: number) => number, target: number, lo: number, hi: number) {
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** A turtle that integrates pieces into dense samples [s, p(3), t(3), up(3)], and records what goes where along s. */
class Path {
  d: number[] = [];
  pose: Pose;
  s = 0;
  tags: Span[] = [];
  keys: Key[] = [];
  sup: Range<Support>[] = [];
  humps: { s0: number; s1: number; amp: number; wave: number }[] = [];
  free: { x: number; z: number }[] = [];
  private cur: Style = { surface: 'plastic', edge: 'rail', width: TRACK_SPEC.width, shoulder: 0 };

  constructor(y: number) {
    this.pose = { x: 0, y, z: 0, yaw: 0, pitch: 0, bank: 0, k: 0 };
    this.push(0, 0, y, 0, 0, 0, 0);
    this.key(0, {});
  }

  push(s: number, x: number, y: number, z: number, yaw: number, pitch: number, bank: number) {
    const cy = Math.cos(yaw), sy = Math.sin(yaw), cp = Math.cos(pitch), sp = Math.sin(pitch), cb = Math.cos(bank), sb = Math.sin(bank);
    // t; unbanked up n0 = d t / d pitch; r0 = t x n0 = (-sy, 0, cy); banked up = n0 cos(bank) + r0 sin(bank)
    this.d.push(s, x, y, z, cp * cy, sp, cp * sy, -sp * cy * cb - sy * sb, cp * cb, -sp * sy * cb + cy * sb);
  }

  /** Over `len`: yaw rate ramps linearly to k, pitch and bank ease (smoothstep) to their targets. */
  seg(len: number, o: { k?: number; pitch?: number; bank?: number } = {}) {
    if (len <= 1e-9) return this;
    const P = this.pose;
    const k0 = P.k, k1 = o.k ?? k0, th0 = P.pitch, th1 = o.pitch ?? th0, b0 = P.bank, b1 = o.bank ?? b0, y0 = P.yaw;
    const yaw = (u: number) => y0 + k0 * u + ((k1 - k0) * u * u) / (2 * len);
    const pitch = (u: number) => th0 + (th1 - th0) * smooth(u / len);
    const tx = (u: number) => Math.cos(pitch(u)) * Math.cos(yaw(u));
    const ty = (u: number) => Math.sin(pitch(u));
    const tz = (u: number) => Math.cos(pitch(u)) * Math.sin(yaw(u));
    const n = Math.ceil(len / STEP), h = len / n;
    let { x, y, z } = P;
    for (let i = 1; i <= n; i++) {
      const a = (i - 1) * h, m = a + h / 2, b = i * h; // Simpson on the tangent
      x += (h / 6) * (tx(a) + 4 * tx(m) + tx(b));
      y += (h / 6) * (ty(a) + 4 * ty(m) + ty(b));
      z += (h / 6) * (tz(a) + 4 * tz(m) + tz(b));
      this.push(this.s + b, x, y, z, yaw(b), pitch(b), b0 + (b1 - b0) * smooth(b / len));
    }
    Object.assign(P, { x, y, z, yaw: yaw(len), pitch: th1, bank: b1, k: k1 });
    this.s += len;
    return this;
  }

  /** A turn of `deg` (+ right) at radius R with eased (clothoid) entry/exit, banked into the turn, at the pitch it
   *  starts with. With `toY` it climbs or descends at a constant pitch, eased in over `pin` u of straight before the turn
   *  and out over `pout` after it (0: inside the turn's own eases). */
  arc(R: number, deg: number, o: { bank?: number; ease?: number; toY?: number; pin?: number; pout?: number } = {}) {
    const ang = Math.abs(deg) * DEG, sg = Math.sign(deg), e = o.ease ?? 8, hold = ang * R - e;
    if (hold < 0) throw new Error(`arc too short: R ${R} deg ${deg}`);
    const bank = sg * (o.bank ?? 0) * DEG, pin = o.pin ?? 0, pout = o.pout ?? 0;
    let th = this.pose.pitch;
    if (o.toY !== undefined) {
      const dy = o.toY - this.pose.y;
      const rise = (t: number) => (pin ? rampRise(t, pin) + Math.sin(t) * e : rampRise(t, e)) + Math.sin(t) * hold + (pout ? Math.sin(t) * e + rampRise(t, pout) : rampRise(t, e));
      th = solve(rise, dy, -0.6, 0.6);
    }
    this.seg(pin, { pitch: th });
    this.seg(e, { k: sg / R, bank, pitch: th }).seg(hold).seg(e, { k: 0, bank: 0, pitch: o.toY !== undefined && !pout ? 0 : th });
    return o.toY !== undefined ? this.seg(pout, { pitch: 0 }) : this;
  }

  /** Climb or drop to height y with at most maxDeg of pitch; smooth sag and crest of lengths rIn / rOut. */
  slopeTo(y: number, maxDeg: number, rIn: number, rOut = rIn) {
    const dy = y - this.pose.y, sg = Math.sign(dy), need = Math.abs(dy);
    let th = maxDeg * DEG;
    let hold = (need - rampRise(th, rIn) - rampRise(th, rOut)) / Math.sin(th);
    if (hold < 0) {
      th = solve((t) => rampRise(t, rIn) + rampRise(t, rOut), need, 0, th);
      hold = 0;
    }
    return this.seg(rIn, { pitch: sg * th }).seg(hold).seg(rOut, { pitch: 0 });
  }

  /** A full loop of radius R whose exit is shifted `off` to the right so it clears the entry. Up points at the axis. */
  loop(R: number, off: number) {
    const P = this.pose;
    const fx = Math.cos(P.yaw), fz = Math.sin(P.yaw), sx = -fz, sz = fx, M = 1440;
    let px = P.x, py = P.y, pz = P.z, s = this.s;
    for (let i = 1; i <= M; i++) {
      const a = (i / M) * 2 * Math.PI, sa = Math.sin(a), ca = Math.cos(a);
      const w = (off * (a - sa)) / (2 * Math.PI), dw = (off * (1 - ca)) / (2 * Math.PI);
      const x = P.x + R * sa * fx + w * sx, y = P.y + R * (1 - ca), z = P.z + R * sa * fz + w * sz;
      const tx = R * ca * fx + dw * sx, ty = R * sa, tz = R * ca * fz + dw * sz, tl = Math.hypot(tx, ty, tz);
      s += Math.hypot(x - px, y - py, z - pz);
      px = x; py = y; pz = z;
      this.d.push(s, x, y, z, tx / tl, ty / tl, tz / tl, -sa * fx, ca, -sa * fz);
    }
    P.x += off * sx;
    P.z += off * sz;
    this.s = s;
    return this;
  }

  /** A straight whose length the closure solve picks (records its horizontal direction). */
  freeStraight(len: number) {
    const c = Math.cos(this.pose.pitch);
    this.free.push({ x: Math.cos(this.pose.yaw) * c, z: Math.sin(this.pose.yaw) * c });
    return this.seg(len);
  }

  /** A straight with a booster pad (tag 'booster') `at` u in. */
  booster(len: number, at: number, pad = 8) {
    this.tags.push({ tag: 'booster', s0: this.s + at, s1: this.s + at + pad });
    return this.seg(len);
  }

  tag(tag: TrackTag, s0: number) {
    this.tags.push({ tag, s0, s1: this.s });
    return this;
  }

  /** What holds the track up from s0 to here. */
  support(kind: Support, s0: number) {
    this.sup.push({ kind, s0, s1: this.s });
    return this;
  }

  /** Gentle humps (crest to crest ~wave u, amp u high) from s0 to here: the dirt's washboard, never a launch crest. */
  bumps(amp: number, wave: number, s0: number) {
    this.humps.push({ s0, s1: this.s, amp, wave });
    return this;
  }

  // ---- style keys (each change is a key with the old values where it starts and one with the new where it ends)
  key(s: number, o: Partial<Style>) {
    this.cur = { ...this.cur, ...o };
    this.keys.push({ s, ...this.cur });
    return this;
  }
  /** Off the plastic: the channel flares to the road's width, then the rails end and the verge opens (or a barrier
   *  takes over at the edge when shoulder is 0). */
  toRoad(surface: Surface, shoulder: number) {
    const s = this.s, w = surface === 'dirt' ? TRACK_SPEC.dirt : TRACK_SPEC.road;
    this.key(s, {}).key(s + FLARE, { width: w }).key(s + FLARE, { surface, edge: shoulder ? 'grass' : 'barrier', shoulder: 0 });
    return shoulder ? this.key(s + FLARE + GROW, { shoulder }) : this;
  }
  /** The plastic starts here: the verge has closed over the u before (CLOSE), and the funnel narrows to the channel. */
  toPlastic() {
    const s = this.s;
    this.key(s - CLOSE(this.cur.shoulder), {}).key(s, { shoulder: 0 }).key(s, { surface: 'plastic', edge: 'rail' });
    return this.key(s + FLARE, { width: TRACK_SPEC.width });
  }
  /** The verge eases to `shoulder` u over the next `len` u. */
  verge(shoulder: number, len = GROW) {
    return this.key(this.s, {}).key(this.s + len, { shoulder });
  }
  /** A barrier (tyre wall / hay bales) at the surface's edge from here: the verge has closed over the u before. */
  wall() {
    const s = this.s;
    return this.key(s - CLOSE(this.cur.shoulder), {}).key(s, { shoulder: 0 }).key(s, { edge: 'barrier' });
  }
  /** The barrier ends here and a verge of `shoulder` u opens over the next `len` u. */
  open(shoulder: number, len = GROW) {
    return this.key(this.s, { edge: 'grass', shoulder: 0 }).key(this.s + len, { shoulder });
  }
  /** Asphalt <-> dirt from here (the width eases over `len` u). */
  surfaceTo(surface: Surface, len = 14) {
    return this.key(this.s, { surface }).key(this.s + len, { width: surface === 'dirt' ? TRACK_SPEC.dirt : TRACK_SPEC.road });
  }
}

/** The lap. A and B are the free straights that close it (the braking zone into the SE corner, the run-up to the big jump). */
function layout(A: number, B: number) {
  const T = TRACK_SPEC, J = JUMP;
  const P = new Path(T.gateY);
  let s0 = 0;
  // ---- The start gate on its wooden tower, then the drop to the meadow: a long crest, so a flying lap stays down.
  P.seg(T.gateLen).tag('gate', 0).support('tower', 0);
  P.tags.push({ tag: 'finish', s0: T.start - 1, s1: T.start + 1 });
  s0 = P.s;
  P.slopeTo(T.floorY, 20, 60, 18).tag('drop', s0).support('trestle', s0);
  // ---- Asphalt: off the plastic into flowing esses over a rise, then the fast sweeper between tyre walls (NE).
  P.toRoad('asphalt', 10).seg(FLARE + GROW + 6);
  P.arc(55, -35, { toY: 2.4, ease: 14 }).arc(52, 70, { ease: 14 }).arc(55, -35, { toY: T.floorY, ease: 14 });
  P.seg(GROW + 6).wall();
  P.arc(64, 90, { bank: 5, ease: 16 });
  P.seg(4).open(5).seg(GROW + 10);
  // East side, heading south: the chicane, esses, a fast kink over a rise, the braking zone into the SE corner.
  P.arc(18, -40).arc(18, 40).seg(4);
  P.verge(8).seg(GROW);
  P.arc(45, 50, { bank: 3, ease: 12 }).arc(45, -50, { bank: 3, ease: 12 }).seg(20);
  P.arc(75, -24, { toY: 2.2, ease: 14 }).arc(75, 24, { toY: T.floorY, ease: 14 });
  P.freeStraight(A);
  P.verge(6).seg(GROW + 4);
  P.arc(24, 90, { bank: 3, ease: 10 });
  P.verge(8).seg(GROW + 4);
  // ---- Dirt, heading west: humps, a bale-lined S, drifty corners, then the SW corner.
  P.surfaceTo('dirt').seg(16);
  s0 = P.s;
  P.arc(40, -40, { ease: 12 }).seg(GROW + 2).wall();
  P.arc(30, 80, { ease: 12 }).arc(32, -80, { ease: 12 }).open(8);
  P.arc(40, 40, { ease: 12 }).seg(20);
  P.arc(28, 56, { ease: 12 }).seg(10);
  P.bumps(0.55, 36, s0);
  P.seg(GROW + 4);
  // ---- Plastic: a booster up onto the scaffolding, the kicker, the gap, the landing and down to the asphalt.
  P.toPlastic();
  s0 = P.s;
  P.seg(FLARE + 6).booster(20, 4);
  // A banked S climbing onto the scaffolding (one pitch through both turns), a long crest, then the run-up to the lip.
  const sLen = 2 * (24 * DEG * 60 + 12), th = solve((t) => rampRise(t, 18) + Math.sin(t) * sLen + rampRise(t, 26), 6.5 - P.pose.y, 0, 0.3);
  P.seg(18, { pitch: th }).arc(60, -24, { bank: 7, ease: 12 }).arc(60, 24, { bank: 7, ease: 12 }).seg(26, { pitch: 0 }).seg(14);
  let k0 = P.s;
  P.seg(J.lipLen, { pitch: J.lip * DEG }).tag('kicker', k0);
  k0 = P.s;
  P.seg(J.gap, { pitch: J.land * DEG }).tag('gap', k0);
  // The landing is a catch tray: 12 u wide where a car comes down (a crooked take-off still lands), narrowing to the
  // channel as the slope eases out.
  P.key(P.s, {}).key(P.s, { width: CATCH }).key(P.s + J.landHold + J.landOut, { width: TRACK_SPEC.width });
  P.seg(J.landHold).seg(J.landOut, { pitch: 0 }).seg(8);
  P.slopeTo(T.floorY, 7, 20, 16).support('scaffold', s0);
  P.seg(6).toRoad('asphalt', 0).seg(FLARE + 10);
  // ---- Asphalt: the NW corner flat out between tyre walls, esses over a rise, the run (B) to the big jump.
  P.arc(34, 124, { bank: 3, ease: 12 });
  P.seg(4).open(8);
  P.arc(45, -40, { bank: 3, ease: 12, toY: 1.8 }).arc(45, 40, { bank: 3, ease: 12, toY: T.floorY });
  P.freeStraight(B);
  // ---- Plastic: THE BIG JUMP, east. The launch ramp up its scaffold tower to the lip, a booster where it starts to
  // climb (so a car leaves the lip within ~3% of the jump's speed even without the vehicle's pull to it), the gap over
  // the road below, the long landing ramp down to the meadow.
  P.toPlastic();
  P.seg(FLARE + 18);
  s0 = P.s;
  const lipTh = BIG.lip * DEG, ramp = (BIG.lipY - P.pose.y - easeRun(0, lipTh, BIG.sag).y) / Math.sin(lipTh);
  P.tags.push({ tag: 'booster', s0: s0 + 8, s1: s0 + 16 });
  P.seg(BIG.sag, { pitch: lipTh }).seg(ramp).tag('kicker', s0);
  const lip = P.s, Lx = P.pose.x, Lz = P.pose.z, Lyaw = P.pose.yaw;
  // The gap's virtual surface: a low crest (two equal eases, lip pitch -> c -> flat) ending on the landing deck's edge.
  const unit = (c: number) => { const a = easeRun(lipTh, c, 1), b = easeRun(c, 0, 1); return { x: a.x + b.x, y: a.y + b.y }; };
  const crest = solve((c) => { const u = unit(c); return u.y / u.x; }, BIG.gapY / BIG.gapX, -lipTh, lipTh);
  const half = BIG.gapX / unit(crest).x;
  P.seg(half, { pitch: crest }).seg(half, { pitch: 0 }).tag('gap', lip);
  // The landing ramp: a catch tray BIG.width wide, narrowing to the road over the runway.
  const h0 = P.s;
  P.key(h0, {}).key(h0, { width: BIG.width });
  for (const [len, deg] of BIG.deck) P.seg(len, { pitch: deg * DEG });
  const rw = BIG.runway * DEG, runway = (T.floorY - P.pose.y - easeRun(rw, 0, BIG.flare).y) / Math.sin(rw);
  P.key(P.s, {}).key(P.s + runway, { width: T.road });
  P.seg(runway).seg(BIG.flare, { pitch: 0 }).tag('bigjump', lip).support('rig', s0);
  // ---- Asphalt: round under the jump. Right, right again and back west beside it, then 60 deg right and across under
  // the flight (the straight back is whatever puts that crossing BIG.cross past the lip), left toward the loop.
  const turnR = { bank: 3, ease: 12 }, X = 60, tX = new Path(0).arc(26, X, turnR).pose; // how far that turn carries on
  P.seg(4).toRoad('asphalt', 6).seg(FLARE + 2);
  P.arc(24, 90, turnR).seg(6);
  P.verge(8);
  P.arc(24, 90, turnR);
  const ca = Math.cos(Lyaw), sa = Math.sin(Lyaw);
  const along = (P.pose.x - Lx) * ca + (P.pose.z - Lz) * sa, south = -(P.pose.x - Lx) * sa + (P.pose.z - Lz) * ca;
  P.seg(along - tX.x - (south - tX.z) / Math.tan(X * DEG) - BIG.cross).arc(26, X, turnR);
  P.seg((south - tX.z) / Math.sin(X * DEG) + 14).arc(30, -X, turnR);
  P.seg(CLOSE(8) + 4);
  // ---- Plastic: the booster into the loop, then the banked climb on stone pillars round to the gate.
  P.toPlastic();
  P.seg(FLARE + 4).booster(28, 6);
  const l0 = P.s;
  P.loop(8.5, 9.5).tag('loop', l0).support('loop', l0);
  P.seg(14);
  s0 = P.s;
  const turn = 360 * Math.ceil(P.pose.yaw / DEG / 360 - 1e-9) - P.pose.yaw / DEG; // whatever closes the heading
  P.arc(38, turn, { bank: 16, ease: 14, toY: T.gateY, pin: 26, pout: 34 }).tag('helix', s0).support('pillar', s0);
  return P;
}

// ---------------------------------------------------------------------------------------------------------------------
// Frames

const v3 = (x = 0, y = 0, z = 0) => new THREE.Vector3(x, y, z);
const W = TRACK_SPEC.width / 2, RAIL = TRACK_SPEC.rail, BASE = TRACK_SPEC.base, OUT = W + TRACK_SPEC.lip;

/** Style at s from the sorted keys (width and verge blend between keys; surface and edge come from the key at or
 *  before s). The lap wraps: before the first key the last one holds. */
function styler(keys: Key[], L: number) {
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

/** The hard limit: how far from the centre line the wall the car feels stands - the rails or the barrier at the
 *  surface's edge, or the far side of a grass verge. */
const hardOf = (f: Style) => f.width / 2 + (f.edge === 'grass' ? f.shoulder : 0);
/** Width of the flat strip just past the hard limit that the tyre stacks or hay bales stand on (u). */
const STRIP = { rail: 0, barrier: 1.8, grass: 1.2 } as const;

/** Ground clearance and the dirt's humps. A banked turn tips one edge of its cross-section (the channel's base, or the
 *  road's verge) toward the meadow: lift the centre line just enough to keep that edge above it, spread out (dilate 24 u,
 *  then two 24 u box filters) so the lift is gentle and never a launch crest. The humps go on top. Then s, t and up are
 *  recomputed from the lifted points, and everything keyed along s moves with the (slightly longer) arc length. */
function settle(P: Path) {
  const d = P.d, n = d.length / 10, L = d[(n - 1) * 10], G = Math.round(L / 0.5), h = L / G;
  const bad = P.keys.findIndex((k, i) => i > 0 && k.s < P.keys[i - 1].s - 1e-6);
  if (bad > 0) console.warn(`track: style changes overlap (a key at s ${P.keys[bad].s.toFixed(1)} before one at ${P.keys[bad - 1].s.toFixed(1)})`);
  const keys = [...P.keys].sort((a, b) => a.s - b.s), style = styler(keys, L), st: Style = { ...keys[0] };
  const need = new Float32Array(G).fill(-1);
  for (let i = 0; i < n; i++) {
    const o = i * 10, tx = d[o + 4], tz = d[o + 6], ux = d[o + 7], uy = d[o + 8], uz = d[o + 9];
    const ry = Math.abs(tz * ux - tx * uz); // |(t x up).y|
    style(d[o], st);
    const low = st.surface === 'plastic' ? 0.05 + OUT * ry + BASE * uy : 0.15 + (hardOf(st) + STRIP[st.edge]) * ry;
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
  for (const k of keys) k.s = remap(Math.min(k.s, L));
  P.keys = keys;
}

const newFrame = (): TrackFrame => ({
  s: 0, p: v3(), t: v3(), up: v3(), right: v3(), kappa: 0, kappaN: 0, width: TRACK_SPEC.width, surface: 'plastic', edge: 'rail', shoulder: 0,
});

/** Builds the closed centre line and its frame table (no meshes; buildTrack adds those). */
export function buildFrames() {
  const base = layout(0, 0);
  const [a, b] = base.free, ex = -base.pose.x, ez = -base.pose.z, det = a.x * b.z - a.z * b.x;
  const A = (ex * b.z - ez * b.x) / det, B = (a.x * ez - a.z * ex) / det;
  if (!(A > 2 && B > 2)) console.warn(`track: closure straights A=${A.toFixed(1)} B=${B.toFixed(1)} too short`);
  const P = layout(A, B);
  const turned = P.pose.yaw / DEG;
  settle(P);
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
  return { frames, L, N, ds, tags: P.tags, sup: P.sup, keys: P.keys, seam, minDot, free: { A, B }, turned };
}

// ---------------------------------------------------------------------------------------------------------------------
// Meshes, 11 draw calls at most: the plastic channel (with its blue connectors), the booster pads, the road (asphalt,
// dirt, mown verges, embankments and curbs under one shader) and the props (supports, the start tower and gate, the big
// jump's arch, tyre walls and hay bales: flat-shaded vertex colours, like the meadow's scenery) in 8 area chunks, so
// the camera only draws the ones in view.

const LIP = TRACK_SPEC.lip, TAPER = 2.5; // u: rails ramp down to nothing where the plastic meets a road
const GROUND = -0.3; // embankments run just under the meadow (y = 0), so no seam shows
const ROAD_TILE = 16; // u of road per texture repeat
const col = (hex: string) => new THREE.Color(hex);

/** Growable vertex arrays for hand-built geometry. */
class Geo {
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

type FrameAt = (s: number, o?: TrackFrame) => TrackFrame;

/** Runs of the closed lap where `pred` holds, as [s0, s1] (s1 > s0, and s1 may pass L where a run wraps). */
function runs(frames: TrackFrame[], ds: number, pred: (f: TrackFrame) => boolean): [number, number][] {
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

/** Ring positions along [s0, s1]: every frame, thinned where nothing changes (<= 3 u apart, <= `deg` of turn, width
 *  and limits steady); `dense(s)` forces every frame. */
function stations(frameAt: FrameAt, s0: number, s1: number, ds: number, dense: (s: number) => boolean = () => false, deg = 2.5) {
  const cand: number[] = [s0];
  for (let s = Math.ceil(s0 / ds + 1e-6) * ds; s < s1 - 1e-6; s += ds) cand.push(s);
  cand.push(s1);
  const keep = [s0], a = newFrame(), b = newFrame(), cos = Math.cos(deg * DEG);
  frameAt(s0, a);
  let ha = hardOf(a);
  for (let i = 1; i < cand.length; i++) {
    frameAt(cand[i], b);
    const hb = hardOf(b);
    if (i === cand.length - 1 || dense(cand[i]) || cand[i] - keep[keep.length - 1] >= 3 || a.t.dot(b.t) < cos || a.up.dot(b.up) < cos ||
      Math.abs(hb - ha) > 0.2 || Math.abs(a.width - b.width) > 0.1 || a.edge !== b.edge || a.surface !== b.surface) {
      keep.push(cand[i]);
      frameAt(cand[i], a);
      ha = hb;
    }
  }
  return keep;
}

const basis = (f: TrackFrame, m: THREE.Matrix4) => m.makeBasis(f.t, f.up, f.right).setPosition(f.p);

/** A box in a local frame (x along t, y up, z right): centre c, size s. `top` colours the +y face. `ends` picks the
 *  y faces drawn: 1 = just the top (nothing sees under the props), 2 = both, 0 = neither (a beam's ends are buried). */
function box(G: Geo, m: THREE.Matrix4, c: number[], s: number[], side: THREE.Color, top = side, ends = 1) {
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
function beam(G: Geo, a: THREE.Vector3, b: THREE.Vector3, w: number, d: number, along: THREE.Vector3, c: THREE.Color) {
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
function prism(G: Geo, x: number, z: number, y0: number, y1: number, r: number, n: number, c: THREE.Color, top: THREE.Color | null, rot = 0, hole?: THREE.Color) {
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

// ---- the plastic ------------------------------------------------------------------------------------------------------

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

/** The orange channel over each plastic run: its width follows the frames (the funnels where it meets a road flare to
 *  the road's width, the big jump's landing ramp is a wide catch tray), the rails ramp down to nothing at a road and
 *  end square at a gap, where a striped lip plate thickens the edge. The blue connectors every 17 u of s go in the same
 *  mesh (vertex colours; the material is white). */
function channelGeometry(frameAt: FrameAt, plastic: [number, number][], L: number, ds: number, gaps: Span[]) {
  const G = new Geo(), f = newFrame(), p = v3(), nr = v3(), orange = col(TRACK_SPEC.color), c = new THREE.Color();
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
    const near = (s: number) => (pc.road0 && s - pc.s0 < TAPER) || (pc.road1 && pc.s1 - s < TAPER);
    const st = stations(frameAt, pc.s0, pc.s1, ds, near);
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
  for (let s = 0; s < L - 2; s += TRACK_SPEC.tabEvery) {
    frameAt(s, f);
    if (f.surface !== 'plastic' || Math.abs(f.width - TRACK_SPEC.width) > 0.01 || !inPiece(s)) continue;
    if (gaps.some((g) => s > g.s0 - 1.5 && s < g.s1 + 1.5)) continue;
    basis(f, m);
    box(G, m, [0, -BASE - 0.1, 0], [0.7, 0.36, 2 * OUT + 0.6], blue, blue, 2);
    for (const sg of [-1, 1]) box(G, m, [0, RAIL + 0.025, sg * (W + LIP / 2)], [0.4, 0.07, LIP + 0.12], blue);
    tabs++;
  }
  return { geo: G.build(), tabs };
}
const m4 = new THREE.Matrix4(), mr = new THREE.Matrix4();
/** A rotation about the local y axis (for boxes in a frame basis that should face the other way). */
const rotY = (a: number) => mr.makeRotationY(a);

/** Booster pad: a dark plate with three chevrons (aPhase 0..2 drives the running-light pulse; -1 = static). */
function boosterGeometry() {
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

// ---- the road ---------------------------------------------------------------------------------------------------------

/** Seeded RNG (mulberry32) so the textures and the props are the same on every load. */
export function rng(seed: number) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

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
  const W2 = 128, H2 = 256, pu = W2 / TRACK_SPEC.road, pv = H2 / ROAD_TILE, r = rng(3), blot = lattice(5, 8), fine = lattice(6, 32);
  return paint(W2, H2, (x, y, c) => {
    const d = (x + 0.5) / pu - TRACK_SPEC.road / 2, v = (y + 0.5) / pv, ad = Math.abs(d);
    let k = 62 + 16 * (blot((x / W2) * 8, (y / H2) * 8) - 0.5) + 10 * (fine((x / W2) * 32, (y / H2) * 32) - 0.5) + 18 * (r() - 0.5);
    if (r() < 0.04) k += 26 * r(); // stone chips
    k -= 7 * Math.exp(-(((ad - 2.6) / 0.9) ** 2)); // tyre lines
    let line = 0;
    if (ad > TRACK_SPEC.road / 2 - 0.62 && ad < TRACK_SPEC.road / 2 - 0.3) line = 1;
    if (ad < 0.14 && v % 8 < 4) line = 1;
    if (line) k = 214 + 22 * (r() - 0.5) - 30 * Math.max(0, fine((x / W2) * 32 + 9, (y / H2) * 32) - 0.7);
    c[0] = k; c[1] = k + 2; c[2] = k + 6;
  });
}

/** Packed dirt across the 11 u track and 16 u along: two darker ruts, pebbles, grass creeping in at the edges. */
function dirtTexture() {
  const W2 = 128, H2 = 256, pu = W2 / TRACK_SPEC.dirt, r = rng(9), blot = lattice(11, 8), fine = lattice(12, 32), streak = lattice(13, 64);
  return paint(W2, H2, (x, y, c) => {
    const d = (x + 0.5) / pu - TRACK_SPEC.dirt / 2, ad = Math.abs(d), u = x / W2, v = y / H2;
    let k = 1 + 0.16 * (blot(u * 8, v * 8) - 0.5) + 0.1 * (fine(u * 32, v * 32) - 0.5) + 0.14 * (r() - 0.5);
    const rut = Math.exp(-(((ad - 2.3) / 0.65) ** 2));
    k *= 1 - 0.17 * rut + 0.05 * rut * (streak(u * 8, v * 64) - 0.5);
    let R = 150 * k, G2 = 112 * k, B2 = 72 * k;
    if (r() < 0.035) { const s = r() < 0.6 ? 1.35 : 0.65; R *= s; G2 *= s; B2 *= s; } // pebbles
    const edge = Math.max(0, Math.min(1, (ad - (TRACK_SPEC.dirt / 2 - 0.9)) / 0.9)) * (0.6 + 0.4 * fine(u * 32 + 5, v * 32));
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
function roadMaterial() {
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
 *  Plus red/white curbs on the inside of the asphalt's corners. */
function roadGeometry(frames: TrackFrame[], frameAt: FrameAt, ds: number, road: [number, number][]) {
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
        const drop = p.y - GROUND, run = Math.max(0.8, drop * 1.8);
        q.copy(p).addScaledVector(h, run);
        q.y = GROUND;
        a.subVectors(q, p);
        n.crossVectors(a, f.t).multiplyScalar(sg).normalize();
        if (n.y < 0) n.negate();
        const verts: [THREE.Vector3, THREE.Vector3, number, number, number, number][] = [
          [q.clone(), n.clone(), 0.62, 0, 0, 3],
          [p.clone(), n.clone(), 0.86, 0, 0, 3],
          [v3().copy(f.p).addScaledVector(f.right, sg * hard), f.up, 0.9, 0, 0, 3],
          [v3().copy(f.p).addScaledVector(f.right, sg * hard), f.up, 0.92, hard - e, s, 2],
          [v3().copy(f.p).addScaledVector(f.right, sg * e), f.up, 0.98, 0, s, 2],
          [v3().copy(f.p).addScaledVector(f.right, sg * e), f.up, 1, sg > 0 ? 1 : 0, v, dw],
        ];
        // the strip shares the bank-top vertex's position but faces up: re-emit it flat
        verts.splice(2, 0, [p.clone(), f.up, 0.86, 0, 0, 3]);
        if (sg > 0) verts.reverse();
        for (const [pos, nor, ao, u, w, k] of verts) G.v(pos, nor, ao, u, w, k);
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
      const pairs = [[0, 1], [2, 3], [6, 7], [10, 11], [12, 13]];
      if (sh0 || sh1) pairs.push([4, 5], [8, 9]);
      for (const [i, j] of pairs) G.idx.push(A + i, A + j, B + j, A + i, B + j, B + i);
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

// ---- the props ----------------------------------------------------------------------------------------------------------

const WOOD = col('#7d5030'), TIMBER = col('#9a6a40'), METAL = col('#a9b2bb'), STONE = col('#a29d94'), STONE2 = col('#8d887f');
const RUBBER = col('#2b2a2c'), HOLE = col('#0d0d0d'), PAINT = [col('#f1efe9'), col('#d6302a')], STRAW = col('#d8b65c'), STRAW_TOP = col('#e9cd78');

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
function barriers(G: Geo, frames: TrackFrame[], frameAt: FrameAt, ds: number) {
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

/** A support's footprint on the ground (centre, unit axis along the track, half extents along / across, top height).
 *  The outdoor supports are open frames, so none is listed today (userData.stacks = []); `posts` carries them. */
export interface Stack { x: number; z: number; ax: number; az: number; hx: number; hz: number; h: number }

/** Outdoor supports under the raised plastic, by kind along s: the wooden start tower under the gate, wooden trestles
 *  (A-frames) under the drop, galvanised scaffolding under the kicker and its landing, tall scaffold towers under the
 *  big jump's ramps, stone pillars under the climb, and two scaffold poles holding the loop. Returns the world-shadow
 *  hints: `posts` are the centre-line points over each support. */
function supports(G: Geo, frameAt: FrameAt, sup: Range<Support>[], tags: Span[]) {
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
      const S = [sp.s0 + 1, TRACK_SPEC.start, (TRACK_SPEC.start + sp.s1 - 0.5) / 2, sp.s1 - 0.5];
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
        box(G, basis(f, m), [0, -BASE - 0.15, 0], [0.3, 0.3, 2 * out(f) + 0.9], METAL);
        const tops: THREE.Vector3[] = [];
        for (const sg of [-1, 1]) {
          const top = side(f, sg, out(f) + 0.3, BASE + 0.15, v3());
          const foot = v3(top.x, -0.2, top.z);
          beam(G, foot, top, 0.24, 0.24, f.t, METAL);
          box(G, m.makeTranslation(foot.x, -0.1, foot.z), [0, 0, 0], [0.7, 0.2, 0.7], METAL); // base plate
          tops.push(top);
        }
        if (prev && s - prevS < 9) {
          for (let k = 0; k < 2; k++) {
            const h0 = Math.min(prev[k].y, tops[k].y) * 0.5;
            beam(G, a.set(prev[k].x, h0, prev[k].z), b.set(tops[k].x, h0, tops[k].z), 0.18, 0.18, v3(0, 1, 0), METAL);
            if (flip > 0) beam(G, a.set(prev[k].x, 0.2, prev[k].z), b.set(tops[k].x, tops[k].y - 0.3, tops[k].z), 0.16, 0.16, v3(0, 1, 0), METAL);
            else beam(G, a.set(tops[k].x, 0.2, tops[k].z), b.set(prev[k].x, prev[k].y - 0.3, prev[k].z), 0.16, 0.16, v3(0, 1, 0), METAL);
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
        box(G, basis(f, m), [0, -BASE - 0.17, 0], [0.34, 0.34, 2 * o + 0.8], METAL); // transom
        const tops: THREE.Vector3[] = [];
        for (const d of f.width > 10 ? [-o, 0, o] : [-o, o]) {
          const top = side(f, 1, d, BASE + 0.34, v3()), foot = v3(top.x, -0.2, top.z);
          beam(G, foot, top, 0.26, 0.26, f.t, METAL);
          box(G, m.makeTranslation(foot.x, -0.1, foot.z), [0, 0, 0], [0.75, 0.2, 0.75], METAL); // base plate
          tops.push(top);
        }
        // X-braces across the bent, between neighbouring standards, ~5 u of height each
        for (let i = 0; i < tops.length - 1; i++) {
          const p0 = tops[i], p1 = tops[i + 1], hTop = Math.min(p0.y, p1.y) - 0.4, n = Math.floor(hTop / 5);
          for (let k = 0; k < n; k++) {
            const y0 = 0.3 + (k * (hTop - 0.3)) / n, y1 = 0.3 + ((k + 1) * (hTop - 0.3)) / n;
            beam(G, a.set(p0.x, y0, p0.z), b.set(p1.x, y1, p1.z), 0.14, 0.14, f.t, METAL);
            beam(G, a.set(p0.x, y1, p0.z), b.set(p1.x, y0, p1.z), 0.14, 0.14, f.t, METAL);
          }
        }
        if (prev && s - prev.s < 8.5 && prev.tops.length === tops.length) {
          const both = tower(s) && tower(prev.s);
          for (let k = 0; k < tops.length; k++) {
            if (k === 1 && tops.length === 3 && !both) continue; // the middle line only braces the towers
            const p0 = prev.tops[k], p1 = tops[k], hTop = Math.min(p0.y, p1.y) - 0.5;
            for (let y = 4; y < hTop; y += 4) beam(G, a.set(p0.x, y, p0.z), b.set(p1.x, y, p1.z), 0.16, 0.16, UP, METAL); // ledgers
            if (both) {
              // a tower: X-braced, ~5 u of height each
              const n = Math.max(1, Math.floor(hTop / 5));
              for (let i = 0; i < n; i++) {
                const y0 = 0.3 + (i * (hTop - 0.3)) / n, y1 = 0.3 + ((i + 1) * (hTop - 0.3)) / n;
                beam(G, a.set(p0.x, y0, p0.z), b.set(p1.x, y1, p1.z), 0.14, 0.14, UP, METAL);
                beam(G, a.set(p0.x, y1, p0.z), b.set(p1.x, y0, p1.z), 0.14, 0.14, UP, METAL);
              }
            } else if (flip > 0) beam(G, a.set(p0.x, 0.3, p0.z), b.set(p1.x, p1.y - 0.4, p1.z), 0.15, 0.15, UP, METAL);
            else beam(G, a.set(p1.x, 0.3, p1.z), b.set(p0.x, p0.y - 0.4, p0.z), 0.15, 0.15, UP, METAL);
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
    } else if (sp.kind === 'loop') {
      // Two poles hold the loop at its front and back (outside the channel), clamped to its base.
      for (const u of [0.25, 0.75]) {
        frameAt(sp.s0 + (sp.s1 - sp.s0) * u, f);
        a.copy(f.p).addScaledVector(f.up, -(BASE + 0.32));
        beam(G, v3(a.x, -0.2, a.z), v3(a.x, a.y + 0.6, a.z), 0.4, 0.4, f.right, METAL);
        box(G, basis(f, m), [0, -BASE - 0.15, 0], [0.9, 0.3, 2 * out(f) + 0.5], METAL);
        box(G, m.makeTranslation(a.x, -0.05, a.z), [0, 0, 0], [1.2, 0.3, 1.2], METAL);
        posts.push([a.x, a.z]);
      }
    }
  }
  return { posts };
}

/** The start gate: a checkered line across the floor and an arch with a checkered banner over it. */
function gate(G: Geo, frameAt: FrameAt) {
  const f = frameAt(TRACK_SPEC.start), m = basis(f, new THREE.Matrix4()), white = col('#f4f4f2'), black = col('#1a1a1c'), red = col('#d62d20');
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
function launchArch(G: Geo, frameAt: FrameAt, s: number) {
  const f = frameAt(s), t = v3(f.t.x, 0, f.t.z).normalize(), up = v3(0, 1, 0), r = v3().crossVectors(t, up);
  const m = new THREE.Matrix4().makeBasis(t, up, r).setPosition(f.p.x, f.p.y, f.p.z);
  const red = col('#d62d20'), black = col('#1a1a1c'), span = 2 * OUT + 2.4, y0 = -BASE - 0.4, top = 9.4;
  for (const sg of [-1, 1]) box(G, m, [0, (y0 + top) / 2, sg * (span / 2 - 0.45)], [0.9, top - y0, 0.9], red, red, 2);
  box(G, m, [0, top - 1.25, 0], [0.42, 2.5, span - 1.8], black, black, 2);
  const bands = [col('#e23a1e'), col('#ff7a00'), col('#ffc21a')];
  for (let i = 0; i < 3; i++) box(G, m, [0, top - 1.95 + i * 0.7, 0], [0.5, 0.66, span - 2.1], bands[i], bands[i], 0);
}

/** Area chunks of the props (~4k triangles each): a chase camera along the lap draws half of them on average. */
const PROP_CHUNKS = 8;

/** Hand-built geometry split into k area chunks: k-means on the triangles' plan centroids, seeded by farthest points
 *  from the first triangle (the same every load), then each chunk keeps the vertices its triangles use. */
function chunked(G: Geo, k: number): THREE.BufferGeometry[] {
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

// ---------------------------------------------------------------------------------------------------------------------
// The track: frame table, queries and meshes.

/** Builds the track. `nearest()` returns a shared object (valid until the next call) whose `offset` is LOCAL to the
 *  frame: x along t, y along up (height above the surface), z along right (lateral, + right). */
export function buildTrack(): Track {
  const F = buildFrames();
  const { frames, L, N, ds, tags } = F;
  const wrap = (s: number) => ((s % L) + L) % L;
  const clamp = (x: number, a: number) => (x < -a ? -a : x > a ? a : x);

  function frameAt(s: number, out: TrackFrame = newFrame()): TrackFrame {
    const w = wrap(s), u = w / ds;
    let i = Math.floor(u);
    const a = u - i;
    if (i >= N) i -= N;
    const f0 = frames[i], f1 = frames[i + 1 === N ? 0 : i + 1];
    out.s = w;
    out.p.lerpVectors(f0.p, f1.p, a);
    out.t.lerpVectors(f0.t, f1.t, a).normalize();
    out.up.lerpVectors(f0.up, f1.up, a);
    out.up.addScaledVector(out.t, -out.up.dot(out.t)).normalize();
    out.right.crossVectors(out.t, out.up).normalize();
    out.kappa = f0.kappa + (f1.kappa - f0.kappa) * a;
    out.kappaN = f0.kappaN + (f1.kappaN - f0.kappaN) * a;
    out.width = f0.width + (f1.width - f0.width) * a;
    out.shoulder = f0.shoulder + (f1.shoulder - f0.shoulder) * a;
    out.surface = f0.surface;
    out.edge = f0.edge;
    return out;
  }

  const res = { s: 0, frame: newFrame(), offset: v3() }, dq = v3();
  function nearest(p: THREE.Vector3, hintS: number, window = 25) {
    const c = Math.round(wrap(hintS) / ds), w = Math.min(Math.ceil(window / ds), N >> 1);
    let best = Infinity, bi = 0;
    for (let k = -w; k <= w; k++) {
      const i = (((c + k) % N) + N) % N, q = frames[i].p;
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bi = i; }
    }
    const f = frames[bi];
    frameAt(f.s + clamp(dq.subVectors(p, f.p).dot(f.t), ds), res.frame);
    frameAt(res.frame.s + clamp(dq.subVectors(p, res.frame.p).dot(res.frame.t), ds), res.frame);
    dq.subVectors(p, res.frame.p);
    res.s = res.frame.s;
    res.offset.set(dq.dot(res.frame.t), dq.dot(res.frame.up), dq.dot(res.frame.right));
    return res;
  }

  function tagAt(s: number): TrackTag | null {
    const w = wrap(s);
    let best: TrackTag | null = null, bl = Infinity;
    for (let i = 0; i < tags.length; i++) {
      const g = tags[i];
      if (w >= g.s0 && w < g.s1 && g.s1 - g.s0 < bl) { best = g.tag; bl = g.s1 - g.s0; }
    }
    return best;
  }

  const object = new THREE.Group();
  object.name = 'track';
  const plasticRuns = runs(frames, ds, (f) => f.surface === 'plastic');
  const roadRuns = runs(frames, ds, (f) => f.surface !== 'plastic');

  // The orange channel (and its tabs). AgX insets saturated primaries, which turns #ff6b00 salmon under the lights: the
  // plastic skips tone mapping (with a darker albedo to match the scene's exposure) so it stays Hot Wheels orange.
  const gaps = tags.filter((g) => g.tag === 'gap');
  const ch = channelGeometry(frameAt, plasticRuns, L, ds, gaps);
  const trackMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), roughness: 0.6, metalness: 0, vertexColors: true, envMapIntensity: 0.25, toneMapped: false });
  const channel = new THREE.Mesh(ch.geo, trackMat);
  channel.name = 'channel';

  // Booster pads with running chevrons (the world advances userData.boosterTime).
  const pads = tags.filter((g) => g.tag === 'booster');
  const time = { value: 0 };
  const padMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  padMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = 'attribute float aPhase;\nvarying float vPhase;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPhase = aPhase;');
    sh.fragmentShader = 'uniform float uTime;\nvarying float vPhase;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\nif (vPhase >= 0.0) diffuseColor.rgb *= 0.35 + 0.95 * pow(0.5 + 0.5 * sin(uTime * 10.0 - vPhase * 2.1), 2.0);',
    );
  };
  const boosters = new THREE.InstancedMesh(boosterGeometry(), padMat, pads.length);
  const m = new THREE.Matrix4(), f = newFrame();
  pads.forEach((g, i) => boosters.setMatrixAt(i, basis(frameAt((g.s0 + g.s1) / 2, f), m)));
  boosters.name = 'boosters';

  // The road: asphalt, dirt, verges, banks and curbs.
  const rd = roadGeometry(frames, frameAt, ds, roadRuns);
  const road = new THREE.Mesh(rd.geo, roadMaterial());
  road.name = 'road';

  // The props: supports, the start tower and gate, the big jump's arch, tyre walls and hay bales - in PROP_CHUNKS area
  // chunks, each its own mesh, so the ones off screen are frustum-culled.
  const PG = new Geo();
  const sp = supports(PG, frameAt, F.sup, tags);
  gate(PG, frameAt);
  for (const g of tags) if (g.tag === 'bigjump') launchArch(PG, frameAt, g.s0 - 3);
  const br = barriers(PG, frames, frameAt, ds);
  const props = new THREE.Group(), propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  props.name = 'props';
  chunked(PG, PROP_CHUNKS).forEach((g, i) => props.add(Object.assign(new THREE.Mesh(g, propMat), { name: `props-${i}` })));

  // Every surface you can drive on, for a physics engine: the channel and the road mesh in one soup.
  const cp = ch.geo.attributes.position.array as Float32Array, rp = rd.geo.attributes.position.array as Float32Array;
  const ci = ch.geo.index!.array as Uint32Array, ri = rd.geo.index!.array as Uint32Array;
  const positions = new Float32Array(cp.length + rp.length);
  positions.set(cp);
  positions.set(rp, cp.length);
  const indices = new Uint32Array(ci.length + ri.length);
  indices.set(ci);
  for (let i = 0; i < ri.length; i++) indices[ci.length + i] = ri[i] + cp.length / 3;

  // How far each frame's footprint reaches on the ground (half-width from the centre line, u): the surface, the verge,
  // the barrier's strip and the bank down to the meadow (or the channel and its supports). Keep scenery out of it.
  const footprint = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const g = frames[i];
    footprint[i] = g.surface === 'plastic' ? g.width / 2 + LIP + 1.2 + 0.12 * Math.max(0, g.p.y) : hardOf(g) + STRIP[g.edge] + Math.max(0.8, (g.p.y - GROUND) * 1.8);
  }

  object.add(channel, boosters, road, props);
  const stacks: Stack[] = [];
  object.userData = { stacks, posts: sp.posts, boosterTime: time, footprint, counts: { tabs: ch.tabs, curbs: rd.curbs, tyres: br.tyres, bales: br.bales } };
  return { length: L, frames, object, collider: { positions, indices }, tags, start: TRACK_SPEC.start, frameAt, nearest, tagAt };
}
