import * as THREE from 'three';
import type { CarSpec, DriveInput, Track, TrackFrame, VehicleState } from './types';

// Every sound is generated in code (no files):
//   engine   built from its firing, per car (setCar; a neutral six until then - ENGINES below): one four-stroke cycle
//            of exhaust pulses (one per cylinder at its firing angle, each its own size - the banks, the runners) as a
//            periodic wave at the cycle rate, rpm / 120 Hz, so its harmonic `cyl` is the firing frequency (rpm / 60 x
//            cyl / 2) and the uneven ones are the lump. Two of them in step, the throttle's sharp, even pulses and the
//            overrun's soft, uneven ones, crossfaded by the load. No two cycles alike: a few cents of random timing,
//            the pulses' sizes wobbling at about half the firing rate, and combustion noise let through on each
//            pulse. Then the exhaust: three resonances (body, mid, a rasp that grows with load), a lowpass the
//            throttle opens (a lift closes it: the burble), a gentle saturation, a highpass. Revs from the wheels
//            through the car's gearbox (its gears, shift points and shift: a turbo's lift, an automatic's slur, a
//            sequential's cut), a clutch / converter slipping at a standstill, free in the air; a turbo's whistle
//            and blow-off, overrun pops (a race car's crackle, a V8's burble), auto-blips on the downshifts
//   rolling  by what the tyres are on, crossfaded over ~0.2 s, silent in the air, and all of it dark - next to
//            nothing above ~2 kHz (broadband hiss under a car reads as a TV off its channel, not as tyres):
//            plastic  brown noise lowpassed at 200 + 18 v Hz (the hollow toy-track hum)
//            asphalt  a warm tyre roar: a loop of pink noise with rougher patches and soft low knocks in it (the
//                     road's grain), scrolling past faster with speed, through 90 Hz .. 260 + 8 v Hz with a lift at the
//                     tyre's cavity resonance (230 Hz); it builds all the way to top speed (~11 dB under the engine at
//                     35 u/s on the throttle)
//            dirt     a low rumble bumping along (a loop of brown noise with irregular swells, lowpassed at 220 + 6 v Hz)
//                     and sparse soft crunches: rounded 300-850 Hz grains at random moments, ~0.8 v a second (more
//                     in a slide), each at its own pitch and weight
//            verge    a low rumble wobbling over the bumps, and a soft swish of grass (a ~0.8 kHz band, in waves)
//   joints   THE Hot Wheels sound, on the plastic only: a round plastic 'tock' (~1.4 kHz over a hollow ~0.56 kHz,
//            three pitches, every hit a little different) per axle each time trackS crosses a multiple of 17 u where
//            the 8 u channel has a connector, front then rear a wheelbase later; the rhythm is a speedometer, in the
//            background
//   squeal   band-passed noise x smoothstep(4 deg, 20 deg, |slip|) on plastic and asphalt; a slide on dirt or
//            grass is a heavier crunch / rumble instead
//   scrape   a corner held on a wall while the car runs along it: noise through two resonances set by the
//            wall (a plastic grind, a rubber rub, a straw rustle), chattering at 31 Hz, louder with speed
//   wind     in the air: a rush of noise (a wide band rising with speed, buffeting) over a low roar of air, and a thin
//            whistle on top, all building with time aloft and speed - a hop barely breathes, the big jump howls
//   one-shots tier 'ting' (higher per tier; the hidden tier 4 a glittering run onto a shimmering chord), boost whump (sine 60 -> 30 Hz + whoosh), landing thud (with the
//            plastic's tick, a tyre chirp on asphalt, a spit of gravel on dirt, a swish on grass), wall impact
//            by material (plastic clack, tyre-wall thump, hay thud with a straw rustle; a very hard hit adds a
//            low crunch and a boom), spin-out screech (a resonant noise sweep falling an octave), perfect-landing chime
//   big jump off a 'bigjump' lip: the launch roar (the car's own engine flaring flat out - revs up, wide open, twice
//            as loud for a second - over a sub whump and a rising whoosh, the lip's plastic clack); the landing
//            slam after a long flight (a deep boom with the plastic rattling, bigger and lower the longer the air);
//            a perfect one adds a third, higher chime. Any lift-off at speed is a soft whoosh
// Surfaces and walls come from the track frame under the car (setTrack); without a track everything is the
// orange plastic. Master compressor + gain. The context is created and resumed on the first gesture (unlock(),
// or the listeners installed here), suspended while the tab is hidden.

export interface DriveAudio {
  unlock(): void;
  update(state: VehicleState, input: DriveInput, dt: number): void;
  setMuted(m: boolean): void;
  /** The track, so the tyres sound like what they roll on and the walls like what they're made of (call once). */
  setTrack(track: Track): void;
  /** The car, so the engine is its own (call once, after loading it; a neutral six until then). */
  setCar(car: CarSpec): void;
}

const JOINT = 17; // u between track connectors (track.ts's tabEvery) ...
const CHANNEL = 8; // ... which sit where the plastic is its plain 8 u channel (not the funnels out to a road)
const WHEELBASE = 2.3; // u between the axles (all three cars are 2.26-2.39)
const HALF_L = 2, HALF_W = 0.8, TYRE_Y = 0.62; // u: the cars' footprint (~4 x 1.5-1.65) and their tyres off the centre
const TING = [0, 1318.5, 1661.2, 1975.5]; // E6, G#6, B6 for spark tiers 1-3
const TAU = Math.PI * 2;
const DEG = Math.PI / 180;
const BLEND = 0.07; // s: time constant of a surface change (~0.2 s to settle)
// The rolling beds' levels at 45 u/s (the asphalt's roar, the dirt's rumble and its crunches, the verge's swish), and the
// joints' tock against the landing's tick.
const ROAD = 0.23, DIRT = 0.15, CRUNCH = 0.36, SWISH = 0.25, TOCK = 0.31;
// What a wall is made of (as fx.ts), and the scrape's two resonances on each: [f1, Q1, f2, Q2, level].
const RAIL = 0, TYRE = 1, HAY = 2, SOFT = 3;
// Levels even out the bands' widths (a narrow band passes less noise): all four ~0.065 RMS at the master.
const SCRAPE = [
  [1500, 5, 3300, 7, 3.6], // plastic rail: a squeaky grind
  [420, 3, 900, 4, 5], // tyre wall: a rubbery rub
  [700, 0.8, 1500, 0.9, 0.45], // hay: a muffled brush of straw (low and soft - a bright hiss here grated)
  [800, 0.8, 1700, 0.9, 0.45], // the verge's soft limit: a brush of grass
];

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Render a mono buffer from a sample function (deterministic noise), normalised to `peak`. */
function render(ctx: BaseAudioContext, dur: number, fn: (t: number, rnd: () => number) => number, peak = 0.9, seed = 0x2f6b) {
  const sr = ctx.sampleRate, n = Math.ceil(dur * sr);
  const buf = ctx.createBuffer(1, n, sr), d = buf.getChannelData(0);
  const rnd = () => (seed = (Math.imul(seed, 1664525) + 1013904223) | 0) / 2147483648;
  let m = 0;
  for (let i = 0; i < n; i++) {
    d[i] = fn(i / sr, rnd);
    m = Math.max(m, Math.abs(d[i]));
  }
  const fade = Math.min(n, Math.ceil(0.002 * sr)); // no click at the cut
  for (let i = 0; i < n; i++) d[i] *= (peak / (m || 1)) * Math.min(1, (n - i) / fade);
  return buf;
}

/** A mono buffer of the samples (at sr, the context's rate by default), normalised to `peak`. */
function toBuffer(ctx: BaseAudioContext, d: Float32Array, peak = 0.9, sr = ctx.sampleRate) {
  let m = 0;
  for (let i = 0; i < d.length; i++) m = Math.max(m, Math.abs(d[i]));
  const buf = ctx.createBuffer(1, d.length, sr), o = buf.getChannelData(0);
  for (let i = 0; i < d.length; i++) o[i] = (d[i] * peak) / (m || 1);
  return buf;
}

/** Filtered noise that loops seamlessly: the filter (`step`, with memory) first runs over the end of the same white
 *  noise (20000 samples, far longer than any pole here remembers), so the start carries on from the end. */
function lapNoise(n: number, rnd: () => number, step: (x: number) => number) {
  const w = new Float32Array(n), d = new Float32Array(n);
  for (let i = 0; i < n; i++) w[i] = rnd() * 2 - 1;
  for (let i = n - Math.min(n, 20000); i < n; i++) step(w[i]);
  for (let i = 0; i < n; i++) d[i] = step(w[i]);
  return d;
}

/** Adds `count` swells (parabolic bumps), len0..len1 s long and up to h high, at random places on env (wrapping round). */
function swells(env: Float32Array, sr: number, rnd: () => number, count: number, len0: number, len1: number, h: number) {
  const n = env.length;
  for (let k = 0; k < count; k++) {
    const at = Math.floor(rnd() * n), len = Math.ceil((len0 + (len1 - len0) * rnd()) * sr), a = 4 * h * rnd();
    for (let i = 0; i < len; i++) env[(at + i) % n] += a * (i / len) * (1 - i / len);
  }
}

/** The rate the rolling loops are made at: all they hold is under ~1.5 kHz, and the filters after them take away what
 *  the resampling adds (22.05 kHz is as low as older Safari makes a buffer). */
const loopRate = (ctx: BaseAudioContext) => Math.min(ctx.sampleRate, 22050);

/** A seamless loop of asphalt under a tyre (dur s at playback rate 1): pink noise (Kellet's filter), the level swelling
 *  a little over patches of rougher road (~10 a second), and soft low knocks in it (~90 a second at 250-800 Hz, a 1 ms
 *  rounded rise, a few ms long) - the road's grain, which the playback rate scrolls past with the speed. */
