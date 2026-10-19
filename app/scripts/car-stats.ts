// `npm run stats` (node scripts/car-stats.ts): every drivable car's stats, measured in the game's own sim - the arcade
// model (src/drive/vehicles/arcade.ts, each car's PROFILES entry on the shared K numbers) driven headless - and written
// to src/garage/stats.ts for the garage page. What the garage shows is what the car drives like. Re-run it after any
// change to PROFILES, K or a car's model.json; it also prints each car's autopilot laps on every course and the medal
// pace rows for tracks/<course>.ts `pars` (3 x the lap's length / the 3-lap total).
//
// The tests, on a flat, wide, straight test strip (no walls in reach) unless a course is named:
//   top speed  the throttle's top on the orange plastic (vtop x the profile's top), in the HUD's km/h (x 4.3)
//   0-100      seconds from rest to 100 km/h on the HUD, full throttle, on plastic
//   braking    distance from 100 km/h to rest, full brake
//   handling   time to turn the travel through 90 deg at full lock, holding 25 u/s and 38 u/s (summed): grip, turn and
//              the steering's lag in one number
//   drift      the mean slip angle over 1.5 s after a tap of drift at 32 u/s, full lock and throttle: how readily the
//              tail lets go and how far it swings
//   off-road   on dirt: time from rest over 150 u, plus the 90 deg turn at 25 u/s
//   weight     the profile's heft (what hits do to the car)
//   laps       the autopilot's 3 laps on each course (s), as the pars are measured
// The bars run 0..1 across the cars (the best 1, the worst BAR_MIN), so they show the order; the numbers are the sim's.
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import * as THREE from 'three';
import { create, profileKey, profileOf, TUNING } from '../src/drive/vehicles/arcade.ts';
import { createAutopilot } from '../src/drive/input.ts';
import { buildTrack, COURSES } from '../src/drive/tracks/index.ts';
import type { CarSpec, Surface, Track, TrackFrame } from '../src/drive/types.ts';

const APP = new URL('..', import.meta.url).pathname;
const CARS = `${APP}../asset-generation/assets/cars/`;
const OUT = `${APP}src/garage/stats.ts`;
const H = 1 / 120;
const KMH = 4.3; // u/s -> the HUD's km/h (drive/main.ts)
const M_PER_U = KMH / 3.6; // ... so a u is this many metres
const V100 = 100 / KMH;
const BAR_MIN = 0.22;

function carSpec(id: string): CarSpec {
  const info = JSON.parse(readFileSync(`${CARS}${id}/model.json`, 'utf8'));
  const meta = JSON.parse(readFileSync(`${CARS}${id}/meta.json`, 'utf8'));
  return { id, length: info.dimensions.length, width: info.dimensions.width, height: info.dimensions.height, wheels: info.wheels, meta };
}
const drivable = readdirSync(CARS).filter((id) => existsSync(`${CARS}${id}/model.json`) && existsSync(`${CARS}${id}/meta.json`)).sort();

/** A straight, flat strip along +x of one surface, 400 u wide (nothing to hit), 20 000 u round. */
function strip(surface: Surface): Track {
  const L = 20000, ds = 0.5, W = 400;
  const mk = (s: number, o?: TrackFrame): TrackFrame => {
    const f = o ?? ({ p: new THREE.Vector3(), t: new THREE.Vector3(), up: new THREE.Vector3(), right: new THREE.Vector3() } as TrackFrame);
    const x = ((s % L) + L) % L;
    f.s = x;
    f.p.set(x, 0, 0);
    f.t.set(1, 0, 0);
    f.up.set(0, 1, 0);
    f.right.set(0, 0, 1);
    f.kappa = 0;
    f.kappaN = 0;
    f.width = W;
    f.surface = surface;
    f.edge = 'barrier';
    f.shoulder = 0;
    return f;
  };
  const frames: TrackFrame[] = [];
  for (let s = 0; s < L; s += ds) frames.push(mk(s));
  return {
    length: L, frames, object: new THREE.Object3D(), collider: { positions: new Float32Array(0), indices: new Uint32Array(0) }, tags: [], start: 0,
    frameAt: (s, out) => mk(s, out),
    nearest: (p) => ({ s: p.x, frame: mk(p.x), offset: new THREE.Vector3() }),
    tagAt: () => null,
  };
}
const PLASTIC = strip('plastic'), DIRT = strip('dirt');

type Inp = { steer: number; throttle: number; brake: number; drift: boolean };
async function car(id: string, track: Track) {
  const veh = await create(track, carSpec(id));
  veh.reset(100);
  const st = veh.state;
  const step = (i: Inp) => {
    veh.step(H, i);
    for (const k of Object.keys(st.events)) (st.events as Record<string, unknown>)[k] = undefined;
  };
  return { veh, st, step };
}
const hold = (v: number, V: number) => (v < V ? 1 : 0);
const travel = (st: { velocity: THREE.Vector3 }) => Math.atan2(st.velocity.z, st.velocity.x);

