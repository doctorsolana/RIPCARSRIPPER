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

export type TrackTag = 'gate' | 'drop' | 'booster' | 'kicker' | 'gap' | 'loop' | 'helix' | 'finish' | 'bigjump'; // bigjump: launch ramp lip -> end of its landing ramp

export interface Track {
  readonly length: number; // closed lap length (s wraps)
  readonly frames: TrackFrame[]; // every 0.5 u
  readonly object: THREE.Object3D; // the track's meshes (channel, tabs, boosters)
  readonly collider: { positions: Float32Array; indices: Uint32Array }; // channel surface + rails (for a physics engine)
  readonly tags: { tag: TrackTag; s0: number; s1: number }[]; // tagged ranges along s
  readonly start: number; // s of the start line (in the gate)
  frameAt(s: number, out?: TrackFrame): TrackFrame; // interpolated frame at s (wraps)
  nearest(p: THREE.Vector3, hintS: number, window?: number): { s: number; frame: TrackFrame; offset: THREE.Vector3 }; // search near hintS
  tagAt(s: number): TrackTag | null;
}

export interface VehicleEvents {
  wallHit?: number; // impact speed into the wall (u/s)
  landed?: number; // vertical speed at touchdown (u/s)
  perfectLanding?: boolean;
  boostStart?: boolean;
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