function roadLoop(ctx: BaseAudioContext, dur: number) {
  const sr = loopRate(ctx), n = Math.ceil(dur * sr);
  let seed = 0x51ab;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
  let b0 = 0, b1 = 0, b2 = 0, b3 = 0, b4 = 0, b5 = 0, b6 = 0;
  const d = lapNoise(n, rnd, (x) => {
    b0 = 0.99886 * b0 + x * 0.0555179;
    b1 = 0.99332 * b1 + x * 0.0750759;
    b2 = 0.969 * b2 + x * 0.153852;
    b3 = 0.8665 * b3 + x * 0.3104856;
    b4 = 0.55 * b4 + x * 0.5329522;
    b5 = -0.7616 * b5 - x * 0.016898;
    const y = b0 + b1 + b2 + b3 + b4 + b5 + b6 + x * 0.5362;
    b6 = x * 0.115926;
    return y;
  });
  let ms = 0;
  for (let i = 0; i < n; i++) ms += d[i] * d[i];
  const env = new Float32Array(n).fill(1);
  swells(env, sr, rnd, Math.round(dur * 10), 0.04, 0.12, 0.25);
  for (let i = 0; i < n; i++) d[i] *= env[i];
  const A = 0.6 * Math.sqrt(ms / n), rise = 1e-3 * sr;
  for (let k = 0, m = Math.round(dur * 90); k < m; k++) {
    const at = Math.floor(rnd() * n), w = (TAU * (250 + 550 * rnd())) / sr, tau = (1.5 + 2.5 * rnd()) * 1e-3 * sr;
    const a = A * (0.3 + 0.7 * rnd()), ph = rnd() * TAU, len = Math.ceil(tau * 5);
    // a phasor turning w and shrinking 1/e every tau samples; its imaginary part is the knock
    const c = Math.cos(w) * Math.exp(-1 / tau), sn = Math.sin(w) * Math.exp(-1 / tau);
    let re = a * Math.cos(ph), im = a * Math.sin(ph);
    for (let i = 0; i < len; i++) {
      const x = Math.min(1, i / rise), r = re * c - im * sn;
      d[(at + i) % n] += x * x * (3 - 2 * x) * im;
      im = re * sn + im * c;
      re = r;
    }
  }
  return toBuffer(ctx, d, 0.9, sr);
}

/** A seamless loop of dirt road under a tyre (dur s at playback rate 1): a low rumble (brown noise) bumping along -
 *  irregular swells, ~6 a second and up to ~+3 dB. */
function dirtLoop(ctx: BaseAudioContext, dur: number) {
  const sr = loopRate(ctx), n = Math.ceil(dur * sr);
  let seed = 0x6b43;
  const rnd = () => ((seed = (Math.imul(seed, 1664525) + 1013904223) | 0) >>> 0) / 4294967296;
  const k = Math.exp((-TAU * 150) / sr); // a leaky integral, flat to 150 Hz (as the shared brown noise)
  let last = 0;
  const d = lapNoise(n, rnd, (x) => (last = k * last + (1 - k) * x));
  const env = new Float32Array(n).fill(1);
  swells(env, sr, rnd, Math.round(dur * 6), 0.07, 0.18, 0.45);
  for (let i = 0; i < n; i++) d[i] *= env[i];
  return toBuffer(ctx, d, 0.9, sr);
}

const e = (t: number, tau: number) => Math.exp(-t / tau);
const sin = Math.sin;

// The joint knock: a round plastic 'tock' - a ~1.4 kHz body over a hollow 0.4 f, gone in ~10 ms - its edge softened
// (a 0.7 ms rise and a puff of dark noise: no click). Made at three pitches.
const tockFn = (f: number) => {
  let lp = 0;
  return (t: number, rnd: () => number) => {
    lp += 0.3 * (rnd() - lp);
    return (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, t / 0.0007))) *
        (sin(TAU * f * t) * e(t, 0.003) +
          0.45 * sin(TAU * 0.4 * f * t + 0.5) * e(t, 0.0045) +
          0.12 * sin(TAU * 1.63 * f * t + 1.3) * e(t, 0.0012) +
          0.25 * sin(TAU * 180 * t) * e(t, 0.008)) +
      0.6 * lp * e(t, 0.0006);
  };
};
// A crunch of gravel under a tyre: a stone knocking (a damped low-mid tone and its overtone) in a puff of dark noise,
// rounded at the front (a 1.5 ms rise) and gone in ~10 ms. The bank of six spans 300-850 Hz.
const crunchFn = (k: number) => {
  const f = 300 + 110 * k, tau = 0.0055 - 0.0006 * k, ph = 1.3 * k;
  let lp = 0;
  return (t: number, rnd: () => number) => {
    lp += 0.2 * (rnd() - lp);
    return (0.5 - 0.5 * Math.cos(Math.PI * Math.min(1, t / 0.0015))) *
      (sin(TAU * f * t + ph) * e(t, tau) + 0.45 * sin(TAU * 1.57 * f * t + 2 * ph) * e(t, 0.5 * tau) + 2.2 * lp * e(t, 0.8 * tau));
  };
};
// The landing's tick (and the plastic's rattle after a slam): a bright plastic click with a little body. Dominant mode
// 2.2 kHz, ~12 ms.
const tickFn = (t: number, rnd: () => number) =>
  Math.min(1, t / 0.0003) *
    (sin(TAU * 2200 * t) * e(t, 0.0045) +
      0.55 * sin(TAU * 3470 * t + 0.6) * e(t, 0.003) +
      0.3 * sin(TAU * 5300 * t + 1.9) * e(t, 0.0018) +
      0.4 * sin(TAU * 760 * t) * e(t, 0.007) +
      0.25 * sin(TAU * 190 * t) * e(t, 0.01)) +
  0.55 * rnd() * e(t, 0.0006);
// Car against the rail: hollow plastic clack.
const clackFn = (t: number, rnd: () => number) =>
  Math.min(1, t / 0.0005) *
    (0.8 * sin(TAU * 540 * t) * e(t, 0.03) +
      0.7 * sin(TAU * 1010 * t + 0.4) * e(t, 0.02) +
      0.5 * sin(TAU * 1630 * t + 1.1) * e(t, 0.014) +
      0.4 * sin(TAU * 2470 * t + 2) * e(t, 0.008) +
      0.3 * sin(TAU * 3900 * t) * e(t, 0.004)) +
  0.7 * rnd() * e(t, 0.003);
// Landing: a falling low thump (150 -> 55 Hz) plus the plastic wheels slapping the track.
const thudFn = (t: number, rnd: () => number) =>
  sin(TAU * (55 * t + 95 * 0.03 * (1 - e(t, 0.03)))) * e(t, 0.09) +
  0.35 * (sin(TAU * 420 * t) * e(t, 0.03) + 0.8 * sin(TAU * 830 * t + 1) * e(t, 0.02) + 0.6 * sin(TAU * 1900 * t) * e(t, 0.008)) +
  0.4 * rnd() * e(t, 0.004);
// Into a tyre wall: a dull rubber thump (130 -> 70 Hz) with a wobbling body as the stack gives and bounces back, and
// enough mid-range (205 / 330 / 470 Hz, a slap of noise) that a phone speaker, which drops everything under ~200 Hz,
// still hears it.
const thumpFn = (t: number, rnd: () => number) =>
  Math.min(1, t / 0.002) *
    (sin(TAU * (70 * t + 60 * 0.025 * (1 - e(t, 0.025)))) * e(t, 0.08) +
      0.8 * sin(TAU * 205 * t + 0.3) * e(t, 0.045) * (1 + 0.35 * sin(TAU * 17 * t)) +
      0.45 * sin(TAU * 330 * t + 1.2) * e(t, 0.03) +
      0.3 * sin(TAU * 470 * t) * e(t, 0.015)) +
  0.4 * rnd() * e(t, 0.008);
// Into hay: a soft, dull thud (90 -> 55 Hz) and a short, dry crunch of straw - noise band-limited to ~300-2000 Hz (two
// one-pole lowpasses, the slower one taken off), no high hiss and no flutter: a cushioned 'whumpf', never a scratch.
function hayFn() {
  let a = 0, b = 0;
  return (t: number, rnd: () => number) => {
    const x = rnd();
    a += 0.25 * (x - a);
    b += 0.04 * (x - b);
    return 0.95 * Math.min(1, t / 0.006) * sin(TAU * (55 * t + 35 * 0.035 * (1 - e(t, 0.035)))) * e(t, 0.07) +
      1.6 * (a - b) * Math.min(1, t / 0.004) * (0.7 * e(t, 0.05) + 0.3 * e(t, 0.015));
  };
}

// The landing slam after a long flight: a deep boom falling 95 -> 34 Hz with a body at 150 Hz (phone speakers), and the
// whole plastic run rattling (a burst of hollow knocks at 380 / 720 / 1350 Hz dying over ~0.2 s).
const slamFn = (t: number, rnd: () => number) =>
  Math.min(1, t / 0.003) *
    (sin(TAU * (34 * t + 61 * 0.06 * (1 - e(t, 0.06)))) * e(t, 0.32) +
      0.5 * sin(TAU * 150 * t + 0.4) * e(t, 0.08) +
      (0.45 * sin(TAU * 380 * t) * e(t, 0.05) + 0.35 * sin(TAU * 720 * t + 1) * e(t, 0.035) + 0.25 * sin(TAU * 1350 * t + 2) * e(t, 0.02)) *
        (0.7 + 0.3 * sin(TAU * 31 * t))) +
  0.5 * rnd() * (e(t, 0.006) + 0.25 * e(t, 0.06));

// Overrun pops (unburnt fuel lighting in the exhaust), by kind: 0 a race car's crack (a sharp bark of noise on a short
// knock), 1 a pop, 2 a big V8's burble (a soft, low 'blub'); k picks the variant (pitch, length).
const popFn = (kind: number, k: number) => {
  const f = [150, 92, 58][kind] * (1 + 0.16 * k), tau = [0.005, 0.011, 0.026][kind] * (1 + 0.2 * k);
  const rise = [0.0006, 0.0012, 0.003][kind], c = [0.35, 0.2, 0.08][kind], nz = 1.3 / Math.sqrt(c);
  let a = 0, b = 0;
  return (t: number, rnd: () => number) => {
    a += c * (rnd() - a);
    b += c * (a - b);
    return Math.min(1, t / rise) * (nz * b * e(t, tau) + 0.8 * sin(TAU * f * t) * e(t, 2.5 * tau) + 0.3 * sin(TAU * 2.6 * f * t + 1) * e(t, tau));
  };
};

// ---- the engine ---------------------------------------------------------------------------------------------------

