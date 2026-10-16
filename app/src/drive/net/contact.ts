import * as THREE from 'three';
import type { CarHit, ContactBody, Track, Vehicle } from '../types';
import { CAR } from '../vehicles/arcade.ts';

// Car-to-car contact for online play, shared by the server (the authority: server/sim.ts) and the drive page (which
// predicts it: net/world.ts) - the same code on both, deterministic: a fixed order (the cars' grid slots), no clocks,
// no randomness, nothing allocated per step. It runs after every car has taken its step; with one car in the room
// there is nothing to do (single player never loads it).
//
// Each car is its body's box (its footprint - the box that hits the walls - standing on the ground, as tall as the
// model), its mass its profile's heft, its yaw inertia a box's (x CAR.inertia: the tyres resist being turned). Two boxes
// are tested in the plane they share (the average of the two cars' up vectors: the track's surface on the ground, on a
// bank, in a loop) with a separating-axis test on their four in-plane axes plus their overlap along the plane's normal -
// so a car in the air passes over one below it unless they really meet, and one coming down on another's roof bounces
// off it. The contact normal is the axis they came together on (swept: where their boxes overlapped least before the
// step - no tunnelling, however fast a stacked boost throws a car), or the least overlap for two that were already
// touching. The contact point is where the touching corner or edge is (the incident face clipped against the reference
// face: a corner hit is at the corner, two flanks side by side touch in the middle of their overlap). There the two
// cars swap an impulse: solid toy cars, not pinballs - the closing speed bounced back by CAR.e (none for a touch under
// 3 u/s or a glancing scrape under 15 deg, as the walls), Coulomb friction (CAR.mu) along the flank, and the yaw that
// impulse makes about each car's middle, at most CAR.yawMax a step (as a wall's kick is capped) - so a hit off a car's
// centre turns it, a heavy car shoves a light one, and a big T-bone on the rear quarter or a PIT spins it (carHit's
// rules). A car pressed against a rail (its body's wn) can't be pushed further into it: that part of the push goes
// into the rail, so the car pushing it takes the whole bounce and the separation (no energy from the sandwich, no
// bounce-back loop). The overlap is eased apart gently - BAUM of it a pass, at most SEP_MAX, the heavier car moving
// less, never into a rail - as a position change only (never a velocity), and the solver iterates (ITER) so a pack of
// ten settles without jitter. No contact through a split's island (cars in different lanes), with a car that was just
// put back on the track (CAR.ghost s) or one falling off it, or with a car that has finished the race (the caller's
// skip list). The step's sum of it per car goes to the vehicle's carHit: the stun / spin-out rules and the events the
// effects read.

const DEG = Math.PI / 180;
const ITER = 3; // passes over the touching pairs per step
const SLOP = 0.02; // u of overlap left alone (no buzz)
const SEP_MAX = 0.06; // u: the most a pair is eased apart in a pass (0.18 u a step: the impulses part them, this only tidies)
const BAUM = 0.25; // of the overlap eased apart per pass
const BOUNCE_MIN = 3; // u/s: a slower closing speed only touches (no bounce, no hit event)
const GLANCE = 15 * DEG; // a shallower hit scrapes along without a bounce (fading in over the next 10 deg)
const BROAD = 12; // u along the track: farther apart, no test

export interface ContactStats {
  pairs: number; // pairs close enough to test
  touches: number; // ... in contact (per pass)
  hits: number; // ... hits (closing faster than BOUNCE_MIN)
  maxDepth: number; // the deepest overlap seen (u)
  maxVn: number; // the hardest hit (closing speed, u/s)
}
export const newContactStats = (): ContactStats => ({ pairs: 0, touches: 0, hits: 0, maxDepth: 0, maxVn: 0 });

const smooth = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

// scratch
const N = new THREE.Vector3(), fa = new THREE.Vector3(), ra = new THREE.Vector3(), fb = new THREE.Vector3(), rb = new THREE.Vector3();
const D = new THREE.Vector3(), Vr = new THREE.Vector3(), nrm = new THREE.Vector3(), P = new THREE.Vector3();
const rA = new THREE.Vector3(), rB = new THREE.Vector3(), t3 = new THREE.Vector3(), vt = new THREE.Vector3(), J = new THREE.Vector3();
const tan = new THREE.Vector3();
const man = { depth: 0, vert: false };

