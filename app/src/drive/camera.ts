import * as THREE from 'three';
import type { Track, TrackFrame, VehicleState } from './types';

// Chase camera. It follows the CAR, never the road: what turns the view is the car turning, so steering and drifting
// read as the player's doing. Springs act on ANGLES and DISTANCE relative to the car, never on a world position (a
// world-position spring trails 2v/omega ~ 6 u behind at top speed and the car swims in frame).
//   yaw   the car's heading - its nose, turned yawTravel (40%) of the way to its direction of travel - on a critically
//         damped spring (yawHalfLife 0.3 s): steer and the car turns in frame first, then the camera comes round after
//         it. Past yawFree of turn in frame the spring starts matching the heading's own turn rate (fully by yawHold), so
//         a long or tight turn holds the car ~15-20 deg round in frame instead of swinging it further. A drift shows the
//         car's side (its slip x 40%, plus the turn) and the camera sits a little to the outside of the slide. Slow or
//         reversing: the nose alone; in the air: the flight; in a spin-out: the travel at any facing, so the car spins in
//         frame instead of the world spinning round it. Never the track's direction, never a look-ahead along the road.
//   look  a little ahead of the car along its own velocity, raised a touch at speed so the car keeps round 2's place on
//         screen (in the air partly at where the flight is going - the landing, or wherever the car really goes)
//   up    level: the camera pitches with the slope under the car but never rolls with a bank, so the horizon stays put on
//         roads, banks and the helix. Only where the track's up leans far from the world's (the loop; a bank past
//         25-45 deg) does it hand over to the track's up (85%, plus 15% world up), so the loop still rolls the world
//   dist  grows with speed, more on boost; plus a critically damped follow along the view (followFreq): speeding up
//         leaves the camera a little behind, braking lets the car come back toward it, level again at a steady speed
//   fov   58 -> 67 deg by (v/vtop)^1.5, +5 on boost (springy punch); portrait: wider, higher, further, aimed lower so
//         the track ahead fills the tall screen
// All numbers live in CAMERA (read every frame, so ?tune=camera sliders can edit it live). Distance, height and lens at
// rest are round 2's: the car's width ~17% of a 16:9 screen at rest, ~13% at cruise, ~11% on boost.
//   air   the camera's height follows slowly so the car rises in frame (by at most airLag; it never rides up over a
//         landing ramp rising to meet the car), aims partly along the flight, dips on touchdown (harder after a long
//         flight). A car that falls short or off the side is followed down (the camera keeps to the track's driving
//         side only while the car is on it)
//   loop  inside a loop it looks at the car, not round the loop ahead (that sank the car out of frame)
//   shake trauma^2 x (0.3 u, 2 deg roll) x smooth noise, trauma decays 1.5/s. A wall hit adds trauma by its
//         severity - the speed into the wall, and its angle: a glancing scrape stays smooth, a square hit
//         shakes - and jolts the camera on toward the wall for a moment, so the car bounces off it in frame
//   kick  nothing here touches time (no hit-stop, no slow-mo: the sim stays fixed-step for lockstep multiplayer), so
//         an impact's drama is the camera's: a wall hit also punches the FOV in for ~0.2 s by its severity (most on
//         the hardest hits), a spin-out kicks harder, a long flight lands with a slam
//   spin  a spin-out (events.spinOut, or the nose > 60 deg off the travel at speed) kicks the roll the way
//         the car spins and pulls the camera back a touch; the yaw keeps to the travel at speed whatever
//         the car's facing, so the car spins in frame instead of the world spinning round it
//   ad    the big jump's "Hot Wheels ad" shot (presentation only: it frames whatever flight the car makes off the lip -
//         a clean one or a miss). Off the 'bigjump' lip with a long flight ahead, the camera swings out round the car to
//         a low side view that dollies along beside the arc (portrait: a rear quarter, so the car crosses the narrow
//         screen less), the car against the sky, and swings back behind it before touchdown so the landing reads from
//         the chase position. The time left in the air is predicted every frame from the car's ballistic path against
//         the track (or the meadow, short of it or beside it). The side is the one with the clearer view (no other part
//         of the course in the way), then the one with the sun behind the camera; the car's centre is held inside the
//         frame throughout. Track 2's sky jump flies through a hoop over the apex of its flight (track.ts hoop()): side-on
//         the ring is edge-on as the car goes through, then its near side sweeps between the camera and the car, so there
//         the dolly holds back (adHoopLag) - the car flies on into the open ring, through it and out
// Pass the interpolated render pose (e.g. the rig root) as `pose`, or the car jitters against the
// camera whenever frames and fixed steps don't line up.

export interface Pose { readonly position: THREE.Vector3; readonly quaternion: THREE.Quaternion }

export interface ChaseCamera {
  camera: THREE.PerspectiveCamera;
  reset(state: VehicleState, track: Track, pose?: Pose): void;
  update(state: VehicleState, dt: number, track: Track, pose?: Pose): void;
  addTrauma(amount: number): void;
  resize(w: number, h: number): void;
}

