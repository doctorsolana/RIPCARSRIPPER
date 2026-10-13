import * as THREE from 'three';
import type { CarSpec, DriveInput, Track, TrackFrame, Vehicle, VehicleFactory, VehicleState } from '../types';

// "arcade": the hand-written driving model. On the track it lives in track space - distance along (s), offset across
// (d), heading relative to the track (psi), slip (beta = heading minus travel), speed (v), yaw rate (omega) - so the
// track's own frames carry slopes, banks and the loop: gravity is projected onto the surface plane, and the car stays
// on while the surface can hold it (v^2 kappaN against g plus a little toy-track "magnet"). Only a gap off a kicker
// (or a loop's ceiling taken too slow) launches it into a ballistic flight in world space - crests anywhere else hold
// it, so it never jumps by accident. In the air the nose follows the flight path and the car levels itself to what it
// comes down on (gently, never a flip); it lands back into track space with a graded landing. Every jump, the big one
// (tag 'bigjump') too, flies off whatever the car brings to the lip - its speed, line and heading. Nothing lines it up
// or sets its speed: too slow, too fast or crooked and it misses (and is put back before the run-up).
// Grip turns the direction of travel toward the heading but keeps |v|. A drift is a loose car, not a hop and not a
// button held: a tap of Space at speed (holding it is the same) lets the rear go loose over a fifth of a second, and
// the slide is then the driving's own - the steering yaws the car, the loose rear lets the travel lag behind the nose
// (the tail steps out), counter-steer swings the nose back, the throttle loosens the rear a little more, a lift tucks
// it in, and past ~35 deg the rear bites (a soft limit). Nothing sets the slip angle. It's over by itself once the car
// is straight again (or too slow, spun, into a wall), the grip easing back over 0.3 s; another tap never cancels it -
// it keeps it going and flicks it toward the wheel, so S-bends link. On dirt a
// hard steer at speed loosens the rear a little by itself. Sparks charge through three tiers while it really slides,
// cashed in as a mini-turbo when it ends clean.
// Surfaces scale grip, turn and top speed - plastic fast, asphalt grippiest, dirt loose and bumpy, the grass verge past
// a road's edge slow and slippery - blended as the wheels cross from one to the next.
// Walls (rails, tyre walls, hay bales, the soft end of a verge) push back at the corner that touches: an impulse with
// the material's restitution and friction and a yaw kick from the corner's lever arm. The corner always leaves the
// wall, so the car never sticks or buzzes on it; hard hits stun for a moment, very hard ones spin the car out - but hay
// only absorbs and slows, never spins. Driving the wrong way raises state.wrongWay; too long the wrong way, or stuck,
// and the car is put back on the track facing the right way.
// Deterministic and input-driven (lockstep-ready): no randomness, no clocks - the state advances only by
// step(h, input), and the dirt's bumps are noise by position. Units: car = 4 u, u/s, rad, s. Fixed step (1/120 s);
// nothing allocates per step.

const DEG = Math.PI / 180;
const KICK_MAX = 8; // rad/s: the most yaw that hits can stack up

