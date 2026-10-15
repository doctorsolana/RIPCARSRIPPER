import * as THREE from 'three';
import type { CarSpec, DriveInput, Track, TrackFrame, Vehicle, VehicleFactory, VehicleState } from '../types';

// "arcade": the hand-written driving model. On the track it lives in track space - distance along (s), offset across
// (d), heading relative to the track (psi), slip (beta = heading minus travel), speed (v), yaw rate (omega) - so the
// track's own frames carry slopes, banks and the loop: gravity is projected onto the surface plane, and the car stays
// on while the surface can hold it (v^2 kappaN against g plus a little toy-track "magnet"). A gap off a kicker (or a
// loop's ceiling taken too slow, or track 2's climb - up the wall and over - taken too slow) launches it into a
// ballistic flight in world space, and so does any other crest the surface can't hold it on - a bump, a hump, the top
// of a hill - with only a little toy-track magnet (hopStick) to stay on: it hops, flies the same ballistics and comes
// down with the same landings (a short hop lands quietly: only real air is graded). The set pieces - a big jump's
// in-run, lip, gap and landing, the kickers, the loops, the climb, the start drops - fly, fall or hold as they're
// built to (a crest there never throws the car). In the air the nose follows the flight path and the car levels itself to
// what it comes down on (gently, never a flip); it lands back into track space with a graded landing. Every jump, the
// big one (tag 'bigjump') too, flies off whatever the car brings to the lip - its speed, line and heading. Nothing lines
// it up or sets its speed: too slow, too fast or crooked and it misses (and is put back before the run-up).
// Grip turns the direction of travel toward the heading but keeps |v|. A drift is a loose car, not a hop and not a
// button held: a tap of Space at speed (holding it is the same) lets the rear go loose over a fifth of a second, and
// the slide is then the driving's own - the steering yaws the car, the loose rear lets the travel lag behind the nose
// (the tail steps out), counter-steer swings the nose back, the throttle loosens the rear a little more, a lift tucks
// it in, and past ~35 deg the rear bites (a soft limit). Nothing sets the slip angle. It's over by itself once the car
// has settled straight again - not while it swings through straight into the other side - (or too slow, spun, into a
// wall), the grip easing back over 0.3 s; another tap never cancels it - it keeps it going and flicks it toward the
// wheel, so S-bends link. On dirt a hard steer at speed loosens the rear a little by itself. Sparks charge through
// three tiers while it really slides - and a hidden fourth, the magic max, for a slide kept going twice as long as gold
// (linked through a whole S) - cashed in as a mini-turbo when it ends clean.
// Every boost - a booster pad, a drift's mini-turbo, a PERFECT landing - pours its time into one shared tank (nothing
// is wasted under another), and boosts stacked onto one still running raise the boost's top speed, without limit: a run
// of pads (or a big drift cashed in just before one) throws the car as far as the physics says (see stackSpeed).
// The throttle pushes up to the car's top speed and no further, but nothing else holds it there: past it only the air
// drags (~v^2), gently, so a hill (or a boost) carries the car well over its top speed for a few seconds - into the
// corners after the drop and the big jump faster than it ever drives there, and the tyres' grip doesn't grow with the
// speed (past the top speed the most it turns falls as 1/v): it needs the brakes, or more road.
// Surfaces scale grip, turn and top speed - plastic fast, asphalt grippiest, dirt loose and bumpy, the grass verge past
// a road's edge slow and slippery - blended as the wheels cross from one to the next.
// Each car has its own character (PROFILES): top speed, how it pulls, brakes, grips and steers, how it drifts, and how
// the air, the walls and the dirt treat it - multipliers on the shared numbers below.
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
  vtop: 44, // top speed on the throttle (u/s; x4.3 = scale km/h), on plastic - each car's x its profile's top
  vboost: 56, // top speed while boosting
  accel: 26, // throttle: accel * (1 - (v/vtop)^2): 0-90% in 2.5 s
  brake: 60,
  reverse: 10, // top speed backwards
  coast: 3, // off the throttle: coast + drag * v^2
  drag: 0.004,
  overspeed: 1.5, // over a surface's top speed (onto grass, dirt) lose overspeed * (v - its cap) per s (a surface that
  overFull: 0.1, // takes less than overFull off the top speed - asphalt - proportionally less) - but over the car's own
  airLin: 0.1, // top speed (down a hill, after a boost) only the air drags, gently: (airLin + airDrag * (v + top)) *
  airDrag: 0.003, // (v - top) per s - 20% over on the flat, half of it is gone in ~1.7 s, nearly all in ~4 s
  g: 24, // ~3x real gravity at this scale: snappy and toy-like
  stick: 0.3, // the track's extra hold, in g (loop tops)
  yawLow: 3, // max yaw rate in grip (rad/s) at low speed ...
  yawHigh: 1.3, // ... and at vtop (a 34 u radius); faster, it falls as 1/v (the tyres' grip is all there is)
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
  straightSlip: 8, // deg: the slip under this (the sparks have stopped), swinging slower than straightRate (deg/s) and
  straightRate: 30, // the nose turning for no more slip than straightSlip either way, for straightTime (s): the car has
  straightTime: 0.12, // settled straight - the drift is over and the sparks cash in (a swing through straight into the
  // other side never counts: it swings too fast, and the nose turns for the other side) ...
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
  tier1: 0.9, // s of real sliding per spark tier (blue, purple, gold) ...
  tier2: 1.8,
  tier3: 2.7,
  tier4: 5.4, // ... and the hidden magic max, twice gold's: only a slide kept going through a whole S gets there
  boost1: 0.5, // s of mini-turbo per tier ...
  boost2: 1,
  boost3: 1.5,
  boost4: 2.5,
  turboAccel: 31, // ... pushing this hard (u/s^2; the magic max's x turbo4; a booster's push is boostAccel)
  turbo4: 1.3,
  boostAccel: 45,
  // One shared boost tank: a booster pad, a drift's mini-turbo and a PERFECT landing each add their time to it - nothing
  // overwrites or wastes another, and there's no cap. It burns its strongest first - a booster's push (boostAccel),
  // then a magic max's (turboAccel x turbo4), then a mini-turbo's (turboAccel) - so on its own each source pushes
  // exactly as hard and as long as it always did. The stack is how many boosts are in the running tank (1 for a lone
  // one; the state's boostStack): each one added while the tank still runs raises the boost's top speed (vboost) by
  // stackSpeed - x1 56, x2 60, x3 64 u/s ... with no limit: a run of pads stacked up throws the car as fast and as far
  // as the physics says (a stacked boost into a jump can overshoot its landing: that's the player's call). The bonus
  // fades out over the tank's last stackFade s and the stack is gone once it's empty. A respawn's second of push tops
  // the tank up without stacking.
  stackSpeed: 4, // u/s per boost stacked
  stackFade: 1, // s
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
  steepBank: 40, // deg: a bank steeper than this (track 2's wall ride; fully 10 deg on) holds the car up only as hard
  bankGrip: 1.1, // as the tyres grip on the load - bankGrip x (g up + the speed pressing it in): slower, it slides down
  airYaw: 2, // rad/s, max yaw rate in the air
  airVane: 3, // per s: the nose swings into the flight path ...
  airLean: 25, // ... offset by up to this (deg) with full steer: steer to aim, let go for a PERFECT
  airPitch: 6, // per s: in the air the nose follows the flight path, so a long arc noses over with it ...
  airLevel: 3, // ... and over its last half second the car levels itself to the track it lands on ...
  airTurn: 1.5, // ... turning (pitch and roll) at most this fast (rad/s): never a flip
  airMax: 60, // s: lost in the air - only a safety net: a flight comes down on the track or the ground by itself, however
  // long stacked boosts throw it (the big jump's flight is ~2.3 s, the sky jump's ~3.3 s)
  perfectDeg: 12, // landing within this: PERFECT (+ boost)
  okDeg: 35, // within this: ok, keep okKeep of the speed; worse: badKeep and a wobble
  perfectBoost: 0.5,
  okKeep: 0.95,
  badKeep: 0.75,
  respawnBack: 24, // u behind the last safe spot ...
  respawnClear: 60, // ... with this much track before a booster (not a narrow one), kicker or gap (time to line up: no
  // miss loop) - and never inside a big jump's in-run (tag 'inrun'): back to its top ...
  respawnSpeed: 0.75, // ... at least this x vtop, plus a second of boost
  wrongTime: 1, // s driving nose first against the lap direction: WRONG WAY ...
  wrongRespawn: 4, // ... and after this long, put back on the track facing the right way
  stuckSpeed: 2, // u/s: slower than this while trying to drive ...
  stuckTime: 4, // ... for this long (s) is stuck: put back on the track
  wallCrawl: 8, // u/s: on a bank past steepBank, slower than this for 1.5 s is stuck too (slid off the wall ride)
  climbPeel: 6, // u/s: up track 2's climb (tag 'climb') slower than this, the car peels off the wall (or, low on its
  climbBack: 0.6, // pull-up, rolls back) and is put back before the run-up this many s later (0.9 s off the wall)
  // Off a crest (not a jump's lip or gap: those are as above) the car flies once the surface can't hold
  // it - g up.y + hopStick g less the speed's v^2 crest - and the track isn't banked past hopBank (deg: a banked turn
  // holds it). A hop needs hopRearm s on the ground since the last landing (no buzz over rough ground); it counts as
  // airborne (sound, dust, camera, the autopilot) once hopShow s or hopClear u clear of the surface - a skim under that
  // lands silently - and its landing is graded (PERFECT, ok, bad) only past hopGrade s of air.
  hopStick: 0.15,
  hopBank: 15,
  hopRearm: 0.1,
  hopShow: 0.1,
  hopClear: 0.25,
  hopGrade: 0.9,
};