/** Live-tunable camera numbers (u, deg, s). */
export const CAMERA: Record<string, number> = {
  vtop: 44, // u/s the speed-scaled framing is normalised to
  dist0: 5.2, // u behind the car at rest
  dist1: 6.0, // ... at vtop
  distBoost: 1.0, // extra while boosting
  height0: 2.05, // u above the car at rest
  height1: 1.85, // ... at vtop
  fov0: 58, // vertical deg at rest
  fov1: 67, // ... at vtop, by (v/vtop)^1.5
  fovBoost: 5,
  lookAhead: 0.12, // s along the car's velocity ...
  lookMax: 4, // ... at most this far (u)
  lookRaise: 0.8, // u above the car at rest ...
  lookRaiseFast: 1.2, // ... and from 15 u/s on (the look ahead is short: this keeps the car's place on screen)
  yawHalfLife: 0.3, // s: the yaw spring's response to a sudden change of heading (half the way round in this long)
  yawTravel: 0.4, // share of the direction of travel in the heading the camera follows (the rest: the car's nose)
  yawFree: 10, // deg of turn in frame the spring lets build freely ...
  yawHold: 32, // ... matching the heading's own turn rate fully by this much
  driftSide: 0.6, // u to the outside of a drift
  followFreq: 7, // rad/s: the critically damped follow along the view (lag = acceleration / followFreq^2)
  followMax: 1.2, // u: at most this much nearer or further for it
  portraitFov: 22, // deg added at 1:2 portrait
  portraitDist: 0.35, // x distance added at 1:2 portrait
  portraitHeight: 0.5, // x height added at 1:2 portrait
  portraitAim: 0.6, // share of the look-ahead and look-raise dropped at 1:2 portrait (aims lower)
  shake: 0.3, // u at trauma 1
  shakeRoll: 2, // deg at trauma 1
  hitShake: 0.85, // trauma from the most severe wall hit (~30 u/s square into it)
  hitJolt: 0.12, // u/s the camera carries on toward the wall per u/s of impact (springs back in ~0.25 s)
  hitPop: 150, // deg/s the FOV punches in at by a hit's severity (peaks ~3 deg, ~5 deg on the hardest), back in ~0.2 s
  spinKick: 1.1, // rad/s of roll kicked in on a spin-out (~3 deg)
  spinPop: 230, // deg/s: a spin-out's FOV punch (~5 deg)
  airLag: 1.5, // u: most the camera's height may trail the car's in the air (off the drop the track falls away 14 u)
  landSlam: 1, // the touchdown after a long flight: extra dip, shake and FOV punch (x)
  adMinAir: 1.4, // s of predicted flight off the 'bigjump' lip for the ad shot (0 = never)
  adIn: 0.65, // s the camera takes to swing out to the side ...
  adOut: 0.6, // ... and back behind the car, ...
  adOutEnd: 0.25, // ... done this long before touchdown
  adDist: 0.18, // x the flight's length: the side camera's distance from the arc (at least 13 u past the widest surface
  // under the flight; clamped adDistMin..adDistMax u)
  adDistMin: 14,
  adDistMax: 22,
  adHeight: -1, // u relative to the lip (or the landing, if lower, by at most 6 u), and 1.5 u over any surface under the
  // flight: low, the car against the sky ...
  adCrane: 0.75, // ... rising this share of the way with the car (and sinking with it toward the landing)
  adFov: 50, // deg (a longer lens than the chase's)
  adPortraitFov: 18, // deg added at 1:2 portrait
  adAz: 90, // deg round from behind the flight: 90 = side-on ...
  adAzPortrait: 50, // ... a rear quarter at 1:2 portrait (the narrow screen)
  adLead: 0.14, // the camera aims ahead of the car along its flight by this x its distance ...
  adAim: 5, // ... and this many deg under it (the car flies high in the frame, the ground below)
  adKeep: 0.6, // the car's centre stays within this share of the half view (the narrower way)
  adHoopLag: 18, // u: through a hoop (track 2's sky jump) the dolly holds back so the car passes the flight's apex at least
  // this far ahead of the camera - the ring seen open, not edge-on, and its near side never between the camera and the car
};

const DEG = Math.PI / 180;
const CLEARANCE = 1.1; // min height of the camera above the track surface behind the car
const UP_HALF_LIFE = 0.045;
const UP_LEAD = UP_HALF_LIFE / Math.LN2; // s: the lag of that smoothing on a steady turn
const WORLD_UP = new THREE.Vector3(0, 1, 0);
const G_AIR = 24; // u/s^2: the arcade model's gravity, for the flight's time left (re-predicted every frame, so a
// different gravity only shifts the swing back a little)
const AIR_LOOK = 0.5; // s: in the air the camera aims partly at the flight this far on (or its touchdown, if sooner)
const YAW_RATE_MAX = 9; // rad/s: the most the camera turns (a big swing back behind a car turns round, never cuts)
// The ad camera dollies along the flight from abreast this share of it to this one: about half the car's pace side-on,
// so the car crosses the frame; nearly its pace at portrait's rear quarter, so it doesn't fly off into the distance.
const AD_FROM = [0.12, 0.02], AD_TO = [0.66, 0.9];
const SUN = new THREE.Vector3(-90, 0, 130).normalize(); // plan direction toward the sun (world-outdoor's sunFrom)

interface Spr { x: number; v: number }
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
/** 0..1 eased with zero velocity and acceleration at both ends. */
const smoother = (x: number) => {
  const t = clamp(x, 0, 1);
  return t * t * t * (t * (6 * t - 15) + 10);
};
/** Exponential smoothing factor for a half-life, frame-rate independent. */
const damp = (halfLife: number, dt: number) => 1 - Math.pow(2, -dt / halfLife);
function spring(s: Spr, target: number, omega: number, zeta: number, dt: number) {
  for (let t = dt; t > 1e-6; t -= 1 / 120) {
    const h = Math.min(t, 1 / 120);
    s.v += (-2 * zeta * omega * s.v - omega * omega * (s.x - target)) * h;
    s.x += s.v * h;
  }
}
/** Signed angle from a to b about the unit axis n (both roughly square to it). */
const angleAbout = (a: THREE.Vector3, b: THREE.Vector3, n: THREE.Vector3, tmp: THREE.Vector3) =>
  Math.atan2(tmp.crossVectors(a, b).dot(n), a.dot(b));