/** A car's engine. Revs in rpm, speeds in u/s (the arcade's top speed is 44, 56 boosting). */
interface Engine {
  cyl: number;
  fire: number[]; // crank angle (deg of the cycle's 720) of each exhaust pulse at the tailpipe, in firing order ...
  load: number[]; // ... each pulse's size on the throttle ...
  lift: number[]; // ... and on the overrun (weak, uneven: the burble)
  width: [number, number]; // the pulses' width (fraction of the cycle) on the throttle, on the overrun
  idle: number;
  redline: number;
  launch: number; // the revs a standing start holds flat out (the clutch / the converter slipping)
  gears: number[]; // u/s at the redline in each gear
  up: number; // flat out, upshift at this fraction of the redline (part throttle earlier) ...
  down: number; // ... and on the throttle downshift under this one (coasting x0.75)
  shift: number; // s an upshift takes ...
  cut: number; // ... keeping this much of the throttle (0: a lift or an ignition cut; an automatic slurs on)
  inertia: number; // s: the revs' lag (the flywheel) ...
  drop: number; // ... and onto the next gear in a shift
  blip: number; // a downshift off the throttle blips it this hard (0: none)
  body: [number, number, number][]; // the exhaust's resonances [Hz, Q, dB]: body, mid, rasp (the last grows with load)
  lp: [number, number]; // its lowpass, Hz: off the throttle at idle .. flat out at the redline
  noise: [number, number, number]; // combustion noise: band Hz, Q, level ...
  rumble: [number, number]; // ... and its low rumble: lowpass Hz, level (both let through on each pulse)
  vary: number; // cycle-to-cycle size wobble (more on the overrun)
  jitter: number; // cents of random timing
  lope: number; // an idle that hunts (a lumpy cam)
  turbo: number; // the turbo's whistle and blow-off (0: none)
  pops: number; // pops a second on a lift from high revs ...
  popFade: number; // ... dying away over this (s) ...
  pop: number; // ... and which: 0 a race car's crack, 1 a pop, 2 a big V8's burble
  shiftPop: number; // a pop on each upshift (a sequential's ignition cut), this loud
  level: number;
}

const ENGINES: Record<string, Engine> = {
  // a neutral straight-six: any car without an engine of its own
  default: {
    cyl: 6, fire: [0, 121, 238, 362, 479, 602], load: [1, 0.84, 1.04, 0.9, 0.96, 0.85], lift: [0.6, 0.46, 0.62, 0.48, 0.58, 0.5], width: [0.024, 0.045],
    idle: 850, redline: 7000, launch: 3800, gears: [13, 21, 30, 40, 54], up: 0.93, down: 0.42, shift: 0.18, cut: 0.15,
    inertia: 0.07, drop: 0.07, blip: 0, body: [[150, 0.8, 6], [430, 1.5, 4], [1200, 2.2, 3]], lp: [550, 2400],
    noise: [800, 0.7, 0.9], rumble: [200, 2], vary: 0.22, jitter: 36, lope: 0.01, turbo: 0, pops: 2, popFade: 0.5, pop: 1, shiftPop: 0, level: 0.149,
  },
  // Nissan RB26DETT twin-turbo straight-six: smooth and silky (even pulses, softened by the turbines; the front and
  // rear turbos' halves alternate a touch), revs to 8000; a 5-speed, lifting for each shift (the blow-off sighs), the
  // turbos whistling as they spool
  'skyline-hck01': {
    cyl: 6, fire: [0, 121, 239, 361, 480, 601], load: [1, 0.88, 1.03, 0.9, 0.97, 0.87], lift: [0.55, 0.48, 0.58, 0.46, 0.56, 0.49], width: [0.022, 0.045],
    idle: 950, redline: 8000, launch: 4200, gears: [14, 22.5, 32, 42, 56], up: 0.95, down: 0.4, shift: 0.22, cut: 0,
    inertia: 0.06, drop: 0.08, blip: 0.35, body: [[170, 0.8, 6], [480, 1.4, 4], [1350, 2.5, 3.5]], lp: [600, 2600],
    noise: [950, 0.6, 1], rumble: [200, 2], vary: 0.2, jitter: 30, lope: 0.006, turbo: 1, pops: 1.5, popFade: 0.4, pop: 1, shiftPop: 0, level: 0.108,
  },
  // 1964 Chevrolet big-block V8, cross-plane: each bank fires 270-180-90-180 (firing order 1-8-4-3-6-5-7-2, the near
  // bank louder, the far one a touch late), so it lopes - a deep, lumpy burble; low revs (5400), big torque; a lazy
  // 3-speed automatic that slurs its shifts; it burbles on a lift
  'chevy-impala-jkb99': {
    cyl: 8, fire: [0, 98, 188, 270, 368, 450, 540, 638], load: [1, 0.7, 0.66, 0.94, 0.72, 1.04, 0.97, 0.68],
    lift: [0.85, 0.3, 0.26, 0.7, 0.38, 0.92, 0.72, 0.28], width: [0.018, 0.035],
    idle: 620, redline: 5400, launch: 2300, gears: [17, 30, 60], up: 0.9, down: 0.3, shift: 0.42, cut: 0.6,
    inertia: 0.12, drop: 0.22, blip: 0, body: [[85, 0.9, 8], [260, 1.3, 5], [780, 2, 2]], lp: [400, 1800],
    noise: [450, 0.7, 0.8], rumble: [160, 1.5], vary: 0.36, jitter: 40, lope: 0.06, turbo: 0, pops: 4, popFade: 1.2, pop: 2, shiftPop: 0, level: 0.191,
  },
  // Porsche 911 GT3 R flat-six race engine: sharp pulses (the banks alternate, the far one's headers a touch longer),
  // a warm body under the rasp, a wail to 9300; a 6-speed sequential (60 ms ignition-cut shifts with a crack,
  // auto-blips down), crackling on a lift
  'roxy-porsche-hrv96': {
    cyl: 6, fire: [0, 124, 240, 364, 480, 604], load: [1, 0.82, 1.03, 0.83, 0.99, 0.81], lift: [0.6, 0.38, 0.64, 0.4, 0.58, 0.36],
    width: [0.02, 0.04], idle: 1250, redline: 9300, launch: 5200, gears: [14.5, 20.5, 27, 34, 42.5, 56], up: 0.97, down: 0.5,
    shift: 0.06, cut: 0, inertia: 0.035, drop: 0.025, blip: 0.75, body: [[190, 0.9, 5], [640, 1.6, 4], [1600, 2.2, 4]],
    lp: [800, 3000], noise: [1200, 0.8, 1.1], rumble: [250, 2], vary: 0.22, jitter: 36, lope: 0.02, turbo: 0, pops: 16, popFade: 0.9, pop: 0,
    shiftPop: 0.5, level: 0.109,
  },
  // Porsche 911 GT3 RS (997) road flat-six: the GT3 R's sharp alternating banks with more muffler - less rasp, a
  // hard metallic edge to 8400; a 6-speed manual (clean quick shifts, a heel-and-toe blip down), a few pops on a lift
  'porsche-911-gt3-rs': {
    cyl: 6, fire: [0, 123, 240, 363, 480, 603], load: [1, 0.85, 1.03, 0.86, 0.99, 0.84], lift: [0.58, 0.42, 0.62, 0.42, 0.57, 0.4],
    width: [0.021, 0.042], idle: 1000, redline: 8400, launch: 4600, gears: [14, 21, 28.5, 36, 45, 57], up: 0.96, down: 0.46,
    shift: 0.13, cut: 0, inertia: 0.045, drop: 0.05, blip: 0.55, body: [[180, 0.9, 5], [560, 1.5, 4], [1450, 2.2, 3.4]],
    lp: [700, 2800], noise: [1100, 0.8, 1], rumble: [230, 2], vary: 0.22, jitter: 34, lope: 0.012, turbo: 0, pops: 6, popFade: 0.7, pop: 1,
    shiftPop: 0, level: 0.112,
  },
  // Porsche 964 air-cooled flat-six: a dry mechanical rasp (the fan, the valvetrain: more combustion noise, a
  // looser cycle), revs to 6800; a 5-speed manual with a slow throw, a crackle or two on the overrun
  'porsche-964-gdf88': {
    cyl: 6, fire: [0, 122, 241, 361, 481, 600], load: [1, 0.8, 1.02, 0.82, 0.97, 0.8], lift: [0.62, 0.4, 0.64, 0.42, 0.6, 0.38],
    width: [0.023, 0.046], idle: 900, redline: 6800, launch: 3900, gears: [13, 21, 30, 40, 54], up: 0.93, down: 0.42,
    shift: 0.24, cut: 0, inertia: 0.06, drop: 0.08, blip: 0.4, body: [[160, 0.8, 5], [520, 1.4, 4.5], [1500, 1.8, 4]],
    lp: [650, 2500], noise: [1300, 0.6, 1.3], rumble: [210, 2], vary: 0.28, jitter: 44, lope: 0.015, turbo: 0, pops: 4, popFade: 0.6, pop: 1,
    shiftPop: 0, level: 0.118,
  },
  // '77 Firebird Trans Am's 6.6 V8: the cross-plane lope of the Impala's big-block but angrier - a shaker hood
  // breathing, more rasp, revs a little higher (5800); a 4-speed manual, a pop and burble on a lift
  'pontiac-firebird-htf40': {
    cyl: 8, fire: [0, 97, 187, 271, 367, 451, 541, 637], load: [1, 0.72, 0.68, 0.95, 0.74, 1.04, 0.98, 0.7],
    lift: [0.85, 0.32, 0.28, 0.72, 0.4, 0.92, 0.74, 0.3], width: [0.019, 0.036],
    idle: 700, redline: 5800, launch: 2800, gears: [16, 26, 38, 58], up: 0.92, down: 0.34, shift: 0.26, cut: 0,
    inertia: 0.1, drop: 0.14, blip: 0.3, body: [[95, 0.9, 8], [300, 1.3, 5], [900, 2, 3]], lp: [450, 2100],
    noise: [520, 0.7, 0.9], rumble: [170, 1.6], vary: 0.34, jitter: 40, lope: 0.05, turbo: 0, pops: 5, popFade: 1, pop: 2, shiftPop: 0, level: 0.178,
  },
  // Honda B16B VTEC four (Civic Type R EK9): even 180-degree pulses, a thin hard bark that turns into a scream
  // high up (8400), a short-geared 5-speed with quick clean shifts; a pop or two on a lift
  'civic-type-r-hcy12': {
    cyl: 4, fire: [0, 180, 360, 540], load: [1, 0.9, 0.98, 0.88], lift: [0.6, 0.5, 0.58, 0.48], width: [0.022, 0.045],
    idle: 1000, redline: 8400, launch: 4500, gears: [13, 20, 28, 37, 50], up: 0.96, down: 0.45, shift: 0.15, cut: 0,
    inertia: 0.04, drop: 0.06, blip: 0.45, body: [[200, 0.9, 5], [620, 1.6, 4.5], [1700, 2.4, 4]], lp: [750, 3000],
    noise: [1300, 0.7, 1], rumble: [240, 2], vary: 0.2, jitter: 32, lope: 0.01, turbo: 0, pops: 3, popFade: 0.5, pop: 1, shiftPop: 0, level: 0.13,
  },
  // Ford 5.8 V8 (Mustang Cobra R): the cross-plane lope with a crisper, higher bark than the big-blocks (5900), a
  // 5-speed manual, a burble on a lift
  'mustang-cobra-r-hgk61': {
    cyl: 8, fire: [0, 99, 189, 270, 369, 449, 541, 639], load: [1, 0.74, 0.7, 0.95, 0.75, 1.03, 0.97, 0.72],
    lift: [0.84, 0.34, 0.3, 0.7, 0.42, 0.9, 0.72, 0.32], width: [0.019, 0.036],
    idle: 720, redline: 5900, launch: 2900, gears: [15, 24, 34, 45, 60], up: 0.93, down: 0.36, shift: 0.22, cut: 0,
    inertia: 0.09, drop: 0.12, blip: 0.35, body: [[105, 0.9, 7.5], [330, 1.3, 5], [1000, 2, 3.2]], lp: [480, 2300],
    noise: [560, 0.7, 0.9], rumble: [175, 1.6], vary: 0.32, jitter: 38, lope: 0.04, turbo: 0, pops: 5, popFade: 0.9, pop: 2, shiftPop: 0, level: 0.17,
  },
  // Beach Bomb Too (VW bus): an air-cooled flat-four putter - even pulses with the boxer's slight unevenness, low
  // revs (4800), a whiny cooling fan in the mid; a 4-speed with long slow shifts; barely pops
  'beach-bomb-too-k3370': {
    cyl: 4, fire: [0, 182, 358, 541], load: [1, 0.86, 0.97, 0.84], lift: [0.62, 0.5, 0.6, 0.48], width: [0.03, 0.055],
    idle: 900, redline: 4800, launch: 2600, gears: [14, 24, 36, 54], up: 0.92, down: 0.38, shift: 0.32, cut: 0,
    inertia: 0.09, drop: 0.12, blip: 0, body: [[130, 0.8, 6], [420, 1.6, 4], [1100, 2.4, 2.5]], lp: [500, 2000],
    noise: [900, 0.7, 1.1], rumble: [180, 2], vary: 0.26, jitter: 40, lope: 0.02, turbo: 0, pops: 1, popFade: 0.4, pop: 1, shiftPop: 0, level: 0.16,
  },
};