const K = {
  vtop: 44, // top speed on the throttle (u/s; x4.3 = scale km/h), on plastic
  vboost: 56, // top speed while boosting
  accel: 26, // throttle: accel * (1 - (v/vtop)^2): 0-90% in 2.5 s
  brake: 60,
  reverse: 10, // top speed backwards
  coast: 3, // off the throttle: coast + drag * v^2
  drag: 0.004,
  overspeed: 1.5, // above the cap (downhill, after a boost, onto grass) lose overspeed * (v - cap) per s
  g: 24, // ~3x real gravity at this scale: snappy and toy-like
  stick: 0.3, // the track's extra hold, in g (loop tops)
  yawLow: 3, // max yaw rate in grip (rad/s) at low speed ...
  yawHigh: 1.3, // ... and at top speed (a 34 u radius)
  yawRamp: 3.2, // yaw is also capped at v / yawRamp: no turning on the spot
  yawLag: 0.06, // s
  grip: 12, // slip decay per s
  scrub: 0.8, // speed lost to slip: scrub * |sin slip| * v
  slipMax: 35, // deg
  // the drift: a tap of Space (holding it is the same) makes the car loose - no hop, nothing sets the slip
  driftMin: 10, // u/s to go loose ...
  driftEnd: 8, // ... and slower than this it's over
  driftBuffer: 0.15, // s: a press counts this long (a tap just before turning in, or before touching down, works)
  driftSteer: 0.15, // with the wheel turned this far a tap flicks the weight over: driftKick rad/s of yaw
  driftKick: 0.2,
  driftIn: 0.2, // s: the rear lets go over this (progressively, no snap) ...
  driftOut: 0.3, // ... and grips again over this once it's over
  looseGrip: 3.2, // the loose rear's grip on the slip: the travel bends at looseGrip x slip (rad/s; in grip: grip) ...
  looseThrottle: 0.8, // ... x this on the throttle (power oversteer: the tail steps further out) ...
  looseLift: 1.3, // ... x this off it (the tail tucks back in, the line tightens)
  looseYaw: 1.25, // loose, the steering's yaw is this x grip's (the car rotates readily) ...
  looseLag: 0.12, // ... and the nose answers this slowly (s; the car's weight swinging)
  limitSlip: 34, // deg: past this the rear bites - the nose is held back by limitYaw per s of the excess: a soft
  limitYaw: 20, // limit (no spin from steering alone), fading out past 60 deg (a big over-rotation still spins)
  straightSlip: 5, // deg: under this for straightTime (s) the car is straight again - the drift is over and the
  straightTime: 0.35, // sparks cash in ...
  looseIdle: 0.8, // ... and one that never slid is over after this (s)
  spinSlip: 75, // deg: past this it has spun (no boost, no help coming round)
  driftHit: 6, // u/s into a wall ends a drift (no boost)
  exitFollow: 0.1, // s: grip coming back, the slip goes by the nose easing back to the travel (this fast) ...
  exitSlack: 0.3, // ... the travel bending at most this much faster than the loose rear let it (rad/s; no snap) ...
  settleMax: 1, // ... until it has settled, or for at most this long (s)
  driftScrub: 0.35,
  dirtLoose: 0.35, // on dirt a hard steer lets the tail out this far by itself (of a full slide) ...
  looseMin: 22, // ... from this speed (u/s), fully 10 u/s faster
  chargeSlip: 10, // deg of slip for sparks: none 2 deg under, full rate 2 over
  tier1: 0.7, // s of drifting per spark tier (blue, purple, gold)
  tier2: 1.4,
  tier3: 2.2,
  boost1: 0.5, // s of mini-turbo per tier ...
  boost2: 1,
  boost3: 1.5,
  turboAccel: 31, // ... pushing this hard (u/s^2; a booster's push is boostAccel)
  boostAccel: 45,
  boostCap: 2, // s
  padBoost: 1, // s
  padKick: 8, // a booster adds this (u/s; it never sets a speed)
  // surfaces, as multipliers on the plastic numbers above, blended as the wheels cross from one to the next
  surfBlend: 0.07, // s (time constant: ~95% changed after 0.2 s)
  asphaltGrip: 1.15, // asphalt grips best (slip and turn) ...
  asphaltYaw: 1.06,
  asphaltCap: 0.97, // ... but plastic is the fast stuff
  dirtGrip: 0.7, // dirt is loose ...
  dirtDrift: 0.9, // ... drifts slide a little wider ...
  dirtYaw: 0.93,
  dirtCap: 0.9, // ... a little slower ...
  dirtBump: 1, // ... and bumpy (heave, pitch and roll noise for the rig's springs)
  grassGrip: 0.55, // the verge past a road's edge, per wheel on it: slippery ...
  grassYaw: 0.75, // ... turns less ...
  grassCap: 0.55, // ... slow ...
  grassDrag: 0.3, // ... and draggy (per s of the speed)
  // walls, at the corner that touches (m = 1): restitution e and friction mu per material
  railE: 0.3, // the orange track's plastic rails
  railMu: 0.25,
  tyreE: 0.15, // tyre walls
  tyreMu: 0.5,
  hayE: 0, // hay bales, and the soft barrier at the end of a grass verge: they swallow the hit (no bounce) ...
  hayMu: 0.7,
  hayKeep: 0.55, // ... and slow the car along them to no less than this share of its speed (no spin-out, no stun) ...
  hayMin: 0.38, // ... this share even square on (turned along the bales the way the track runs: never stopped dead) ...
  hayYaw: 1.5, // ... turning it by at most this yaw rate (rad/s) per hit, and stop it turning in. Then for hayTime the
  hayTime: 0.45, // car slides along the bales on hayGrip of its grip and scrub (up to haySide deg to its nose before it
  hayGrip: 0.15, // counts as going backwards) while the nose swings round to the way it's sliding (hayAlign per s, at
  haySide: 165, // most hayTurn rad/s): it straightens up along them instead of being dragged back in nose first or
  hayAlign: 8, // spun round
  hayTurn: 4,
  wallI: 6, // yaw inertia against the corner's lever arm: a front-corner hit swings the nose away ...
  wallYaw: 4, // ... by at most this much yaw rate (rad/s) per hit ...
  wallYawTime: 0.15, // ... dying away over this (s)
  wallRound: 0.6, // u of lever toward the way the track runs on square hits (a rounded nose glances off)
  wallNose: 6, // deg: against a wall the nose can't be steered in further than this - the car slides along it ...
  wallAlign: 3, // ... and further in, the wall eases it back (per s)
  wallSep: 0.4, // u/s: a corner on a wall always leaves it at least this fast (never sticks, never buzzes)
  bounceMin: 3, // u/s into the wall: slower touches only scrape (no bounce, no hit event)
  glance: 15, // deg: shallower hits scrape along without a bounce (it fades in over the next 10 deg)
  stunAngle: 35, // deg and ...
  stunSpeed: 15, // ... u/s into the wall: a hard hit - grip and steering x stunCtl for stunTime, the drift is over
  stunTime: 0.3,
  stunCtl: 0.5,
  spinAngle: 55, // deg and ...
  spinSpeed: 25, // ... u/s: a very hard hit spins the car out - spinYaw of yaw, control x spinCtl for spinTime
  spinTime: 0.6,
  spinYaw: 6,
  spinCtl: 0.25,
  railHeight: 0.8, // a car in the air this low still hits the rails ...
  barrierHeight: 1.2, // ... or a tyre wall / hay bales
  bankAssist: 1.5, // banks hold the car harder than gravity alone would
  airYaw: 2, // rad/s, max yaw rate in the air
  airVane: 3, // per s: the nose swings into the flight path ...
  airLean: 25, // ... offset by up to this (deg) with full steer: steer to aim, let go for a PERFECT
  airPitch: 6, // per s: in the air the nose follows the flight path, so a long arc noses over with it ...
  airLevel: 3, // ... and over its last half second the car levels itself to the track it lands on ...
  airTurn: 1.5, // ... turning (pitch and roll) at most this fast (rad/s): never a flip
  airMax: 4.5, // s: lost in the air (the big jump's flight is ~2-2.5 s)
  perfectDeg: 12, // landing within this: PERFECT (+ boost)
  okDeg: 35, // within this: ok, keep okKeep of the speed; worse: badKeep and a wobble
  perfectBoost: 0.5,
  okKeep: 0.95,
  badKeep: 0.75,
  respawnBack: 24, // u behind the last safe spot ...
  respawnClear: 60, // ... with this much track before a booster, kicker or gap (time to line up: no miss loop) ...
  respawnSpeed: 0.75, // ... at least this x vtop, plus a second of boost
  wrongTime: 1, // s driving nose first against the lap direction: WRONG WAY ...
  wrongRespawn: 4, // ... and after this long, put back on the track facing the right way
  stuckSpeed: 2, // u/s: slower than this while trying to drive ...
  stuckTime: 4, // ... for this long (s) is stuck: put back on the track
};

/** Live-tunable numbers (?tune=1). Per-car flavour multiplies on top and is not in here. */
export const TUNING: Record<string, number> = K;

// Per-car flavour, feel only (never better stats). Keyed by the first word of the car id. (The Impala's hydraulic
// bounce into a drift is rig.ts's, on its soft springs.)
interface Flavour { grip: number; driftGrip: number; charge: number }
const FLAVOUR: Record<string, Partial<Flavour>> = {
  roxy: { grip: 1.15 }, // race Porsche: bites harder
  skyline: { driftGrip: 0.85 }, // Mountain Drifter: slides wider
};

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
const smooth = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrapA = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
/** Smooth noise in about -1..1 along the track: the dirt's bumps (the same ones every lap). */
const bumps = (x: number) => (Math.sin(x * 0.45) + 0.6 * Math.sin(x * 0.83 + 1.3) + 0.35 * Math.sin(x * 1.7 + 4.1)) / 1.95;
/** The wall at a frame's edge: 0 the orange track's rails, 1 a tyre wall, 2 hay bales (or the soft end of a verge). */
const wallOf = (f: TrackFrame) => (f.edge === 'rail' ? 0 : f.edge === 'barrier' && f.surface !== 'dirt' ? 1 : 2);
/** How far either side of the centre line the car's corners may reach (a verge is drivable up to its end). */
const limitOf = (f: TrackFrame) => f.width * 0.5 + (f.edge === 'grass' ? f.shoulder : 0);

function newFrame(): TrackFrame {
  return {
    s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(0, 0, 1), kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
  };
}