/** Two boxes in contact? Leaves the normal (A to B) in nrm, the contact point in P, the overlap in man. */
function collide(A: ContactBody, B: ContactBody, h: number): boolean {
  if (A.u.dot(B.u) < 0.5) return false; // (one upside down over the other: they can't meet flat)
  N.addVectors(A.u, B.u).normalize();
  D.subVectors(B.c, A.c);
  const dz = D.dot(N);
  const hzA = A.hh * Math.abs(A.u.dot(N)) + A.hl * Math.abs(A.f.dot(N)) + A.hw * Math.abs(A.r.dot(N));
  const hzB = B.hh * Math.abs(B.u.dot(N)) + B.hl * Math.abs(B.f.dot(N)) + B.hw * Math.abs(B.r.dot(N));
  const overZ = hzA + hzB - Math.abs(dz);
  if (overZ <= 0) return false;
  // in the plane: each box's nose and right axes, the centres' offset, and where it was a step ago (relative motion)
  fa.copy(A.f).addScaledVector(N, -A.f.dot(N)).normalize();
  ra.crossVectors(fa, N);
  fb.copy(B.f).addScaledVector(N, -B.f.dot(N)).normalize();
  rb.crossVectors(fb, N);
  Vr.subVectors(B.v, A.v);
  const vz = Vr.dot(N);
  const dx = D.dot(fa), dy = D.dot(ra); // (2D: A's nose x, its right y)
  const vx = Vr.dot(fa), vy = Vr.dot(ra);
  const x0 = dx - vx * h, y0 = dy - vy * h, dz0 = dz - vz * h;
  const bfx = fb.dot(fa), bfy = fb.dot(ra), brx = rb.dot(fa), bry = rb.dot(ra); // B's axes in A's 2D frame
  let minOver = Infinity, minK = -1, entry = -Infinity, entryK = -1;
  for (let k = 0; k < 4; k++) {
    const ux = k === 0 ? 1 : k === 1 ? 0 : k === 2 ? bfx : brx;
    const uy = k === 0 ? 0 : k === 1 ? 1 : k === 2 ? bfy : bry;
    const pa = A.hl * Math.abs(ux) + A.hw * Math.abs(uy);
    const pb = B.hl * Math.abs(ux * bfx + uy * bfy) + B.hw * Math.abs(ux * brx + uy * bry);
    const over = pa + pb - Math.abs(dx * ux + dy * uy);
    if (over <= 0) return false;
    if (over < minOver) (minOver = over), (minK = k);
    const over0 = pa + pb - Math.abs(x0 * ux + y0 * uy);
    if (over0 <= 0) {
      const t = -over0 / (over - over0);
      if (t > entry) (entry = t), (entryK = k);
    }
  }
  // the plane's normal as a fifth axis - only with a car in the air (two on the ground share the surface)
  const air = A.air || B.air;
  if (air) {
    const over0 = hzA + hzB - Math.abs(dz0);
    if (over0 <= 0) {
      const t = -over0 / (overZ - over0);
      if (t > entry) (entry = t), (entryK = 4);
    }
    if (entryK < 0 && overZ < minOver) (minOver = overZ), (minK = 4);
  }
  const k = entryK >= 0 ? entryK : minK;
  const zlo = Math.max(-hzA, dz - hzB), zhi = Math.min(hzA, dz + hzB), zc = (zlo + zhi) / 2;
  if (k === 4) {
    man.vert = true;
    man.depth = overZ;
    nrm.copy(N).multiplyScalar(dz < 0 ? -1 : 1);
    P.copy(A.c).addScaledVector(fa, dx / 2).addScaledVector(ra, dy / 2).addScaledVector(N, zc);
    return true;
  }
  man.vert = false;
  // the normal (A to B) in 2D, and the overlap along it
  let ux = k === 0 ? 1 : k === 1 ? 0 : k === 2 ? bfx : brx, uy = k === 0 ? 0 : k === 1 ? 1 : k === 2 ? bfy : bry;
  const dist = dx * ux + dy * uy, dist0 = x0 * ux + y0 * uy;
  if (dist < 0 || (dist === 0 && dist0 < 0)) (ux = -ux), (uy = -uy);
  {
    const pa = A.hl * Math.abs(ux) + A.hw * Math.abs(uy);
    const pb = B.hl * Math.abs(ux * bfx + uy * bfy) + B.hw * Math.abs(ux * brx + uy * bry);
    man.depth = pa + pb - Math.abs(dx * ux + dy * uy);
  }
  // The contact point: the reference face (the box the axis belongs to, its face along the normal) and the incident
  // box's face most against it, clipped to the reference face's width; the points under the reference face, averaged.
  const refA = k < 2;
  const nx = refA ? ux : -ux, ny = refA ? uy : -uy; // the reference face's outward normal (toward the other box)
  const cx = refA ? 0 : dx, cy = refA ? 0 : dy; // reference box's centre
  const rfx = refA ? 1 : bfx, rfy = refA ? 0 : bfy, rrx = refA ? 0 : brx, rry = refA ? 1 : bry, rhl = refA ? A.hl : B.hl, rhw = refA ? A.hw : B.hw;
  const alongNose = k % 2 === 0; // the axis is the reference box's nose axis: its face is the nose or tail
  const ext = alongNose ? rhl : rhw, half = alongNose ? rhw : rhl;
  const tx = alongNose ? rrx : rfx, ty = alongNose ? rry : rfy; // along the reference face
  const fcx = cx + nx * ext, fcy = cy + ny * ext; // the reference face's centre
  // incident box
  const icx = refA ? dx : 0, icy = refA ? dy : 0;
  const ifx = refA ? bfx : 1, ify = refA ? bfy : 0, irx = refA ? brx : 0, iry = refA ? bry : 1, ihl = refA ? B.hl : A.hl, ihw = refA ? B.hw : A.hw;
  const dF = ifx * nx + ify * ny, dR = irx * nx + iry * ny;
  let ex: number, ey: number, sx: number, sy: number; // incident face centre and half-extent along it
  if (Math.abs(dF) >= Math.abs(dR)) {
    const sg = dF > 0 ? -1 : 1; // the face whose normal points against the reference normal
    ex = icx + ifx * sg * ihl, ey = icy + ify * sg * ihl, sx = irx * ihw, sy = iry * ihw;
  } else {
    const sg = dR > 0 ? -1 : 1;
    ex = icx + irx * sg * ihw, ey = icy + iry * sg * ihw, sx = ifx * ihl, sy = ify * ihl;
  }
  // the segment (ex, ey) +- (sx, sy), clipped to |(p - fc) . t| <= half
  let ta = -1, tb = 1;
  const a0 = (ex - fcx) * tx + (ey - fcy) * ty, a1 = sx * tx + sy * ty; // along the face: a0 + a1 * u, u in -1..1
  if (Math.abs(a1) > 1e-9) {
    const u1 = (-half - a0) / a1, u2 = (half - a0) / a1;
    ta = Math.max(ta, Math.min(u1, u2));
    tb = Math.min(tb, Math.max(u1, u2));
  } else if (Math.abs(a0) > half) (ta = 0), (tb = 0); // (parallel, off the face: degenerate - use the middle)
  if (ta > tb) ta = tb = (ta + tb) / 2;
  let px = 0, py = 0, w = 0, bx = 0, by = 0, bs = Infinity;
  for (let i = 0; i < 2; i++) {
    const u = i === 0 ? ta : tb;
    const qx = ex + sx * u, qy = ey + sy * u;
    const sep = (qx - fcx) * nx + (qy - fcy) * ny; // < 0: under the reference face
    if (sep < bs) (bs = sep), (bx = qx), (by = qy);
    if (sep < 0) (px += qx - (nx * sep) / 2), (py += qy - (ny * sep) / 2), w++;
  }
  if (w) (px /= w), (py /= w);
  else (px = bx), (py = by);
  nrm.copy(fa).multiplyScalar(ux).addScaledVector(ra, uy);
  P.copy(A.c).addScaledVector(fa, px).addScaledVector(ra, py).addScaledVector(N, zc);
  return true;
}