/** The car's engine: its own by id, else one like it by make, else the neutral six. */
function engineFor(car: CarSpec): Engine {
  const own = ENGINES[car.id];
  if (own) return own;
  const m = (car.meta ?? {}) as { make?: unknown; model?: unknown };
  const s = `${m.make ?? ''} ${m.model ?? ''}`.toLowerCase();
  if (/porsche/.test(s)) return ENGINES['roxy-porsche-hrv96'];
  if (/skyline|gt-?r\b|supra/.test(s)) return ENGINES['skyline-hck01'];
  if (/chevrolet|chevy|ford|dodge|plymouth|pontiac|buick|cadillac|oldsmobile|mercury|lincoln|chrysler|amc/.test(s)) return ENGINES['chevy-impala-jkb99'];
  return ENGINES.default;
}

/** The gear a car at vEng would be in (the one an acceleration on `want` would have reached, or a cruise's). */
function pickGear(P: Engine, vEng: number, want: number) {
  const at = want > 0.05 ? 0.9 * P.up : 0.75;
  for (let i = 0; i < P.gears.length - 1; i++) if (vEng < at * P.gears[i]) return i + 1;
  return P.gears.length;
}

/** One four-stroke cycle of exhaust pulses as a PeriodicWave at the cycle rate (rpm / 120 Hz), so its harmonic `cyl` is
 *  the firing frequency. Each pulse is z^2 e^(2 - 2z), z = t / w (a quick rise, a slower fall), at its firing angle and
 *  its own size; the series is closed-form: c_k = 2e^2 w / (2 + 2 pi k w i)^3 x sum_j a_j e^(-2 pi i k phi_j). Scaled to a
 *  peak of 1, with its RMS, and the curve of a gate that opens on each pulse (its top two thirds) for the noise. */
function cycleWave(ctx: BaseAudioContext, fire: number[], size: number[], w: number, N = 320) {
  const re = new Float32Array(N + 1), im = new Float32Array(N + 1), E2 = 2 * Math.E * Math.E * w;
  for (let k = 1; k <= N; k++) {
    const x = TAU * k * w, dr = 8 - 6 * x * x, di = 12 * x - x * x * x, dd = dr * dr + di * di;
    const sr = (E2 * dr) / dd, si = (-E2 * di) / dd;
    let pr = 0, pi = 0;
    for (let j = 0; j < fire.length; j++) {
      const a = (-TAU * k * fire[j]) / 720;
      pr += size[j] * Math.cos(a);
      pi += size[j] * Math.sin(a);
    }
    const taper = 0.5 + 0.5 * Math.cos((Math.PI * k) / (N + 1)); // no ringing from the cut
    re[k] = 2 * (sr * pr - si * pi) * taper;
    im[k] = -2 * (sr * pi + si * pr) * taper;
  }
  // its shape over a cycle: the peak, the floor, the RMS
  const M = 512, cs = new Float32Array(M), Q = (3 * M) / 4;
  for (let m = 0; m < M; m++) cs[m] = Math.cos((TAU * m) / M);
  let hi = -Infinity, lo = Infinity, ms = 0;
  for (let m = 0; m < M; m++) {
    let y = 0;
    for (let k = 1, i = 0; k <= N; k++) {
      i = (i + m) & (M - 1); // k m mod M
      y += re[k] * cs[i] + im[k] * cs[(i + Q) & (M - 1)]; // cos, sin
    }
    hi = Math.max(hi, y);
    lo = Math.min(lo, y);
    ms += y * y;
  }
  const s = 1 / Math.max(hi, -lo);
  for (let k = 1; k <= N; k++) (re[k] *= s), (im[k] *= s);
  const floor = lo * s, x0 = floor + (1 - floor) / 3, gate = new Float32Array(256);
  for (let i = 0; i < 256; i++) gate[i] = Math.max(0, ((2 * i) / 255 - 1 - x0) / (1 - x0)) ** 1.5;
  return { wave: ctx.createPeriodicWave(re, im, { disableNormalization: true }), rms: s * Math.sqrt(ms / M), gate };
}

/** The saturation: tanh, a touch asymmetric (some even harmonics: warmth), unity at the ends of its input range. */
const SAT = (() => {
  const n = 2048, c = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const u = (2 * i) / (n - 1) - 1;
    c[i] = Math.tanh(2 * u + 0.3 * u * u) / Math.tanh(2.3);
  }
  return c;
})();

/** The engine's voice: P as nodes into `to`. `white` is broadband noise, `wander` slow random (RMS 1, under ~300 Hz).
 *  Returns its controls (update() sets them every frame) and stop(), which fades it out. */
function engineVoice(ctx: BaseAudioContext, P: Engine, white: AudioBuffer, wander: AudioBuffer, to: AudioNode) {
  const t0 = ctx.currentTime;
  const filter = (type: BiquadFilterType, f: number, q: number, db = 0) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    b.gain.value = db;
    return b;
  };
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const srcs: AudioScheduledSourceNode[] = [];
  const loop = (buf: AudioBuffer, rate = 1) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.playbackRate.value = rate;
    s.start(t0, Math.random() * buf.duration);
    srcs.push(s);
    return s;
  };
  // the throttle's pulses, the overrun's, and at low revs short ones: a pulse's width is set in crank degrees, but at
  // idle the blowdown is short against the long cycle - without them an idle is a dull thud a phone speaker can't play
  const A = cycleWave(ctx, P.fire, P.load, P.width[0]), B = cycleWave(ctx, P.fire, P.lift, P.width[1]);
  const C = cycleWave(ctx, P.fire, P.load, 0.008);
  // the revs: one control, the cycle rate (Hz), drives the three waves so they stay in step
  const rate = ctx.createConstantSource();
  rate.offset.value = P.idle / 120;
  // no two cycles alike: random timing on the waves' detune (its band follows the cycle rate: update(); nothing under
  // 12 Hz - the revs are tied to the wheels, so it's grit, never a wander) ...
  const jitF = filter('lowpass', 16, 0.7), jit = gain(0);
  loop(wander, 0.83).connect(filter('highpass', 12, 0.7)).connect(jitF).connect(jit);
  // ... and the pulses' sizes wobbling: a gain the slow noise moves (its band follows the firing rate)
  const sum = gain(1), varF = filter('lowpass', 40, 0.7), varG = gain(0);
  loop(wander, 1.21).connect(varF).connect(varG).connect(sum.gain);
  const oscA = ctx.createOscillator(), oscB = ctx.createOscillator(), oscC = ctx.createOscillator();
  const aG = gain(0), bG = gain(0), cG = gain(0);
  oscA.setPeriodicWave(A.wave);
  oscB.setPeriodicWave(B.wave);
  oscC.setPeriodicWave(C.wave);
  for (const [o, g] of [[oscA, aG], [oscB, bG], [oscC, cG]] as const) {
    o.frequency.value = 0;
    rate.connect(o.frequency);
    jit.connect(o.detune);
    o.connect(g).connect(sum);
    o.start(t0);
    srcs.push(o);
  }
  rate.start(t0);
  srcs.push(rate);
  // combustion noise: a band of noise and a low rumble, let through on each pulse (the throttle's wave through the
  // gate curve)
  const gate = ctx.createWaveShaper(), nGate = gain(0), nG = gain(0);
  gate.curve = A.gate;
  oscA.connect(gate).connect(nGate.gain);
  const hiss = loop(white), rumble = gain(P.rumble[1] / P.noise[2]);
  hiss.connect(filter('bandpass', P.noise[0], P.noise[1])).connect(nGate);
  hiss.connect(filter('lowpass', P.rumble[0], 0.7)).connect(rumble).connect(nGate);
  nGate.connect(nG).connect(sum);
  // the exhaust: its resonances and the load's lowpass; a gentle saturation (driven harder on the throttle); a last
  // lowpass for any fizz, a highpass for the sub-audio lumps
  const res = P.body.map(([f, q, db]) => filter('peaking', f, q, db));
  let x: AudioNode = sum;
  for (const r of res) x = x.connect(r);
  const lp = filter('lowpass', P.lp[0], 0.75), drive = gain(0.3), sat = ctx.createWaveShaper();
  sat.curve = SAT;
  sat.oversample = '2x';
  const out = gain(0), flare = gain(1), voice = gain(1);
  x.connect(lp).connect(drive).connect(sat).connect(filter('lowpass', 6500, 0.6)).connect(filter('highpass', 30, 0.7)).connect(out);
  out.connect(flare).connect(voice).connect(to);
  // a turbo: its whistle (a sine rising with the boost) and the rush of air through it
  let whistle: OscillatorNode | null = null, wG: GainNode | null = null, hG: GainNode | null = null;
  if (P.turbo) {
    whistle = ctx.createOscillator();
    wG = gain(0);
    hG = gain(0);
    whistle.frequency.value = 1200;
    whistle.connect(wG).connect(voice);
    loop(white).connect(filter('bandpass', 2200, 1)).connect(hG).connect(voice);
    whistle.start(t0);
    srcs.push(whistle);
  }
  return {
    P, rate, aG, bG, cG, bK: A.rms / B.rms, cK: A.rms / C.rms, jitF, jit, varF, varG, nG, rasp: res[res.length - 1], lp, drive, out, flare, whistle, wG, hG,
    stop() {
      const t = ctx.currentTime;
      voice.gain.setTargetAtTime(0, t, 0.03);
      for (const s of srcs) s.stop(t + 0.25);
    },
  };
}

