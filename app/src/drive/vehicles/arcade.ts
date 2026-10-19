import * as THREE from 'three';
import type { CarHit, CarSpec, ContactBody, DriveInput, Track, TrackFrame, Vehicle, VehicleFactory, VehicleState } from '../types';

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
/** Online play: snapshot()'s layout (its first number; bump it whenever the list changes) and length. */
export const SNAP_VERSION = 3, SNAP_LENGTH = 102;
/** ... of which the first CORE_LENGTH are the simulation's own (the rest, the state's outputs, follow from them:
 *  restoreCore works them out again, bit for bit - the server sends a client only these when it corrects its car). */
export const CORE_LENGTH = 77;
const KICK_MAX = 8; // rad/s: the most yaw that hits can stack up

/** Online play: car-to-car hits (net/contact.ts finds the contact and works out the impulse between the two cars'
 *  boxes; carPush / carHit below apply it). Solid toy cars, not pinballs: a nudge moves a car a little and it keeps
 *  control, a hard hit knocks it sideways with a wobble, and only a big T-bone on the rear quarter or a real PIT at
 *  speed spins it out. Offline nothing here ever runs - and it isn't in TUNING. */
export const CAR = {
  e: 0.1, // restitution between two car bodies: a knock, not a bounce (the orange rails' is 0.3) ...
  mu: 0.25, // ... and the friction of one flank sliding along another
  inertia: 2.5, // yaw inertia: x a box's own, m (L^2 + W^2) / 12 (each car's footprint, its mass = its profile's heft) -
  // the tyres resist being turned
  yawMax: 1.5, // rad/s: the most one step's car hits turn a car (a wall hit's kick is capped too: K.wallYaw)
  knockGrip: 36, // u/s^2: a car knocked sideways slides on its tyres, losing the sideways speed this fast (x the surface's
  // grip) - it is never turned into speed along the heading the way the grip turns a slip ...
  knockMax: 12, // ... and pushes build that slide up to this at most (u/s; the tyres take the rest) - a single hard hit
  // knocks it as hard as it is
  spinHit: 14, // a hit behind the car's middle, square on (past the walls' stunAngle), as hard as a wall hit of this
  // (closing speed x the other car's share of the mass: 28 u/s between two of the same heft) knocks the tail out - it
  // spins out (a T-bone on the rear quarter at speed)
  spinRear: 3, // rad/s of yaw pushes on the rear quarter (closing faster than a touch) have kicked in lately (dying away
  // as a wall's kick does: a PIT's push builds it up) - the tail knocked out: it spins out ...
  spinMin: 30, // ... at speed (u/s; slower, the tyres catch it). Resting contact - two cars leaning on each other, door
  // to door or nose to tail - never spins anyone
  ghost: 1, // s: a car put back on the track passes through the others this long
};

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
  respawnLane: 40, // ... (in a split's lane, this much: put back in the middle of the lane, lined up)
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
// Keyed by a word of the car id (or a car's toy number: profileKey). Ordered like the real cars - power to weight,
// era, layout, tyres - squeezed into a field that stays close on a lap (each 3-lap autopilot total within ~7% of the
// next), and fair: each is quickest somewhere else - the race Porsches on the brakes and through the asphalt corners,
// the Skylines pulling out of the corners and drifting, the light cars turning in, the heavy ones through the knocks,
// over the dirt and down the hills. The garage's stats are measured off these (npm run stats: src/garage/stats.ts).
// (The Impala's hydraulic hop into a drift is rig.ts's, on its soft springs.)
// Nissan Skyline GT-R (BNR34, the stock one and Godzilla's): the RB26's twin turbos on ATTESA four-wheel drive - a
// breath of lag, then strong pull and the best traction out of a corner; planted and grippy, heavier than the
// Porsches, harder to throw sideways than the rear-drive ER34s, and the AWD claws through the dirt.
const GTR: Partial<Profile> = {
  top: 1.02, pull: 1.03, rev: 2.7, spool: 0.12, brake: 1.08, grip: 1.08, turn: 1.02, steer: 0.9,
  slide: 1.05, unstick: 0.95, float: 0.95, angle: 0.98, charge: 1.04, aero: 1.05, heft: 1.15, dirt: 1.06,
};
const PROFILES: Record<string, Partial<Profile>> = {
  // Porsche 911 GT3 R "Roxy" (992, 2023): a race car - ~565 hp in ~1250 kg, slicks, a big wing, race brakes. The most
  // grip and braking, the sharpest steering, the highest top speed; hard to get sideways and it slides short and tight,
  // its wing's drag eats a hill's extra speed soonest, and it's light and stiff: hits knock it about, it hates the dirt.
  roxy: {
    top: 1.06, pull: 1.07, rev: 2.6, brake: 1.18, grip: 1.16, turn: 1.06, steer: 0.75,
    unstick: 0.72, float: 0.95, angle: 0.9, charge: 1.06, aero: 1.25, heft: 0.9, dirt: 0.92,
  },
  // Porsche 911 GT3 RS (997.2, 2011): the road-going racer - 450 hp, 1370 kg, 310 km/h; sharp, grippy, brakes hard
  // and revs to the top; a step below the GT3 R on grip and aero, a little easier to get sideways
  gt3: {
    top: 1.05, pull: 1.05, rev: 2.5, brake: 1.14, grip: 1.12, turn: 1.05, steer: 0.8,
    unstick: 0.82, float: 0.95, angle: 0.95, charge: 1.04, aero: 1.15, heft: 0.95, dirt: 0.92,
  },
  fyg14: GTR,
  jhw90: GTR,
  // Nissan LB-ER34 Super Silhouette Skyline (the Liberty Walk widebodies): turbo-six pull - a breath of lag, then the
  // strongest mid-range - on wide rubber in a rear-drive drift machine: the easiest to throw sideways, a big
  // controllable slide that charges quickest; grippy, close on top speed, slammed (no dirt car)
  skyline: {
    top: 1.02, pull: 1.04, rev: 3, spool: 0.2, brake: 1.06, grip: 1.07, turn: 1.03, steer: 0.88,
    unstick: 1.3, float: 0.85, angle: 1.1, charge: 1.06, aero: 1.1, heft: 1.05, dirt: 0.95,
  },
  // Porsche 964 (1989; Magnus Walker's outlaw): an air-cooled 911, ~250-300 hp in 1350 kg - the engine hung out behind
  // the rear axle, so the tail swings readily on a lift and the slide runs long; good brakes, quick steering
  '964': {
    top: 1.01, pull: 1.01, rev: 2.1, brake: 1.06, grip: 1.03, turn: 1.02, steer: 0.85,
    slide: 0.95, unstick: 1.2, float: 0.95, angle: 1.08, aero: 1.05, heft: 0.97, dirt: 1,
  },
  // Splittin' Image (a Hot Wheels original, 2004): a light fantasy racer - twin canopies, a big blown V8 out in the
  // open. Explosive pull and a top speed with the Porsches' - the straight-line car - but a loose, lively tail and
  // just ordinary grip and brakes; light, so hits knock it about, and it's no dirt car
  splittin: {
    top: 1.04, pull: 1.12, rev: 1.9, brake: 0.98, grip: 0.99, turn: 1, steer: 0.9,
    slide: 0.95, unstick: 1.15, float: 0.98, angle: 1.08, aero: 0.95, heft: 0.85, dirt: 0.94,
  },
  // 1993 Ford Mustang Cobra R: a stripped Fox-body with the 5.0 V8 (235 hp, 1450 kg) - strong low-down pull, a willing
  // tail under power, decent race brakes; a touch heavier than the imports
  mustang: {
    top: 1.01, pull: 1.03, rev: 1.9, brake: 1.02, grip: 0.98, turn: 0.99, steer: 1,
    slide: 0.95, unstick: 1.15, float: 1.05, angle: 1.1, aero: 0.95, heft: 1.08, dirt: 1,
  },
  // 1964 Jaguar E-Type (the XK six, ~265 hp claimed, 1250 kg): a long, low GT - quick in its day and slippery: a high
  // top speed it holds on to and carries off a hill, stable and long-legged; but soft, a long nose that turns in
  // lazily, skinny period tyres and brakes; a long, smooth slide
  jaguar: {
    top: 1.01, pull: 0.99, rev: 2.4, brake: 0.92, grip: 0.96, turn: 0.96, steer: 1.1,
    slide: 1, unstick: 0.95, float: 1.08, angle: 1.06, aero: 0.85, heft: 0.97, dirt: 0.95,
  },
  // '99 Honda Civic Type R (EK9): a light front-drive hot hatch - 185 hp in 1050 kg, quick to turn in, grippy and
  // planted, a VTEC four that loves the top of the revs but runs out of top speed; front drive means it's harder to
  // get sideways and the slide stays tidy
  civic: {
    top: 0.97, pull: 0.98, rev: 2.7, brake: 1.06, grip: 1.07, turn: 1.07, steer: 0.78,
    slide: 0.95, unstick: 0.75, float: 0.9, angle: 0.92, charge: 1.04, aero: 1, heft: 0.8, dirt: 1,
  },
  // '77 Pontiac Firebird Trans Am: the 6.6 V8 (200 hp) in 1650 kg - a big shove off the corners that fades up top, a
  // heavy nose, a lazy wheel and a tail that steps out under power - the muscle car slides; soft brakes
  firebird: {
    top: 0.97, pull: 1.02, rev: 1.7, brake: 0.88, grip: 0.93, turn: 0.97, steer: 1.12,
    slide: 0.92, unstick: 1.25, float: 1.15, angle: 1.15, aero: 0.9, heft: 1.25, dirt: 1.04,
  },
  // 1964 Chevy Impala lowrider: big, heavy and soft - a V8's shove fading to a lower top speed, drum brakes, lazy
  // steering, skinny whitewalls: it slides big and floaty - a fun boat. Its weight carries a hill's speed furthest and
  // shrugs off the knocks; its soft hydraulics float it over the dirt.
  impala: {
    top: 0.96, pull: 0.94, rev: 1.8, brake: 0.8, grip: 0.89, turn: 0.96, steer: 1.25,
    slide: 0.9, unstick: 1.1, float: 1.3, angle: 1.18, aero: 0.8, heft: 1.35, dirt: 1.12,
  },
  // 1965 Nissan Silvia (CSP311): a small, light hand-built coupe with a 1.6 four (96 hp, 980 kg) - not much shove and a
  // low top speed, but the quickest to turn in, nimble and easy to place; light, so the knocks throw it about
  silvia: {
    top: 0.94, pull: 0.91, rev: 2.1, brake: 1, grip: 1.03, turn: 1.08, steer: 0.8,
    slide: 1, unstick: 1.08, float: 0.92, angle: 1, charge: 1.04, aero: 1, heft: 0.78, dirt: 1.02,
  },
  // '73 Volvo 142 GL: a boxy sedan with the B20 four (~100 hp) - slow to get going and to turn, soft and roll-y, but a
  // tank: it shrugs off the knocks, carries a hill's speed, and the rally-bred Volvo likes the dirt
  volvo: {
    top: 0.95, pull: 0.92, rev: 2, brake: 0.95, grip: 0.95, turn: 0.97, steer: 1.15,
    slide: 0.95, unstick: 1, float: 1.12, angle: 1.06, charge: 1.02, aero: 0.85, heft: 1.2, dirt: 1.1,
  },
  // Beach Bomb Too (a VW bus with surfboards): tall, soft and slow - an air-cooled flat-4's putter, a floaty lean into
  // every slide, drum brakes, but it shrugs over the dirt and carries a hill's speed (a box on wheels)
  beach: {
    top: 0.93, pull: 0.9, rev: 1.8, brake: 0.8, grip: 0.92, turn: 0.96, steer: 1.25,
    slide: 0.9, unstick: 1.15, float: 1.35, angle: 1.15, charge: 1.04, aero: 0.85, heft: 1.25, dirt: 1.12,
  },
};
/** Which PROFILES entry a car drives on: its id's last word - the toy number, for a car with a profile of its own - if
 *  that has one, else the first word that has one (skyline-..., chevy-impala-..., roxy-porsche-...). Each course's pars
 *  (tracks/course.ts) go by the same key. */
