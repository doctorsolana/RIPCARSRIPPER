import type { Surface, TrackTag } from '../types';
import { DEG, KIT, smooth, type Key, type Range, type Span, type Style } from './kit.ts';
import type { Support } from './supports.ts';

// The piece builder every course's layout is written in: a turtle (Path) that integrates analytic pieces - each with
// an authored yaw-rate / pitch / bank profile (never Frenet frames) - into a dense centre line, and records along s
// what goes where: tags (gate, booster, kicker, gap, loop ...), the supports under it, humps, the style keys (width,
// surface, edge, verge) and the free straights the closure solve sizes (tracks/frames.ts). A course's layout(A, B)
// lays its lap with two free straights A and B; the builder solves them so the lap closes exactly.

const STEP = 0.1; // dense integration step (u)
export const FLARE = 12; // u: the plastic funnel between the channel (8 u) and a road
export const GROW = 20; // u: a verge opens (or closes) over this
/** u a verge of `w` u takes to close: its far edge then meets a car on it at under ~14 deg, a glancing scrape. */
export const CLOSE = (w: number) => Math.max(GROW, 6 * w);

interface Pose { x: number; y: number; z: number; yaw: number; pitch: number; bank: number; k: number }

/** Height gained over a ramp of length len whose pitch eases 0 -> th (smoothstep). */
export function rampRise(th: number, len: number) {
  if (len <= 0) return 0;
  const n = 64;
  let a = 0;
  for (let i = 0; i <= n; i++) a += (i === 0 || i === n ? 1 : i % 2 ? 4 : 2) * Math.sin(th * smooth(i / n));
  return (a * len) / (3 * n);
}