/** The contact solver: one per race (server: RaceSim; page: its predicted world). Not reentrant. */
export class ContactSolver {
  readonly stats: ContactStats = newContactStats();
  private hits: CarHit[] = [];
  private touched = new Uint8Array(0);
  private cand = new Int32Array(0);
  private bodies: ContactBody[] = [];
  readonly track: Track;
  constructor(track: Track) {
    this.track = track;
  }

  /** After every car's step: contact between the `n` first `cars` (in the race's fixed order); skip[i] = 1: car i
   *  passes through the others (finished). Returns how many pairs touched (any pass). */
  solve(cars: readonly Vehicle[], n: number, skip: ArrayLike<number> | null, h: number): number {
    if (n < 2) return 0;
    if (this.touched.length < n) {
      this.touched = new Uint8Array(n);
      this.cand = new Int32Array(n * n);
      while (this.hits.length < n) this.hits.push({ vn: 0, unq: 0, th: 0, xc: 0, slide: 0, dw: 0, dwr: 0, px: 0, py: 0, pz: 0, nx: 0, ny: 0, nz: 0, dvx: 0, dvy: 0, dvz: 0 });
    }
    const L = this.track.length, st = this.stats, touched = this.touched, hits = this.hits, bodies = this.bodies;
    bodies.length = n;
    for (let i = 0; i < n; i++) bodies[i] = cars[i].body!();
    // the pairs worth testing: close along the track, close in the world, not through the island, neither a ghost
    let nc = 0;
    for (let i = 0; i < n; i++) {
      const A = bodies[i];
      if (A.ghost || (skip && skip[i])) continue;
      const rA2 = A.hl * A.hl + A.hw * A.hw + A.hh * A.hh;
      for (let j = i + 1; j < n; j++) {
        const B = bodies[j];
        if (B.ghost || (skip && skip[j])) continue;
        if (A.lane !== 0 && B.lane !== 0 && A.lane !== B.lane) continue;
        let ds = B.s - A.s;
        if (ds > L / 2) ds -= L;
        else if (ds < -L / 2) ds += L;
        if (ds > BROAD || ds < -BROAD) continue;
        const r = Math.sqrt(rA2) + Math.sqrt(B.hl * B.hl + B.hw * B.hw + B.hh * B.hh);
        if (A.c.distanceToSquared(B.c) > r * r) continue;
        this.cand[nc++] = i * n + j;
      }
    }
    st.pairs += nc;
    if (!nc) return 0;
    touched.fill(0, 0, n);
    let touching = 0;
    for (let it = 0; it < ITER; it++) {
      let any = false;
      for (let c = 0; c < nc; c++) {
        const i = (this.cand[c] / n) | 0, j = this.cand[c] - i * n;
        const A = cars[i].body!(), B = cars[j].body!();
        if (!collide(A, B, h)) continue;
        any = true;
        st.touches++;
        if (man.depth > st.maxDepth) st.maxDepth = man.depth;
        // the impulse at P: closing speed along the normal (yaw rates about the shared plane's normal; + right is a
        // clockwise turn seen from above, so the angular velocity is -w N)
        rA.subVectors(P, A.c);
        rB.subVectors(P, B.c);
        Vr.subVectors(B.v, A.v);
        Vr.addScaledVector(t3.crossVectors(N, rB), -B.w).addScaledVector(t3.crossVectors(N, rA), A.w);
        const vn = Vr.dot(nrm);
        const vert = man.vert;
        // (coming down on a car on the ground: that one is held by the ground along the normal; a car pressed against
        // a rail is held by it along the rail's normal - fA, fB: the share of a push along the normal it can still take)
        const pA = vert ? 0 : Math.max(0, -nrm.dot(A.wn)), pB = vert ? 0 : Math.max(0, nrm.dot(B.wn));
        const fA = 1 - pA * pA, fB = 1 - pB * pB;
        const iA = vert && !A.air ? 0 : fA / A.m, iB = vert && !B.air ? 0 : fB / B.m;
        if (iA + iB < 1e-6) continue;
        const cA = vert ? 0 : t3.crossVectors(rA, nrm).dot(N), cB = vert ? 0 : t3.crossVectors(rB, nrm).dot(N);
        const kn = iA + iB + (fA * cA * cA) / A.I + (fB * cB * cB) / B.I;
        vt.copy(Vr).addScaledVector(nrm, -vn);
        const vtl = vt.length();
        const th = Math.atan2(Math.max(0, -vn), vtl);
        let jn = 0, jt = 0;
        if (vn < 0) {
          const e = it === 0 ? CAR.e * smooth(BOUNCE_MIN, BOUNCE_MIN + 3, -vn) * smooth(GLANCE, GLANCE + 10 * DEG, th) : 0;
          jn = (-(1 + e) * vn) / kn;
          if (vtl > 1e-6) {
            tan.copy(vt).divideScalar(vtl);
            const tA = vert ? 0 : t3.crossVectors(rA, tan).dot(N), tB = vert ? 0 : t3.crossVectors(rB, tan).dot(N);
            const kt = iA + iB + (fA * tA * tA) / A.I + (fB * tB * tB) / B.I;
            jt = Math.min(vtl / kt, CAR.mu * jn);
          }
        }
        J.copy(nrm).multiplyScalar(jn);
        if (jt > 0) J.addScaledVector(tan, -jt);
        // what a rail holds back: the part of each car's push into its rail (A takes -J: into its rail when J . wn < 0)
        const hA = Math.min(0, J.dot(A.wn)), hB = Math.max(0, J.dot(B.wn));
        const mA = 1 / A.m, mB = 1 / B.m;
        const dvAx = (A.wn.x * hA - J.x) * mA, dvAy = (A.wn.y * hA - J.y) * mA, dvAz = (A.wn.z * hA - J.z) * mA;
        const dvBx = (J.x - B.wn.x * hB) * mB, dvBy = (J.y - B.wn.y * hB) * mB, dvBz = (J.z - B.wn.z * hB) * mB;
        // yaw: dW = (r x J) . N / I (counter-clockwise), and + right is the other way; a step's hits turn a car by at
        // most CAR.yawMax (summed over its contacts and passes)
        let dwA = vert ? 0 : (fA * t3.crossVectors(rA, J).dot(N)) / A.I; // (A takes -J)
        let dwB = vert ? 0 : (-fB * t3.crossVectors(rB, J).dot(N)) / B.I;
        const hitA = hits[i], hitB = hits[j];
        const wA0 = touched[i] ? hitA.dw : 0, wB0 = touched[j] ? hitB.dw : 0;
        dwA = Math.max(-CAR.yawMax, Math.min(CAR.yawMax, wA0 + dwA)) - wA0;
        dwB = Math.max(-CAR.yawMax, Math.min(CAR.yawMax, wB0 + dwB)) - wB0;
        // ease the overlap apart, the heavier car moving less (one held by a rail: the other)
        const corr = Math.min(SEP_MAX, Math.max(0, man.depth - SLOP) * BAUM) / (iA + iB);
        // the hit's record for each car (what carHit judges): the hardest contact, the summed push
        if (it === 0 && -vn > BOUNCE_MIN) st.hits++;
        if (-vn > st.maxVn) st.maxVn = -vn;
        for (let s = 0; s < 2; s++) {
          const me = s === 0 ? i : j, X = s === 0 ? A : B, iOther = s === 0 ? iB : iA, iMe = s === 0 ? iA : iB;
          const hh = hits[me];
          if (!touched[me]) {
            touched[me] = 1;
            hh.vn = -1, hh.slide = 0, hh.dw = 0, hh.dwr = 0, hh.dvx = hh.dvy = hh.dvz = 0;
          }
          const xc = (P.x - X.c.x) * X.f.x + (P.y - X.c.y) * X.f.y + (P.z - X.c.z) * X.f.z;
          if (-vn > hh.vn) {
            hh.vn = -vn;
            hh.unq = -vn * (iMe / Math.max(1e-6, iMe + iOther)); // x the other car's share of the mass (the ground's: all)
            hh.th = th;
            hh.px = P.x, hh.py = P.y, hh.pz = P.z;
            const sg = s === 0 ? -1 : 1; // the normal into this car
            hh.nx = nrm.x * sg, hh.ny = nrm.y * sg, hh.nz = nrm.z * sg;
            hh.xc = xc;
          }
          if (vtl > hh.slide) hh.slide = vtl;
          // (a push on its rear quarter that closed faster than a touch: a PIT's yaw)
          if (-vn > BOUNCE_MIN && xc < -0.3 * X.hl) hh.dwr += s === 0 ? dwA : dwB;
        }
        hitA.dvx += dvAx, hitA.dvy += dvAy, hitA.dvz += dvAz, hitA.dw += dwA;
        hitB.dvx += dvBx, hitB.dvy += dvBy, hitB.dvz += dvBz, hitB.dw += dwB;
        cars[i].carPush!(dvAx, dvAy, dvAz, dwA, -nrm.x * corr * iA, -nrm.y * corr * iA, -nrm.z * corr * iA);
        cars[j].carPush!(dvBx, dvBy, dvBz, dwB, nrm.x * corr * iB, nrm.y * corr * iB, nrm.z * corr * iB);
        if (it === 0) touching++;
      }
      if (!any) break;
    }
    for (let i = 0; i < n; i++) {
      if (!touched[i]) continue;
      const hh = hits[i];
      if (hh.vn < 0) hh.vn = 0;
      cars[i].carHit!(hh);
    }
    return touching;
  }
}