export function profileKey(id: string): string | undefined {
  const w = id.toLowerCase().split('-');
  return [w[w.length - 1], ...w.slice(0, -1)].find((x) => PROFILES[x]);
}
/** The car's profile (STOCK for a car without one). */
export function profileOf(id: string): Profile {
  const k = profileKey(id);
  return k ? { ...STOCK, ...PROFILES[k] } : { ...STOCK };
}

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const B = (x: boolean) => (x ? 1 : 0);
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
    hh: (car.height || 1.2) / 2, // ... and half its height (online: the box that hits other cars stands on the ground)
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
  // online only (another car's hit: carPush): the sideways slide a hit knocked into the car (u/s, + right of its nose),
  // which the tyres scrub off; the yaw pushes on its rear quarter kicked in lately (a PIT's: rad/s, dying away as the
  // kick does); s left passing through the other cars after being put back. Always 0 offline.
  let knock = 0, hitYaw = 0, ghostT = 0;
  // (online, within a step: the knock before this step's car hits and what they have added - carPush caps the build-up;
  // set by step(), read by the contact solver's pushes that follow it: no state of its own between steps)
  let knock0 = 0, knockAdd = 0;

  // A lane split (track.split: track 2's sky bridge, two channels either side of an island): the car's lane (-1 left,
  // +1 right, 0 none) - taken by the side it's on as it reaches the island's point and kept to the far end (laneAt) -
  // whose tags are the car's (tagL) and whose lift off the deck (its own jump) the frames under the car carry (frame).
  // The island's faces are walls like any rail (wallHit); d stays the track's own, across its centre line.
  const SP = track.split;
  let lane = 0, safeLane = 0;
  const lq = { h: 0, th: 0, dth: 0 }, vL = new THREE.Vector3();
  const tagL = (ss: number) => track.tagAt(ss, lane);

  /** The track frame at s, written into `o` (whatever frameAt does with `out`) - in a split, the car's lane's surface
   *  (raised onto its jump, pitched with it). */
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
    if (lane !== 0 && SP!.lift(lane, ss, lq)) {
      const c = Math.cos(lq.th), sn = Math.sin(lq.th);
      o.p.addScaledVector(o.up, lq.h);
      vL.copy(o.t);
      o.t.multiplyScalar(c).addScaledVector(o.up, sn);
      o.up.multiplyScalar(c).addScaledVector(vL, -sn);
      o.kappaN -= lq.dth * c; // (+: a crest)
    }
    return o;
  }

  /** In a split, which lane: the side the car is on as it reaches the island's point; in the air, the other one once it
   *  is over it (past the island); off the split, none. */
  function laneAt() {
    if (!SP) return;
    if (s < SP.s0 || s > SP.s1) lane = 0;
    else if (lane === 0) lane = d < 0 ? -1 : 1;
    else if (!grounded && d * lane < -Math.max(0, SP.island(s))) lane = -lane;
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
      if (ahead(g.s0, ss) < g.s1 - g.s0 && (g.d0 === undefined || (dd >= g.d0 && dd <= (g.d1 ?? g.d0))) && (g.lane === undefined || g.lane === lane)) return true;
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

  /** The slip the state shows (the effects' smoke and squeal, the autopilot): the heading against the travel - and,
   *  knocked sideways by another car (online), against the slide too. */
  const slipOut = () => (knock !== 0 ? beta - Math.atan2(knock, Math.max(Math.abs(v), 1)) : beta);

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
    if (knock !== 0) state.velocity.addScaledVector(f.t, -Math.sin(psi) * knock).addScaledVector(f.right, Math.cos(psi) * knock);
  }

  function place(s0: number) {
    s = wrapS(s0);
    d = psi = beta = omega = v = vPrev = 0;
    grounded = true;
    falling = false;
    respawnIn = airTime = stuck = wrongT = 0;
    lane = 0;
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
    knock = hitYaw = ghostT = knock0 = knockAdd = 0;
    slipLim = K.slipMax * DEG;
    wallAgo = 1;
    onPad = tagL(s) === 'booster';
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
    lane = safeLane; // (a lane's jump is that lane's: stepping back clear of it, and put back in that lane)
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
      const tg = tagL(rs);
      let ok = frame(rs, fA).up.y > 0.8 && tg !== 'gap' && tg !== 'kicker' && tg !== 'loop' && tg !== 'climb' && tg !== 'bigjump' &&
        tg !== 'booster';
      // (in a split's lane - or just before the island, on its side - the car is put back in the middle of it, lined
      // up: a clear run of respawnLane is enough before that lane's kicker)
      const clear = safeLane !== 0 && rs >= SP!.s0 - K.respawnLane && rs <= SP!.s1 ? K.respawnLane : K.respawnClear;
      for (let x = 4; ok && x <= clear; x += 4) {
        const tx = tagL(rs + x);
        ok = tx !== 'kicker' && tx !== 'gap' && tx !== 'bigjump' && tx !== 'climb' && (tx !== 'booster' || (narrow && !widePadAt(rs + x)));
      }
      if (ok) break;
      rs = wrapS(rs - 2);
    }
    place(rs);
    let inLane = false;
    if (SP && safeLane !== 0 && rs > SP.s0 - K.respawnClear && rs < SP.s1) {
      // in a split: in the middle of the lane it was in (never on the island), or on its way to it before the point
      lane = rs >= SP.s0 ? safeLane : 0;
      d = safeLane * Math.min(SP.centre(rs), frame(rs, fM).width / 2 - 2);
      inLane = true;
    }
    const top = K.vtop * P.top;
    v = vPrev = clamp(safeV, K.respawnSpeed * top, top);
    // a second of push (a fresh tank: what was left of the old one doesn't come along) - but not in a split's lane, put
    // back a short run before its jump: there it goes at its own pace (a boost would throw it past the landing)
    boost = inLane ? 0 : 1;
    stack = inLane ? 0 : 1;
    pressT = 0;
    poseGround(fM);
    state.events.respawn = true;
    ghostT = CAR.ghost; // (online: it passes through the other cars for a moment)
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

  /** A wall hit on `side` (impact): an island's face in a split stands at an angle to the track where it opens or closes
   *  (its point's wedge) - the hit is taken square to that face, so a nose-on hit glances off it to one side. */
  function wallHit(side: number, f: TrackFrame, vT: number, vR: number, yawRel: number) {
    if (lane === 0 || side !== -lane) return impact(side, f, vT, vR, yawRel);
    const g = Math.atan(lane * SP!.slope(s)), c = Math.cos(g), sn = Math.sin(g), p0 = psi;
    psi -= g;
    impact(side, f, vT * c + vR * sn, vR * c - vT * sn, yawRel);
    psi = p0;
    const t = oT;
    oT = t * c - oR * sn;
    oR = t * sn + oR * c;
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
    knock = 0; // (a knock's sideways slide flies on in airV)
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
      if (tagL(ss) !== 'gap' && preO.subVectors(preP, f.p).dot(f.up) <= geo.ride) return t;
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
    if (lane !== 0) d = lane < 0 ? Math.min(d, -SP!.island(s) - ext) : Math.max(d, SP!.island(s) + ext);
    poseGround(frame(s, fM));
  }

  function airStep(h: number, inp: DriveInput) {
    airTime += h;
    airV.y -= K.g * h;
    airP.addScaledVector(airV, h);
    let f = project(airP);
    let off = v1.subVectors(airP, f.p);
    d = off.dot(f.right);
    if (SP) {
      const was = lane;
      laneAt();
      if (lane !== was) (f = frame(s, fM)), (off = v1.subVectors(airP, f.p));
    }
    const hb = off.dot(f.up) - geo.ride; // tyres above the surface
    const tag = tagL(s);
    // (in a split, over the island: no surface under the car)
    const deck = lane === 0 || lane * d >= SP!.island(s);
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
      // ... and the island's faces in a split
      if (lane !== 0 && tag !== 'gap' && hb < wallH && hb > -0.6) {
        const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi)), e = SP!.island(s);
        const x = lane * d - (e + ext); // < 0: a corner past the island's face
        if (x < 0 && lane * d > e - 0.4) {
          airP.addScaledVector(f.right, -lane * x);
          d -= lane * x;
          const vN = airV.dot(f.up);
          wallHit(-lane, f, airV.dot(f.t), airV.dot(f.right), airYawRate);
          airV.copy(f.t).multiplyScalar(oT).addScaledVector(f.right, oR).addScaledVector(f.up, vN);
        }
      }
      // touchdown: on a surface (not over a gap), coming down onto it, within the edges (a verge counts)
      if (tag !== 'gap' && hb <= 0 && hb > -0.75 && airTime > 0.05 && airV.dot(f.up) < 0 && Math.abs(d) <= lim && deck) {
        land(f);
        return;
      }
      // missed the track: the ground, under a surface (short of a landing ramp: it would fall through it), or lost
      if (airP.y < floorY || airTime > K.airMax || (tag !== 'gap' && hb <= -0.75 && Math.abs(d) <= lim && deck)) {
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
    const tag0 = tagL(s);
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
    // (a lane's jump: its surface runs longer than the track's s under it, by 1 / cos of its pitch)
    const jac = lane !== 0 && SP!.lift(lane, s, lq) ? 1 / Math.cos(lq.th) : 1;
    const sdot = (v * cph) / Math.max(0.3, 1 - f.kappa * d) / jac;
    s = wrapS(s + sdot * h);
    d += v * sph * h;
    if (knock !== 0) {
      // (online: knocked sideways by another car - it slides across its nose while the tyres scrub that off)
      s = wrapS(s - (Math.sin(psi) * knock * h) / Math.max(0.3, 1 - f.kappa * d) / jac);
      d += Math.cos(psi) * knock * h;
      const kd = CAR.knockGrip * sGrip * h;
      knock = knock > kd ? knock - kd : knock < -kd ? knock + kd : 0;
    }
    const yawRel = omega + kick - f.kappa * sdot; // the car's turn against the track (and its walls)
    psi = wrapA(psi + yawRel * h);
    if (knock !== 0) {
      // (online: the slide keeps its way in the world while the car turns under it - what turns out of across the nose
      // is along it, into the speed: a car spun by a hit slides on the way the hit sent it, not round with its nose)
      const dk = (omega + kick) * h, lon = knock * Math.sin(dk);
      knock *= Math.cos(dk);
      const ph = psi - beta, vT = v * Math.cos(ph) + lon * Math.cos(psi), vR = v * Math.sin(ph) + lon * Math.sin(psi);
      const sp = Math.hypot(vT, vR);
      let bb = sp > 1e-3 ? wrapA(psi - Math.atan2(vR, vT)) : 0, sg = 1;
      if (bb > Math.PI / 2 || bb < -Math.PI / 2) (bb = wrapA(bb + Math.PI)), (sg = -1);
      v = sg * sp;
      beta = bb;
      if (Math.abs(bb) > slipLim) slipLim = Math.abs(bb);
    }
    laneAt();
    f = frame(s, fM);

    if (sag !== 0) d += sag * h; // (sliding down a steep bank)

    // ---- walls: the half-width the car needs depends on its heading; a corner past the edge's limit is on the wall
    const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
    const dMax = Math.max(0, limitOf(f) - ext);
    let hi = dMax, lo = -dMax; // (in a split, the island's face is the lane's inner wall)
    if (lane !== 0) {
      const e = SP!.island(s) + ext;
      if (lane < 0) hi = Math.min(hi, -e);
      else lo = Math.max(lo, e);
    }
    if (d > hi || d < lo) {
      const side = d > hi ? 1 : -1;
      d = side > 0 ? hi : lo;
      if (sag * side > 0) sag = 0; // the rail stops the slide
      const ph = psi - beta;
      let wT = v * Math.cos(ph), wR = v * Math.sin(ph);
      if (knock !== 0) {
        // (online: a knock's sideways slide hits the wall with the rest of the car's speed)
        wT -= Math.sin(psi) * knock;
        wR += Math.cos(psi) * knock;
        knock = 0;
      }
      wallHit(side, f, wT, wR, yawRel);
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
    const tag = tagL(s);
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
      safeLane = lane;
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

  // ---- Online play (net/): the whole simulation state as a flat list of numbers - the closure's variables, the flight
  // and the body-feel vectors, the axle frames' crest (read at the next step's start) and the state's outputs - so a
  // client can rewind its car to the server's state at a step and replay its inputs since (prediction and
  // reconciliation), bit for bit: restore(snapshot()) and the same inputs step on exactly as before. netState() is the
  // short version the other cars travel as (what a car's next steps depend on; net/codec.ts quantizes it), so a client
  // can predict them too; body(), carPush() and carHit() are car-to-car hits (net/contact.ts). Plus where the car is in
  // track space. None of it runs offline: step() is as it was (knock and hitYaw stay 0 there; ghostT, set on a respawn,
  // is only read by the contact).
  const tp = { s: 0, d: 0, psi: 0, beta: 0, v: 0, grounded: true, lane: 0, hl: geo.hl, hw: geo.hw };
  function writeSnap(o: { [i: number]: number }) {
    const st = state;
    let i = 0;
    o[i++] = SNAP_VERSION;
    o[i++] = s, o[i++] = d, o[i++] = psi, o[i++] = beta, o[i++] = v, o[i++] = omega;
    o[i++] = B(grounded), o[i++] = B(falling), o[i++] = respawnIn, o[i++] = airTime, o[i++] = stuck, o[i++] = wrongT;
    o[i++] = B(drifting), o[i++] = dir, o[i++] = charge, o[i++] = tier, o[i++] = pressT, o[i++] = B(held);
    o[i++] = slide, o[i++] = looseT, o[i++] = straightT, o[i++] = B(slid), o[i++] = B(spun), o[i++] = settleT;
    o[i++] = boost, o[i++] = magic, o[i++] = turbo, o[i++] = stack, o[i++] = B(onPad);
    o[i++] = safeS, o[i++] = safeV, o[i++] = vPrev, o[i++] = steerVis, o[i++] = spin, o[i++] = aY;
    o[i++] = kick, o[i++] = stunT, o[i++] = spinT, o[i++] = slipLim, o[i++] = wallAgo, o[i++] = wallSide, o[i++] = airYawRate, o[i++] = hayT;
    o[i++] = sag, o[i++] = oT, o[i++] = oR;
    o[i++] = sGrip, o[i++] = sDrift, o[i++] = sYaw, o[i++] = sCap, o[i++] = sDrag, o[i++] = sBump, o[i++] = sLoose;
    o[i++] = B(hop), o[i++] = B(shown), o[i++] = groundT;
    o[i++] = lane, o[i++] = safeLane, o[i++] = knock, o[i++] = ghostT, o[i++] = hitYaw;
    o[i++] = airP.x, o[i++] = airP.y, o[i++] = airP.z, o[i++] = airV.x, o[i++] = airV.y, o[i++] = airV.z;
    o[i++] = airQ.x, o[i++] = airQ.y, o[i++] = airQ.z, o[i++] = airQ.w;
    o[i++] = accBase.x, o[i++] = accBase.y, o[i++] = accBase.z, o[i++] = fA.kappaN, o[i++] = fB.kappaN;
    o[i++] = st.position.x, o[i++] = st.position.y, o[i++] = st.position.z;
    o[i++] = st.quaternion.x, o[i++] = st.quaternion.y, o[i++] = st.quaternion.z, o[i++] = st.quaternion.w;
    o[i++] = st.velocity.x, o[i++] = st.velocity.y, o[i++] = st.velocity.z, o[i++] = st.accelLocal.x, o[i++] = st.accelLocal.y, o[i++] = st.accelLocal.z;
    o[i++] = st.speed, o[i++] = st.steerVisual, o[i++] = st.wheelSpinRate, o[i++] = st.slip, o[i++] = B(st.drifting), o[i++] = st.driftTier;
    o[i++] = B(st.boosting), o[i++] = st.boostStack, o[i++] = B(st.grounded), o[i++] = st.trackS, o[i++] = st.lapDelta, o[i++] = B(!!st.wrongWay);
    return i;
  }
  function restore(a: ArrayLike<number>) {
    if (a[0] !== SNAP_VERSION || a.length !== SNAP_LENGTH) throw new Error(`arcade: not a snapshot of this model (${a[0]}, ${a.length})`);
    let i = 1;
    s = a[i++], d = a[i++], psi = a[i++], beta = a[i++], v = a[i++], omega = a[i++];
    grounded = a[i++] !== 0, falling = a[i++] !== 0, respawnIn = a[i++], airTime = a[i++], stuck = a[i++], wrongT = a[i++];
    drifting = a[i++] !== 0, dir = a[i++], charge = a[i++], tier = a[i++] as 0 | 1 | 2 | 3 | 4, pressT = a[i++], held = a[i++] !== 0;
    slide = a[i++], looseT = a[i++], straightT = a[i++], slid = a[i++] !== 0, spun = a[i++] !== 0, settleT = a[i++];
    boost = a[i++], magic = a[i++], turbo = a[i++], stack = a[i++], onPad = a[i++] !== 0;
    safeS = a[i++], safeV = a[i++], vPrev = a[i++], steerVis = a[i++], spin = a[i++], aY = a[i++];
    kick = a[i++], stunT = a[i++], spinT = a[i++], slipLim = a[i++], wallAgo = a[i++], wallSide = a[i++], airYawRate = a[i++], hayT = a[i++];
    sag = a[i++], oT = a[i++], oR = a[i++];
    sGrip = a[i++], sDrift = a[i++], sYaw = a[i++], sCap = a[i++], sDrag = a[i++], sBump = a[i++], sLoose = a[i++];
    hop = a[i++] !== 0, shown = a[i++] !== 0, groundT = a[i++];
    lane = a[i++], safeLane = a[i++], knock = a[i++], ghostT = a[i++], hitYaw = a[i++];
    knock0 = knock, knockAdd = 0;
    airP.set(a[i++], a[i++], a[i++]);
    airV.set(a[i++], a[i++], a[i++]);
    airQ.set(a[i++], a[i++], a[i++], a[i++]);
    accBase.set(a[i++], a[i++], a[i++]);
    fA.kappaN = a[i++];
    fB.kappaN = a[i++];
    const st = state;
    st.position.set(a[i++], a[i++], a[i++]);
    st.quaternion.set(a[i++], a[i++], a[i++], a[i++]);
    st.velocity.set(a[i++], a[i++], a[i++]);
    st.accelLocal.set(a[i++], a[i++], a[i++]);
    st.speed = a[i++], st.steerVisual = a[i++], st.wheelSpinRate = a[i++], st.slip = a[i++], st.drifting = a[i++] !== 0;
    st.driftTier = a[i++] as 0 | 1 | 2 | 3 | 4, st.boosting = a[i++] !== 0, st.boostStack = a[i++];
    st.grounded = a[i++] !== 0, st.trackS = a[i++], st.lapDelta = a[i++], st.wrongWay = a[i++] !== 0;
  }

  /** restore() from the core alone (snapshot()[0..CORE_LENGTH)): the outputs worked out again exactly as a step leaves
   *  them (the pose on the ground, the flight's in the air) - all but lapDelta, which only a step knows (0 here). */
  function restoreCore(a: ArrayLike<number>) {
    if (a[0] !== SNAP_VERSION) throw new Error(`arcade: not a snapshot of this model (${a[0]})`);
    let i = 1;
    s = a[i++], d = a[i++], psi = a[i++], beta = a[i++], v = a[i++], omega = a[i++];
    grounded = a[i++] !== 0, falling = a[i++] !== 0, respawnIn = a[i++], airTime = a[i++], stuck = a[i++], wrongT = a[i++];
    drifting = a[i++] !== 0, dir = a[i++], charge = a[i++], tier = a[i++] as 0 | 1 | 2 | 3 | 4, pressT = a[i++], held = a[i++] !== 0;
    slide = a[i++], looseT = a[i++], straightT = a[i++], slid = a[i++] !== 0, spun = a[i++] !== 0, settleT = a[i++];
    boost = a[i++], magic = a[i++], turbo = a[i++], stack = a[i++], onPad = a[i++] !== 0;
    safeS = a[i++], safeV = a[i++], vPrev = a[i++], steerVis = a[i++], spin = a[i++], aY = a[i++];
    kick = a[i++], stunT = a[i++], spinT = a[i++], slipLim = a[i++], wallAgo = a[i++], wallSide = a[i++], airYawRate = a[i++], hayT = a[i++];
    sag = a[i++], oT = a[i++], oR = a[i++];
    sGrip = a[i++], sDrift = a[i++], sYaw = a[i++], sCap = a[i++], sDrag = a[i++], sBump = a[i++], sLoose = a[i++];
    hop = a[i++] !== 0, shown = a[i++] !== 0, groundT = a[i++];
    lane = a[i++], safeLane = a[i++], knock = a[i++], ghostT = a[i++], hitYaw = a[i++];
    knock0 = knock, knockAdd = 0;
    airP.set(a[i++], a[i++], a[i++]);
    airV.set(a[i++], a[i++], a[i++]);
    airQ.set(a[i++], a[i++], a[i++], a[i++]);
    accBase.set(a[i++], a[i++], a[i++]);
    const kA = a[i++], kB = a[i++];
    const st = state;
    if (grounded) {
      poseGround(frame(s, fM));
      st.accelLocal.copy(accBase);
      if (sBump > 0.01) {
        const b = (sBump * K.dirtBump * Math.min(1, Math.abs(v) / 25)) / P.heft;
        st.accelLocal.x += 24 * b * bumps(s + 5.3);
        st.accelLocal.y += 55 * b * bumps(s);
        st.accelLocal.z += 24 * b * bumps(s * 1.3 + 11);
      }
    } else {
      st.position.copy(airP);
      st.quaternion.copy(airQ);
      st.velocity.copy(airV);
      st.accelLocal.copy(accBase);
    }
    fA.kappaN = kA; // (on the ground the pose worked them out the same)
    fB.kappaN = kB;
    st.speed = grounded ? Math.abs(v) : airV.length();
    st.steerVisual = steerVis;
    st.wheelSpinRate = spin;
    st.slip = grounded ? slipOut() : 0;
    st.drifting = drifting;
    st.driftTier = tier;
    st.boosting = boost > 0 || magic > 0 || turbo > 0;
    st.boostStack = stack;
    st.grounded = grounded || !shown;
    st.trackS = s;
    st.lapDelta = 0;
    st.wrongWay = wrongT > K.wrongTime;
  }

  /** The short state another client predicts this car from (NET_LEN numbers in net/codec.ts's order and units; the
   *  input at 8..11 and the race at 68..71 are the caller's to fill). What only matters in the air is 0 on the ground,
   *  and timers past the last value anything compares them with are clamped, so an idle field never changes. */
  function netState(o: Float64Array) {
    o[0] = s, o[1] = d, o[2] = psi, o[3] = beta, o[4] = v, o[5] = omega, o[6] = kick, o[7] = knock;
    o[12] = steerVis, o[13] = accBase.x, o[14] = accBase.y, o[15] = accBase.z;
    o[16] = sGrip, o[17] = sDrift, o[18] = sYaw, o[19] = sCap, o[20] = sDrag, o[21] = sBump, o[22] = sLoose, o[23] = lane;
    let off = s - safeS;
    if (off > LEN / 2) off -= LEN;
    else if (off < -LEN / 2) off += LEN;
    o[24] = off, o[25] = v - safeV, o[26] = safeLane, o[27] = respawnIn, o[28] = stuck, o[29] = wrongT, o[30] = ghostT;
    o[31] = (grounded ? 1 : 0) | (falling ? 2 : 0) | (hop ? 4 : 0) | (shown ? 8 : 0) | (held ? 16 : 0) | (onPad ? 32 : 0);
    o[32] = B(drifting), o[33] = dir, o[34] = charge, o[35] = tier, o[36] = pressT, o[37] = slide, o[38] = looseT, o[39] = straightT;
    o[40] = B(slid), o[41] = B(spun), o[42] = settleT, o[43] = boost, o[44] = magic, o[45] = turbo, o[46] = stack, o[47] = grounded ? 0 : spin;
    o[48] = stunT, o[49] = spinT, o[50] = hayT, o[51] = slipLim, o[52] = Math.min(wallAgo, 1.5), o[53] = wallSide, o[54] = sag;
    o[55] = Math.min(groundT, 1);
    if (grounded) o.fill(0, 56, 68);
    else {
      o[56] = Math.min(airTime, K.airMax), o[57] = airP.x, o[58] = airP.y, o[59] = airP.z, o[60] = airV.x, o[61] = airV.y, o[62] = airV.z;
      o[63] = airYawRate, o[64] = airQ.x, o[65] = airQ.y, o[66] = airQ.z, o[67] = airQ.w;
    }
    o[71] = hitYaw;
  }
  /** Back from netState() (quantized): the car as another client predicts it - the pose and outputs worked out again. */
  function restoreNet(a: ArrayLike<number>) {
    s = wrapS(a[0]), d = a[1], psi = a[2], beta = a[3], v = a[4], omega = a[5], kick = a[6], knock = a[7];
    knock0 = knock, knockAdd = 0;
    steerVis = a[12];
    accBase.set(a[13], a[14], a[15]);
    sGrip = a[16], sDrift = a[17], sYaw = a[18], sCap = a[19], sDrag = a[20], sBump = a[21], sLoose = a[22], lane = a[23];
    safeS = wrapS(s - a[24]), safeV = v - a[25], safeLane = a[26], respawnIn = a[27], stuck = a[28], wrongT = a[29], ghostT = a[30];
    const fl = a[31];
    grounded = (fl & 1) !== 0, falling = (fl & 2) !== 0, hop = (fl & 4) !== 0, shown = (fl & 8) !== 0, held = (fl & 16) !== 0, onPad = (fl & 32) !== 0;
    drifting = a[32] !== 0, dir = a[33], charge = a[34], tier = a[35] as 0 | 1 | 2 | 3 | 4, pressT = a[36], slide = a[37], looseT = a[38], straightT = a[39];
    slid = a[40] !== 0, spun = a[41] !== 0, settleT = a[42], boost = a[43], magic = a[44], turbo = a[45], stack = a[46];
    stunT = a[48], spinT = a[49], hayT = a[50], slipLim = a[51], wallAgo = a[52], wallSide = a[53], sag = a[54], groundT = a[55];
    hitYaw = a[71];
    vPrev = v, aY = 0, oT = oR = 0;
    const st = state;
    if (grounded) {
      airTime = 0;
      spin = (v * Math.cos(beta)) / geo.r;
      poseGround(frame(s, fM));
    } else {
      airTime = a[56];
      airP.set(a[57], a[58], a[59]);
      airV.set(a[60], a[61], a[62]);
      airYawRate = a[63];
      airQ.set(a[64], a[65], a[66], a[67]).normalize();
      spin = a[47];
      st.position.copy(airP);
      st.quaternion.copy(airQ);
      st.velocity.copy(airV);
    }
    st.accelLocal.copy(accBase);
    st.speed = grounded ? Math.abs(v) : airV.length();
    st.slip = grounded ? slipOut() : 0;
    st.drifting = drifting;
    st.driftTier = tier;
    st.boosting = boost > 0 || magic > 0 || turbo > 0;
    st.boostStack = stack;
    st.grounded = grounded || !shown;
    st.steerVisual = steerVis;
    st.wheelSpinRate = spin;
    st.trackS = s;
    st.lapDelta = 0;
    st.wrongWay = wrongT > K.wrongTime;
  }

  // ---- Car-to-car hits. The box another car hits: the body's footprint (the walls' box) standing on the ground, its
  // height the model's; its mass the profile's heft and its yaw inertia a box's (CAR.inertia x m (L^2 + W^2) / 12).
  const bd: ContactBody = {
    c: new THREE.Vector3(), f: new THREE.Vector3(), u: new THREE.Vector3(), r: new THREE.Vector3(), v: new THREE.Vector3(), w: 0,
    hl: geo.hl, hw: geo.hw, hh: geo.hh, m: P.heft, I: (P.heft * (geo.length * geo.length + geo.width * geo.width)) / 12, s: 0, lane: 0,
    air: false, ghost: false, wn: new THREE.Vector3(),
  };
  // (a corner within PIN u of its rail is pressed against it - and held by it less and less out to PIN + PIN_FADE u:
  // smooth, so a car predicted a hair off the rail isn't pushed in a different way)
  const fW = newFrame(), PIN = 0.05, PIN_FADE = 0.25;
  const contact = { at: new THREE.Vector3(), normal: new THREE.Vector3() };
  (state as VehicleState).contact = contact;
  function body(): ContactBody {
    const q = state.quaternion;
    bd.f.set(1, 0, 0).applyQuaternion(q);
    bd.u.set(0, 1, 0).applyQuaternion(q);
    bd.r.set(0, 0, 1).applyQuaternion(q);
    bd.c.copy(state.position).addScaledVector(bd.u, geo.hh);
    bd.v.copy(state.velocity);
    bd.w = grounded ? omega + kick : airYawRate; // (+ right; in the air the kick is in airYawRate)
    bd.I = (P.heft * (geo.length * geo.length + geo.width * geo.width) * CAR.inertia) / 12;
    bd.s = s;
    bd.lane = lane;
    bd.air = !grounded;
    bd.ghost = ghostT > 0 || respawnIn > 0 || falling;
    // pressed against a rail (or a split's island): the rail's outward normal, as long as how firmly it holds the car
    // (1 on it, fading to 0 a little off it) - another car can't push it further in
    bd.wn.set(0, 0, 0);
    if (grounded) {
      const f = frame(s, fW);
      const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
      const dMax = Math.max(0, limitOf(f) - ext);
      let hi = dMax, lo = -dMax;
      if (lane !== 0) {
        const e = SP!.island(s) + ext;
        if (lane < 0) hi = Math.min(hi, -e);
        else lo = Math.max(lo, e);
      }
      const gR = hi - d, gL = d - lo;
      if (gR < gL && gR < PIN + PIN_FADE) bd.wn.copy(f.right).multiplyScalar(1 - smooth(PIN, PIN + PIN_FADE, gR));
      else if (gL <= gR && gL < PIN + PIN_FADE) bd.wn.copy(f.right).multiplyScalar(smooth(PIN, PIN + PIN_FADE, gL) - 1);
    }
    return bd;
  }
  /** Another car's push, applied at once (the contact solver's iterations see it): the velocity changed by dv (world),
   *  the yaw rate by dw (+ right), moved by dp (world). On the ground a push along the nose goes into the speed (the
   *  wheels roll), a push across it into the knock - a sideways slide the tyres scrub off - and the yaw into the kick
   *  (as a wall's); the car stays between the walls (pinned on one, not through it). In the air it all goes into the
   *  flight. */
  function carPush(dvx: number, dvy: number, dvz: number, dw: number, dpx: number, dpy: number, dpz: number) {
    kick = clamp(kick + dw, -KICK_MAX, KICK_MAX);
    if (!grounded) {
      airV.x += dvx, airV.y += dvy, airV.z += dvz;
      airP.x += dpx, airP.y += dpy, airP.z += dpz;
      airYawRate += dw;
      state.position.copy(airP);
      state.velocity.copy(airV);
      return;
    }
    let f = frame(s, fM);
    const dT = dvx * f.t.x + dvy * f.t.y + dvz * f.t.z, dR = dvx * f.right.x + dvy * f.right.y + dvz * f.right.z;
    const c = Math.cos(psi), sn = Math.sin(psi);
    const lon = dT * c + dR * sn; // along the nose
    // across it: pushes build the slide up to CAR.knockMax at most (beyond what one step's hits gave it, or had left)
    knockAdd += -dT * sn + dR * c;
    const kMax = Math.max(CAR.knockMax, Math.abs(knock0), Math.abs(knockAdd));
    knock = clamp(knock0 + knockAdd, -kMax, kMax);
    if (lon !== 0) {
      const ph = psi - beta, vT = v * Math.cos(ph) + lon * c, vR = v * Math.sin(ph) + lon * sn, sp = Math.hypot(vT, vR);
      let bb = sp > 1e-3 ? wrapA(psi - Math.atan2(vR, vT)) : 0, sg = 1;
      if (bb > Math.PI / 2 || bb < -Math.PI / 2) (bb = wrapA(bb + Math.PI)), (sg = -1);
      v = sg * sp;
      beta = bb;
      if (Math.abs(bb) > slipLim) slipLim = Math.abs(bb);
    }
    if (dpx !== 0 || dpy !== 0 || dpz !== 0) {
      const pT = dpx * f.t.x + dpy * f.t.y + dpz * f.t.z, pR = dpx * f.right.x + dpy * f.right.y + dpz * f.right.z;
      const jac = lane !== 0 && SP!.lift(lane, s, lq) ? 1 / Math.cos(lq.th) : 1;
      s = wrapS(s + pT / Math.max(0.3, 1 - f.kappa * d) / jac);
      d += pR;
      f = frame(s, fM);
      const ext = geo.hl * Math.abs(Math.sin(psi)) + geo.hw * Math.abs(Math.cos(psi));
      const dMax = Math.max(0, limitOf(f) - ext);
      let hi = dMax, lo = -dMax;
      if (lane !== 0) {
        const e = SP!.island(s) + ext;
        if (lane < 0) hi = Math.min(hi, -e);
        else lo = Math.max(lo, e);
      }
      if (d > hi) d = hi;
      else if (d < lo) d = lo;
      state.trackS = s;
    }
    poseGround(f);
  }
  /** What a step's car hits did to this car (after the contact solver's iterations; `h`: the hardest contact and the
   *  sum of the pushes). As a wall hit: the hit's speed and angle (closing speed x the other car's share of the mass:
   *  the wall it was as good as) end a drift, stun and spin out by the walls' own thresholds. Two more spin it out: a
   *  hit behind the car's middle, square on and past CAR.spinHit (a T-bone on the rear quarter at speed), and a PIT -
   *  pushes on the rear quarter that closed faster than a touch, whose yaw has built up past CAR.spinRear while the car
   *  goes faster than CAR.spinMin. Nudges, scrapes and two cars leaning on each other never spin anyone (the tyres
   *  catch it). Then the events the effects read. */
  function carHit(h: CarHit) {
    const ev = state.events;
    contact.at.set(h.px, h.py, h.pz);
    contact.normal.set(h.nx, h.ny, h.nz);
    if (h.vn > K.bounceMin) ev.carHit = Math.max(ev.carHit ?? 0, h.vn);
    if (h.slide > 4) ev.carScrape = Math.max(ev.carScrape ?? 0, h.slide);
    // the body rocks with the push (the rig's springs)
    const q = state.quaternion;
    const fx = v1.set(1, 0, 0).applyQuaternion(q), rx = v2.set(0, 0, 1).applyQuaternion(q);
    const lon = h.dvx * fx.x + h.dvy * fx.y + h.dvz * fx.z, lat = h.dvx * rx.x + h.dvy * rx.y + h.dvz * rx.z;
    accBase.x = clamp(accBase.x + (lon * 3) / P.heft, -60, 60);
    accBase.z = clamp(accBase.z + (lat * 3) / P.heft, -60, 60);
    if (drifting && h.unq > K.driftHit) endDrift(false); // a hit ends a drift (no boost)
    const sp = grounded ? Math.hypot(v, knock) : airV.length();
    hitYaw += h.dwr;
    const pit = Math.abs(hitYaw) > CAR.spinRear && hitYaw * h.dwr > 0 && sp > CAR.spinMin;
    const tbone = h.xc < -0.3 * geo.hl && h.th > K.stunAngle * DEG && h.unq > CAR.spinHit;
    if (spinT <= 0 && (pit || tbone || (h.th > K.spinAngle * DEG && h.unq > K.spinSpeed))) {
      const yaw = pit ? hitYaw : h.dw;
      const sg = yaw > 0 ? 1 : yaw < 0 ? -1 : Math.sin(psi) > 0 ? -1 : 1;
      kick = sg * Math.max(K.spinYaw, sg * kick);
      if (!grounded) airYawRate += kick - airYawRate;
      spinT = K.spinTime;
      hitYaw = 0;
      ev.spinOut = true;
      if (drifting) endDrift(false);
      slide = 0;
    } else if (h.th > K.stunAngle * DEG && h.unq > K.stunSpeed) {
      stunT = Math.max(stunT, K.stunTime);
      if (drifting) endDrift(false);
    }
  }

  return {
    state,
    tuning: TUNING,
    snapshot: () => {
      const a = new Array<number>(SNAP_LENGTH);
      writeSnap(a);
      return a;
    },
    snapshotInto: (o: Float64Array) => void writeSnap(o),
    restore,
    restoreCore,
    netState,
    restoreNet,
    body,
    carPush,
    carHit,
    trackPose() {
      tp.s = s, tp.d = d, tp.psi = psi, tp.beta = beta, tp.v = v, tp.grounded = grounded, tp.lane = lane;
      return tp;
    },
    reset(s0: number, d0?: number) {
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
      if (d0) {
        // (online: a start grid slot across the line)
        d = d0;
        poseGround(frame(s, fM));
        surfaceAt(fM, 0);
      }
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
      if (ghostT > 0) ghostT -= h;
      if (hitYaw !== 0) hitYaw *= Math.exp(-h / K.wallYawTime);
      wallAgo += h;
      if (!grounded) {
        accBase.multiplyScalar(Math.exp(-10 * h)); // weightless
        state.accelLocal.copy(accBase);
      }

      // wheels: rolling speed plus a little wheelspin off the line; in the air they rev with the throttle
      if (grounded) spin = (v * Math.cos(beta)) / geo.r + inp.throttle * Math.max(0, 1 - Math.abs(v) / 12) * 30;
      else spin += ((inp.throttle * K.vtop * P.top * 1.2) / geo.r - spin) * (1 - Math.exp(-h * (inp.throttle > 0 ? 2 : 0.4)));
      steerVis += (inp.steer - steerVis) * (1 - Math.exp(-h * 25));
      knock0 = knock;
      knockAdd = 0;

      const r0 = wrapS(s0 - track.start), r1 = wrapS(s - track.start);
      state.lapDelta = r0 > 0.75 * LEN && r1 < 0.25 * LEN ? 1 : r0 < 0.25 * LEN && r1 > 0.75 * LEN ? -1 : 0;
      state.trackS = s;
      state.speed = grounded ? Math.abs(v) : airV.length();
      state.slip = grounded ? slipOut() : 0;
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