/** How far a stretch of `len` u whose pitch eases a -> b (smoothstep, as Path.seg) runs along (x) and rises (y). */
export function easeRun(a: number, b: number, len: number) {
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
export function solve(f: (x: number) => number, target: number, lo: number, hi: number) {
  for (let i = 0; i < 60; i++) {
    const m = (lo + hi) / 2;
    if (f(m) < target) lo = m;
    else hi = m;
  }
  return (lo + hi) / 2;
}

/** A turtle that integrates pieces into dense samples [s, p(3), t(3), up(3)], and records what goes where along s. */
export class Path {
  d: number[] = [];
  pose: Pose;
  s = 0;
  tags: Span[] = [];
  keys: Key[] = [];
  sup: Range<Support>[] = [];
  humps: { s0: number; s1: number; amp: number; wave: number }[] = [];
  free: { x: number; z: number }[] = [];
  private cur: Style = { surface: 'plastic', edge: 'rail', width: KIT.width, shoulder: 0 };

  /** Starts at height y heading +x, in the style given (the plain channel by default). */
  constructor(y: number, style: Partial<Style> = {}) {
    this.pose = { x: 0, y, z: 0, yaw: 0, pitch: 0, bank: 0, k: 0 };
    this.push(0, 0, y, 0, 0, 0, 0);
    this.key(0, style);
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
  /** `n` rounded humps (raised cosines, `wave` u crest to crest, `amp` u high) from s0 on, over track still to come:
   *  track 2's bumps - rolled over slowly, hopped at speed. */
  humpsAt(s0: number, n: number, wave: number, amp: number) {
    this.humps.push({ s0, s1: s0 + n * wave, amp, wave });
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
  toRoad(surface: Surface, shoulder: number, width?: number) {
    const s = this.s, w = width ?? (surface === 'dirt' ? KIT.dirt : KIT.road);
    this.key(s, {}).key(s + FLARE, { width: w }).key(s + FLARE, { surface, edge: shoulder ? 'grass' : 'barrier', shoulder: 0 });
    return shoulder ? this.key(s + FLARE + GROW, { shoulder }) : this;
  }
  /** The plastic starts here: the verge has closed over the u before (CLOSE), and the funnel narrows to the channel
   *  (or to `width`). */
  toPlastic(width: number = KIT.width) {
    const s = this.s;
    this.key(s - CLOSE(this.cur.shoulder), {}).key(s, { shoulder: 0 }).key(s, { surface: 'plastic', edge: 'rail' });
    return this.key(s + FLARE, { width });
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
    return this.key(this.s, { surface }).key(this.s + len, { width: surface === 'dirt' ? KIT.dirt : KIT.road });
  }
  /** The surface widens (or narrows) to w over the next `len` u. */
  widen(w: number, len: number) {
    return this.key(this.s, {}).key(this.s + len, { width: w });
  }
  /** A kicker over a gap onto a landing: the lip eases up to `lip` deg over lipLen, the gap's virtual surface eases on
   *  to the landing's `land` deg over `gap` u, the landing holds it for `hold` u and eases flat over `out`. */
  kicker(J: { lip: number; lipLen: number; gap: number; land: number; hold: number; out: number }) {
    let k0 = this.s;
    this.seg(J.lipLen, { pitch: J.lip * DEG }).tag('kicker', k0);
    k0 = this.s;
    this.seg(J.gap, { pitch: J.land * DEG }).tag('gap', k0);
    return this.seg(J.hold).seg(J.out, { pitch: 0 });
  }

  /** Over `len`: yaw rate ramps linearly to k1 and bank eases (smoothstep) to bank1, as seg, while the centre line
   *  climbs h(u) over where it starts (h(0) = 0): the pitch is asin(h'(u)), so the line starts and ends level wherever
   *  h does. (Track 2's wall ride; the meadow never comes here.) */
  climb(len: number, k1: number, bank1: number, h: (u: number) => number) {
    const P = this.pose, k0 = P.k, b0 = P.bank, y0 = P.yaw, e = 1e-3;
    const yaw = (u: number) => y0 + k0 * u + ((k1 - k0) * u * u) / (2 * len);
    const pitch = (u: number) => {
      const a = Math.max(0, u - e), b = Math.min(len, u + e);
      return Math.asin(Math.max(-0.9, Math.min(0.9, (h(b) - h(a)) / (b - a))));
    };
    const tx = (u: number) => Math.cos(pitch(u)) * Math.cos(yaw(u));
    const ty = (u: number) => Math.sin(pitch(u));
    const tz = (u: number) => Math.cos(pitch(u)) * Math.sin(yaw(u));
    const n = Math.ceil(len / STEP), dh = len / n;
    let { x, y, z } = P;
    for (let i = 1; i <= n; i++) {
      const a = (i - 1) * dh, m = a + dh / 2, b = i * dh;
      x += (dh / 6) * (tx(a) + 4 * tx(m) + tx(b));
      y += (dh / 6) * (ty(a) + 4 * ty(m) + ty(b));
      z += (dh / 6) * (tz(a) + 4 * tz(m) + tz(b));
      this.push(this.s + b, x, y, z, yaw(b), pitch(b), b0 + (bank1 - b0) * smooth(b / len));
    }
    Object.assign(P, { x, y, z, yaw: yaw(len), pitch: pitch(len), bank: bank1, k: k1 });
    this.s += len;
    return this;
  }

  /** Over `len`: the heading, pitch and bank are the given functions of u (0 .. len, starting where the pose is) -
   *  integrated as seg does (Simpson on the tangent). Pitch may run past 90 deg (up a wall and over the top): the frame
   *  is push's, smooth through vertical while the yaw holds still there. Ends with yaw rate k1. (Track 2's climb.) */
  sweep(len: number, yaw: (u: number) => number, pitch: (u: number) => number, bank: (u: number) => number, k1 = 0) {
    const P = this.pose;
    const tx = (u: number) => Math.cos(pitch(u)) * Math.cos(yaw(u));
    const ty = (u: number) => Math.sin(pitch(u));
    const tz = (u: number) => Math.cos(pitch(u)) * Math.sin(yaw(u));
    const n = Math.ceil(len / STEP), dh = len / n;
    let { x, y, z } = P;
    for (let i = 1; i <= n; i++) {
      const a = (i - 1) * dh, m = a + dh / 2, b = i * dh;
      x += (dh / 6) * (tx(a) + 4 * tx(m) + tx(b));
      y += (dh / 6) * (ty(a) + 4 * ty(m) + ty(b));
      z += (dh / 6) * (tz(a) + 4 * tz(m) + tz(b));
      this.push(this.s + b, x, y, z, yaw(b), pitch(b), bank(b));
    }
    Object.assign(P, { x, y, z, yaw: yaw(len), pitch: pitch(len), bank: bank(len), k: k1 });
    this.s += len;
    return this;
  }

  /** Up the wall and over (track 2's climb, C = CLIMB): from level, a pull-up - a clothoid into radius r1 and out of
   *  it - to `over` deg, past vertical; a straight `wall` there; over the top at r2, easing to rTop as it comes upside
   *  down and level, heading back the way it came. Then a half roll (`roll` u) out of that into a right-hand turn of
   *  radius turnR banked `bank` deg: the line dives a little while the car is upside down and on its side (the curve
   *  that keeps it pressed onto the track) and levels as it comes upright, the turn's yaw rate ramping in. Ends in
   *  that turn (yaw rate 1 / turnR). The Euler angles hold over the half loop (the yaw stays put while the pitch runs
   *  0 -> 180 deg); at the top the pose is re-expressed - heading reversed, pitch 0, bank 180 - for the roll. */
  immelmann(C: { r1: number; e1: number; over: number; wall: number; r2: number; e2: number; rTop: number; e3: number; roll: number; dive: number; pull: number; turnR: number; bank: number }) {
    const P = this.pose, y0 = P.yaw;
    // the half loop: the pitch rate (curvature) along u, piecewise linear between knots, and its integral
    const q1 = 1 / C.r1, q2 = 1 / C.r2, qt = 1 / C.rTop, over = C.over * DEG;
    const h1 = over * C.r1 - C.e1 / 2; // clothoids (e1 / 2 each) in and out of r1: (h1 + e1 / 2) q1 = over
    const h2 = (Math.PI - over - (C.e2 * q2) / 2 - (C.e3 * (q2 + qt)) / 2) / q2; // ... then up to 180 deg
    if (h1 < 0 || h2 < 0) throw new Error('immelmann: radii too tight for the eases');
    const knots: [number, number][] = [[0, 0]];
    const add = (du: number, q: number) => knots.push([knots[knots.length - 1][0] + du, q]);
    add(C.e1 / 2, q1), add(h1, q1), add(C.e1 / 2, 0), add(C.wall, 0), add(C.e2, q2), add(h2, q2), add(C.e3, qt);
    const len = knots[knots.length - 1][0];
    const th = (u: number) => {
      let a = 0;
      for (let i = 0; i < knots.length - 1; i++) {
        const [u0, qa] = knots[i], [u1, qb] = knots[i + 1], du = Math.min(u, u1) - u0;
        if (du <= 0) break;
        a += qa * du + ((qb - qa) * du * du) / (2 * (u1 - u0));
      }
      return a;
    };
    this.sweep(len, () => y0, th, () => 0);
    // the half roll: heading reversed, the bank 180 -> `bank` (rolling right, through the car on its side), the yaw rate
    // ramping in to the turn's; the pitch keeps diving - at rTop's rate, easing off over the first `dive` of it (on its
    // side, gravity's own curve, so nothing pushes it across) - and pulls back up to level over the last `pull` of it
    const L = C.roll, b1 = C.bank * DEG, kT = 1 / C.turnR, yr = y0 + Math.PI, xd = C.dive, x3 = 1 - C.pull;
    const dive = (x: number) => { const t = Math.min(1, x / xd); return x < xd ? x - xd * (t * t * t - (t * t * t * t) / 2) : xd / 2; };
    const pull = (x: number) => (x < x3 ? 0 : (x - x3) / 2 - ((1 - x3) / (4 * Math.PI)) * Math.sin((2 * Math.PI * (x - x3)) / (1 - x3)));
    const lam = (qt * dive(1)) / pull(1);
    Object.assign(P, { yaw: yr, pitch: 0, bank: Math.PI });
    return this.sweep(L, (u) => yr + (kT * u * u) / (2 * L), (u) => L * (lam * pull(u / L) - qt * dive(u / L)),
      (u) => Math.PI - (Math.PI - b1) * smooth(u / L), kT);
  }

  /** A wall ride: a turn of `deg` (+ right) at radius R banked `bank` deg into it, ridden UP onto: its deck (w u
   *  across) pivots on its inner edge, so as the bank comes in over the entry's `ease` u the centre line climbs
   *  w / 2 sin(bank) - and `lift` more, the inner edge rising too - while the turn tightens in; the band holds level
   *  round the turn; the exit unwinds the bank and comes back down all of that and `drop` u more. */
  wallArc(R: number, deg: number, o: { bank: number; ease: number; w: number; lift: number; drop: number }) {
    const ang = Math.abs(deg) * DEG, sg = Math.sign(deg), e = o.ease, hold = ang * R - e;
    if (hold < 0) throw new Error(`wallArc too short: R ${R} deg ${deg}`);
    const b = o.bank * DEG, half = o.w / 2;
    this.climb(e, sg / R, sg * b, (u) => o.lift * smooth(u / e) + half * Math.sin(b * smooth(u / e)));
    this.seg(hold);
    return this.climb(e, 0, 0, (u) => -o.drop * smooth(u / e) - half * (Math.sin(b) - Math.sin(b * (1 - smooth(u / e)))));
  }
}