function build(ctx: BaseAudioContext, muted: boolean) {
  const sr = ctx.sampleRate;
  // A peak limiter, not a leveller: a low threshold would duck the engine on every joint tick and
  // the mix would pump in the tick rhythm.
  const comp = ctx.createDynamicsCompressor();
  comp.threshold.value = -8;
  comp.knee.value = 6;
  comp.ratio.value = 8;
  comp.attack.value = 0.002;
  comp.release.value = 0.12;
  const mute = ctx.createGain();
  mute.gain.value = muted ? 0 : 1;
  const master = ctx.createGain();
  master.gain.value = 0.8;
  master.connect(mute).connect(comp).connect(ctx.destination);

  // noise beds
  const white = ctx.createBuffer(1, sr, sr);
  {
    const w = white.getChannelData(0);
    for (let i = 0; i < w.length; i++) w[i] = Math.random() * 2 - 1;
  }
  let last = 0;
  const brown = toBuffer(ctx, lapNoise(sr * 2, Math.random, (x) => (last = (last + 0.02 * x) / 1.02)));
  const loop = (buf: AudioBuffer) => {
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.loop = true;
    s.start(0, Math.random() * buf.duration);
    return s;
  };
  const filter = (type: BiquadFilterType, f: number, q: number) => {
    const b = ctx.createBiquadFilter();
    b.type = type;
    b.frequency.value = f;
    b.Q.value = q;
    return b;
  };
  const gain = (v: number) => {
    const g = ctx.createGain();
    g.gain.value = v;
    return g;
  };
  const lfo = (f: number, depth: number, to: AudioParam) => {
    const o = ctx.createOscillator();
    o.frequency.value = f;
    o.connect(gain(depth)).connect(to);
    o.start();
  };

  // the engine's slow random (its timing, its pulses' sizes): white through a one-pole at 300 Hz, RMS 1, 6 s round so
  // no pattern in it repeats audibly
  const wander = (() => {
    const r = loopRate(ctx), k = 1 - Math.exp((-TAU * 300) / r);
    let l = 0, ms = 0;
    const d = lapNoise(6 * r, Math.random, (x) => (l += k * (x - l)));
    for (let i = 0; i < d.length; i++) ms += d[i] * d[i];
    const buf = ctx.createBuffer(1, d.length, r), o = buf.getChannelData(0), s = 1 / Math.sqrt(ms / d.length);
    for (let i = 0; i < d.length; i++) o[i] = d[i] * s;
    return buf;
  })();

  // rolling: the plastic's hum; the asphalt's roar; the dirt's rumble, and the bus its crunches play into; the verge's
  // rumble and swish
  const humF = filter('lowpass', 200, 0.7), humG = gain(0);
  loop(brown).connect(humF).connect(humG).connect(master);
  const road = loop(roadLoop(ctx, 4)), roadF = filter('lowpass', 500, 0.6), cavity = filter('peaking', 230, 2), roadG = gain(0);
  cavity.gain.value = 4;
  road.connect(filter('highpass', 90, 0.7)).connect(roadF).connect(filter('lowpass', 1200, 0.7)).connect(cavity).connect(roadG).connect(master);
  const dirt = loop(dirtLoop(ctx, 4)), dirtF = filter('lowpass', 400, 0.7), dirtG = gain(0);
  dirt.connect(filter('highpass', 55, 0.7)).connect(dirtF).connect(dirtG).connect(master);
  const crunchG = gain(0);
  crunchG.connect(filter('lowpass', 1800, 0.7)).connect(master);
  const grassF = filter('lowpass', 140, 0.9), grassBump = gain(0.75), grassG = gain(0);
  loop(brown).connect(grassF).connect(grassBump).connect(grassG).connect(master);
  lfo(6.5, 0.25, grassBump.gain); // bumps
  const swishAM = gain(0.7), swishG = gain(0);
  loop(brown).connect(filter('bandpass', 800, 0.9)).connect(filter('lowpass', 1600, 0.7)).connect(swishAM).connect(swishG).connect(master);
  lfo(1.6, 0.3, swishAM.gain); // the blades brush past in waves
  // tyre squeal: two resonances from one noise bed
  const sqG = gain(0), sqF1 = filter('bandpass', 1700, 7), sqF2 = filter('bandpass', 3500, 9), sqF2G = gain(0.5);
  const sqSrc = loop(white);
  sqSrc.connect(sqF1).connect(sqG);
  sqSrc.connect(sqF2).connect(sqF2G).connect(sqG);
  sqG.connect(master);
  // wall scrape: two resonances set by the wall, chattering
  const scF1 = filter('bandpass', 1500, 5), scF2 = filter('bandpass', 3300, 7), scF2G = gain(0.6), scAM = gain(0.65), scG = gain(0);
  const scSrc = loop(white);
  scSrc.connect(scF1).connect(scAM);
  scSrc.connect(scF2).connect(scF2G).connect(scAM);
  scAM.connect(scG).connect(master);
  lfo(31, 0.35, scAM.gain);
  // boost hiss
  const jetF = filter('bandpass', 1400, 0.6), jetG = gain(0);
  loop(white).connect(jetF).connect(jetG).connect(master);
  // wind in the air: a wide band of rushing noise (buffeting), a low roar of air under it, a thin whistle on top
  const windF = filter('bandpass', 700, 0.55), windAM = gain(0.8), windG = gain(0);
  loop(white).connect(windF).connect(windAM).connect(windG).connect(master);
  lfo(2.9, 0.22, windAM.gain);
  const windLowF = filter('lowpass', 240, 0.7), windLowG = gain(0);
  loop(brown).connect(windLowF).connect(windLowG).connect(master);
  const whistleF = filter('bandpass', 1800, 9), whistleG = gain(0);
  loop(white).connect(whistleF).connect(whistleG).connect(master);

  return {
    master, mute, white, wander, humF, humG, road, roadF, roadG, dirt, dirtF, dirtG, crunchG, grassF, grassG,
    swishG, sqG, sqF1, sqF2, scF1, scF2, scG, jetG, windF, windG, windLowF, windLowG, whistleF, whistleG,
    pops: [0, 1, 2].map((kind) => [0, 1, 2].map((k) => render(ctx, [0.05, 0.1, 0.18][kind], popFn(kind, k), 0.9, 0x4c1d + 31 * kind + 7 * k))),
    tick: render(ctx, 0.03, tickFn, 0.9),
    tock: [1300, 1420, 1560].map((f, i) => render(ctx, 0.03, tockFn(f), 0.9, 0x2f6b + i)),
    crunch: [0, 1, 2, 3, 4, 5].map((k) => render(ctx, 0.03, crunchFn(k), 0.9, 0x7a31 + 97 * k)),
    slam: render(ctx, 0.7, slamFn, 0.95),
    clack: render(ctx, 0.12, clackFn, 0.9),
    thud: render(ctx, 0.3, thudFn, 0.95),
    thump: render(ctx, 0.3, thumpFn, 0.95),
    hay: render(ctx, 0.35, hayFn(), 0.9),
  };
}

const newFrame = (): TrackFrame => ({
  s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(0, 0, 1), kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
});

/** `offline`: play into this context instead (an OfflineAudioContext a test drives with scripted states): no gesture
 *  or tab listeners, and update() plays whatever the context's state (the test suspends it to step it). */
