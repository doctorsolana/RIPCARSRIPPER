import { readFileSync } from 'node:fs';
import * as THREE from 'three';
import { createAutopilot } from '../src/drive/input.ts';
import { ContactSolver } from '../src/drive/net/contact.ts';
import { carSpecOf, gridSlots, lapStep, newLap, progressOf, type LapState } from '../src/drive/net/race.ts';
import { dequantize, hashSnap, quantizeInto, type QInput, type ResultRow } from '../src/drive/net/protocol.ts';
import { buildTrack, isCourse, type CourseId } from '../src/drive/tracks/index.ts';
import type { DriveInput, Track, TrackFrame, TrafficCar, TrafficView, Vehicle } from '../src/drive/types.ts';
import { create, SNAP_LENGTH } from '../src/drive/vehicles/arcade.ts';

// The authoritative race simulation, with no network in it: the server's rooms (room.ts), the replay script
// (replay.ts) and the bench (bench.ts) all drive this. The same code the drive page runs - vehicles/arcade.ts on a
// tracks/ course - for every car, one fixed 1/120 s step at a time: every car's input (a player's from its buffer, a
// bot's from the autopilot racing in traffic - src/drive/input.ts createAutopilot's `traffic`: it sees the race as it
// stands at the step's start), then every car's step, then car-to-car contact (net/contact.ts: real impacts between the
// cars' boxes - mass, spin, stuns), then laps. Nothing allocated per step.
// It is a pure function of (course, laps, cars and their slots, the start step, each car's applied input per step):
// that's what a race log stores, so a race can be re-simulated exactly - every collision included.
// Each car also keeps whether it touched another car during its lap, or in the CARRY s before the lap began (a push
// over the line carries its speed into the next lap): the leaderboard counts only laps with neither (server/store.ts).
// Read only - it changes nothing in the race.

const H = 1 / 120;
export const CARS_DIR = new URL('../../asset-generation/assets/cars/', import.meta.url).pathname;
/** s: car-to-car contact this long before a lap began still marks the lap (its speed came from the push). */
export const CARRY = 3;
const CARRY_STEPS = Math.round(CARRY / H);

const specCache = new Map<string, ReturnType<typeof carSpecOf>>();
/** A car's spec from its model.json / meta.json (as the page's rig builds it); null if the car isn't there. */
export function loadSpec(id: string) {
  if (!/^[a-z0-9-]{1,64}$/.test(id)) return null;
  if (!specCache.has(id)) {
    try {
      const info = JSON.parse(readFileSync(`${CARS_DIR}${id}/model.json`, 'utf8'));
      let meta: Record<string, unknown> | null = null;
      try {
        meta = JSON.parse(readFileSync(`${CARS_DIR}${id}/meta.json`, 'utf8'));
      } catch {
        // no meta: the stock look
      }
      specCache.set(id, carSpecOf(id, info, meta));
    } catch {
      return null;
    }
  }
  return specCache.get(id)!;
}
export const carName = (id: string) => {
  const m = loadSpec(id)?.meta as { make?: string; model?: string } | undefined;
  return [m?.make, m?.model].filter(Boolean).join(' ') || id;
};

const trackCache = new Map<CourseId, Track>();
export function trackOf(course: string): Track {
  const id: CourseId = isCourse(course) ? course : 'meadow';
  if (!trackCache.has(id)) trackCache.set(id, buildTrack(id));
  return trackCache.get(id)!;
}

export interface SimCar {
  key: number; // the player's id
  car: string;
  slot: number;
  veh: Vehicle;
  lap: LapState;
  /** The input applied at the last step (repeated when the next one hasn't arrived). Written in place. */
  last: QInput;
  inp: DriveInput; // scratch
  /** A server-side bot: the autopilot drives it (its inputs go through the same quantize as a client's), into last. */
  bot?: (veh: Vehicle, out: QInput) => void;
  out: boolean; // left mid-race (stays where it is, no longer stepped)
  /** The car as the bots see it (filled at the start of each step). */
  tc: TrafficCar;
  /** Car-to-car contact, for the leaderboard: the last step this car's box met another's, whether it has since the
   *  current lap began, and whether it had in the CARRY s before that (both read by onLap, then set for the next lap). */
  touchK: number;
  lapTouch: boolean;
  preTouch: boolean;
}