/** Seconds from rest to `v` on full throttle (and the distance it took, u). */
async function sprint(id: string, track: Track, v: number) {
  const { st, step } = await car(id, track);
  let t = 0, x = 0;
  while (st.speed < v && t < 30) step({ steer: 0, throttle: 1, brake: 0, drift: false }), (t += H), (x += st.speed * H);
  return { t, x };
}
async function distance(id: string, track: Track, d: number) {
  const { st, step } = await car(id, track);
  let t = 0, x = 0;
  while (x < d && t < 30) step({ steer: 0, throttle: 1, brake: 0, drift: false }), (t += H), (x += st.speed * H);
  return t;
}
async function braking(id: string) {
  const { st, step } = await car(id, PLASTIC);
  for (let t = 0; st.speed < V100 && t < 30; t += H) step({ steer: 0, throttle: 1, brake: 0, drift: false });
  let x = 0;
  for (let t = 0; st.speed > 0.05 && t < 30; t += H) step({ steer: 0, throttle: 0, brake: 1, drift: false }), (x += st.speed * H);
  return x;
}
/** Seconds to turn the travel through 90 deg at full lock from a straight run at V u/s (holding V). */
async function turn90(id: string, track: Track, V: number) {
  const { st, step } = await car(id, track);
  for (let t = 0; t < 30 && st.speed < V; t += H) step({ steer: 0, throttle: 1, brake: 0, drift: false });
  for (let t = 0; t < 0.5; t += H) step({ steer: 0, throttle: hold(st.speed, V), brake: 0, drift: false });
  const h0 = travel(st);
  let t = 0;
  while (t < 10) {
    step({ steer: 1, throttle: hold(st.speed, V), brake: 0, drift: false });
    t += H;
    if (Math.abs(Math.atan2(Math.sin(travel(st) - h0), Math.cos(travel(st) - h0))) >= Math.PI / 2) break;
  }
  return t;
}
/** A drift at 32 u/s: a tap of drift at full lock and throttle - the mean |slip| (deg) over the next 1.5 s, held at
 *  full lock (how readily the tail lets go and how far it swings) - and, again, held through a long bend (steering to
 *  keep the slide near 25 deg, never spun): how soon the sparks reach tier 2 (s). */
async function drift(id: string) {
  const deg = (st: { slip: number }) => Math.abs(st.slip) * (180 / Math.PI);
  let a = await car(id, PLASTIC);
  for (let t = 0; t < 30 && a.st.speed < 32; t += H) a.step({ steer: 0, throttle: 1, brake: 0, drift: false });
  let sum = 0, n = 0;
  for (; n < 180; n++) a.step({ steer: 1, throttle: 1, brake: 0, drift: n === 0 }), (sum += deg(a.st));
  a = await car(id, PLASTIC);
  for (let t = 0; t < 30 && a.st.speed < 32; t += H) a.step({ steer: 0, throttle: 1, brake: 0, drift: false });
  let t2 = 6;
  for (let t = 0, i = 0; t < 6; t += H, i++) {
    a.step({ steer: i < 30 ? 1 : deg(a.st) > 25 ? 0.15 : 1, throttle: 1, brake: 0, drift: i === 0 });
    if (a.st.driftTier >= 2) {
      t2 = t;
      break;
    }
  }
  return { slip: sum / n, tier2: t2 };
}
/** The autopilot's 3 laps on a course (s), as the identity checks and the pars measure them. */
async function laps(id: string, track: Track) {
  const veh = await create(track, carSpec(id));
  const st = veh.state, ap = createAutopilot(), L = track.length;
  veh.reset(track.start);
  let n = 0, far = false, t0 = 0, t = 0;
  const times: number[] = [];
  for (; t < 600 && n < 3; t += H) {
    veh.step(H, ap(st, track));
    const r = (((st.trackS - track.start) % L) + L) % L;
    if (r > L * 0.5 && r < L * 0.9) far = true;
    if (st.lapDelta > 0 && far) (far = false), n++, times.push(t - t0), (t0 = t);
    for (const k of Object.keys(st.events)) (st.events as Record<string, unknown>)[k] = undefined;
  }
  return times.reduce((a, b) => a + b, 0);
}

const courses = COURSES.map((c) => ({ id: c.id, track: buildTrack(c.id) }));
interface Raw { top: number; zero100: number; brake: number; handling: number; drift: number; slip: number; tier2: number; offroad: number; heft: number; laps: Record<string, number> }
const raw: Record<string, Raw> = {};
for (const id of drivable) {
  const P = profileOf(id);
  raw[id] = {
    top: TUNING.vtop * P.top * KMH,
    zero100: (await sprint(id, PLASTIC, V100)).t,
    brake: (await braking(id)) * M_PER_U,
    handling: (await turn90(id, PLASTIC, 25)) + (await turn90(id, PLASTIC, 38)),
    drift: 0,
    ...(await drift(id)),
    // dirt against the same on plastic: how much of itself it keeps off the road
    offroad: ((await distance(id, DIRT, 150)) + (await turn90(id, DIRT, 25))) / ((await distance(id, PLASTIC, 150)) + (await turn90(id, PLASTIC, 25))),
    heft: P.heft,
    laps: {},
  };
  for (const c of courses) raw[id].laps[c.id] = await laps(id, c.track);
}
// the drift: the slide's size and the sparks' pace, each against the cars' mean, weighed alike
const mean = (k: 'slip' | 'tier2') => drivable.reduce((a, id) => a + raw[id][k], 0) / drivable.length;
const mSlip = mean('slip'), mTier = mean('tier2');
for (const id of drivable) raw[id].drift = raw[id].slip / mSlip + mTier / raw[id].tier2;

