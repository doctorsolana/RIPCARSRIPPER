import type * as THREE from 'three';

// Contracts shared by the drive page's modules (see the build spec). Units: the car is 4 u long,
// model frame nose +x, up +y, right side +z, ground y = 0. Fixed simulation step H = 1/120 s.

export interface DriveInput {
  steer: number; // -1 (left) .. 1 (right), already slewed and curved
  throttle: number; // 0..1
  brake: number; // 0..1 (brake / reverse)
  drift: boolean; // the drift button is down (a press counts for at least 150 ms: input.ts); a fresh press is what acts
}

export interface WheelSpec { name: string; centre: [number, number, number]; r: number }

export interface CarSpec {
  id: string;
  length: number;
  width: number;
  height: number;
  wheels: WheelSpec[]; // from model.json (hub centres in the model frame)
  meta: Record<string, unknown>; // meta.json (make, model, year, rarity, ...)
}

/** What the car drives on: the orange Hot Wheels plastic, an asphalt road or a loose dirt track. */
export type Surface = 'plastic' | 'asphalt' | 'dirt';
/** What stops the car at the side: the orange track's rails, a solid barrier (tyre wall / hay bales) at the surface's
 *  edge, or a grass verge of `shoulder` u beyond the edge (drivable but slow) ending in a soft barrier. */
export type Edge = 'rail' | 'barrier' | 'grass';

/** One sample of the track every 0.5 u. Vectors are unit length; `right` = cross(t, up) points to the car's right. */
export interface TrackFrame {
  s: number; // distance along the centre line
  p: THREE.Vector3; // centre line point on the driving surface
  t: THREE.Vector3; // tangent (driving direction)
  up: THREE.Vector3; // surface normal (authored, banked; loops point inward)
  right: THREE.Vector3;
  kappa: number; // signed curvature in the surface plane (1/u), + = turning right
  kappaN: number; // curvature in the vertical (normal) plane, + = crest (surface falls away)
  width: number; // width of the driving surface (between the rails on plastic)
  surface: Surface;
  edge: Edge;
  shoulder: number; // grass verge beyond each side of the surface (edge 'grass'), 0 otherwise; hard limit = width/2 + shoulder
}

// bigjump: launch ramp lip -> end of its landing ramp; inrun: a big jump's in-run (the descent that builds its speed,
// to the lip): a respawn never lands inside one; climb: track 2's climb up the wall, over the top and the half roll out
// (the speed brought to it carries the car; too slow, it falls off and is put back before its pads)
export type TrackTag = 'gate' | 'drop' | 'booster' | 'kicker' | 'gap' | 'loop' | 'helix' | 'finish' | 'bigjump' | 'inrun' | 'climb';

/** How the page dresses a course (its tracks/<course>.ts sets it; a track without one gets the meadow's): `world`
 *  picks world-outdoor.ts's style (STYLES), `hoop` - a hoop over the big jump's flight, which the camera's jump shot
 *  holds back for - and `wide` - plastic wider than the channel, with connectors (the audio's joint ticks) across it. */
export interface TrackLook { world: 'meadow' | 'sky'; hoop: boolean; wide: boolean }

export interface Track {
  readonly length: number; // closed lap length (s wraps)
  readonly frames: TrackFrame[]; // every 0.5 u
  readonly object: THREE.Object3D; // the track's meshes (channel, tabs, boosters)
  readonly collider: { positions: Float32Array; indices: Uint32Array }; // channel surface + rails (for a physics engine)
  // tagged ranges along s; a booster with d0..d1 (lateral, + right) is a narrow pad: only a car over it boosts (none:
  // the pad spans the track); one with a `lane` belongs to that lane of a split (track.split) alone
  readonly tags: { tag: TrackTag; s0: number; s1: number; d0?: number; d1?: number; lane?: -1 | 1 }[];
  readonly start: number; // s of the start line (in the gate)
  frameAt(s: number, out?: TrackFrame): TrackFrame; // interpolated frame at s (wraps)
  nearest(p: THREE.Vector3, hintS: number, window?: number): { s: number; frame: TrackFrame; offset: THREE.Vector3 }; // search near hintS
  /** The tag at s (the shortest span there). A lane's own tags (`lane`) count only when asked for that lane. */
  tagAt(s: number, lane?: number): TrackTag | null;
  /** Where the track splits into two lanes side by side round an island (track 2's sky bridge); none on the meadow. */
  readonly split?: TrackSplit;
  readonly look?: TrackLook; // how the world, camera and audio dress this course (none: the meadow's)
}