function carGeometry(car: CarSpec) {
  const avg = (xs: number[], d: number) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : d);
  const front = car.wheels.filter((w) => w.name.includes('front'));
  const rear = car.wheels.filter((w) => w.name.includes('rear'));
  let xf = avg(front.map((w) => w.centre[0]), 1.15);
  let xr = avg(rear.map((w) => w.centre[0]), -1.15);
  if (xf - xr < 0.5) (xf = 1.15), (xr = -1.15);
  const length = car.length || 4, width = car.width || 1.5;
  return {
    xf, xr,
    // the model origin's height above the surface: rig.ts already seats the lowest tyre on the origin
    ride: 0,
    r: avg(car.wheels.map((w) => w.r), 0.3),
    length,
    width,
    hl: length / 2, // the body's half-length and half-width (the model is centred on its origin): the box that hits walls
    hw: width / 2,
    tw: avg(car.wheels.map((w) => Math.abs(w.centre[2])), 0.6), // the wheels' half-track (which ones are on the verge)
  };
}

export const create: VehicleFactory = async (track: Track, car: CarSpec): Promise<Vehicle> => {
  const LEN = track.length;
  const wrapS = (x: number) => ((x % LEN) + LEN) % LEN;
  const geo = carGeometry(car);
  const flav: Flavour = { grip: 1, driftGrip: 1, charge: 1, ...FLAVOUR[car.id.split('-')[0]] };
  let floorY = 0; // the ground: below every bit of track
  for (const f of track.frames) floorY = Math.min(floorY, f.p.y - 0.05);

  const state: VehicleState = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), speed: 0,
    steerVisual: 0, wheelSpinRate: 0, slip: 0, drifting: false, driftTier: 0, boosting: false, grounded: true,
    accelLocal: new THREE.Vector3(), trackS: 0, lapDelta: 0, events: {}, wrongWay: false,
  };

  // scratch (no allocation per step)
  const fM = newFrame(), fA = newFrame(), fB = newFrame();
  const v1 = new THREE.Vector3(), v2 = new THREE.Vector3(), v3 = new THREE.Vector3(), v4 = new THREE.Vector3();
  const v5 = new THREE.Vector3(), aT = new THREE.Vector3(), accBase = new THREE.Vector3();
  const m4 = new THREE.Matrix4(), q1 = new THREE.Quaternion(), q2 = new THREE.Quaternion();
  const X = new THREE.Vector3(1, 0, 0), Y = new THREE.Vector3(0, 1, 0);
  const airP = new THREE.Vector3(), airV = new THREE.Vector3(), airQ = new THREE.Quaternion();
  // the touchdown look-ahead
  const preP = new THREE.Vector3(), preV = new THREE.Vector3(), preO = new THREE.Vector3(), fL = newFrame();

  // simulation state
  let s = 0, d = 0, psi = 0, beta = 0, v = 0, omega = 0;
  let grounded = true, falling = false, respawnIn = 0, airTime = 0, stuck = 0, wrongT = 0;
  let drifting = false, dir = 0, charge = 0, tier: 0 | 1 | 2 | 3 = 0, pressT = 0, held = false;
  // the slide: how far the rear has let go (0 grip .. 1 loose); a drift's time loose, time straight, whether it has
  // slid yet; a drift that ended spun gets no help coming round
  let slide = 0, looseT = 0, straightT = 0, slid = false, spun = false, settleT = 0;
  let boost = 0, turbo = 0, onPad = false; // s left of a booster's (or a landing's) push, of a drift's mini-turbo
  let safeS = 0, safeV = 0, vPrev = 0, steerVis = 0, spin = 0, aY = 0;
  // walls: the yaw a hit kicked in (it dies away by itself, apart from the steering's omega), the stun and spin-out
  // timers, how far the slip may go (a hit can leave it past slipMax), time since the corner last touched a wall
  let kick = 0, stunT = 0, spinT = 0, slipLim = K.slipMax * DEG, wallAgo = 1, wallSide = 0, airYawRate = 0, hayT = 0;
  let oT = 0, oR = 0; // impact()'s result: the velocity along / across the track after the hit
  // the surface under the wheels, blended: grip, drift grip, turn, top speed, drag, bumps, looseness (dirt)
  let sGrip = 1, sDrift = 1, sYaw = 1, sCap = 1, sDrag = 0, sBump = 0, sLoose = 0;

  /** The track frame at s, written into `o` (whatever frameAt does with `out`). */
  function frame(ss: number, o: TrackFrame): TrackFrame {
    const f = track.frameAt(ss, o);
    if (f !== o) {
      o.s = f.s;
      o.p.copy(f.p);
      o.t.copy(f.t);
      o.up.copy(f.up);
      o.right.copy(f.right);
      o.kappa = f.kappa;
      o.kappaN = f.kappaN;
      o.width = f.width;
      o.surface = f.surface;
      o.edge = f.edge;
      o.shoulder = f.shoulder;
    }
    return o;
  }

  /** How far s1 lies ahead of s0 along the lap (0 .. LEN). */
  const ahead = (s0: number, s1: number) => wrapS(s1 - s0);

  // ---- Big jumps (tag 'bigjump': the launch lip to the end of the landing ramp), read off the track once for the
  // respawn: the lip, the landing ramp (from the end of the jump's 'gap') and its end. That's all the car knows of them.
  interface Jump { lip: number; land: number; end: number }
  const jumps: Jump[] = [];
  for (const b of track.tags) {
    if (b.tag !== 'bigjump') continue;
    const lip = b.s0, span = ahead(lip, b.s1);
    const gap = track.tags.find((g) => g.tag === 'gap' && (ahead(lip, g.s0) < span || ahead(g.s0, lip) < 4));
    if (gap) jumps.push({ lip, land: gap.s1, end: b.s1 });
  }

  /** Blend the surface numbers toward what's under the wheels (h = 0 snaps): the frame's surface, and grass for each
   *  wheel out on a verge. */
  function surfaceAt(f: TrackFrame, h: number) {
    let gr = 1, dr = 1, yw = 1, cp = 1, bp = 0, w = 0;
    if (f.surface === 'asphalt') (gr = dr = K.asphaltGrip), (yw = K.asphaltYaw), (cp = K.asphaltCap);
    else if (f.surface === 'dirt') (gr = K.dirtGrip), (dr = K.dirtDrift), (yw = K.dirtYaw), (cp = K.dirtCap), (bp = 1);
    const ls = bp; // loose: the dirt (not its verge)
    if (f.edge === 'grass') {
      const half = f.width * 0.5, sn = Math.sin(psi), zs = geo.tw * Math.cos(psi);
      for (let i = 0; i < 2; i++) {
        const o = d + (i ? geo.xr : geo.xf) * sn;
        if (Math.abs(o + zs) > half) w += 0.25;
        if (Math.abs(o - zs) > half) w += 0.25;
      }
      if (w > 0) {
        gr = lerp(gr, K.grassGrip, w);
        dr = lerp(dr, K.grassGrip, w);
        yw = lerp(yw, K.grassYaw, w);
        cp = lerp(cp, K.grassCap, w);
        bp = lerp(bp, 0.6, w);
      }
    }
    const b = h > 0 ? 1 - Math.exp(-h / K.surfBlend) : 1;
    sGrip += (gr - sGrip) * b;
    sDrift += (dr - sDrift) * b;
    sYaw += (yw - sYaw) * b;
    sCap += (cp - sCap) * b;
    sDrag += (w * K.grassDrag - sDrag) * b;
    sBump += (bp - sBump) * b;
    sLoose += (ls * (1 - w) - sLoose) * b;
  }

  /** World pose on the surface: both axles on the track (so the loop and ramps seat the car), the origin raised
   *  by the ride height. Also the world velocity. */
  function poseGround(f: TrackFrame) {
    const c = Math.cos(psi), sn = Math.sin(psi);
    const den = Math.max(0.3, 1 - f.kappa * d);
    const a = frame(s + (geo.xf * c) / den, fA);
    const b = frame(s + (geo.xr * c) / den, fB);
    const pF = v1.copy(a.p).addScaledVector(a.right, d + geo.xf * sn);
    const pR = v2.copy(b.p).addScaledVector(b.right, d + geo.xr * sn);
    const fwd = v3.subVectors(pF, pR);
    const len = fwd.length();
    if (len > 1e-4) fwd.divideScalar(len);
    else fwd.copy(f.t);
    const up = v4.copy(a.up).add(b.up);
    up.addScaledVector(fwd, -up.dot(fwd)).normalize();
    const right = v5.crossVectors(fwd, up);
    state.quaternion.setFromRotationMatrix(m4.makeBasis(fwd, up, right));
    state.position.copy(pR).lerp(pF, -geo.xr / (geo.xf - geo.xr)).addScaledVector(up, geo.ride);
    const ph = psi - beta;
    state.velocity.copy(f.t).multiplyScalar(v * Math.cos(ph)).addScaledVector(f.right, v * Math.sin(ph));
  }

  function place(s0: number) {
    s = wrapS(s0);
    d = psi = beta = omega = v = vPrev = 0;
    grounded = true;
    falling = false;
    respawnIn = airTime = stuck = wrongT = 0;
    drifting = slid = spun = false;
    tier = 0;
    charge = 0;
    slide = looseT = straightT = settleT = turbo = 0;
    aY = 0;
    kick = stunT = spinT = airYawRate = hayT = 0;
    slipLim = K.slipMax * DEG;
    wallAgo = 1;
    onPad = track.tagAt(s) === 'booster';
    poseGround(frame(s, fM));
    surfaceAt(fM, 0);
    accBase.set(0, 0, 0);
    state.accelLocal.set(0, 0, 0);
  }

  function respawn() {
    // The last safe spot on the ground, stepped back past anything tricky and far enough before a jump (and the
    // booster that launches it) to line up for it (put back just before the lip, a car still wobbling from the miss
    // launches crooked and misses again). A car that had landed a big jump (its last safe spot on the landing ramp or
    // not far past it) doesn't jump it again: stepping back stops at the foot of the landing ramp.
    let landed: Jump | null = null;
    for (const J of jumps) if (ahead(J.land, safeS) < ahead(J.land, J.end) + 120) landed = J;
    let rs = wrapS(safeS - K.respawnBack);
    for (let i = 0; i < 120; i++) {
      if (landed && ahead(landed.lip, rs) < ahead(landed.lip, landed.end) + 2) {
        rs = wrapS(landed.end + 2);
        break;
      }
      const tg = track.tagAt(rs);
      let ok = frame(rs, fA).up.y > 0.8 && tg !== 'gap' && tg !== 'kicker' && tg !== 'loop' && tg !== 'bigjump' &&
        tg !== 'booster';
      for (let x = 4; ok && x <= K.respawnClear; x += 4) {
        const tx = track.tagAt(rs + x);
        ok = tx !== 'kicker' && tx !== 'gap' && tx !== 'bigjump' && tx !== 'booster';
      }
      if (ok) break;
      rs = wrapS(rs - 2);
    }
    place(rs);
    v = vPrev = clamp(safeV, K.respawnSpeed * K.vtop, K.vtop);
    boost = Math.max(boost, 1);
    pressT = 0;
    poseGround(fM);
    state.events.respawn = true;
  }

  /** Go loose (the wheel turned: a flick of weight that way). A tail already out (the last drift's, or the dirt's own
   *  slide) stays out. */
  function startDrift(steer: number) {
    drifting = true;
    slid = spun = false;
    looseT = straightT = 0;
    charge = 0;
    tier = 0;
    pressT = 0;
    if (Math.abs(steer) >= K.driftSteer) omega += Math.sign(steer) * K.driftKick;
  }

  /** Another tap mid-drift: keep the car loose (the straightening clock restarts) and flick it toward the wheel like
   *  a fresh entry, so the next bend links; the sparks keep charging. */
  function reFlick(steer: number) {
    pressT = 0;
    looseT = straightT = 0;
    if (Math.abs(steer) >= K.driftSteer) omega += Math.sign(steer) * K.driftKick;
  }

  /** The drift is over (reward: cash the sparks in as a mini-turbo); the rear grips up again over driftOut. */
  function endDrift(reward: boolean) {
    if (reward && tier > 0) {
      turbo = Math.min(K.boostCap, turbo + (tier === 3 ? K.boost3 : tier === 2 ? K.boost2 : K.boost1));
      state.events.boostStart = true;
    }
    drifting = false;
    tier = 0;
    charge = 0;
    pressT = 0;
    settleT = K.settleMax;
  }

  /** A corner of the car meets the wall on `side` (+1 right, -1 left) of frame f, the car moving (vT, vR) along /
   *  across the track and turning at yawRel against it. The touching corner takes an impulse (m = 1): the wall's
   *  restitution (none for touches and glancing scrapes) and Coulomb friction, and a yaw kick from its lever arm - a
   *  front-corner hit swings the nose away - clamped. Whatever the clamp held back, the corner leaves at wallSep or
   *  faster, so the car never sticks to or buzzes on a wall, and steering into one slides along it. Any hit past
   *  driftHit ends a drift (no boost); a hard one stuns (grip and steering down), a very hard one spins the car out.
   *  Hay is soft: it swallows the hit and slows the car along it to no less than hayKeep of its speed (hayMin square
   *  on, turned the way the track runs), with a gentle turn and no stun or spin-out. Leaves the new velocity in oT, oR. */
  function impact(side: number, f: TrackFrame, vT: number, vR: number, yawRel: number) {
    const m = wallOf(f), hay = m === 2;
    const e0 = m === 0 ? K.railE : m === 1 ? K.tyreE : K.hayE;
    const mu = m === 0 ? K.railMu : m === 1 ? K.tyreMu : K.hayMu;
    const c = Math.cos(psi), sn = Math.sin(psi);
    // The touching corner (car frame: x ahead, z right). As a flank or the nose comes to lie along the wall the contact
    // slides to its middle, so the lever arm doesn't flip between corners.
    const xc = side * geo.hl * clamp(sn / 0.07, -1, 1), zc = side * geo.hw * clamp(c / 0.07, -1, 1);
    const lev = xc * c - zc * sn; // the corner's lead along the wall
    const lat = xc * sn + zc * c; // its offset across the track
    const un = side * (vR + yawRel * lev); // the corner's speed into the wall ...
    const ut = vT - yawRel * lat; // ... and along it
    // The lever arm of the push off the wall. Square on it vanishes and the car would stay nose-in, pushing (stuck); a
    // rounded nose glances off, so steep hits get a little lever toward the way the track runs and the car pivots along.
    const arm = lev + (c > -0.3 ? 1 : -1) * K.wallRound * smooth(0.6, 0.95, Math.abs(sn));
    oT = vT;
    oR = vR;
    wallAgo = 0;
    wallSide = side;
    if (un <= -K.wallSep) return; // already leaving
    const th = Math.atan2(Math.max(0, un), Math.abs(ut)); // the angle it comes in at
    const e = un < K.bounceMin ? 0 : e0 * smooth(K.glance * DEG, (K.glance + 10) * DEG, th);
    const I = K.wallI;
    const j = Math.max((1 + e) * un, un + K.wallSep) / (1 + (arm * arm) / I);
    let jt = clamp(-ut, -mu * j, mu * j); // Coulomb: at most stops the slide along the wall
    if (hay) {
      // hay: the slide along it keeps at least hayKeep of the speed the car came in with (turned along the bales from a
      // steep hit), and hayMin even square on - turned the way the track runs unless the car was clearly going back.
      // While it settles from a hit, the bales only push it off (the swinging tail brushing them costs nothing more).
      const sp = Math.hypot(vT, vR), thC = Math.atan2(Math.max(0, side * vR), Math.abs(vT));
      const dirT = vT > -0.35 * sp ? 1 : -1;
      const keep = Math.max(K.hayMin, K.hayKeep * (1 - smooth(70 * DEG, 90 * DEG, thC)));
      jt = hayT > 0 ? 0 : dirT * Math.max(dirT * vT - mu * j, keep * sp) - vT;
    }
    oR -= side * j;
    oT += jt;
    // Only the push turns the car: the friction's own torque (at the corner's offset across) would grab a grippy wall
    // and wind the car square into it, which plays as getting stuck.
    const yawMax = hay ? K.hayYaw : K.wallYaw;
    const dW = clamp((-side * arm * j) / I, -yawMax, yawMax);
    kick = clamp(kick + dW, hay ? -K.hayYaw : -KICK_MAX, hay ? K.hayYaw : KICK_MAX);
    const still = side * (oR + (yawRel + dW) * lev); // the clamp held some yaw back: the corner must leave anyway
    if (still > -K.wallSep) oR -= side * (still + K.wallSep);
    accBase.z = clamp(accBase.z - side * j * c * 3, -60, 60); // the body rocks toward the wall (the rig's roll spring)
    if (un <= K.bounceMin) return; // a touch: it scrapes along
    const ev = state.events;
    ev.wallHit = Math.max(ev.wallHit ?? 0, un);
    if (drifting && un > K.driftHit) endDrift(false); // a hit ends a drift (no boost)
    if (hay) {
      hayT = K.hayTime;
      omega = 0; // the bales stop the car turning in (the settle straightens it)
      if (!drifting) slide = 0;
    } else if (th > K.spinAngle * DEG && un > K.spinSpeed) {
      // spun out: the nose goes the way the lever arm swings it (head-on: round toward the way the track runs)
      const sg = Math.abs(arm) > 0.3 ? -side * Math.sign(arm) : sn > 0 ? -1 : 1;
      kick = sg * Math.max(K.spinYaw, sg * kick);
      spinT = K.spinTime;
      ev.spinOut = true;
      if (drifting) endDrift(false);
      slide = 0;
    } else if (th > K.stunAngle * DEG && un > K.stunSpeed) {
      stunT = Math.max(stunT, K.stunTime);
      if (drifting) endDrift(false);
    }
  }

  /** Leave the surface with the current pose and velocity - exactly what the car brought, nothing added. A drift held
   *  carries on when it lands; one being let go of is over. */
  function launch(stall: boolean) {
    grounded = false;
    airTime = 0;
    falling = stall;
    if (!drifting) slide = 0;
    if (stall) respawnIn = 0.9; // fell off the loop's ceiling
    airP.copy(state.position);
    airV.copy(state.velocity);
    airQ.copy(state.quaternion);
    state.events.airborne = true;
  }

  /** Where the flight comes down: the arc stepped ahead (1/30 s steps, up to `horizon` s) against the track under it.
   *  Returns the time to touchdown (Infinity: not within the horizon, or not onto a surface), its frame left in fL. */
  function touchdown(horizon: number): number {
    preP.copy(airP);
    preV.copy(airV);
    let ss = s, f = frame(ss, fL);
    const dt = 1 / 30;
    for (let t = dt; t <= horizon + 1e-6; t += dt) {
      preV.y -= K.g * dt;
      preP.addScaledVector(preV, dt);
      for (let i = 0; i < 3; i++) {
        const ds = clamp(preO.subVectors(preP, f.p).dot(f.t), -6, 6);
        if (Math.abs(ds) < 0.05) break;
        ss = wrapS(ss + ds);
        f = frame(ss, fL);
      }
      if (track.tagAt(ss) !== 'gap' && preO.subVectors(preP, f.p).dot(f.up) <= geo.ride) return t;
    }
    return Infinity;
  }

  /** Follow the track under a free-flying point: Newton steps along the tangent from the current s. */
  function project(P: THREE.Vector3): TrackFrame {
    let f = frame(s, fM);
    for (let i = 0; i < 4; i++) {
      const ds = clamp(v1.subVectors(P, f.p).dot(f.t), -6, 6);
      if (Math.abs(ds) < 0.01) break;
      s = wrapS(s + ds);
      f = frame(s, fM);
    }
    return f;
  }

  function land(f: TrackFrame) {
    const ev = state.events;
    const vn = airV.dot(f.up);
    const vT = airV.dot(f.t), vR = airV.dot(f.right);
    const sp = Math.hypot(vT, vR);
    const fwd = v2.copy(X).applyQuaternion(airQ), up = v3.copy(Y).applyQuaternion(airQ);
    psi = Math.atan2(fwd.dot(f.right), fwd.dot(f.t));
    let b = sp > 0.5 ? wrapA(psi - Math.atan2(vR, vT)) : 0;
    v = sp;
    if (Math.abs(b) > Math.PI / 2) {
      v = -sp; // landed going backwards
      b = wrapA(b + Math.PI);
    }
    if (airTime > 0.3) {
      // graded on the worse of tilt (car up vs track up) and yaw (nose vs flight path)
      const err = Math.max(Math.acos(clamp(up.dot(f.up), -1, 1)), Math.abs(b)) / DEG;
      if (err <= K.perfectDeg) {
        boost = Math.min(K.boostCap, boost + K.perfectBoost);
        ev.perfectLanding = true;
        ev.boostStart = true;
      } else if (err <= K.okDeg) v *= K.okKeep;
      else {
        v *= K.badKeep;
        omega = -Math.sign(b) * 1.5; // wobble back toward straight
      }
    }
    beta = clamp(b, -K.slipMax * DEG, K.slipMax * DEG);
    ev.landed = Math.max(ev.landed ?? 0, -vn);
    grounded = true;
    airTime = 0;
    vPrev = v;
    const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
    const dMax = Math.max(0, limitOf(f) - ext);
    d = clamp(d, -dMax, dMax);
    poseGround(frame(s, fM));
  }

  function airStep(h: number, inp: DriveInput) {
    airTime += h;
    airV.y -= K.g * h;
    airP.addScaledVector(airV, h);
    const f = project(airP);
    const off = v1.subVectors(airP, f.p);
    d = off.dot(f.right);
    const hb = off.dot(f.up) - geo.ride; // tyres above the surface
    const tag = track.tagAt(s);
    const fwd = v2.copy(X).applyQuaternion(airQ);
    const up = v3.copy(Y).applyQuaternion(airQ);
    psi = Math.atan2(fwd.dot(f.right), fwd.dot(f.t));
    if (!falling) {
      // the nose swings into the flight path, offset by the steer (aim the landing), plus what a hit kicked in
      const right = v4.crossVectors(fwd, up);
      const toPath = Math.atan2(airV.dot(right), Math.max(Math.abs(airV.dot(fwd)), 1e-3));
      airYawRate = clamp((toPath + inp.steer * K.airLean * DEG) * K.airVane, -K.airYaw, K.airYaw) + kick;
      q1.setFromAxisAngle(up, -airYawRate * h); // +angle about up turns the nose left
      airQ.premultiply(q1);
      // Pitch and roll: the nose follows the flight path (the world's up square to the flight: no roll), so a long arc
      // noses over with gravity; over its last half second the car levels to the surface it will come down on (the
      // arc looked ahead). Never faster than airTurn, and always toward upright: no flips.
      up.copy(Y).applyQuaternion(airQ);
      const sp2 = airV.lengthSq();
      const tgt = v5.copy(Y).addScaledVector(airV, -airV.y / Math.max(sp2, 1e-6));
      if (tgt.lengthSq() < 1e-6) tgt.copy(f.up);
      tgt.normalize();
      const w = smooth(0.5, 0.15, touchdown(0.6));
      tgt.lerp(fL.up, w).normalize();
      q2.setFromUnitVectors(up, tgt);
      const ang = 2 * Math.acos(Math.min(1, Math.abs(q2.w)));
      if (ang > 1e-5) {
        const k = lerp(K.airPitch, K.airLevel, w);
        q1.identity().slerp(q2, Math.min(1 - Math.exp(-k * h), (K.airTurn * h) / ang));
        airQ.premultiply(q1).normalize();
      }
      // the walls still catch a low car: the same impulse as on the ground
      const lim = limitOf(f);
      const dMax = Math.max(0, lim - (geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi))));
      const wallH = f.edge === 'rail' ? K.railHeight : K.barrierHeight;
      if (tag !== 'gap' && hb < wallH && hb > -0.6 && Math.abs(d) > dMax && Math.abs(d) < lim + 0.4) {
        const side = d > 0 ? 1 : -1;
        airP.addScaledVector(f.right, side * dMax - d);
        d = side * dMax;
        const vN = airV.dot(f.up);
        impact(side, f, airV.dot(f.t), airV.dot(f.right), airYawRate);
        airV.copy(f.t).multiplyScalar(oT).addScaledVector(f.right, oR).addScaledVector(f.up, vN);
      }
      // touchdown: on a surface (not over a gap), coming down onto it, within the edges (a verge counts)
      if (tag !== 'gap' && hb <= 0 && hb > -0.75 && airTime > 0.05 && airV.dot(f.up) < 0 && Math.abs(d) <= lim) {
        land(f);
        return;
      }
      // missed the track: the ground, under a surface (short of a landing ramp: it would fall through it), or lost
      if (airP.y < floorY || airTime > K.airMax || (tag !== 'gap' && hb <= -0.75 && Math.abs(d) <= lim)) {
        falling = true;
        respawnIn = 0.6;
      }
    }
    if (airP.y < floorY) {
      airP.y = floorY;
      airV.set(0, 0, 0);
    }
    state.position.copy(airP);
    state.quaternion.copy(airQ);
    state.velocity.copy(airV);
  }

  function groundStep(h: number, inp: DriveInput) {
    const ev = state.events;
    let f = frame(s, fM);
    const g = K.g;
    let phi = psi - beta;
    let cph = Math.cos(phi), sph = Math.sin(phi);

    // ---- leave the surface? Only where the track means it to: over the gap off the kicker, or a loop's ceiling too
    // slow. Anywhere else the toy track's magnet holds the car over crests (no accidental jumps). The crest curvature
    // is averaged over the wheelbase (the axle frames of the last pose), so one kinked sample can't throw the car.
    const tag0 = track.tagAt(s);
    const vt = v * cph;
    const crest = (f.kappaN + fA.kappaN + fB.kappaN) / 3;
    const hold = g * f.up.y - vt * vt * crest + K.stick * g;
    if (tag0 === 'gap' || (hold < 0 && (tag0 === 'kicker' || tag0 === 'loop' || f.up.y < 0.5))) {
      launch(hold < 0 && f.up.y < 0.2);
      airStep(h, inp);
      return;
    }

    // ---- what's under the wheels
    surfaceAt(f, h);

    // ---- knocked about: a hard hit stuns for a moment, a very hard one spins the car out (control fades back in)
    const ctl = lerp(lerp(1, K.stunCtl, clamp(stunT / 0.1, 0, 1)), K.spinCtl, clamp(spinT / 0.15, 0, 1));
    const steer = inp.steer, thr = inp.throttle, brk = inp.brake;
    const av = Math.abs(v);

    // ---- drift: a fresh press of Space (held or not) at speed makes the car loose. It's over once the car is straight
    // again (the sparks cash in) - or one that never slid, after looseIdle - or too slow or spun. A press mid-drift
    // keeps it going (reFlick), so tapping for each bend of an S never cancels the slide.
    if (drifting) {
      const ab = Math.abs(beta);
      looseT += h;
      if (ab > (K.straightSlip + 3) * DEG) slid = true;
      straightT = ab < K.straightSlip * DEG && slide >= 1 ? straightT + h : 0;
      if (ab > 0.02) dir = beta > 0 ? 1 : -1;
      if (v < K.driftEnd) endDrift(false);
      else if (ab > K.spinSlip * DEG) {
        endDrift(false);
        spun = true;
        settleT = 0;
      } else if (pressT > 0) reFlick(steer);
      else if (slid ? straightT >= K.straightTime : looseT >= K.looseIdle) endDrift(slid);
    } else if (pressT > 0 && ctl > 0.99 && hayT <= 0 && v >= K.driftMin) startDrift(steer);
    // The slide: in a drift the rear lets go over driftIn, out of one it grips up again over driftOut - down to what
    // the dirt lets go by itself under a hard steer at speed (the way the wheel is turned; steering against that
    // slide lets it go first).
    let loose = sLoose * K.dirtLoose * smooth(0.7, 1, Math.abs(steer)) * smooth(K.looseMin, K.looseMin + 10, v);
    if (!drifting) {
      if (slide < 0.05) dir = steer > 0 ? 1 : steer < 0 ? -1 : dir;
      else if (steer * dir < 0) loose = 0;
    }
    if (drifting) slide = Math.min(1, slide + h / K.driftIn);
    else if (slide > loose) slide = Math.max(loose, slide - h / K.driftOut);
    else slide = Math.min(loose, slide + h / K.driftIn);
    const sm = slide * slide * (3 - 2 * slide);
    if (slide <= loose) spun = false;
    if (settleT > 0) settleT -= h;

    // ---- grip on the slip: the tyres' (kN), or the loose rear's (kL: looser on the throttle, tighter off it)
    const kN = K.grip * flav.grip * sGrip;
    const kL = K.looseGrip * flav.driftGrip * sDrift * lerp(K.looseLift, K.looseThrottle, thr);
    let k = kN + (kL - kN) * sm;
    let c = K.scrub + (K.driftScrub - K.scrub) * sm;

    // ---- gravity in the surface plane: along the travel changes speed, across it bends the path (banks hold the car)
    const gT = -g * f.t.y, gR = -g * f.right.y;
    const gAlong = gT * cph + gR * sph;
    const gPerp = -gT * sph + gR * cph;
    const gTurn = v > 0 ? (K.bankAssist * gPerp * v) / (v * v + 25) : 0; // ~ gPerp / v, fading out at a standstill

    // ---- speed (the surface sets the top speed; the verge drags)
    const vtop = K.vtop * sCap;
    let a = gAlong;
    if (v > -0.5 && v < vtop) a += thr * K.accel * (1 - (v / vtop) ** 2);
    if (brk > 0 && v < 0.5) a -= brk * K.accel * 0.5 * Math.max(0, 1 + v / K.reverse); // reverse
    const push = boost > 0 ? K.boostAccel : turbo > 0 ? K.turboAccel : 0; // a booster's push, or a drift's mini-turbo
    if (push > 0 && v > -0.5) a += push * Math.max(0, 1 - (v / (K.vboost * sCap)) ** 2);
    let fr = c * Math.abs(Math.sin(beta)) * av; // friction-like: never reverses the motion
    fr += (1 - thr) * (K.coast + K.drag * v * v); // part throttle: a lower top speed
    fr += sDrag * av;
    if (brk > 0 && v > 0.5) fr += K.brake * brk;
    if (thr > 0 && v < -0.5) fr += K.brake * thr;
    const cap = (push > 0 ? K.vboost : K.vtop) * sCap;
    if (av > cap) fr += K.overspeed * (av - cap);
    v += a * h;
    v = v > 0 ? Math.max(0, v - fr * h) : Math.min(0, v + fr * h);

    // ---- yaw (a hit's kick turns the car on top of this): the steering asks for a yaw rate, and the travel follows the
    // nose on the grip above. Loose, it asks a little more (the car rotates readily) and the nose answers more slowly
    // (the car's weight swinging), while the loose rear lets the travel lag: the slip is whatever that leaves - the
    // tail steps out while the car rotates faster than the travel bends, and comes back in when it doesn't. Past
    // limitSlip the rear bites and holds the nose back (no spin from steering alone; it fades out past 60 deg). The
    // grip coming back, the slip goes by the nose easing back to the travel, which bends no faster than the loose
    // rear let it plus exitSlack (no snap) - unless the car has spun: then nothing helps it round.
    const av2 = Math.abs(v);
    const wGrip = steer * ctl * sYaw * (v < 0 ? -1 : 1) * Math.min(av2 / K.yawRamp, lerp(K.yawLow, K.yawHigh, Math.min(1, av2 / K.vtop)));
    let wT = wGrip * (1 + (K.looseYaw - 1) * sm);
    const ab = Math.abs(beta);
    if (sm > 0 && v > 0 && hayT <= 0) {
      wT -= Math.sign(beta) * Math.max(0, ab - K.limitSlip * DEG) * (1 - smooth(60 * DEG, 80 * DEG, ab)) * K.limitYaw * sm;
    }
    if (settleT > 0 && !drifting && v > 0 && hayT <= 0) {
      // settling after a drift: toward the slip this much grip holds with this steering (bN)
      const bN = wT / Math.max(k, 0.5), ex = Math.abs(beta - bN);
      k = lerp(k, Math.min(k, kL + K.exitSlack / Math.max(ab, 0.02)), smooth(1 * DEG, 6 * DEG, ex));
      wT += ((bN - beta) * (1 - sm)) / K.exitFollow;
      if (slide <= loose && ex < 0.5 * DEG) settleT = 0; // settled
    }
    k *= ctl;
    if (hayT > 0) (k *= K.hayGrip), (c *= K.hayGrip); // caught by hay: it slides along the bales while it straightens
    wT += gTurn;
    if (hayT > 0) wT -= clamp(beta * K.hayAlign, -K.hayTurn, K.hayTurn); // ... its nose swinging round to its slide
    omega += (wT - omega) * (1 - Math.exp(-h / lerp(K.yawLag, K.looseLag, sm)));
    // Against a wall the nose can't be steered in past wallNose, and further in the wall eases it back: the wall takes
    // the turn and the car slides along it (a drift steered into it is over). Without this the steering out-turns the
    // wall and winds the car in nose first, scrubbing off all its speed.
    const nose = wallSide * psi;
    if (wallAgo < 0.05 && nose > K.wallNose * DEG && nose < 1.75) {
      const into = wallSide * (omega + kick - (f.kappa * v * cph) / Math.max(0.3, 1 - f.kappa * d));
      const want = -K.wallAlign * (nose - K.wallNose * DEG); // the most it may turn in (< 0: out)
      if (into > want) {
        if (drifting && into > 0) endDrift(false);
        omega -= wallSide * (into - want);
      }
    }

    // ---- slip: the heading turns, the travel lags behind it; grip pulls the travel back toward the heading. A hit can
    // leave the slip past slipMax (it eases back); a spin-out turns the car past side-on, and then it slides backwards.
    beta += (omega + kick - gTurn) * h;
    // past side-on it's going backwards (driving forward into hay: further round, while it settles)
    const back = hayT > 0 && v > 0 ? K.haySide * DEG : Math.PI / 2;
    if (beta > back || beta < -back) {
      beta = wrapA(beta + Math.PI);
      v = -v;
    }
    beta *= Math.exp(-k * h);
    // (loose, the soft limit is all that holds the slip)
    slipLim = spinT > 0 || slide > 0.5 ? Math.PI / 2 : Math.max(K.slipMax * DEG, slipLim - 3 * h);
    beta = clamp(beta, -slipLim, slipLim);

    // ---- move in track space (the inside line is genuinely shorter)
    phi = psi - beta;
    cph = Math.cos(phi);
    sph = Math.sin(phi);
    const sdot = (v * cph) / Math.max(0.3, 1 - f.kappa * d);
    s = wrapS(s + sdot * h);
    d += v * sph * h;
    const yawRel = omega + kick - f.kappa * sdot; // the car's turn against the track (and its walls)
    psi = wrapA(psi + yawRel * h);
    f = frame(s, fM);

    // ---- walls: the half-width the car needs depends on its heading; a corner past the edge's limit is on the wall
    const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
    const dMax = Math.max(0, limitOf(f) - ext);
    if (d > dMax || d < -dMax) {
      const side = d > 0 ? 1 : -1;
      d = side * dMax;
      const ph = psi - beta;
      impact(side, f, v * Math.cos(ph), v * Math.sin(ph), yawRel);
      // back to speed and slip (a hit can turn the travel past side-on: then it's going backwards)
      const sp = Math.hypot(oT, oR);
      let b = sp > 1e-3 ? wrapA(psi - Math.atan2(oR, oT)) : 0, sg = 1;
      const back = hayT > 0 && v > 0 ? K.haySide * DEG : Math.PI / 2;
      if (b > back || b < -back) (b = wrapA(b + Math.PI)), (sg = -1);
      v = sg * sp;
      beta = b;
      if (Math.abs(b) > slipLim) slipLim = Math.abs(b);
    }

    // ---- sparks: only while it really slides (the rear all the way loose, the slip past chargeSlip either way)
    if (drifting && sm > 0.9 && v > K.driftEnd) {
      charge += h * flav.charge * smooth(K.chargeSlip - 2, K.chargeSlip + 2, Math.abs(beta) / DEG);
      const nt = charge >= K.tier3 ? 3 : charge >= K.tier2 ? 2 : charge >= K.tier1 ? 1 : 0;
      if (nt > tier) {
        tier = nt as 1 | 2 | 3;
        ev.tierUp = tier;
      }
    }

    // ---- boosters
    const tag = track.tagAt(s);
    const pad = tag === 'booster';
    if (pad && !onPad && v > 0) {
      v += K.padKick;
      boost = Math.min(K.boostCap, Math.max(boost, K.padBoost));
      ev.boostStart = true;
    }
    onPad = pad;

    // ---- remember a safe spot for respawns (not on a launch ramp or in the loop). Put the car back on the track when
    // it's stuck - trying to drive but going nowhere (sooner nose-in on a wall, or upside down in the loop) - or has
    // been driving the wrong way too long: nose first against the lap direction (backing up the right way doesn't
    // count, and clears it, as does turning round)
    const av3 = Math.abs(v);
    if (f.up.y > 0.8 && tag !== 'kicker' && tag !== 'loop' && Math.abs(psi) < 0.6 && v > 5 && Math.abs(d) < f.width * 0.5 && ctl > 0.99) {
      safeS = s;
      safeV = v;
    }
    stuck = av3 < K.stuckSpeed && (f.up.y < 0.5 || thr > 0.5 || brk > 0.5) ? stuck + h : 0;
    const facing = Math.cos(psi), along = v * Math.cos(psi - beta); // nose against the lap; speed along it
    if (facing < -0.17 && v > 3) wrongT += h;
    else if (facing > 0.17 || along > 3) wrongT = 0;
    if (stuck > (f.up.y < 0.5 ? 1.5 : wallAgo < 0.3 ? 2.5 : K.stuckTime) || wrongT > K.wrongRespawn) {
      respawn();
      return;
    }

    // ---- body feel: longitudinal, lateral (+ right), normal load (+ compressed in dips and loops); dirt's bumps on top
    aY = -(v * cph) * (v * cph) * f.kappaN;
    aT.set(clamp(v * vPrev < 0 ? 0 : (v - vPrev) / h, -60, 60), clamp(aY, -60, 60), clamp(v * omega, -60, 60));
    accBase.lerp(aT, 1 - Math.exp(-20 * h));
    state.accelLocal.copy(accBase);
    if (sBump > 0.01) {
      const b = sBump * K.dirtBump * Math.min(1, av3 / 25);
      state.accelLocal.x += 24 * b * bumps(s + 5.3); // through the rig's springs: ~1 deg of pitch and roll, ~0.02 u of heave
      state.accelLocal.y += 55 * b * bumps(s);
      state.accelLocal.z += 24 * b * bumps(s * 1.3 + 11);
    }
    vPrev = v;
    poseGround(f);
  }

  return {
    state,
    tuning: TUNING,
    reset(s0: number) {
      place(s0);
      boost = 0;
      pressT = 0;
      held = false;
      safeS = s;
      safeV = 0;
      steerVis = 0;
      spin = 0;
      state.speed = 0;
      state.steerVisual = 0;
      state.wheelSpinRate = 0;
      state.slip = 0;
      state.drifting = false;
      state.driftTier = 0;
      state.boosting = false;
      state.grounded = true;
      state.trackS = s;
      state.lapDelta = 0;
      state.wrongWay = false;
    },
    step(h: number, inp: DriveInput) {
      const s0 = s;
      // a drift starts (or, loose, ends) on a fresh press of Space, which counts for driftBuffer s; holding it is the
      // same as a tap
      if (inp.drift && !held) pressT = K.driftBuffer;
      held = inp.drift;

      if (respawnIn > 0 && (respawnIn -= h) <= 0) respawn();
      else if (grounded) groundStep(h, inp);
      else airStep(h, inp);
      if (boost > 0) boost = Math.max(0, boost - h);
      if (turbo > 0) turbo = Math.max(0, turbo - h);
      if (pressT > 0) pressT = Math.max(0, pressT - h);
      // a hit's yaw dies away (slower through a spin-out); the stun and spin wear off
      kick *= Math.exp(-h / (spinT > 0 ? K.spinTime * 0.5 : K.wallYawTime));
      if (stunT > 0) stunT -= h;
      if (spinT > 0) spinT -= h;
      if (hayT > 0) hayT -= h;
      wallAgo += h;
      if (!grounded) {
        accBase.multiplyScalar(Math.exp(-10 * h)); // weightless
        state.accelLocal.copy(accBase);
      }

      // wheels: rolling speed plus a little wheelspin off the line; in the air they rev with the throttle
      if (grounded) spin = (v * Math.cos(beta)) / geo.r + inp.throttle * Math.max(0, 1 - Math.abs(v) / 12) * 30;
      else spin += ((inp.throttle * K.vtop * 1.2) / geo.r - spin) * (1 - Math.exp(-h * (inp.throttle > 0 ? 2 : 0.4)));
      steerVis += (inp.steer - steerVis) * (1 - Math.exp(-h * 25));

      const r0 = wrapS(s0 - track.start), r1 = wrapS(s - track.start);
      state.lapDelta = r0 > 0.75 * LEN && r1 < 0.25 * LEN ? 1 : r0 < 0.25 * LEN && r1 > 0.75 * LEN ? -1 : 0;
      state.trackS = s;
      state.speed = grounded ? Math.abs(v) : airV.length();
      state.slip = grounded ? beta : 0;
      state.drifting = drifting;
      state.driftTier = tier;
      state.boosting = boost > 0 || turbo > 0;
      state.grounded = grounded;
      state.steerVisual = steerVis;
      state.wheelSpinRate = spin;
      state.wrongWay = wrongT > K.wrongTime;
    },
  };
};