/** 0..1 across the cars: the best (higher, or lower with `low`) 1, the worst BAR_MIN. */
function bars(key: keyof Omit<Raw, 'laps'>, low = false) {
  const xs = drivable.map((id) => raw[id][key]), lo = Math.min(...xs), hi = Math.max(...xs);
  const out: Record<string, number> = {};
  for (const id of drivable) {
    const f = hi > lo ? (raw[id][key] - lo) / (hi - lo) : 1;
    out[id] = +(BAR_MIN + (1 - BAR_MIN) * (low ? 1 - f : f)).toFixed(3);
  }
  return out;
}
const B = {
  top: bars('top'), accel: bars('zero100', true), brake: bars('brake', true), handling: bars('handling', true), drift: bars('drift'),
  offroad: bars('offroad', true), weight: bars('heft'),
};
const r2 = (x: number, d = 2) => +x.toFixed(d);
const stats = Object.fromEntries(drivable.map((id) => {
  const r = raw[id];
  return [id, {
    topKmh: Math.round(r.top), zero100: r2(r.zero100), brakeM: r2(r.brake, 1),
    laps: Object.fromEntries(Object.entries(r.laps).map(([k, v]) => [k, r2(v, 3)])),
    bars: Object.fromEntries(Object.entries(B).map(([k, b]) => [k, b[id]])),
  }];
}));

writeFileSync(OUT, `// Generated by scripts/car-stats.ts (npm run stats) from the sim itself - don't edit by hand: re-run it after changing
// a car's PROFILES entry (src/drive/vehicles/arcade.ts), the shared K numbers or a car's model.json.
// topKmh: the throttle's top speed (HUD km/h); zero100: s to 100 km/h; brakeM: 100 to 0 in m (the HUD's scale); laps:
// the autopilot's 3 laps per course (s); bars: 0..1 across the cars, the best 1 (accel: the quickest 0-100; brake: the
// shortest stop; handling: the quickest 90 deg turns; drift: the widest slide; offroad: the quickest on dirt; weight:
// the heaviest).

export interface CarStats {
  topKmh: number;
  zero100: number;
  brakeM: number;
  laps: Record<string, number>;
  bars: { top: number; accel: number; brake: number; handling: number; drift: number; offroad: number; weight: number };
}

export const STATS: Record<string, CarStats> = ${JSON.stringify(stats, null, 2)};
`);

// the report
const pad = (s: string | number, n: number) => String(s).padStart(n);
console.log(`${'car'.padEnd(24)}${pad('km/h', 6)}${pad('0-100', 7)}${pad('brk m', 7)}${pad('hand s', 8)}${pad('slip', 6)}${pad('tier2', 7)}${pad('dirt x', 8)}${pad('heft', 6)}${courses.map((c) => pad(c.id, 9)).join('')}`);
for (const id of drivable) {
  const r = raw[id];
  console.log(`${id.padEnd(24)}${pad(r.top.toFixed(0), 6)}${pad(r.zero100.toFixed(2), 7)}${pad(r.brake.toFixed(1), 7)}${pad(r.handling.toFixed(2), 8)}${pad(r.slip.toFixed(1), 6)}${pad(r.tier2.toFixed(2), 7)}${pad(r.offroad.toFixed(3), 8)}${pad(r.heft.toFixed(2), 6)}${courses.map((c) => pad(r.laps[c.id].toFixed(3), 9)).join('')}`);
}
for (const c of courses) {
  const ts = drivable.map((id) => raw[id].laps[c.id]);
  console.log(`${c.id}: ${Math.min(...ts).toFixed(1)}-${Math.max(...ts).toFixed(1)} s (spread ${(((Math.max(...ts) / Math.min(...ts)) - 1) * 100).toFixed(1)}%)`);
}
// the medal pace per profile key (the first car on each key), as tracks/<course>.ts `pars` has it
for (const c of courses) {
  const row: Record<string, number> = {};
  for (const id of drivable) {
    const key = profileKey(id) ?? '*';
    if (row[key] === undefined) row[key] = +((3 * c.track.length) / raw[id].laps[c.id]).toFixed(2);
  }
  console.log(`${c.id} pars: ${JSON.stringify(row)}`);
}
console.log(`wrote ${OUT.replace(APP, '')}`);