/** A lane split (tracks/split.ts): over s0..s1 the track (its full width) is two lanes, left (-1) and right (+1),
 *  either side of an island - a gap between two separate channels, whose inner rails are walls - that opens from a
 *  point (`nose`) and closes to one (`tail`). Lateral offsets stay the track's own (d across the centre line); each
 *  lane can rise off the deck on its own (its jump: `lift`), and tags with a `lane` are that lane's. */
export interface TrackSplit {
  readonly s0: number; // a car is in one lane or the other from s0 (just before the nose) to s1 (just past the tail)
  readonly s1: number;
  readonly nose: number; // s of the island's points
  readonly tail: number;
  /** The island's half-width at s (its rails' faces stand at +-island): < 0 just before the nose and after the tail
   *  (where its point is still ahead, or behind: the wedge's line carried on), -Infinity off the split. */
  island(s: number): number;
  /** d island / ds at s. */
  slope(s: number): number;
  /** |d| of a lane's line at s: the middle of its own width off the island (a catch tray widens it outward). */
  centre(s: number): number;
  /** The lane's rise off the deck at s (h u, pitch th, dth/ds); false where it lies flat on the deck. */
  lift(lane: number, s: number, out: { h: number; th: number; dth: number }): boolean;
}

export interface VehicleEvents {
  wallHit?: number; // impact speed into the wall (u/s)
  landed?: number; // vertical speed at touchdown (u/s)
  perfectLanding?: boolean;
  boostStart?: boolean;
  stackUp?: number; // a boost added onto one still running: the tank's stack is now this (x2, x3 ...: a higher top speed)
  tierUp?: 1 | 2 | 3 | 4; // drift spark tier reached (4: the hidden 'magic max', about twice tier 3's drift time)
  airborne?: boolean;
  respawn?: boolean;
  spinOut?: boolean; // a very hard wall hit spun the car out this step (camera kick, tyre screech); optional: without it
  // fx/audio/camera spot a spin-out from the pose (nose > 60 deg off the travel at speed)
}

export interface VehicleState {
  position: THREE.Vector3; // world position of the car's model origin
  quaternion: THREE.Quaternion; // world orientation of the car's model frame
  velocity: THREE.Vector3; // world u/s
  speed: number; // |velocity|
  steerVisual: number; // -1..1 front wheel steer for the rig
  wheelSpinRate: number; // rad/s wheel rotation (rolling + wheelspin)
  slip: number; // rad, signed: heading minus direction of travel
  drifting: boolean;
  driftTier: 0 | 1 | 2 | 3 | 4; // 4 is the hidden max tier
  boosting: boolean;
  boostStack: number; // boosts stacked in the running tank: 0 none, 1 a lone boost, 2+ stacked (each a higher top speed)
  grounded: boolean;
  accelLocal: THREE.Vector3; // car-frame acceleration (x forward, y up, z right) for body pitch/roll springs
  trackS: number; // distance along the track, wraps at track.length
  lapDelta: number; // +1 when the car crossed the start line forward this step, -1 backward, else 0
  events: VehicleEvents; // filled during step(); the loop clears it after fx/audio/camera read it
  wrongWay?: boolean; // driving against the lap direction for a while (HUD warning)
}

export interface Vehicle {
  readonly state: VehicleState;
  readonly tuning: Record<string, number>; // live-tunable numbers (?tune=1 sliders)
  reset(s0: number): void; // place at rest on the track at s0
  step(h: number, input: DriveInput): void; // advance one fixed step
  dispose?(): void;
}

export type VehicleFactory = (track: Track, car: CarSpec) => Promise<Vehicle>;