/** Live-tunable numbers (?tune=1), shared by every car. Each car's profile multiplies on top and is not in here. */
export const TUNING: Record<string, number> = K;

/** A car's character: multipliers on the numbers above (1 = the stock car; a car not in PROFILES drives on K alone). */
export interface Profile {
  top: number; // top speed (vtop: where the throttle stops pushing)
  pull: number; // the throttle's push (accel) ...
  rev: number; // ... and how it holds toward the top: accel * (1 - x^rev), x = v / top (stock 2; more holds on) ...
  spool: number; // ... less this share of it off the line, coming in by half the top speed (a turbo's lag)
  brake: number;
  grip: number; // how fast the travel follows the nose (the slip's decay) ...
  turn: number; // ... and the most the car turns (yawLow, yawHigh): its cornering
  steer: number; // how slowly the nose answers the wheel (yawLag; < 1 sharper)
  slide: number; // the loose rear's grip (looseGrip): < 1 the tail swings out wider for the same bend ...
  unstick: number; // ... how readily it lets go on a tap (over driftIn / unstick; < 1 harder to get sideways) ...
  float: number; // ... how slowly the nose answers it loose (looseLag; > 1 floaty) ...
  angle: number; // ... and how far it slides before the rear bites (limitSlip)
  charge: number; // how fast the sparks charge
  aero: number; // drag past the top speed (< 1: carries a hill's speed further)
  heft: number; // weight: hits bounce and turn it less (and take more to stun or spin it), the dirt's bumps shake it less
  dirt: number; // how it copes with dirt: the dirt's grip, slide, turn and top speed x this (> 1 likes it; at most 1)
}
const STOCK: Profile = {
  top: 1, pull: 1, rev: 2, spool: 0, brake: 1, grip: 1, turn: 1, steer: 1, slide: 1, unstick: 1, float: 1, angle: 1, charge: 1,
  aero: 1, heft: 1, dirt: 1,
};
// Keyed by a word of the car id. Fair - each is quickest somewhere else: the Porsche through the asphalt corners and
// on the brakes, the Skyline drifting and pulling out of the corners, the Impala over the dirt and down the hills.
// (The Impala's hydraulic hop into a drift is rig.ts's, on its soft springs.)
const PROFILES: Record<string, Partial<Profile>> = {
  // Porsche 911 GT3 R: a race car - slicks, wings, race brakes, a flat-6 that revs to the top. The most grip and
  // braking, the sharpest steering, the highest top speed; hard to get sideways and it slides short and tight, its
  // wing's drag eats a hill's extra speed soonest, and it's light and stiff: hits knock it about, it hates the dirt.
  roxy: {
    top: 1.04, rev: 2.3, brake: 1.15, grip: 1.15, turn: 1.05, steer: 0.75,
    unstick: 0.5, float: 0.95, angle: 0.9, aero: 1.25, heft: 0.9, dirt: 0.9,
  },
  // Nissan LB-ER34 Super Silhouette Skyline: the RB26's twin turbos - a breath of lag, then the strongest mid-range
  // pull - in a drift machine: the easiest to throw sideways, a big controllable slide that charges quickest; close on
  // top speed.
  skyline: { top: 1.02, pull: 1.04, rev: 3, spool: 0.2, unstick: 1.3, float: 0.85, angle: 1.1, charge: 1.06, aero: 1.1 },
  // 1964 Chevy Impala lowrider: big, heavy and soft. A big-block V8's shove fading to a lower top speed, drum brakes,
  // lazy steering, skinny whitewalls: it slides big and floaty - a fun boat. Its weight carries a hill's speed furthest
  // and shrugs off the knocks; its soft hydraulics float it over the dirt.
  impala: {
    top: 0.96, pull: 0.96, rev: 1.8, brake: 0.82, grip: 0.9, turn: 0.97, steer: 1.25,
    slide: 0.9, unstick: 1.1, float: 1.3, angle: 1.18, aero: 0.8, heft: 1.35, dirt: 1.12,
  },
  // Porsche 911 GT3 RS (997): the road-going racer - sharp, grippy, brakes hard and revs to the top; a step below
  // the GT3 R on grip and aero, a little easier to get sideways
  gt3: {
    top: 1.03, pull: 1.02, rev: 2.3, brake: 1.12, grip: 1.1, turn: 1.04, steer: 0.8,
    unstick: 0.7, float: 0.95, angle: 0.95, aero: 1.15, heft: 0.9, dirt: 0.92,
  },
  // Porsche 964 (Magnus Walker's outlaw): an air-cooled classic 911 - the engine hung out behind the rear axle, so
  // the tail swings readily on a lift and the slide runs long; good brakes, quick steering, a tad less top
  '964': {
    top: 1, pull: 1, rev: 2.1, brake: 1.08, grip: 1.03, turn: 1.01, steer: 0.85,
    slide: 0.95, unstick: 1.2, float: 0.95, angle: 1.08, aero: 1.05, heft: 0.95, dirt: 0.95,
  },
  // '77 Pontiac Firebird Trans Am: a big V8's shove off the corners that fades up top, a heavy nose, a lazy wheel
  // and a tail that steps out under power - the muscle car slides; soft brakes
  firebird: {
    top: 0.99, pull: 1.06, rev: 1.7, brake: 0.88, grip: 0.93, turn: 0.97, steer: 1.12,
    slide: 0.92, unstick: 1.25, float: 1.15, angle: 1.15, aero: 0.9, heft: 1.25, dirt: 1.05,
  },
  // '99 Honda Civic Type R (EK9): a light front-drive hot hatch - quick to turn in, grippy and planted, a VTEC four
  // that loves the top of the revs; front drive means it's harder to get sideways and the slide stays tidy
  civic: {
    top: 0.98, pull: 0.97, rev: 2.6, brake: 1.05, grip: 1.05, turn: 1.06, steer: 0.8,
    slide: 0.95, unstick: 0.75, float: 0.9, angle: 0.92, aero: 1.05, heft: 0.85, dirt: 1,
  },
  // 1993 Ford Mustang Cobra R: a stripped Fox-body with a V8 - strong low-down pull, a willing tail under power,
  // decent race brakes; a touch heavier than the imports
  mustang: {
    top: 1.01, pull: 1.04, rev: 1.9, brake: 1.02, grip: 0.97, turn: 0.99, steer: 1,
    slide: 0.95, unstick: 1.15, float: 1.05, angle: 1.1, aero: 0.95, heft: 1.1, dirt: 1,
  },
  // Beach Bomb Too (a VW bus with surfboards): tall, soft and slow - an air-cooled flat-4's putter, a floaty lean
  // into every slide, drum brakes, but it shrugs over the dirt and carries a hill's speed (a box on wheels)
  beach: {
    top: 0.93, pull: 0.9, rev: 1.8, brake: 0.8, grip: 0.92, turn: 0.96, steer: 1.25,
    slide: 0.9, unstick: 1.15, float: 1.35, angle: 1.15, aero: 0.85, heft: 1.3, dirt: 1.1,
  },
};
/** The car's profile: the first word of its id that has one (skyline-..., chevy-impala-..., roxy-porsche-...). */
export function profileOf(id: string): Profile {
  for (const w of id.toLowerCase().split('-')) if (PROFILES[w]) return { ...STOCK, ...PROFILES[w] };
  return { ...STOCK };
}

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
  const P = profileOf(car.id);
  let floorY = 0; // the ground: below every bit of track
  for (const f of track.frames) floorY = Math.min(floorY, f.p.y - 0.05);

  // (the profile rides on the state, read-only, for a driver that plans ahead: the autopilot)
  const state: VehicleState & { readonly profile: Readonly<Profile> } = {
    position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), speed: 0,
    steerVisual: 0, wheelSpinRate: 0, slip: 0, drifting: false, driftTier: 0, boosting: false, boostStack: 0,
    grounded: true, accelLocal: new THREE.Vector3(), trackS: 0, lapDelta: 0, events: {}, wrongWay: false, profile: P,
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
  let drifting = false, dir = 0, charge = 0, tier: 0 | 1 | 2 | 3 | 4 = 0, pressT = 0, held = false;
  // the slide: how far the rear has let go (0 grip .. 1 loose); a drift's time loose, time straight, whether it has
  // slid yet; a drift that ended spun gets no help coming round
  let slide = 0, looseT = 0, straightT = 0, slid = false, spun = false, settleT = 0;
  // the boost tank, by strength (burnt strongest first): s left of a booster's (or a landing's, a respawn's) push, of a
  // magic max's mini-turbo, of a drift's mini-turbo; how many boosts are in it (the stack)
  let boost = 0, magic = 0, turbo = 0, stack = 0, onPad = false;
  let safeS = 0, safeV = 0, vPrev = 0, steerVis = 0, spin = 0, aY = 0;
  // walls: the yaw a hit kicked in (it dies away by itself, apart from the steering's omega), the stun and spin-out
  // timers, how far the slip may go (a hit can leave it past slipMax), time since the corner last touched a wall
  let kick = 0, stunT = 0, spinT = 0, slipLim = K.slipMax * DEG, wallAgo = 1, wallSide = 0, airYawRate = 0, hayT = 0;
  let sag = 0; // u/s: sliding sideways down a steep bank (+ right), the tyres short of grip there
  let oT = 0, oR = 0; // impact()'s result: the velocity along / across the track after the hit
  // the surface under the wheels, blended: grip, drift grip, turn, top speed, drag, bumps, looseness (dirt)
  let sGrip = 1, sDrift = 1, sYaw = 1, sCap = 1, sDrag = 0, sBump = 0, sLoose = 0;
  // this flight is a hop off a crest (not a jump), shown yet as airborne; s on the ground since landing
  let hop = false, shown = true, groundT = 0;

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

  // ---- Booster pads: any number of 'booster' tags. One with a lateral extent (d0..d1, track 2's narrow pad before the
  // wall ride) boosts only a car whose centre is over it; the rest span the track. A big jump's in-run (tag 'inrun':
  // the descent that builds its speed) is never cut short by a respawn.
  const pads = track.tags.filter((g) => g.tag === 'booster'), narrow = pads.some((g) => g.d0 !== undefined);
  const inruns = track.tags.filter((g) => g.tag === 'inrun'), climbs = track.tags.filter((g) => g.tag === 'climb');
  /** On a booster pad at (s, d)? (only asked where tagAt says 'booster') */
  function overPad(ss: number, dd: number) {
    for (let i = 0; i < pads.length; i++) {
      const g = pads[i];
      if (ahead(g.s0, ss) < g.s1 - g.s0 && (g.d0 === undefined || (dd >= g.d0 && dd <= (g.d1 ?? g.d0)))) return true;
    }
    return false;
  }
  // Where a crest never throws the car - a big jump (lip to the end of its landing ramp) and its in-run, a kicker and
  // its gap, a loop, the climb, a start drop (the Sky Tower's plunge would throw a car at speed 1.3-1.7 s down the tower
  // into its loop's mouth): those fly (or fall, or hold) as they're built to (per frame of the track)
  const dsF = LEN / track.frames.length, noHop = new Uint8Array(track.frames.length);
  for (const g of track.tags) {
    if (!['bigjump', 'inrun', 'kicker', 'gap', 'loop', 'climb', 'drop'].includes(g.tag)) continue;
    const n = noHop.length;
    for (let x = g.s0 - 1; x <= g.s0 + ahead(g.s0, g.s1) + 1; x += dsF / 2) noHop[Math.round(wrapS(x) / dsF) % n] = 1;
  }
  /** A full-width pad at s? (a narrow one needs no run-up kept clear before it: it launches nothing) */
  const widePadAt = (ss: number) => pads.some((g) => g.d0 === undefined && ahead(g.s0, ss) < g.s1 - g.s0);

  /** Blend the surface numbers toward what's under the wheels (h = 0 snaps): the frame's surface (the dirt's as this
   *  car copes with it), and grass for each wheel out on a verge. */
  function surfaceAt(f: TrackFrame, h: number) {
    let gr = 1, dr = 1, yw = 1, cp = 1, bp = 0, w = 0;
    if (f.surface === 'asphalt') (gr = dr = K.asphaltGrip), (yw = K.asphaltYaw), (cp = K.asphaltCap);
    else if (f.surface === 'dirt') {
      gr = Math.min(1, K.dirtGrip * P.dirt);
      dr = Math.min(1, K.dirtDrift * P.dirt);
      yw = Math.min(1, K.dirtYaw * P.dirt);
      cp = Math.min(1, K.dirtCap * P.dirt);
      bp = 1;
    }
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
    state.velocity.copy(f.t).multiplyScalar(v * Math.cos(ph)).addScaledVector(f.right, v * Math.sin(ph) + sag);
  }

  function place(s0: number) {
    s = wrapS(s0);
    d = psi = beta = omega = v = vPrev = 0;
    grounded = true;
    falling = false;
    respawnIn = airTime = stuck = wrongT = 0;
    hop = false;
    shown = true;
    groundT = 0;
    drifting = slid = spun = false;
    tier = 0;
    charge = 0;
    slide = looseT = straightT = settleT = turbo = magic = 0;
    stack = 0;
    aY = 0;
    kick = stunT = spinT = airYawRate = hayT = sag = 0;
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
    // not far past it) doesn't jump it again: stepping back stops at the foot of the landing ramp. Likewise one that
    // had made it over track 2's climb (tag 'climb') isn't sent back up it: stepping back stops at its end; one that
    // didn't make it goes back a clear run before the climb and its pads.
    let landed: Jump | null = null;
    for (const J of jumps) if (ahead(J.land, safeS) < ahead(J.land, J.end) + 120) landed = J;
    let over: { s0: number; s1: number } | null = null;
    for (const c of climbs) if (ahead(c.s1, safeS) < 120) over = c;
    let rs = wrapS(safeS - K.respawnBack);
    for (let i = 0; i < 120; i++) {
      if (landed && ahead(landed.lip, rs) < ahead(landed.lip, landed.end) + 2) {
        rs = wrapS(landed.end + 2);
        break;
      }
      if (over && ahead(over.s0, rs) < ahead(over.s0, over.s1) + 2) {
        rs = wrapS(over.s1 + 2);
        break;
      }
      const run = inruns.find((g) => ahead(g.s0, rs) < g.s1 - g.s0);
      if (run) {
        rs = wrapS(run.s0 - 4); // the whole in-run again, from the top
        continue;
      }
      const tg = track.tagAt(rs);
      let ok = frame(rs, fA).up.y > 0.8 && tg !== 'gap' && tg !== 'kicker' && tg !== 'loop' && tg !== 'climb' && tg !== 'bigjump' &&
        tg !== 'booster';
      for (let x = 4; ok && x <= K.respawnClear; x += 4) {
        const tx = track.tagAt(rs + x);
        ok = tx !== 'kicker' && tx !== 'gap' && tx !== 'bigjump' && tx !== 'climb' && (tx !== 'booster' || (narrow && !widePadAt(rs + x)));
      }
      if (ok) break;
      rs = wrapS(rs - 2);
    }
    place(rs);
    const top = K.vtop * P.top;
    v = vPrev = clamp(safeV, K.respawnSpeed * top, top);
    boost = 1; // a second of push (a fresh tank: what was left of the old one doesn't come along)
    stack = 1;
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

  /** Add t s of boost to the tank: kind 0 a booster's push (pads, landings), 1 a magic max's, 2 a mini-turbo's. On top
   *  of a running tank it's a stack (a higher top speed: see stackSpeed). */
  function addBoost(kind: 0 | 1 | 2, t: number) {
    stack = boost + magic + turbo > 0 ? Math.max(1, stack) + 1 : 1;
    if (stack > 1) state.events.stackUp = stack;
    if (kind === 0) boost += t;
    else if (kind === 1) magic += t;
    else turbo += t;
    state.events.boostStart = true;
  }

  /** The drift is over (reward: cash the sparks in as a mini-turbo - the magic max's longer and stronger); the rear
   *  grips up again over driftOut. */
  function endDrift(reward: boolean) {
    if (reward && tier > 0) {
      const b = tier === 4 ? K.boost4 : tier === 3 ? K.boost3 : tier === 2 ? K.boost2 : K.boost1;
      addBoost(tier === 4 ? 1 : 2, b);
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
   *  on, turned the way the track runs), with a gentle turn and no stun or spin-out. A heavier car (heft) bounces and
   *  turns less and takes a harder hit to stun or spin. Leaves the new velocity in oT, oR. */
  function impact(side: number, f: TrackFrame, vT: number, vR: number, yawRel: number) {
    const m = wallOf(f), hay = m === 2;
    const e0 = (m === 0 ? K.railE : m === 1 ? K.tyreE : K.hayE) / P.heft;
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
    const I = K.wallI * P.heft;
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
    accBase.z = clamp(accBase.z - (side * j * c * 3) / P.heft, -60, 60); // the body rocks toward the wall (the rig's roll spring)
    if (un <= K.bounceMin) return; // a touch: it scrapes along
    const ev = state.events;
    ev.wallHit = Math.max(ev.wallHit ?? 0, un);
    if (drifting && un > K.driftHit * P.heft) endDrift(false); // a hit ends a drift (no boost)
    if (hay) {
      hayT = K.hayTime;
      omega = 0; // the bales stop the car turning in (the settle straightens it)
      if (!drifting) slide = 0;
    } else if (th > K.spinAngle * DEG && un > K.spinSpeed * P.heft) {
      // spun out: the nose goes the way the lever arm swings it (head-on: round toward the way the track runs)
      const sg = Math.abs(arm) > 0.3 ? -side * Math.sign(arm) : sn > 0 ? -1 : 1;
      kick = sg * Math.max(K.spinYaw, sg * kick);
      spinT = K.spinTime;
      ev.spinOut = true;
      if (drifting) endDrift(false);
      slide = 0;
    } else if (th > K.stunAngle * DEG && un > K.stunSpeed * P.heft) {
      stunT = Math.max(stunT, K.stunTime);
      if (drifting) endDrift(false);
    }
  }

  /** Leave the surface with the current pose and velocity - exactly what the car brought, nothing added. A drift held
   *  carries on when it lands; one being let go of is over. A hop off a crest only shows as airborne
   *  once it's clear of the surface (airStep). */
  function launch(stall: boolean, crest = false) {
    grounded = false;
    airTime = 0;
    falling = stall;
    hop = crest;
    shown = !crest;
    if (!drifting) slide = 0;
    if (stall) respawnIn = 0.9; // fell off the loop's ceiling
    airP.copy(state.position);
    airV.copy(state.velocity);
    airQ.copy(state.quaternion);
    if (!crest) state.events.airborne = true;
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
    if (airTime > (hop ? K.hopGrade : 0.3)) {
      // graded on the worse of tilt (car up vs track up) and yaw (nose vs flight path)
      const err = Math.max(Math.acos(clamp(up.dot(f.up), -1, 1)), Math.abs(b)) / DEG;
      if (err <= K.perfectDeg) {
        addBoost(0, K.perfectBoost);
        ev.perfectLanding = true;
      } else if (err <= K.okDeg) v *= K.okKeep;
      else {
        v *= K.badKeep;
        omega = -Math.sign(b) * 1.5; // wobble back toward straight
      }
    }
    beta = clamp(b, -K.slipMax * DEG, K.slipMax * DEG);
    if (shown) ev.landed = Math.max(ev.landed ?? 0, -vn); // (a hop that never cleared the surface lands silently)
    grounded = true;
    airTime = 0;
    hop = false;
    shown = true;
    groundT = 0;
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
    if (!shown && (airTime >= K.hopShow || hb > K.hopClear)) {
      shown = true; // a hop clear of the surface: now it's in the air
      state.events.airborne = true;
    }
    const fwd = v2.copy(X).applyQuaternion(airQ);
    const up = v3.copy(Y).applyQuaternion(airQ);
    psi = Math.atan2(fwd.dot(f.right), fwd.dot(f.t));
    if (!falling) {
      // the nose swings into the flight path, offset by the steer (aim the landing), plus what a hit kicked in - but a
      // hop's short flight isn't aimed: the wheel held through it doesn't twist the car (it lands
      // straight and steers on), and only a hop that turns into real air (hopGrade) takes the steer
      const right = v4.crossVectors(fwd, up);
      const toPath = Math.atan2(airV.dot(right), Math.max(Math.abs(airV.dot(fwd)), 1e-3));
      const aim = hop ? smooth(K.hopGrade - 0.4, K.hopGrade, airTime) : 1;
      airYawRate = clamp((toPath + inp.steer * aim * K.airLean * DEG) * K.airVane, -K.airYaw, K.airYaw) + kick;
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
    // Any other crest the surface can't hold the car on throws it - with only hopStick of magnet, on
    // ground that isn't banked into a turn (that holds it), and never on a set piece (noHop: a big jump, a kicker, a
    // loop, the climb, a start drop), which fly, fall or hold exactly as above. Not again within hopRearm of landing.
    groundT += h;
    if (groundT >= K.hopRearm && vt > 0 && Math.abs(f.right.y) < Math.sin(K.hopBank * DEG) &&
      g * f.up.y - vt * vt * crest + K.hopStick * g < 0 && !noHop[Math.round(s / dsF) % noHop.length]) {
      launch(false, true);
      airStep(h, inp);
      return;
    }
    // Up track 2's climb (tag 'climb': up the wall, over the top and a half roll out) too slow: nothing presses the car
    // onto a wall it can't drive up - it peels off and falls, or low on the pull-up rolls back - and it is put back
    // before the run-up (respawn: never inside the climb, a clear run to its pads), so the next go has the speed.
    if (tag0 === 'climb' && vt < K.climbPeel && (f.t.y > 0.17 || f.up.y < 0.5) && respawnIn <= 0) {
      respawnIn = K.climbBack;
      if (f.up.y < 0.5) {
        launch(true); // (put back 0.9 s later)
        airStep(h, inp);
        return;
      }
    }

    // ---- what's under the wheels
    surfaceAt(f, h);

    // ---- knocked about: a hard hit stuns for a moment, a very hard one spins the car out (control fades back in)
    const ctl = lerp(lerp(1, K.stunCtl, clamp(stunT / 0.1, 0, 1)), K.spinCtl, clamp(spinT / 0.15, 0, 1));
    const steer = inp.steer, thr = inp.throttle, brk = inp.brake;
    const av = Math.abs(v);

    // ---- drift: a fresh press of Space (held or not) at speed makes the car loose. It's over once the car has settled
    // straight again (straightT, below: the sparks cash in) - or one that never slid, after looseIdle - or too slow or
    // spun. A press mid-drift keeps it going (reFlick), so tapping for each bend of an S never cancels the slide.
    if (drifting) {
      const ab = Math.abs(beta);
      looseT += h;
      if (ab > K.straightSlip * DEG) slid = true;
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
    const letGo = (h * P.unstick) / K.driftIn;
    if (drifting) slide = Math.min(1, slide + letGo);
    else if (slide > loose) slide = Math.max(loose, slide - h / K.driftOut);
    else slide = Math.min(loose, slide + letGo);
    const sm = slide * slide * (3 - 2 * slide);
    if (slide <= loose) spun = false;
    if (settleT > 0) settleT -= h;

    // ---- grip on the slip: the tyres' (kN), or the loose rear's (kL: looser on the throttle, tighter off it)
    const kN = K.grip * P.grip * sGrip;
    const kL = K.looseGrip * P.slide * sDrift * lerp(K.looseLift, K.looseThrottle, thr);
    let k = kN + (kL - kN) * sm;
    let c = K.scrub + (K.driftScrub - K.scrub) * sm;

    // ---- gravity in the surface plane: along the travel changes speed, across it bends the path (banks hold the car)
    const gT = -g * f.t.y, gR = -g * f.right.y;
    const gAlong = gT * cph + gR * sph;
    const gPerp = -gT * sph + gR * cph;
    const gTurn = v > 0 ? (K.bankAssist * gPerp * v) / (v * v + 25) : 0; // ~ gPerp / v, fading out at a standstill

    // ---- a steep bank (track 2's wall ride) holds the car only as hard as the tyres grip: following the track takes
    // a push across it of v^2 kappa less the bank's pull, and they manage bankGrip x the load (g up.y plus the speed
    // pressing the car into the bank's dip). Short of that - too slow for the wall - the rest slides it sideways down
    // the bank (sag), to its low edge, where the rail catches it; with grip to spare the slide stops. Nothing on a bank
    // under steepBank (all of the meadow) ever runs this.
    const sb = -f.right.y; // the bank's sine (+: the right side is the low one)
    const steep0 = Math.sin(K.steepBank * DEG), steep1 = Math.sin((K.steepBank + 10) * DEG);
    if (sag !== 0 || sb > steep0 || sb < -steep0) {
      const w = smooth(steep0, steep1, Math.abs(sb));
      const need = vt * vt * f.kappa - g * sb; // the push the tyres must give (+ right) to follow the track
      const held = K.bankGrip * P.grip * sGrip * Math.max(0, g * f.up.y - vt * vt * crest);
      const over = (Math.abs(need) - held) * w;
      if (over > 0) sag -= Math.sign(need) * over * h;
      else sag = sag > 0 ? Math.max(0, sag + over * h - (1 - w) * 20 * h) : Math.min(0, sag - over * h + (1 - w) * 20 * h);
    }

    // ---- speed: the throttle pushes along the car's curve up to its top speed on this surface (the surface sets it;
    // the verge drags). Over it the surface's share bleeds off firmly, and over the car's own top speed - a hill's, a
    // boost's - only the air drags it back, gently.
    // (up track 2's climb the tyres push less the steeper it gets, and not at all up the wall or upside down: it's the
    // speed brought to it that carries the car up and over)
    const top = K.vtop * P.top, vtop = top * sCap, drive = tag0 === 'climb' ? clamp(f.up.y, 0, 1) : 1;
    let a = gAlong;
    if (v > -0.5 && v < vtop) {
      const x = Math.max(0, v) / vtop;
      a += drive * thr * K.accel * P.pull * (1 - x ** P.rev) * (1 - P.spool * (1 - smooth(0.1, 0.5, x)));
    }
    if (brk > 0 && v < 0.5) a -= brk * K.accel * 0.5 * Math.max(0, 1 + v / K.reverse); // reverse
    // the tank's push (its strongest part: a booster's, a magic max's, a mini-turbo's), up to the boost's top speed -
    // higher per boost stacked in it, fading back over its last stackFade s
    const push = boost > 0 ? K.boostAccel : magic > 0 ? K.turboAccel * K.turbo4 : turbo > 0 ? K.turboAccel : 0;
    const vb = K.vboost + K.stackSpeed * Math.max(0, stack - 1) * Math.min(1, (boost + magic + turbo) / K.stackFade);
    if (push > 0 && v > -0.5) a += drive * push * Math.max(0, 1 - (v / (vb * sCap)) ** 2);
    let fr = c * Math.abs(Math.sin(beta)) * av; // friction-like: never reverses the motion
    fr += (1 - thr) * (K.coast + K.drag * v * v); // part throttle: a lower top speed
    fr += sDrag * av;
    if (brk > 0 && v > 0.5) fr += K.brake * P.brake * brk;
    if (thr > 0 && v < -0.5) fr += K.brake * P.brake * thr;
    const lim = push > 0 ? Math.max(vb, top) : top, cap = lim * sCap;
    if (av > cap) fr += K.overspeed * Math.min(1, (1 - sCap) / Math.max(K.overFull, 1e-3)) * (Math.min(av, lim) - cap);
    if (av > lim) fr += P.aero * (av - lim) * (K.airLin + K.airDrag * (av + lim));
    v += a * h;
    v = v > 0 ? Math.max(0, v - fr * h) : Math.min(0, v + fr * h);

    // ---- yaw (a hit's kick turns the car on top of this): the steering asks for a yaw rate, and the travel follows the
    // nose on the grip above. Loose, it asks a little more (the car rotates readily) and the nose answers more slowly
    // (the car's weight swinging), while the loose rear lets the travel lag: the slip is whatever that leaves - the
    // tail steps out while the car rotates faster than the travel bends, and comes back in when it doesn't. Past
    // limitSlip the rear bites and holds the nose back (no spin from steering alone; it fades out past 60 deg). The
    // grip coming back, the slip goes by the nose easing back to the travel, which bends no faster than the loose
    // rear let it plus exitSlack (no snap) - unless the car has spun: then nothing helps it round. The most the
    // steering asks falls with speed to yawHigh at vtop, and past it as 1/v: over its top speed the car needs more road.
    const av2 = Math.abs(v);
    const yawV = av2 < K.vtop ? lerp(K.yawLow, K.yawHigh, av2 / K.vtop) : (K.yawHigh * K.vtop) / av2;
    const wGrip = steer * ctl * sYaw * P.turn * (v < 0 ? -1 : 1) * Math.min(av2 / K.yawRamp, yawV);
    let wT = wGrip * (1 + (K.looseYaw - 1) * sm);
    const ab = Math.abs(beta);
    if (sm > 0 && v > 0 && hayT <= 0) {
      wT -= Math.sign(beta) * Math.max(0, ab - K.limitSlip * P.angle * DEG) * (1 - smooth(60 * DEG, 80 * DEG, ab)) * K.limitYaw * sm;
    }
    const b0 = beta; // (the slip before this step: how fast it swings, below)
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
    omega += (wT - omega) * (1 - Math.exp(-h / lerp(K.yawLag * P.steer, K.looseLag * P.float, sm)));
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

    if (sag !== 0) d += sag * h; // (sliding down a steep bank)

    // ---- walls: the half-width the car needs depends on its heading; a corner past the edge's limit is on the wall
    const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
    const dMax = Math.max(0, limitOf(f) - ext);
    if (d > dMax || d < -dMax) {
      const side = d > 0 ? 1 : -1;
      d = side * dMax;
      if (sag * side > 0) sag = 0; // the rail stops the slide
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
      charge += h * P.charge * smooth(K.chargeSlip - 2, K.chargeSlip + 2, Math.abs(beta) / DEG);
      const nt = charge >= K.tier4 ? 4 : charge >= K.tier3 ? 3 : charge >= K.tier2 ? 2 : charge >= K.tier1 ? 1 : 0;
      if (nt > tier) {
        tier = nt as 1 | 2 | 3 | 4;
        ev.tierUp = tier;
      }
    }
    // ---- straight again? Once the slide has settled - the slip small, no longer swinging (a swing through straight
    // into the other side is quick) and the nose not turning for a slide either way (the slip its yaw would hold: a
    // wheel held into the other side turns it there, a quick tap of a key to correct the line hardly does) - for
    // straightTime, the drift is over
    if (drifting) {
      const lim = K.straightSlip * DEG;
      const heading = Math.abs(omega + kick - gTurn) / Math.max(k, 0.5);
      const settled = slide >= 1 && Math.abs(beta) < lim && Math.abs(beta - b0) < K.straightRate * DEG * h && heading < lim;
      straightT = settled ? straightT + h : 0;
    }

    // ---- boosters
    const tag = track.tagAt(s);
    const pad = tag === 'booster' && (!narrow || overPad(s, d));
    if (pad && !onPad && v > 0) {
      v += K.padKick;
      addBoost(0, K.padBoost);
    }
    onPad = pad;

    // ---- remember a safe spot for respawns (not on a launch ramp or in the loop). Put the car back on the track when
    // it's stuck - trying to drive but going nowhere (sooner nose-in on a wall, or upside down in the loop) - or has
    // been driving the wrong way too long: nose first against the lap direction (backing up the right way doesn't
    // count, and clears it, as does turning round)
    const av3 = Math.abs(v);
    if (f.up.y > 0.8 && tag !== 'kicker' && tag !== 'loop' && tag !== 'climb' && Math.abs(psi) < 0.6 && v > 5 && Math.abs(d) < f.width * 0.5 && ctl > 0.99) {
      safeS = s;
      safeV = v;
    }
    const crawl = sb > steep0 || sb < -steep0 ? K.wallCrawl : K.stuckSpeed; // (too slow to climb back up a wall)
    stuck = av3 < crawl && (f.up.y < 0.5 || thr > 0.5 || brk > 0.5) ? stuck + h : 0;
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
      const b = (sBump * K.dirtBump * Math.min(1, av3 / 25)) / P.heft;
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
      state.boostStack = 0;
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
      // the tank burns its strongest part first; empty, the stack is gone
      let burn = h, x = Math.min(boost, burn);
      boost -= x;
      burn -= x;
      x = Math.min(magic, burn);
      magic -= x;
      burn -= x;
      turbo = Math.max(0, turbo - burn);
      if (boost + magic + turbo <= 0) stack = 0;
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
      else spin += ((inp.throttle * K.vtop * P.top * 1.2) / geo.r - spin) * (1 - Math.exp(-h * (inp.throttle > 0 ? 2 : 0.4)));
      steerVis += (inp.steer - steerVis) * (1 - Math.exp(-h * 25));

      const r0 = wrapS(s0 - track.start), r1 = wrapS(s - track.start);
      state.lapDelta = r0 > 0.75 * LEN && r1 < 0.25 * LEN ? 1 : r0 < 0.25 * LEN && r1 > 0.75 * LEN ? -1 : 0;
      state.trackS = s;
      state.speed = grounded ? Math.abs(v) : airV.length();
      state.slip = grounded ? beta : 0;
      state.drifting = drifting;
      state.driftTier = tier;
      state.boosting = boost > 0 || magic > 0 || turbo > 0;
      state.boostStack = stack;
      state.grounded = grounded || !shown; // (a hop skimming the surface still counts as on it)
      state.steerVisual = steerVis;
      state.wheelSpinRate = spin;
      state.wrongWay = wrongT > K.wrongTime;
    },
  };
};