// Smooth, zero-mean noise in about -1..1 (~10-27 Hz content).
const noise = (t: number, seed: number) =>
  (Math.sin(t * 61.3 + seed) + 0.6 * Math.sin(t * 107.9 + seed * 2.1) + 0.3 * Math.sin(t * 171.1 + seed * 3.7)) / 1.9;
const frame = (): TrackFrame => ({
  s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(0, 0, 1), kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
});

export function createChaseCamera(): ChaseCamera {
  const C = CAMERA;
  const camera = new THREE.PerspectiveCamera(C.fov0, 16 / 9, 0.1, 1200);
  const fr = frame(), fr2 = frame(), frP = frame();
  const up = new THREE.Vector3(0, 1, 0), fwd = new THREE.Vector3(1, 0, 0), right = new THREE.Vector3(0, 0, 1);
  const trackUp = new THREE.Vector3(), trackP = new THREE.Vector3();
  const nose = new THREE.Vector3(), carRight = new THREE.Vector3(), tgt = new THREE.Vector3(), tmp = new THREE.Vector3();
  const tmp2 = new THREE.Vector3(), prevNose = new THREE.Vector3(1, 0, 0), prevTgt = new THREE.Vector3(1, 0, 0);
  const lookT = new THREE.Vector3(), lookOff = new THREE.Vector3(), look = new THREE.Vector3();
  const anchor = new THREE.Vector3(), pos = new THREE.Vector3();
  const dist: Spr = { x: C.dist0, v: 0 }, fovKick: Spr = { x: 0, v: 0 }, dip: Spr = { x: 0, v: 0 };
  const jolt: Spr = { x: 0, v: 0 }, roll: Spr = { x: 0, v: 0 }; // impact jolt (u, camera right), spin-out roll (rad)
  const pop: Spr = { x: 0, v: 0 }; // impact FOV punch (deg)
  let fovBase = C.fov0, lat = 0, lift = 0, driftW = 0, airW = 0, trauma = 0, time = 0, portrait = 0, loopW = 0;
  let lastSpeed = 0, spinning = false, spinW = 0, spinT = -1, spinAt = -1, airT = 0;
  // the yaw spring's turn rate (rad/s), the followed heading's own turn rate (rad/s), the track's share of the up (0 on
  // roads, 1 in the loop); the follow along the view: how far the camera has dropped back (u) and its speed (u/s)
  let yawV = 0, tgtRate = 0, upW = 0, lagX = 0, camV = 0;
  let resetting = false;

  // ---- the big jump's ad shot
  // the track's 'bigjump' spans [s0, s1, ...] and the meadow's height (the course is scanned once per track)
  const jumps: number[] = [];
  let scanned: Track | null = null, groundY = 0, hoop = false; // hoop: the big jump flies through a hoop at its apex
  // the shot: launch point and velocity, flight direction (plan), the side the camera is on, the flight's plan length,
  // the camera's distance and height; time since launch and the predicted time left; the blend weight
  const adP0 = new THREE.Vector3(), adV0 = new THREE.Vector3(), adG = new THREE.Vector3(), adS = new THREE.Vector3();
  const adPos = new THREE.Vector3(), adLook = new THREE.Vector3(), carC = new THREE.Vector3(), camUp = new THREE.Vector3();
  const oc = new THREE.Vector3(), oa = new THREE.Vector3(), xp = new THREE.Vector3(), xq = new THREE.Vector3();
  let adOn = false, adT = 0, adLeft = Infinity, adW = 0, adDx = 0, adD = 20, adY = 0, adFlight = 1, landS = 0, adApex = -1;
  let landMiss = false; // the last prediction came down on the meadow, not the track

  function scan(track: Track) {
    scanned = track;
    jumps.length = 0;
    for (const g of track.tags) if (g.tag === 'bigjump') jumps.push(g.s0, g.s1);
    hoop = (track.object.userData as { course?: string }).course === 'sky'; // (track 2: the hoop over its sky jump)
    let minY = 0;
    for (const f of track.frames) minY = Math.min(minY, f.p.y);
    groundY = Math.min(0, minY - 0.3); // as world-outdoor's meadow
  }

  /** At s, on a big jump's lip (a little before it, or up to its middle)? */
  function onJumpLip(s: number, L: number) {
    for (let i = 0; i < jumps.length; i += 2) {
      const span = (((jumps[i + 1] - jumps[i]) % L) + L) % L, d = (((s - jumps[i]) % L) + L) % L;
      if (d < 0.5 * span || d > L - 10) return true;
    }
    return false;
  }

  /** Seconds until a ballistic flight from p at velocity v comes down onto the track (not over a gap, within its
   *  edges) or onto the meadow (landMiss), following the track along from s as the vehicle does; Infinity past `max`
   *  s. It lands where it crosses the surface on the way down, or where a gap ends with it just under the surface (as
   *  the vehicle, within 0.75 u, plus a sample's fall). */
  function timeToLand(track: Track, p: THREE.Vector3, v: THREE.Vector3, s0: number, max: number) {
    let s = s0, prevH = -1, prevT = 0, prevGap = false;
    landMiss = false;
    for (let t = 0; t <= max; t += 1 / 30) {
      xp.copy(p).addScaledVector(v, t);
      xp.y -= 0.5 * G_AIR * t * t;
      if (xp.y < groundY) return (landS = s), (landMiss = true), t;
      let f = track.frameAt(s, frP);
      for (let i = 0; i < 4; i++) {
        const ds = clamp(xq.subVectors(xp, f.p).dot(f.t), -6, 6);
        if (Math.abs(ds) < 0.02) break;
        s += ds;
        f = track.frameAt(s, frP);
      }
      xq.subVectors(xp, f.p);
      const hb = xq.dot(f.up), d = xq.dot(f.right), lim = f.width * 0.5 + (f.edge === 'grass' ? f.shoulder : 0);
      const vn = v.x * f.up.x + (v.y - G_AIR * t) * f.up.y + v.z * f.up.z;
      const gap = track.tagAt(s) === 'gap';
      if (t > 0 && !gap && hb <= 0 && vn < 0 && Math.abs(d) <= lim + 0.5) {
        landS = s; // (where along the track)
        if (prevH > 0) return prevT + ((t - prevT) * prevH) / (prevH - hb); // between the two samples
        if (prevGap && hb > -0.75 + vn / 30) return t;
      }
      prevH = hb;
      prevT = t;
      prevGap = gap;
    }
    return Infinity;
  }

  /** The flight at progress k (0 at the lip, 1 at touchdown). */
  function arcAt(k: number, out: THREE.Vector3) {
    const t = k * adFlight;
    out.copy(adP0).addScaledVector(adV0, t);
    out.y -= 0.5 * G_AIR * t * t;
    return out;
  }
  /** The ad camera at flight progress k on side sg (of adS): abreast of the arc, dollying along it at about half the
   *  car's pace (from AD_FROM to AD_TO of the flight), round toward the rear quarter in portrait. */
  function adCamAt(k: number, sg: number, out: THREE.Vector3) {
    const az = (C.adAz + (C.adAzPortrait - C.adAz) * portrait) * DEG;
    let u0 = AD_FROM[0] + (AD_FROM[1] - AD_FROM[0]) * portrait, u1 = AD_TO[0] + (AD_TO[1] - AD_TO[0]) * portrait;
    if (adApex >= 0) {
      // through a hoop at the apex: at least adHoopLag behind the car as it gets there (the portrait's rear quarter is)
      const behind = (adApex - u0 - (u1 - u0) * adApex) * adDx + adD * Math.cos(az);
      if (behind < C.adHoopLag) (u0 -= (C.adHoopLag - behind) / adDx), (u1 -= (C.adHoopLag - behind) / adDx);
    }
    out.copy(adP0).addScaledVector(adG, adDx * (u0 + (u1 - u0) * k) - adD * Math.cos(az));
    out.x += adS.x * sg * adD * Math.sin(az);
    out.z += adS.z * sg * adD * Math.sin(az);
    // a crane: low, rising part way with the car (the arc reads against the horizon, the car against the sky)
    out.y = Math.max(groundY + 2.5, adY + C.adCrane * (arcAt(k, xq).y - adY));
    return out;
  }

  /** How much of the course stands between the camera at a and the car at b: of 9 samples along the sight line
   *  (stopping short of the car), how many lie inside a stretch of track's footprint at or below its surface - the
   *  channel, its supports, a road's barriers. Only the track inside the sight line's box is looked at. */
  function occluded(track: Track, a: THREE.Vector3, b: THREE.Vector3) {
    const F = track.frames, M = 8;
    const x0 = Math.min(a.x, b.x) - M, x1 = Math.max(a.x, b.x) + M, z0 = Math.min(a.z, b.z) - M, z1 = Math.max(a.z, b.z) + M;
    let hit = 0;
    for (let k = 0; k < F.length; k += 4) {
      const f = F[k], p = f.p;
      if (p.x < x0 || p.x > x1 || p.z < z0 || p.z > z1) continue;
      const r = f.width * 0.5 + 2;
      for (let i = 0; i <= 8; i++) {
        if (hit & (1 << i)) continue;
        xp.lerpVectors(a, b, (i / 8) * 0.9);
        const dx = xp.x - p.x, dz = xp.z - p.z;
        if (dx * dx + dz * dz < r * r && xp.y < p.y + 1.4) hit |= 1 << i;
      }
    }
    let n = 0;
    for (; hit; hit &= hit - 1) n++;
    return n;
  }

  function startAd(state: VehicleState, P: THREE.Vector3, track: Track, left: number) {
    const V = state.velocity;
    adG.set(V.x, 0, V.z);
    const vh = adG.length();
    if (vh < 5) return;
    adG.divideScalar(vh);
    adS.set(-adG.z, 0, adG.x); // right of the flight
    adP0.copy(P);
    adV0.copy(V);
    adFlight = left;
    adDx = vh * left;
    adApex = hoop && V.y > 0 && V.y / G_AIR < left ? V.y / G_AIR / left : -1; // the apex's share of the flight
    const yLand = P.y + V.y * left - 0.5 * G_AIR * left * left;
    adY = Math.min(P.y, Math.max(yLand, P.y - 6)) + C.adHeight;
    // ... but over every real surface the flight passes, and well out beside it (a landing deck higher than the lip, or
    // a wide one, would fill the bottom of the frame from beside it)
    const F = track.frames, ds = F.length > 1 ? F[1].s - F[0].s : 0.5, L = track.length;
    let wide = 0;
    for (let i = 0, n = Math.min(F.length, Math.ceil((((landS - state.trackS) % L) + L) % L / ds)); i < n; i += 2) {
      const f = F[Math.floor(((state.trackS + i * ds) % L) / ds) % F.length];
      if (track.tagAt(f.s) === 'gap') continue;
      adY = Math.max(adY, f.p.y + 1.5);
      wide = Math.max(wide, f.width * 0.5 + (f.edge === 'grass' ? f.shoulder : 0));
    }
    adD = clamp(Math.max(C.adDist * adDx, wide + 13), C.adDistMin, C.adDistMax);
    // the side with the clearer view of the flight, then the one with the sun behind the camera
    let best = -Infinity, side = 1;
    for (let i = 0; i < 2; i++) {
      const sg = i ? -1 : 1;
      let blocked = 0;
      for (let k = 0.3; k < 0.8; k += 0.2) blocked += occluded(track, adCamAt(k, sg, pos), arcAt(k, tmp2));
      blocked += occluded(track, adCamAt(0.05, sg, pos), adCamAt(0.95, sg, tmp2)); // the dolly's own path
      const score = -10 * blocked + 3 * sg * adS.dot(SUN);
      if (score > best) (best = score), (side = sg);
    }
    adS.multiplyScalar(side);
    adOn = true;
    adT = 0;
    adLeft = left;
    trauma = Math.min(1, trauma + 0.2); // the launch kicks
    pop.v += 90; // the FOV pops out with the roar
  }

  function update(state: VehicleState, dtIn: number, track: Track, pose?: Pose) {
    const dt = clamp(dtIn, 0, 0.1);
    time += dt;
    if (scanned !== track) scan(track);
    const P = pose ? pose.position : state.position;
    const Q = pose ? pose.quaternion : state.quaternion;
    const ev = state.events;
    const f = track.frameAt(state.trackS, fr);
    const airWas = airT;
    airT = state.grounded ? 0 : airT + dt;
    if (!resetting) {
      if (ev.respawn) return reset(state, track, pose);
      if (ev.wallHit) {
        // Severity: the speed into the wall and how square the hit was (its angle, from the speed just before):
        // a glancing scrape barely shakes, a square 30 u/s hit shakes hard.
        const n = ev.wallHit;
        const ang = Math.asin(clamp(n / Math.max(lastSpeed, n, 1e-3), 0, 1));
        const sev = smoothstep(4, 30, n) * (0.35 + 0.65 * smoothstep(12 * DEG, 40 * DEG, ang));
        trauma = Math.min(1, trauma + C.hitShake * sev);
        // the camera carries on toward the wall for a moment, so the car bounces off it in frame
        const toWall = tmp.copy(P).sub(f.p).dot(f.right) >= 0 ? 1 : -1;
        jolt.v += (f.right.dot(right) >= 0 ? toWall : -toWall) * Math.min(4, C.hitJolt * n) * (0.3 + 0.7 * sev);
        // and the lens punches in: the impact frame (the hardest hits, past ~22 u/s square, half as much again)
        pop.v -= C.hitPop * sev * (1 + 0.5 * smoothstep(20, 30, n));
      }
      if (ev.landed) {
        const v = Math.min(ev.landed, 25);
        const slam = C.landSlam * smoothstep(0.6, 2.4, airWas); // a long flight comes down hard
        trauma = Math.min(1, trauma + Math.min(0.4, 0.0012 * v * v) + 0.3 * slam);
        dip.v -= v * 0.06 + 1.8 * slam;
        fovKick.v -= v * 1.6;
        pop.v -= 110 * slam;
      }
      if (ev.boostStart) trauma = Math.min(1, trauma + 0.15);
      if (ev.airborne && !state.grounded && !adOn && C.adMinAir > 0 && jumps.length && state.speed > 15 && onJumpLip(state.trackS, track.length)) {
        const left = timeToLand(track, P, state.velocity, state.trackS, 4.5);
        if (left >= C.adMinAir && left < 4.5) startAd(state, P, track, left);
      }
    }

    trackUp.copy(f.up);
    trackP.copy(f.p);

    // Up: level, pitched with the slope under the car (read UP_LEAD s ahead, which cancels the smoothing lag) but never
    // banked. Where the track's up leans far from the world's - here or just ahead: the loop (40..70 deg of lean), or a
    // bank past 25..45 deg - the track's own up takes over (mostly), so the loop rolls the world round the car. Loops: the
    // track ahead bends up over the car, so a look ahead along it would aim high and sink the car out of the bottom of
    // the frame (the clamp below pins the camera to the track behind): inside one, look at the car itself.
    const lead = state.speed * UP_LEAD;
    let sag = 0, steep = 0;
    for (let i = -1; i <= 3; i++) {
      const g = track.frameAt(state.trackS + lead + i * 4, fr2);
      sag = Math.max(sag, -g.kappaN);
      steep = Math.max(steep, 1 - smoothstep(0.34, 0.77, g.up.y), smoothstep(0.42, 0.71, Math.abs(g.right.y)));
    }
    const loopT = clamp((sag - 0.06) / 0.04, 0, 1);
    loopW += (loopT * loopT * (3 - 2 * loopT) - loopW) * damp(0.1, dt);
    const u = track.frameAt(state.trackS + lead, fr2);
    tmp2.crossVectors(u.t, WORLD_UP); // the slope's level right
    if (tmp2.lengthSq() > 0.04) tmp.crossVectors(tmp2, u.t).normalize(); // square to the tangent, in its vertical plane
    else tmp.copy(u.up);
    if (tmp.dot(u.up) < 0) tmp.copy(u.up); // (past vertical in a loop - where the track's up has it anyway)
    tmp2.copy(u.up).multiplyScalar(0.85).addScaledVector(WORLD_UP, 0.15);
    if (tmp2.lengthSq() < 1e-6) tmp2.copy(u.up);
    tmp.lerp(tmp2.normalize(), steep);
    if (tmp.lengthSq() < 1e-6) tmp.copy(u.up);
    tmp.normalize();
    if (resetting) up.copy(tmp);
    else up.lerp(tmp, damp(UP_HALF_LIFE, dt));
    if (up.lengthSq() < 0.25) up.copy(tmp);
    up.normalize();
    upW = resetting ? steep : upW + (steep - upW) * damp(UP_HALF_LIFE, dt); // how much of the camera's roll is the track's

    // Spin-outs: the vehicle says so, or the nose swings far off the travel at speed (a rollback has the angle
    // but no yaw rate). Latched until the car is nearly straight again or slow.
    nose.set(1, 0, 0).applyQuaternion(Q);
    carRight.set(0, 0, 1).applyQuaternion(Q);
    const vF = state.velocity.dot(nose), vR = state.velocity.dot(carRight);
    const off = state.speed > 0.5 ? Math.abs(Math.atan2(vR, vF)) : 0;
    const yaw = tmp.crossVectors(prevNose, nose).dot(up); // + = the nose swung left since the last frame
    prevNose.copy(nose);
    const spinNow = state.grounded && state.speed > 10 && off > 60 * DEG && Math.abs(yaw) > 1.5 * dt;
    const spun = !!ev.spinOut || (spinNow && !spinning);
    if (spun) spinAt = time;
    if (!resetting && spun && time - spinT > 0.8) {
      spinT = time;
      roll.v += (Math.abs(yaw) > 0.2 * dt ? (yaw < 0 ? 1 : -1) : vR > 0 ? -1 : 1) * C.spinKick; // the horizon tips the way it spins
      trauma = Math.min(1, trauma + 0.4);
      dist.v += 3; // and the camera pulls back a touch
      pop.v -= C.spinPop;
    }
    spinning = time - spinAt < 0.35 || (spinning && off > 35 * DEG && state.speed > 6);
    spinW += ((spinning ? 1 : 0) - spinW) * damp(0.05, dt);
    driftW += ((state.drifting ? 1 : 0) - driftW) * damp(0.12, dt);
    airW += ((state.grounded ? 0 : 1) - airW) * damp(0.1, dt);

    // Yaw: the car's heading - the nose turned yawTravel of the way to the travel (all the way in the air, where the
    // flight is what lands; in a spin-out, so the car spins in frame). The nose is turned toward the travel about up
    // rather than lerped to it: a lerp between far-apart directions passes through zero.
    tgt.copy(nose);
    if (state.speed > 0.5) {
      const w0 = smoothstep(2, 8, vF), w1 = spinW * clamp((state.speed - 4) / 6, 0, 1);
      const w = Math.max(w0 * (C.yawTravel + (1 - C.yawTravel) * airW), w1);
      tmp.copy(nose).addScaledVector(up, -nose.dot(up));
      tmp2.copy(state.velocity).addScaledVector(up, -state.velocity.dot(up));
      if (w > 0 && tmp2.lengthSq() > 0.25) tgt.applyAxisAngle(up, w * Math.atan2(tmp.cross(tmp2).dot(up), nose.dot(tmp2)));
    }
    tgt.addScaledVector(up, -tgt.dot(up));
    if (tgt.lengthSq() < 1e-8) tgt.copy(fwd).addScaledVector(up, -fwd.dot(up)); // (nose along up: hold the heading)
    tgt.normalize();
    // carry the previous heading (and the last target) onto the new up plane (transports them round loops without lag)
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.copy(tgt);
    fwd.normalize();
    prevTgt.addScaledVector(up, -prevTgt.dot(up));
    if (prevTgt.lengthSq() < 1e-6) prevTgt.copy(tgt);
    prevTgt.normalize();
    // the heading's own turn rate (lightly smoothed; capped: a snap of the target is followed by the spring, not matched)
    if (dt > 0) tgtRate += (clamp(angleAbout(prevTgt, tgt, up, tmp) / dt, -4, 4) - tgtRate) * damp(0.04, dt);
    prevTgt.copy(tgt);
    // the spring: critically damped on the angle to the heading, matching the heading's turn rate as the car gets round
    // in frame (yawFree..yawHold), at most YAW_RATE_MAX
    const da = angleAbout(fwd, tgt, up, tmp);
    const om = 1.678 / Math.max(0.02, C.yawHalfLife); // 1.678: a critically damped spring's step half-life x omega
    const e0 = C.yawFree * DEG, e1 = Math.max(e0 + 1e-3, C.yawHold * DEG);
    let turned = 0;
    for (let t = dt; t > 1e-6; t -= 1 / 120) {
      const h = Math.min(t, 1 / 120), e = da - turned;
      const match = smoothstep(e0, e1, Math.abs(e)) * (Math.sign(e) === Math.sign(tgtRate) ? 1 : 0);
      yawV = clamp(yawV + (om * om * e - 2 * om * (yawV - match * tgtRate)) * h, -YAW_RATE_MAX, YAW_RATE_MAX);
      turned += yawV * h;
    }
    fwd.applyAxisAngle(up, turned);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-8) fwd.copy(tgt);
    fwd.normalize();
    right.crossVectors(fwd, up).normalize();

    // Speed framing, and the follow along the view: the camera's own speed chases the car's (critically damped), so it
    // drops back a little while the car speeds up and closes in while it brakes; level at a steady speed.
    const k = Math.min(state.speed / C.vtop, 1);
    const kk = Math.pow(Math.min(state.speed / C.vtop, 1.1), 1.5);
    spring(dist, (C.dist0 + (C.dist1 - C.dist0) * k + (state.boosting ? C.distBoost : 0)) * (1 + C.portraitDist * portrait), 4, 0.8, dt);
    const vCar = state.velocity.dot(fwd), wf = C.followFreq;
    for (let t = dt; t > 1e-6; t -= 1 / 120) {
      const h = Math.min(t, 1 / 120);
      lagX = clamp(lagX + (vCar - camV) * h, -3, 3);
      camV += (wf * wf * lagX + 2 * wf * (vCar - camV)) * h;
    }
    const lagM = Math.max(1e-3, C.followMax), follow = lagM * Math.tanh(lagX / lagM);
    fovBase += (C.fov0 + (C.fov1 - C.fov0) * kk - fovBase) * damp(0.12, dt);
    spring(fovKick, state.boosting ? C.fovBoost : 0, 9, 0.55, dt);
    spring(pop, 0, 24, 0.5, dt);
    let fov = clamp(fovBase + fovKick.x + pop.x + C.portraitFov * portrait, 30, 110);
    const height = (C.height0 + (C.height1 - C.height0) * k) * (1 + C.portraitHeight * portrait);
    const latT = clamp(Math.atan2(vR, Math.max(vF, 1)) / 0.6, -1, 1) * C.driftSide * driftW; // to the outside
    lat += (latT - lat) * damp(0.2, dt);

    // Jumps: anchor height lags the car's height above the track, so the car rises in frame.
    const hAbove = clamp(tmp.copy(P).sub(trackP).dot(trackUp), -1, 12);
    lift += (hAbove - lift) * damp(state.grounded ? 0.07 : 0.45, dt);
    // capped: off a drop the car would leave the frame's top. Coming down onto a steep landing ramp the ground rises to
    // meet the car faster than the height follows: the camera may not ride up over it (the car sank out of the bottom)
    const lag = clamp(hAbove - lift, -0.4, C.airLag);
    anchor.copy(P).addScaledVector(trackUp, -lag);

    // Look a little ahead along the car's own velocity (not behind it when reversing); in the air, partly at the flight
    // AIR_LOOK s on, or where it comes down if that's sooner - the landing, or wherever the car is really going.
    const aim = 1 - C.portraitAim * portrait;
    const ahead = C.lookAhead * aim, aheadMax = C.lookMax * aim;
    const fwdShare = clamp(vF / (state.speed + 1e-3), 0, 1); // reversing: don't look behind the car
    lookT.copy(state.velocity).multiplyScalar(ahead * fwdShare);
    if (lookT.lengthSq() > aheadMax * aheadMax) lookT.setLength(aheadMax);
    if (airW > 0.01) {
      const ta = Math.min(AIR_LOOK, timeToLand(track, P, state.velocity, state.trackS, AIR_LOOK));
      tmp.copy(state.velocity).multiplyScalar(ta);
      tmp.y -= 0.5 * G_AIR * ta * ta;
      lookT.lerp(tmp, 0.35 * airW);
    }
    lookT.multiplyScalar(1 - loopW);
    if (resetting) lookOff.copy(lookT);
    else lookOff.lerp(lookT, damp(0.06, dt));
    const raise = C.lookRaise + (C.lookRaiseFast - C.lookRaise) * smoothstep(0, 15, state.speed) * fwdShare;
    look.copy(P).add(lookOff).addScaledVector(up, raise * aim).addScaledVector(trackUp, -0.5 * lag);

    spring(dip, 0, 10, 0.5, dt);
    spring(jolt, 0, 14, 0.5, dt);
    spring(roll, 0, 11, 0.5, dt);
    trauma = Math.max(0, trauma - 1.5 * dt);
    const sh = trauma * trauma;
    pos.copy(anchor)
      .addScaledVector(up, height + dip.x + sh * C.shake * noise(time, 7))
      .addScaledVector(fwd, -(dist.x + follow))
      .addScaledVector(right, lat + jolt.x + sh * C.shake * noise(time, 1));

    // Stay on the driving side of the track behind the car (inside loops, above dips) - while the car is on that side
    // and there is a surface there (not a jump's gap, not out beside the track): a car that misses a jump and falls
    // under the landing is followed down, not watched from up on a deck it never reached.
    const b = track.frameAt(state.trackS - dist.x * 0.9, fr2);
    const pen = tmp.copy(pos).sub(b.p).dot(b.up);
    if (pen < CLEARANCE && hAbove > -0.75 && Math.abs(tmp.dot(b.right)) < b.width * 0.5 + b.shoulder + 1 && track.tagAt(b.s) !== 'gap') {
      pos.addScaledVector(b.up, CLEARANCE - pen);
    }

    // The ad shot: in from 0.08 s after the lip, back out before touchdown (the predicted time left) so a landing reads
    // from behind; an early end (a landing sooner than predicted, a crash) swings back quickly. A flight that comes down
    // short of the track or beside it (onto the meadow) stays on the side view, which shows the miss, until the car is
    // put back.
    let adTarget = 0;
    if (adOn) {
      if (state.grounded || resetting) adOn = false;
      else {
        adT += dt;
        adLeft = timeToLand(track, P, state.velocity, state.trackS, 4.5);
        const T = adT + adLeft, kf = clamp(adT / Math.max(T, 1e-3), 0, 1);
        // (a shorter flight swings out and back quicker)
        adTarget = Math.min(smoother((adT - 0.08) / Math.min(C.adIn, 0.3 * T)), landMiss ? 1 : smoother((adLeft - C.adOutEnd) / Math.min(C.adOut, 0.25 * T)));
        adCamAt(kf, 1, adPos);
      }
    }
    adW = resetting ? 0 : adW + (adTarget - adW) * damp(0.04, dt);
    if (adW < 1e-3) adW = 0;

    // the horizon: level (the world's up), but the track's in the loop
    camUp.copy(WORLD_UP).lerp(up, upW);
    if (camUp.lengthSq() < 1e-6) camUp.copy(up);
    camUp.normalize();
    if (adW > 0) {
      // Orbit from the chase position to the ad camera round the car (never nearer it than either end), blend the
      // aim, the up (to the world's) and the lens.
      carC.copy(P).addScaledVector(WORLD_UP, 0.55);
      const dc = adPos.distanceTo(carC);
      adLook.copy(state.velocity).normalize().multiplyScalar(C.adLead * (1 - 0.6 * portrait) * dc).add(carC);
      adLook.y -= dc * Math.tan(C.adAim * DEG);
      oc.subVectors(pos, carC);
      oa.subVectors(adPos, carC);
      const lc = Math.max(oc.length(), 1e-3), la = Math.max(oa.length(), 1e-3);
      oc.divideScalar(lc);
      oa.divideScalar(la);
      const th = Math.acos(clamp(oc.dot(oa), -1, 1));
      if (th > 1e-3 && th < Math.PI - 1e-3) {
        const sn = Math.sin(th);
        tmp.copy(oc).multiplyScalar(Math.sin((1 - adW) * th) / sn).addScaledVector(oa, Math.sin(adW * th) / sn);
      } else tmp.copy(oc).lerp(oa, adW).normalize();
      pos.copy(carC).addScaledVector(tmp, lc + (la - lc) * adW);
      pos.y = Math.max(pos.y, groundY + 1);
      look.lerp(adLook, adW);
      camUp.lerp(WORLD_UP, adW).normalize();
      fov += (C.adFov + C.adPortraitFov * portrait - fov) * adW;
      // keep the car inside the frame: turn the aim toward it if its centre strays past adKeep of the half view (the
      // narrower way), or its far end past 90% (relaxed toward the chase's own framing as the blend fades out, so it
      // lets go without a jump)
      const hv = 0.5 * fov * DEG, half = Math.min(hv, Math.atan(Math.tan(hv) * camera.aspect));
      oc.subVectors(look, pos);
      const ll = oc.length();
      oc.divideScalar(ll);
      oa.subVectors(carC, pos);
      const keep = Math.max(0, Math.min(C.adKeep * half, 0.9 * half - Math.atan(2.3 / Math.max(oa.length(), 2.3))));
      const maxA = keep + Math.PI * (1 - smoothstep(0, 0.3, adW));
      oa.normalize();
      const a = Math.acos(clamp(oc.dot(oa), -1, 1));
      if (a > maxA) {
        tmp.crossVectors(oa, oc);
        if (tmp.lengthSq() > 1e-12) look.copy(pos).addScaledVector(oa.applyAxisAngle(tmp.normalize(), maxA), ll);
      }
    }

    camera.position.copy(pos);
    camera.up.copy(camUp);
    camera.lookAt(look);
    const rz = (sh * C.shakeRoll * DEG * noise(time, 13) + roll.x) * (1 - adW);
    if (rz !== 0) camera.rotateZ(rz);
    if (Math.abs(camera.fov - fov) > 0.01) {
      camera.fov = fov;
      camera.updateProjectionMatrix();
    }
    lastSpeed = state.speed;
  }

  function reset(state: VehicleState, track: Track, pose?: Pose) {
    const P = pose ? pose.position : state.position;
    const Q = pose ? pose.quaternion : state.quaternion;
    const f = track.frameAt(state.trackS, fr);
    up.copy(f.up); // (update() below sets the camera's own up from it at once)
    fwd.set(1, 0, 0).applyQuaternion(Q);
    fwd.addScaledVector(up, -fwd.dot(up));
    if (fwd.lengthSq() < 1e-6) fwd.copy(f.t).addScaledVector(up, -f.t.dot(up));
    fwd.normalize();
    prevTgt.copy(fwd);
    yawV = tgtRate = 0;
    const k = Math.min(state.speed / C.vtop, 1);
    dist.x = (C.dist0 + (C.dist1 - C.dist0) * k) * (1 + C.portraitDist * portrait);
    dist.v = 0;
    lagX = 0;
    camV = state.velocity.dot(fwd);
    fovBase = C.fov0 + (C.fov1 - C.fov0) * Math.pow(k, 1.5);
    fovKick.x = fovKick.v = dip.x = dip.v = jolt.x = jolt.v = roll.x = roll.v = pop.x = pop.v = 0;
    lift = clamp(tmp.copy(P).sub(f.p).dot(f.up), -1, 12);
    lat = 0;
    driftW = state.drifting ? 1 : 0;
    airW = state.grounded ? 0 : 1;
    airT = 0;
    trauma = 0;
    spinning = false;
    spinW = 0;
    spinAt = -1;
    adOn = false;
    adW = 0;
    prevNose.set(1, 0, 0).applyQuaternion(Q);
    lastSpeed = state.speed;
    resetting = true;
    update(state, 0, track, pose);
    resetting = false;
  }

  return {
    camera,
    reset,
    update,
    addTrauma(amount: number) {
      trauma = clamp(trauma + amount, 0, 1);
    },
    resize(w: number, h: number) {
      camera.aspect = w / Math.max(1, h);
      portrait = clamp((1 - camera.aspect) / 0.5, 0, 1); // 1 at 1:2 portrait phones
      camera.updateProjectionMatrix();
    },
  };
}