/** Car i passes through the others at step k: it has finished (from the step after its finish on). The page's
 *  prediction uses the same rule (net/world.ts). */
export const ghostAt = (finish: number, k: number) => finish >= 0 && finish <= k;

export class RaceSim {
  readonly track: Track;
  readonly cars: SimCar[] = [];
  readonly solver: ContactSolver;
  go = -1; // the start step of the race (cars step from it)
  readonly course: string;
  readonly laps: number;
  // per step scratch: the live cars in slot order, their vehicles, who passes through
  private live: SimCar[] = [];
  private vehs: Vehicle[] = [];
  private skip = new Uint8Array(16);
  private snap = new Float64Array(SNAP_LENGTH);
  /** Every car as the bots see it, in the cars' order (each bot's view holds this array: kept in place). */
  private tcs: TrafficCar[] = [];
  private fr: TrackFrame = {
    s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), right: new THREE.Vector3(0, 0, 1),
    kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
  };
  constructor(course: string, laps: number) {
    this.course = isCourse(course) ? course : 'meadow';
    this.track = trackOf(this.course);
    this.laps = laps;
    this.solver = new ContactSolver(this.track);
  }
  /** Contact counts since the room opened (stats, the race log). */
  get contact() {
    return this.solver.stats;
  }

  grid(n = Math.max(8, this.cars.length)) {
    return gridSlots(this.track, n);
  }

  async addCar(key: number, car: string, slot: number, bot = false): Promise<SimCar> {
    const spec = loadSpec(car) ?? loadSpec('skyline-hck01')!;
    const veh = await create(this.track, spec);
    const c: SimCar = {
      key, car: spec.id, slot, veh, lap: newLap(0), last: [0, 0, 0, 0], inp: { steer: 0, throttle: 0, brake: 0, drift: false }, out: false,
      tc: { s: 0, d: 0, vs: 0, vd: 0, hl: 0, hw: 0, lane: 0, gone: true }, touchK: -1e9, lapTouch: false, preTouch: false,
    };
    if (bot) {
      // (the autopilot in traffic: it sees every car of the race as it stands at the step's start)
      const view: TrafficView = { me: c.tc, cars: this.tcs };
      const ap = createAutopilot({ traffic: () => view });
      c.bot = (v, out) => void quantizeInto(ap(v.state, this.track), out, out);
    }
    this.cars.push(c);
    this.cars.sort((a, b) => a.slot - b.slot);
    this.syncTraffic();
    this.place(c);
    return c;
  }
  remove(key: number) {
    const i = this.cars.findIndex((c) => c.key === key);
    if (i >= 0) this.cars.splice(i, 1);
    this.syncTraffic();
  }
  private syncTraffic() {
    this.tcs.length = 0;
    for (const c of this.cars) this.tcs.push(c.tc);
  }
  /** Car c as the bots see it at step k: where it is in track space, its speed along and across the track. */
  private see(c: SimCar, k: number) {
    const tc = c.tc, v = c.veh, tp = v.trackPose!();
    const f = this.track.frameAt(tp.s, this.fr), vel = v.state.velocity;
    tc.s = tp.s, tc.d = tp.d, tc.hl = tp.hl, tc.hw = tp.hw, tc.lane = tp.lane;
    tc.vs = vel.x * f.t.x + vel.y * f.t.y + vel.z * f.t.z;
    tc.vd = vel.x * f.right.x + vel.y * f.right.y + vel.z * f.right.z;
    tc.gone = c.out || ghostAt(c.lap.finish, k) || v.body!().ghost;
  }
  /** On its grid slot, at rest. */
  place(c: SimCar) {
    const g = this.grid(Math.max(8, c.slot + 1))[c.slot];
    c.veh.reset(g.s, g.d);
    c.lap = newLap(this.go);
    c.last[0] = c.last[1] = c.last[2] = c.last[3] = 0;
    c.touchK = -1e9;
    c.lapTouch = c.preTouch = false;
    for (const k of Object.keys(c.veh.state.events)) (c.veh.state.events as Record<string, unknown>)[k] = undefined;
  }
  /** Line everyone up for a race starting at step `go`. */
  start(go: number) {
    this.go = go;
    for (const c of this.cars) (c.out = false), this.place(c);
  }

  /** Step k (k >= go): every car's input for k (`inputOf` writes the player's into `out` and says so, or leaves it: the
   *  last one repeats; a bot's from the autopilot, every car where it stands now), then every car on its input,
   *  car-to-car contact, laps. Calls back on a lap or a finish (the car's lapTouch / preTouch are that lap's). */
  step(k: number, inputOf: (c: SimCar, out: QInput) => boolean, onLap?: (c: SimCar, what: 'lap' | 'finish') => void) {
    const live = this.live, vehs = this.vehs;
    let n = 0, bots = false;
    for (const c of this.cars) {
      if (c.out) continue;
      live[n] = c;
      vehs[n] = c.veh;
      n++;
      if (c.bot) bots = true;
    }
    live.length = vehs.length = n;
    if (this.skip.length < n) this.skip = new Uint8Array(n * 2);
    if (bots) {
      for (const c of this.cars) {
        if (c.out) c.tc.gone = true;
        else this.see(c, k);
      }
    }
    for (let i = 0; i < n; i++) {
      const c = live[i];
      this.skip[i] = ghostAt(c.lap.finish, k) ? 1 : 0;
      if (c.bot) c.bot(c.veh, c.last);
      else inputOf(c, c.last);
    }
    for (let i = 0; i < n; i++) live[i].veh.step(H, dequantize(live[i].last, live[i].inp));
    this.solver.solve(vehs, n, this.skip, H);
    for (let i = 0; i < n; i++) {
      const c = live[i];
      if (this.solver.touchedLast(i)) (c.touchK = k), (c.lapTouch = true);
      const what = c.lap.finish < 0 ? lapStep(c.lap, c.veh.state, this.track, k, this.laps) : (lapStep(c.lap, c.veh.state, this.track, k, Infinity), null);
      if (what && onLap) onLap(c, what);
      if (c.lap.lapStart === k + 1) {
        // a lap just began (at tick k + 1): clean so far, unless the car touched another in the last CARRY s
        c.preTouch = k + 1 - c.touchK <= CARRY_STEPS;
        c.lapTouch = false;
      }
      const e = c.veh.state.events as Record<string, unknown>;
      for (const x in e) e[x] = undefined;
    }
  }

  progress(c: SimCar) {
    return progressOf(c.lap, c.veh.state, this.track);
  }
  /** Finishing order: finishers by their step, then the rest by how far they got. */
  standings(): SimCar[] {
    return [...this.cars].sort((a, b) => {
      const fa = a.lap.finish >= 0, fb = b.lap.finish >= 0;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return a.lap.finish - b.lap.finish || a.slot - b.slot;
      return this.progress(b) - this.progress(a) || a.slot - b.slot;
    });
  }
  results(name: (c: SimCar) => string): ResultRow[] {
    return this.standings().map((c, i) => ({
      id: c.key, name: name(c), car: c.car, pos: i + 1,
      total: c.lap.finish >= 0 ? c.lap.finish - this.go : null,
      laps: c.lap.lapTimes.slice(0, this.laps),
      best: c.lap.lapTimes.length ? Math.min(...c.lap.lapTimes.slice(0, this.laps)) : null,
    }));
  }
  /** A car's full state hashed (the client's prediction check), with nothing allocated. */
  hashCar(c: SimCar) {
    c.veh.snapshotInto!(this.snap);
    return hashSnap(this.snap);
  }
  /** A hash of every car's full state (slot order): a replay must end on the same one. */
  hash() {
    let h = 0;
    for (const c of this.cars) h = (Math.imul(h ^ this.hashCar(c), 2654435761) >>> 0);
    return h.toString(16).padStart(8, '0');
  }
}