export function createAudio(offline?: BaseAudioContext): DriveAudio {
  let live: AudioContext | null = null; // the speakers' context, made on the first gesture
  let ctx: BaseAudioContext | null = offline ?? null;
  let g: ReturnType<typeof build> | null = offline ? build(offline, false) : null;
  let muted = false;
  let time = 0, sPrev = NaN;
  // the engine: its profile (setCar), its voice (once there's a context), the wheels' radius (u) that turns their spin
  // into speed; the gearbox (0: pick one), the shift / blip in progress, the revs (fraction of the redline), the load,
  // the boost, the big jump's flare, the throttle held, the pops still due after a lift, the idle's hunting
  let P = ENGINES.default, wheelR = 0.3;
  let eng: ReturnType<typeof engineVoice> | null = offline && g ? engineVoice(offline, P, g.white, g.wander, g.master) : null;
  let gear = 0, up = false, shiftT = 0, blipT = 0, rpmN = P.idle / P.redline, load = 0, boost = 0, flareT = 0, onThr = false;
  let popEnv = 0, popDue = 0, popGap = 1, lopeA = 0, lopeB = 0;
  // what's under and beside the car (probe(), every frame): the surface mix under the tyres, the nearer wall
  let track: Track | null = null;
  const fr = newFrame(), fr2 = newFrame();
  const nose = new THREE.Vector3(), side = new THREE.Vector3(), rel = new THREE.Vector3(), prevNose = new THREE.Vector3(1, 0, 0);
  let mixP = 1, mixA = 0, mixD = 0, mixV = 0, wallMat = RAIL, wallGap = Infinity, vAlong = 0, hAbove = 0;
  let scrapeHold = 0, scMat = -1, hitT = -1, hitN = 0, spinT = -1, spinning = false;
  // the big jump: the track's 'bigjump' spans [s0, s1, ...]; time aloft, and whether this flight left a big jump's lip
  const lips: number[] = [];
  let airT = 0, bigAir = false;
  let crunchGap = 1; // the gravel: expected crunches left until the next one (an exponential draw)

  const unlock = () => {
    if (offline) return;
    try {
      if (!live) {
        ctx = live = new AudioContext({ latencyHint: 'interactive' });
        g = build(live, muted);
        eng = engineVoice(live, P, g.white, g.wander, g.master);
      }
      if (live.state !== 'running' && !document.hidden) void live.resume().catch(() => {});
    } catch {
      /* no audio on this device */
    }
  };
  // Resume inside the gesture itself (iOS needs it on the call stack of a user event).
  const opts = { capture: true, passive: true } as const;
  const onGesture = () => {
    unlock();
    if (live?.state === 'running') for (const t of ['pointerdown', 'keydown', 'touchend'] as const) window.removeEventListener(t, onGesture, opts);
  };
  if (!offline) {
    for (const t of ['pointerdown', 'keydown', 'touchend'] as const) window.addEventListener(t, onGesture, opts);
    document.addEventListener('visibilitychange', () => {
      if (!live) return;
      if (document.hidden) void live.suspend().catch(() => {});
      else void live.resume().catch(() => {});
    });
  }

  // ---- one-shots ----------------------------------------------------------------------------------
  /** A one-shot buffer into the master (or `to`, a bus). */
  function play(buf: AudioBuffer, when: number, level: number, rate = 1, to?: AudioNode) {
    if (!ctx || !g) return;
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.playbackRate.value = rate;
    const a = ctx.createGain();
    a.gain.value = level;
    s.connect(a).connect(to ?? g.master);
    s.start(Math.max(when, ctx.currentTime));
  }
  /** A crunch of gravel: a grain of the bank at its own pitch and weight. */
  const crunch = (when: number, level: number, rate: number, to?: AudioNode) =>
    g && play(g.crunch[Math.floor(Math.random() * g.crunch.length)], when, level * (0.3 + 0.7 * Math.random() * Math.random()), rate * (0.85 + 0.3 * Math.random()), to);
  /** A joint's tock: one of the three, +-5% in pitch, +-1.3 dB - every hit a little different. */
  const tock = (when: number, level: number, rate: number) =>
    g && play(g.tock[Math.floor(Math.random() * g.tock.length)], when, level * (0.85 + 0.3 * Math.random()), rate * (1 + 0.1 * (Math.random() - 0.5)));
  function tone(f: number, when: number, level: number, decay: number, type: OscillatorType = 'sine', fEnd = 0, attack = 0.004) {
    if (!ctx || !g) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, when);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, when + decay * 0.7);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0, when);
    a.gain.linearRampToValueAtTime(level, when + attack);
    a.gain.exponentialRampToValueAtTime(0.0001, when + decay);
    o.connect(a).connect(g.master);
    o.start(when);
    o.stop(when + decay + 0.02);
  }
  /** Bell: inharmonic partials, the top ones die fast. */
  function ting(f: number, when: number, level: number) {
    tone(f, when, level, 1.1);
    tone(f * 2.76, when, level * 0.35, 0.5);
    tone(f * 5.4, when, level * 0.15, 0.2);
  }
  /** Band-passed noise, its centre gliding f0 -> f1. A low Q is a whoosh; a high Q sings (tyre chirps, screeches). */
  function whoosh(when: number, level: number, f0: number, f1: number, dur: number, q = 1.2, attack = 0.06) {
    if (!ctx || !g) return;
    const s = ctx.createBufferSource();
    s.buffer = g.white;
    const bp = ctx.createBiquadFilter();
    bp.type = 'bandpass';
    bp.Q.value = q;
    bp.frequency.setValueAtTime(f0, when);
    bp.frequency.exponentialRampToValueAtTime(f1, when + dur * 0.75);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0, when);
    a.gain.linearRampToValueAtTime(level, when + attack);
    a.gain.exponentialRampToValueAtTime(0.0001, when + dur);
    s.connect(bp).connect(a).connect(g.master);
    s.start(when, Math.random() * 0.3);
    s.stop(when + dur + 0.02);
  }

  /** The engine flat out off a big jump's lip: its voice swells to ~2x for ~1.4 s while update() revs it up and opens
   *  it wide (flareT). */
  function flare(when: number) {
    if (!eng) return;
    const f = eng.flare.gain;
    f.cancelScheduledValues(when);
    f.setValueAtTime(1, when);
    f.linearRampToValueAtTime(2.1, when + 0.05);
    f.linearRampToValueAtTime(1.6, when + 0.5);
    f.linearRampToValueAtTime(1, when + 1.4);
    flareT = 1.4;
  }
  /** A turbo's blow-off valve venting the boost: a hiss falling ~2.6 -> 1.3 kHz over a breath of lower air, ~0.5 s. */
  function pssh(when: number, level: number) {
    if (!ctx || !g) return;
    for (const [f0, f1, q, l] of [[2600, 1300, 0.9, 1], [900, 450, 1.1, 0.45]]) {
      const s = ctx.createBufferSource(), bp = ctx.createBiquadFilter(), a = ctx.createGain();
      s.buffer = g.white;
      bp.type = 'bandpass';
      bp.Q.value = q;
      bp.frequency.setValueAtTime(f0, when);
      bp.frequency.exponentialRampToValueAtTime(f1, when + 0.45);
      a.gain.setValueAtTime(0, when);
      a.gain.linearRampToValueAtTime(level * l, when + 0.008);
      a.gain.linearRampToValueAtTime(level * l * 0.6, when + 0.12);
      a.gain.exponentialRampToValueAtTime(0.0001, when + 0.5);
      s.connect(bp).connect(a).connect(g.master);
      s.start(when, Math.random() * 0.5);
      s.stop(when + 0.52);
    }
  }
  /** An exhaust pop of the engine's kind, this loud (x the engine's level; each one its own variant, weight, pitch). */
  const pop = (when: number, level: number) =>
    g && play(g.pops[P.pop][Math.floor(Math.random() * 3)], when, [1.1, 0.5, 0.45][P.pop] * P.level * level * (0.4 + 0.6 * Math.random() * Math.random()), 0.9 + 0.22 * Math.random());
  /** The hidden tier 4: a glittering run two octaves up the E-major pentatonic onto a shimmering E chord (each note two
   *  voices a few hertz apart, beating) with a bell on top, over a rising breath and a soft low E: a power-up, well
   *  beyond tier 3's two tings. ~1.4 s. */
  function magic(when: number) {
    [1318.5, 1480, 1661.2, 1975.5, 2217.5, 2637, 2960, 3322.4, 3951].forEach((f, i) => tone(f, when + 0.026 * i, 0.06 + 0.005 * i, 0.22));
    const at = when + 0.24;
    for (const [f, l] of [[659.3, 0.07], [1318.5, 0.06], [1661.2, 0.045], [1975.5, 0.045], [2637, 0.035]]) {
      tone(f, at, l, 1.3, 'sine', 0, 0.05);
      tone(f * 1.0045, at, l, 1.3, 'sine', 0, 0.05);
    }
    ting(2637, at, 0.13);
    whoosh(when, 0.07, 400, 3600, 0.5, 0.8, 0.1);
    tone(82.4, at, 0.3, 0.8, 'sine', 0, 0.03);
    tone(164.8, at, 0.12, 0.6, 'sine', 0, 0.03); // so phone speakers hear the low E
  }

  /** At s, on a big jump's lip (a little before it, or up to its middle)? */
  function onLip(s: number) {
    if (!track) return false;
    const L = track.length;
    for (let i = 0; i < lips.length; i += 2) {
      const span = (((lips[i + 1] - lips[i]) % L) + L) % L, d = (((s - lips[i]) % L) + L) % L;
      if (d < 0.5 * span || d > L - 10) return true;
    }
    return false;
  }

  const isJoint = (f: TrackFrame) => f.surface === 'plastic' && Math.abs(f.width - CHANNEL) < 0.05;

  /** Reads the frame under the car: the share of the tyres on each surface, and the nearer wall (as fx.ts). */
  function probe(state: VehicleState) {
    if (!track) {
      mixP = 1;
      mixA = mixD = mixV = 0;
      wallMat = RAIL;
      wallGap = Infinity;
      return;
    }
    const f = track.frameAt(state.trackS, fr);
    rel.subVectors(state.position, f.p);
    const d = rel.dot(f.right), half = f.width * 0.5;
    hAbove = rel.dot(f.up);
    // the tyres either side of the centre: on the verge past the surface's edge where the edge is grass
    mixV = f.edge === 'grass' ? 0.5 * (smoothstep(half - 0.1, half + 0.2, Math.abs(d - TYRE_Y)) + smoothstep(half - 0.1, half + 0.2, Math.abs(d + TYRE_Y))) : 0;
    mixP = f.surface === 'plastic' ? 1 - mixV : 0;
    mixA = f.surface === 'asphalt' ? 1 - mixV : 0;
    mixD = f.surface === 'dirt' ? 1 - mixV : 0;
    const lim = f.edge === 'grass' ? half + Math.max(0, f.shoulder || 0) : half;
    const reach = HALF_L * Math.abs(nose.dot(f.right)) + HALF_W * Math.abs(side.dot(f.right));
    wallGap = Math.min(lim - d - reach, lim + d - reach);
    // track.ts lines the far edge of every verge with hay bales: they sound like the dirt's (SOFT, a bare grass limit,
    // is kept for a course without them)
    wallMat = f.edge === 'grass' || (f.edge === 'barrier' && f.surface === 'dirt') ? HAY : f.edge === 'barrier' ? TYRE : RAIL;
    vAlong = Math.abs(state.velocity.dot(f.t));
  }

  // ---- per frame ----------------------------------------------------------------------------------
  function update(state: VehicleState, input: DriveInput, dtIn: number) {
    const dt = clamp(dtIn, 0, 0.1);
    time += dt;
    const ev = state.events;
    // time aloft (kept while the audio is off too), and whether this flight left a big jump's lip
    const airWas = airT;
    airT = state.grounded ? 0 : airT + dt;
    if (ev.airborne) bigAir = !state.grounded && state.speed > 15 && onLip(state.trackS);
    if (!ctx || !g || (live && live.state !== 'running')) {
      sPrev = state.trackS;
      return;
    }
    const now = ctx.currentTime;
    const v = state.speed;
    const grounded = state.grounded;
    const V = state.velocity;
    nose.set(1, 0, 0).applyQuaternion(state.quaternion);
    side.set(0, 0, 1).applyQuaternion(state.quaternion);
    probe(state);
    const hard = mixP + mixA; // share of the tyres on a surface that squeals

    // Slip: the vehicle's, or the pose's when that's bigger (a spin-out swings the nose past a drift's clamp),
    // folded onto the line of travel (sliding backwards is rolling).
    let slip = Math.abs(state.slip), off = 0;
    if (v > 3) {
      off = Math.abs(Math.atan2(V.dot(side), V.dot(nose)));
      slip = Math.max(slip, Math.min(off, Math.PI - off));
    }
    const slipDeg = slip / DEG, slide = smoothstep(6, 26, slipDeg);

    // Engine: the revs from the wheels (their spin: wheelspin, and free in the air) through the car's gearbox; the
    // load from the throttle (cut in a shift, stabbed by a blip); the turbo's boost; then the voice's controls.
    popDue = 0;
    if (eng) {
      const n = P.gears.length, idleN = P.idle / P.redline;
      const back = V.dot(nose) < -1; // reversing: the brake drives it
      const want = back ? input.brake : input.throttle;
      // a drift on the throttle spins the rear up a little more
      const vEng = Math.max(v, Math.abs(state.wheelSpinRate) * wheelR) * (1 + 0.1 * slide * want);
      if (!gear || ev.respawn) {
        gear = pickGear(P, vEng, want);
        shiftT = blipT = 0;
      }
      shiftT = Math.max(0, shiftT - dt);
      blipT = Math.max(0, blipT - dt);
      if (grounded && !back && shiftT <= 0) {
        const r = vEng / P.gears[gear - 1];
        if (gear < n && r > (want > 0.05 ? P.up * (0.62 + 0.38 * want) : 0.99)) {
          gear++;
          up = true;
          shiftT = P.shift;
          // a turbo vents its boost through the blow-off as the throttle closes; a sequential's ignition cut cracks
          if (P.turbo && boost > 0.3) {
            pssh(now, 0.55 * P.level * P.turbo * boost);
            boost *= 0.3;
          }
          if (P.shiftPop && rpmN > 0.6) pop(now + 0.012, P.shiftPop);
        } else if (gear > 1 && r < P.down * (want > 0.05 ? 1 : 0.75) && vEng < 0.9 * P.gears[gear - 2]) {
          gear--;
          up = false;
          shiftT = 0.5 * P.shift;
          if (want < 0.3 && P.blip) {
            blipT = 0.12;
            if (P.pops) popEnv = Math.max(popEnv, 0.5);
          }
        }
      }
      // the revs: the gear's, held up by a slipping clutch (converter) at a standstill as the throttle asks, free in
      // the air, flaring off a big jump, hunting at idle; the limiter rounds them off
      flareT = Math.max(0, flareT - dt);
      const fl = Math.min(1, flareT / 0.9);
      const hold = idleN + (P.launch / P.redline - idleN) * want;
      let rN = vEng / P.gears[back ? 0 : gear - 1];
      rN = 0.5 * (rN + hold + Math.sqrt((rN - hold) ** 2 + 0.0016)); // a smooth max
      if (!grounded) rN = Math.max(rN, idleN + (0.97 - idleN) * want);
      rN = Math.max(rN, 0.97 * fl);
      lopeA += dt * TAU * 1.27;
      lopeB += dt * TAU * 2.09;
      const idleK = 1 - smoothstep(1.15 * idleN, 1.9 * idleN, rpmN);
      const hunt = P.lope * idleK * (0.65 * sin(lopeA) + 0.35 * sin(lopeB + 0.8 * sin(0.31 * lopeA)));
      rN *= 1 + hunt;
      if (rN > 0.94) rN = 0.94 + 0.06 * Math.tanh((rN - 0.94) / 0.06);
      rpmN += (rN - rpmN) * (1 - Math.exp(-dt / (shiftT > 0 ? P.drop : grounded ? P.inertia : 0.12)));
      // the load
      let L = want;
      if (shiftT > 0 && up) L *= P.cut;
      if (blipT > 0) L = Math.max(L, P.blip);
      L = Math.max(L, fl);
      load += (L - load) * (1 - Math.exp(-dt / (L < load ? 0.025 : 0.05)));
      const lo = Math.max(load, 0.3 * idleK); // idling, it still fires
      // a lift from high revs: the blow-off, and the exhaust pops for a while
      if (onThr && want < 0.2) {
        onThr = false;
        if (P.turbo && boost > 0.25) {
          pssh(now, 0.7 * P.level * P.turbo * boost);
          boost *= 0.2;
        }
        popEnv = Math.max(popEnv, smoothstep(0.4, 0.75, rpmN));
      } else if (!onThr && want > 0.6) onThr = true;
      popEnv *= Math.exp(-dt / P.popFade);
      popDue = P.pops * popEnv * (1 - lo) * smoothstep(0.22, 0.5, rpmN) * dt; // pops expected this frame
      // the turbo spools up on the throttle at revs (~0.5 s), and bleeds off quickly
      const bT = P.turbo ? lo * smoothstep(0.3, 0.68, rpmN) * (shiftT > 0 && up ? 0 : 1) : 0;
      boost += (bT - boost) * (1 - Math.exp(-dt / (bT > boost ? 0.5 : 0.12)));
      // the voice
      const fc = (rpmN * P.redline) / 120, fire = fc * P.cyl; // the cycle rate, the firing rate (Hz)
      eng.rate.offset.setTargetAtTime(fc, now, 0.012);
      const xa = Math.sqrt(lo), xc = 1 - smoothstep(idleN, 2.6 * idleN, rpmN); // the low revs' short pulses
      eng.aG.gain.setTargetAtTime((1 - xc) * xa, now, 0.02);
      eng.bG.gain.setTargetAtTime((1 - xc) * (1 - xa) * eng.bK, now, 0.02);
      eng.cG.gain.setTargetAtTime(xc * eng.cK, now, 0.02);
      // the randoms' bands follow the engine (timing: about the cycle rate; sizes: about the firing rate), their gains
      // keep them at P.jitter cents and P.vary RMS (the wander through a lowpass at f: RMS ~ sqrt(0.707 f / its band))
      const jf = clamp(fc, 10, 90), vf = clamp(0.8 * fire, 20, 300);
      eng.jitF.frequency.setTargetAtTime(jf, now, 0.05);
      eng.jit.gain.setTargetAtTime(P.jitter / Math.sqrt((0.707 * jf) / 249), now, 0.05);
      eng.varF.frequency.setTargetAtTime(vf, now, 0.05);
      eng.varG.gain.setTargetAtTime(Math.min(0.45, P.vary * (1 + 1.2 * (1 - lo))) / Math.sqrt((0.707 * vf) / 363), now, 0.05);
      eng.nG.gain.setTargetAtTime(P.noise[2] * (0.3 + 0.7 * lo) * (0.5 + 0.5 * rpmN), now, 0.03);
      eng.rasp.gain.setTargetAtTime(P.body[P.body.length - 1][2] * (0.25 + 0.75 * lo), now, 0.05);
      eng.lp.frequency.setTargetAtTime(P.lp[0] + (P.lp[1] - P.lp[0]) * lo ** 1.3 * (0.3 + 0.7 * rpmN) + 900 * xc, now, 0.03);
      eng.drive.gain.setTargetAtTime(0.14 + 0.12 * lo, now, 0.03);
      eng.out.gain.setTargetAtTime(P.level * (0.36 + 0.64 * lo ** 0.8) * (0.55 + 0.45 * rpmN) * (1 + 0.4 * xc) * (1 + 2.5 * hunt), now, 0.03);
      if (eng.whistle && eng.wG && eng.hG) {
        eng.whistle.frequency.setTargetAtTime(1200 + 1700 * boost * (0.6 + 0.4 * rpmN), now, 0.05);
        eng.wG.gain.setTargetAtTime(0.025 * P.level * P.turbo * boost * boost, now, 0.05);
        eng.hG.gain.setTargetAtTime(0.06 * P.level * P.turbo * boost * lo, now, 0.05);
      }
    }

    // Rolling, by surface (silent in the air). The asphalt and the dirt build smoothly all the way to top speed.
    const roll = grounded ? Math.min(1, v / 25) : 0, tc = grounded ? BLEND : 0.12;
    const rise = grounded ? Math.pow(Math.min(v, 55) / 45, 0.7) : 0, rate = 0.5 + v / 50; // the loops scroll past
    g.humF.frequency.setTargetAtTime(200 + 18 * v, now, 0.05);
    g.humG.gain.setTargetAtTime(roll * 0.34 * mixP, now, tc);
    g.road.playbackRate.setTargetAtTime(rate, now, 0.05);
    g.roadF.frequency.setTargetAtTime(260 + 8 * v, now, 0.05);
    g.roadG.gain.setTargetAtTime(rise * ROAD * mixA * (1 + 0.3 * slide), now, tc);
    g.dirt.playbackRate.setTargetAtTime(rate + 0.15 * slide, now, 0.05);
    g.dirtF.frequency.setTargetAtTime(220 + 6 * v, now, 0.05);
    g.dirtG.gain.setTargetAtTime(rise * DIRT * mixD * (1 + 0.6 * slide), now, tc);
    g.crunchG.gain.setTargetAtTime(rise * CRUNCH * mixD * (1 + 0.4 * slide), now, tc);
    g.grassF.frequency.setTargetAtTime(110 + 4 * v, now, 0.05);
    g.grassG.gain.setTargetAtTime(roll * 0.32 * mixV * (1 + 0.6 * slide), now, tc);
    g.swishG.gain.setTargetAtTime(roll * SWISH * mixV * (1 + 0.5 * slide), now, tc);

    // Squeal: slip, or hard braking, on the surfaces that squeal.
    const sq = grounded ? Math.max(smoothstep(4, 20, slipDeg), 0.6 * smoothstep(30, 55, -state.accelLocal.x)) * Math.min(1, v / 10) * hard : 0;
    const fSq = 1500 + 22 * Math.min(slipDeg, 30) + 70 * sin(time * TAU * 6.5);
    g.sqF1.frequency.setTargetAtTime(fSq, now, 0.03);
    g.sqF2.frequency.setTargetAtTime(fSq * 2.1, now, 0.03);
    g.sqG.gain.setTargetAtTime(0.16 * sq, now, 0.04);

    // Scrape: a corner on the wall while the car runs along it; the hold rides out the little bounces off it.
    scrapeHold = track && wallGap < 0.12 && v > 4 && hAbove < 1.2 ? 0.12 : Math.max(0, scrapeHold - dt);
    const scr = scrapeHold > 0 ? smoothstep(4, 30, vAlong) : 0;
    if (wallMat !== scMat) {
      const m = SCRAPE[wallMat];
      g.scF1.frequency.setTargetAtTime(m[0], now, 0.02);
      g.scF1.Q.setTargetAtTime(m[1], now, 0.02);
      g.scF2.frequency.setTargetAtTime(m[2], now, 0.02);
      g.scF2.Q.setTargetAtTime(m[3], now, 0.02);
      scMat = wallMat;
    }
    g.scG.gain.setTargetAtTime(0.22 * scr * SCRAPE[wallMat][4], now, scr > 0 ? 0.03 : 0.08);

    g.jetG.gain.setTargetAtTime(state.boosting ? 0.07 : 0, now, state.boosting ? 0.03 : 0.15);

    // Wind: builds with time aloft and speed (a hop barely breathes, the big jump howls); cut on touchdown.
    const wk = grounded ? 0 : smoothstep(0.08, 1.6, airT) * clamp(v / 48, 0.3, 1.25), wt = grounded ? 0.05 : 0.25;
    g.windF.frequency.setTargetAtTime(420 + 20 * v + 600 * wk, now, 0.12);
    g.windG.gain.setTargetAtTime(0.3 * wk, now, wt);
    g.windLowF.frequency.setTargetAtTime(180 + 3 * v, now, 0.12);
    g.windLowG.gain.setTargetAtTime(0.35 * wk, now, wt);
    g.whistleF.frequency.setTargetAtTime(1500 + 28 * v + 300 * wk, now, 0.2);
    g.whistleG.gain.setTargetAtTime(0.1 * wk * wk, now, wt);

    // Events.
    if (ev.tierUp === 4) magic(now);
    else if (ev.tierUp) {
      ting(TING[ev.tierUp], now, 0.2);
      if (ev.tierUp === 3) ting(TING[1] * 2, now + 0.07, 0.14);
    }
    if (ev.boostStart) {
      tone(64, now, 0.85, 0.55, 'sine', 30);
      tone(128, now, 0.25, 0.35, 'sine', 60); // so phone speakers hear the whump
      whoosh(now, 0.3, 350, 2600, 0.6);
    }
    // Lift-off: a soft whoosh at speed; off a big jump's lip, the roar.
    if (ev.airborne && !grounded) {
      if (bigAir) {
        flare(now); // the engine flat out, ~2x the bed
        tone(58, now, 0.8, 0.7, 'sine', 28);
        tone(116, now, 0.22, 0.4, 'sine', 56); // so phone speakers hear the whump
        whoosh(now, 0.32, 300, 3200, 0.9, 1, 0.08);
        play(g.clack, now, 0.45, 0.8); // the lip's plastic
      } else if (v > 20) whoosh(now, 0.1, 500, 1600, 0.35);
    }
    if (ev.landed) {
      const k = clamp(ev.landed / 18, 0.2, 1), grass = mixV > 0.5;
      const big = smoothstep(0.5, 2.6, airWas); // the longer the flight, the bigger and lower the slam
      play(g.thud, now, 0.9 * k * (grass ? 0.75 : 1) * (1 + 0.5 * big), (0.95 + 0.1 * Math.random()) * (grass ? 0.85 : 1) * (1 - 0.2 * big));
      if (mixP >= 0.5) play(g.tick, now + 0.012, 0.5 * k, 0.8); // the plastic wheels slap the track
      else if (mixA >= 0.5) whoosh(now + 0.01, 0.35 * k, 2100, 1700, 0.12, 8, 0.005); // the tyres chirp
      else if (mixD >= 0.5) for (let i = 0; i < 8; i++) crunch(now + 0.15 * (i / 8) ** 1.5 + 0.008 * Math.random(), 0.9 * k * (1 - i / 10), 0.9); // a spit of gravel
      else whoosh(now, 0.12 * k, 4500, 2000, 0.3, 0.8, 0.02); // a swish of grass
      if (big > 0.05) {
        play(g.slam, now, 0.25 + 0.6 * big, 1.05 - 0.2 * big);
        // the plastic run rattles after it
        if (mixP >= 0.5) for (let i = 1; i <= 3; i++) play(g.tick, now + 0.02 + 0.035 * i + 0.01 * Math.random(), (0.45 * big) / i, 0.7 + 0.08 * i);
      }
    }
    if (ev.perfectLanding) {
      ting(1975.5, now + 0.05, 0.16);
      ting(2637, now + 0.13, 0.14);
      if (bigAir || airWas > 1.2) ting(3136, now + 0.21, 0.13); // off the big jump: a third, higher one
    }
    // Wall impacts, by material; light knocks between them only count when much harder (a scrape has the loop).
    const n = ev.wallHit ?? 0;
    const soft = wallMat === HAY || wallMat === SOFT; // hay is hit again and again sliding along it: fewer, gentler knocks
    if (n > 2 && (time - hitT > (soft ? 0.18 : 0.07) || n > hitN * 1.5)) {
      hitT = time;
      hitN = n;
      const k = clamp(n / 25, 0.15, 1), r = 0.92 + 0.16 * Math.random();
      if (wallMat === RAIL) play(g.clack, now, 0.75 * k, r);
      else if (wallMat === TYRE) play(g.thump, now, 1.1 * k, r);
      else play(g.hay, now, 0.7 * k, wallMat === SOFT ? r * 0.85 : r);
      // a heavy hit has weight (hay only a softer one: it swallows the hit, and the slam's plastic rattle isn't straw)
      if (n > 22) play(g.thud, now + 0.004, (soft ? 0.4 : 0.75) * clamp((n - 22) / 15, 0.35, 1), 0.72);
      if (n > 25 && !soft) play(g.slam, now + 0.006, 0.4 * clamp((n - 25) / 12, 0.3, 1), 1.2); // the hardest boom
    }
    // Spin-out: the vehicle says so, or the nose swings far off the travel at speed (a rollback has the angle
    // but no yaw rate). A long screech on the surfaces that squeal, a gravelly skid on the others.
    const turn = rel.crossVectors(prevNose, nose).length();
    prevNose.copy(nose);
    const spinNow = grounded && v > 10 && off > 60 * DEG && turn > 1.5 * dt;
    if ((ev.spinOut || (spinNow && !spinning)) && time - spinT > 0.8) {
      spinT = time;
      const k = clamp(v / 30, 0.5, 1);
      if (hard >= 0.5) {
        whoosh(now, 1.4 * k, 2400, 1200, 0.95, 7, 0.03);
        whoosh(now, 0.5 * k, 5100, 2500, 0.8, 6, 0.03);
      } else whoosh(now, 0.6 * k, 1400, 600, 0.8, 1.5, 0.03);
    }
    spinning = (spinning || spinNow || !!ev.spinOut) && off > 35 * DEG && v > 6;
    if (ev.respawn) whoosh(now, 0.18, 2400, 300, 0.7);

    // Scheduled one frame ahead at their sub-frame moments, so the rhythms stay even at any frame rate:
    const lead = Math.max(dt, 1 / 60) + 0.006, t0 = now + lead - dt;
    // the gravel's crunches, at random moments (a Poisson stream at a rate that follows the speed; a slide sprays more)
    const due = grounded && mixD > 0.02 ? v * (0.8 + 1.4 * slide) * dt : 0; // crunches expected this frame
    let left = due;
    while (due > 0 && crunchGap <= left) {
      left -= crunchGap;
      crunch(t0 + (1 - left / due) * dt, 1, 1 - 0.12 * slide, g.crunchG);
      crunchGap = -Math.log(1 - Math.random());
    }
    crunchGap -= left;
    // the exhaust's pops after a lift (a Poisson stream too, fading)
    left = popDue;
    while (popDue > 0 && popGap <= left) {
      left -= popGap;
      pop(t0 + (1 - left / popDue) * dt, 1);
      popGap = -Math.log(1 - Math.random());
    }
    popGap -= left;
    // and the track joints, on the plastic: a tock per axle at every multiple of JOINT along s.
    const s = state.trackS;
    if (!Number.isNaN(sPrev) && !ev.respawn) {
      let ds = s - sPrev, k = -1, frac = 0;
      if (Math.abs(ds) < 30) {
        const a = Math.floor(sPrev / JOINT), b = Math.floor(s / JOINT);
        if (a !== b && ds !== 0) {
          k = ds > 0 ? b : a;
          frac = (k * JOINT - sPrev) / ds;
        }
      } else if (s < 6 && sPrev > s) {
        // wrapped past the start line (the joint at s = 0)
        ds = Math.max(v * dt, 1e-3);
        k = 0;
        frac = clamp(1 - s / ds, 0, 1);
      }
      if (k >= 0 && grounded && v > 1.5 && (!track || isJoint(track.frameAt(k * JOINT, fr2)))) {
        const when = t0 + frac * dt;
        const level = TOCK * (0.26 + 0.36 * Math.min(1, v / 40));
        const bright = 0.94 + 0.1 * Math.min(1, v / 50); // harder hits ring a little higher
        tock(when, level, bright);
        const lagRear = WHEELBASE / v;
        if (lagRear < 0.4) tock(when + lagRear, level * 0.78, bright * 0.94);
      }
    }
    sPrev = s;
  }

  return {
    unlock,
    update,
    setMuted(m: boolean) {
      muted = m;
      if (ctx && g) g.mute.gain.setTargetAtTime(m ? 0 : 1, ctx.currentTime, 0.03);
    },
    setTrack(t: Track) {
      track = t;
      lips.length = 0;
      for (const b of t.tags) if (b.tag === 'bigjump') lips.push(b.s0, b.s1);
    },
    setCar(car: CarSpec) {
      const r = (car.wheels ?? []).map((w) => w.r).filter((x) => x > 0);
      wheelR = r.length ? r.reduce((a, b) => a + b, 0) / r.length : 0.3; // as the arcade's (the mean)
      const next = engineFor(car);
      if (next === P) return;
      P = next;
      gear = 0;
      rpmN = P.idle / P.redline;
      if (ctx && g && eng) {
        eng.stop();
        eng = engineVoice(ctx, P, g.white, g.wander, g.master);
      }
    },
  };
}
