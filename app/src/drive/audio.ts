import * as THREE from 'three';
import type { DriveInput, Track, TrackFrame, VehicleState } from './types';

// Every sound is generated in code (no files):
//   engine   2 detuned saws + a sub sine through a lowpass that opens with throttle (900 Hz -> 6 kHz);
//            pitch from a fake 5-speed gearbox (shift at 92%, drop to 62%, 120 ms throttle dip)
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
//   one-shots tier 'ting' (higher per tier), boost whump (sine 60 -> 30 Hz + whoosh), landing thud (with the
//            plastic's tick, a tyre chirp on asphalt, a spit of gravel on dirt, a swish on grass), wall impact
//            by material (plastic clack, tyre-wall thump, hay thud with a straw rustle; a very hard hit adds a
//            low crunch and a boom), spin-out screech (a resonant noise sweep falling an octave), perfect-landing chime
//   big jump off a 'bigjump' lip: the launch roar (the engine flat out - two detuned saws sweeping up an octave
//            through an opening filter - over a sub whump and a rising whoosh, the lip's plastic clack); the landing
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
}

const JOINT = 17; // u between track connectors (track.ts's tabEvery) ...
const CHANNEL = 8; // ... which sit where the plastic is its plain 8 u channel (not the funnels out to a road)
const WHEELBASE = 2.3; // u between the axles (all three cars are 2.26-2.39)
const HALF_L = 2, HALF_W = 0.8, TYRE_Y = 0.62; // u: the cars' footprint (~4 x 1.5-1.65) and their tyres off the centre
const GEAR_TOP = [10.5, 15.5, 23, 34, 50]; // u/s at 92% rpm in gears 1-5 (each gear spans x1.48)
const SHIFT_DIP = 0.12; // s of throttle cut on an upshift
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
  [3200, 0.8, 6000, 1, 0.9], // hay: a rustle
  [2400, 0.7, 5000, 0.9, 0.9], // the verge's soft limit: a brush of grass
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
// Into hay: a soft, dull thud (100 -> 58 Hz) and a rustle of straw (high-passed noise, fluttering).
function hayFn() {
  let lp = 0;
  return (t: number, rnd: () => number) => {
    const x = rnd();
    lp += 0.35 * (x - lp);
    return 0.9 * Math.min(1, t / 0.004) * sin(TAU * (58 * t + 42 * 0.03 * (1 - e(t, 0.03)))) * e(t, 0.06) +
      (x - lp) * (0.9 * e(t, 0.12) + 0.6 * e(t, 0.025)) * (0.6 + 0.4 * sin(TAU * 43 * t) * sin(TAU * 11 * t));
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

  // engine
  const engF = filter('lowpass', 900, 1.6);
  const engG = gain(0);
  engF.connect(engG).connect(master);
  const saw1 = ctx.createOscillator(), saw2 = ctx.createOscillator(), sub = ctx.createOscillator();
  saw1.type = saw2.type = 'sawtooth';
  sub.type = 'sine';
  saw2.detune.value = 14;
  const sawG = gain(0.22), subG = gain(0.6);
  saw1.connect(sawG);
  saw2.connect(sawG);
  sawG.connect(engF);
  sub.connect(subG).connect(engF);
  const wob = ctx.createOscillator(), wobG = gain(7); // a slow wobble so the note lives
  wob.frequency.value = 5.3;
  wob.connect(wobG);
  wobG.connect(saw1.detune);
  wobG.connect(saw2.detune);
  for (const o of [saw1, saw2, sub, wob]) o.start();

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
    master, mute, white, engF, engG, saw1, saw2, sub, humF, humG, road, roadF, roadG, dirt, dirtF, dirtG, crunchG, grassF, grassG,
    swishG, sqG, sqF1, sqF2, scF1, scF2, scG, jetG, windF, windG, windLowF, windLowG, whistleF, whistleG,
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
  let gear = 1, shiftT = 0, thr = 0, time = 0, sPrev = NaN;
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
  function tone(f: number, when: number, level: number, decay: number, type: OscillatorType = 'sine', fEnd = 0) {
    if (!ctx || !g) return;
    const o = ctx.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(f, when);
    if (fEnd) o.frequency.exponentialRampToValueAtTime(fEnd, when + decay * 0.7);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0, when);
    a.gain.linearRampToValueAtTime(level, when + 0.004);
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

  /** The engine flat out off a big jump's lip: two detuned saws sweeping up an octave through a filter that opens and
   *  closes again, swelling in and dying over ~1.4 s. */
  function roar(when: number, level: number, f0: number) {
    if (!ctx || !g) return;
    const lp = ctx.createBiquadFilter();
    lp.type = 'lowpass';
    lp.Q.value = 2.5;
    lp.frequency.setValueAtTime(600, when);
    lp.frequency.exponentialRampToValueAtTime(4200, when + 0.35);
    lp.frequency.exponentialRampToValueAtTime(900, when + 1.4);
    const a = ctx.createGain();
    a.gain.setValueAtTime(0, when);
    a.gain.linearRampToValueAtTime(level, when + 0.04);
    a.gain.linearRampToValueAtTime(level * 0.7, when + 0.45);
    a.gain.exponentialRampToValueAtTime(0.0001, when + 1.4);
    lp.connect(a).connect(g.master);
    for (let i = 0; i < 2; i++) {
      const o = ctx.createOscillator();
      o.type = 'sawtooth';
      o.detune.value = i ? 11 : -11;
      o.frequency.setValueAtTime(f0, when);
      o.frequency.exponentialRampToValueAtTime(f0 * 2, when + 0.5);
      o.frequency.exponentialRampToValueAtTime(f0 * 1.7, when + 1.4);
      o.connect(lp);
      o.start(when);
      o.stop(when + 1.45);
    }
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

    // Engine: gearbox from the wheel speed (spins up in the air / under wheelspin).
    let vEng = Math.max(v, Math.abs(state.wheelSpinRate) * 0.29);
    if (!grounded) vEng += 6 * input.throttle;
    if (gear < 5 && vEng > GEAR_TOP[gear - 1]) {
      gear++;
      shiftT = SHIFT_DIP;
    } else if (gear > 1 && vEng < 0.87 * GEAR_TOP[gear - 2]) gear--;
    const rpm = clamp(gear === 1 ? 0.18 + (0.74 * vEng) / GEAR_TOP[0] : (0.92 * vEng) / GEAR_TOP[gear - 1], 0.18, 1);
    shiftT = Math.max(0, shiftT - dt);
    const tIn = shiftT > 0 ? input.throttle * 0.2 : input.throttle;
    thr += (tIn - thr) * (1 - Math.exp(-dt / 0.035));
    const f = 38 + 210 * rpm;
    g.saw1.frequency.setTargetAtTime(f, now, 0.025);
    g.saw2.frequency.setTargetAtTime(f, now, 0.025);
    g.sub.frequency.setTargetAtTime(f / 2, now, 0.025);
    g.engF.frequency.setTargetAtTime(900 + 5100 * Math.pow(thr, 1.4) * (0.55 + 0.45 * rpm), now, 0.03);
    g.engG.gain.setTargetAtTime(0.075 + 0.11 * thr + 0.035 * rpm, now, 0.04);

    // Slip: the vehicle's, or the pose's when that's bigger (a spin-out swings the nose past a drift's clamp),
    // folded onto the line of travel (sliding backwards is rolling).
    let slip = Math.abs(state.slip), off = 0;
    if (v > 3) {
      off = Math.abs(Math.atan2(V.dot(side), V.dot(nose)));
      slip = Math.max(slip, Math.min(off, Math.PI - off));
    }
    const slipDeg = slip / DEG, slide = smoothstep(6, 26, slipDeg);

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
    if (ev.tierUp) {
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
        roar(now, 0.14, 72); // ~0.1 RMS at its peak: two to three times the engine bed
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
    if (n > 2 && (time - hitT > 0.07 || n > hitN * 1.5)) {
      hitT = time;
      hitN = n;
      const k = clamp(n / 25, 0.15, 1), r = 0.92 + 0.16 * Math.random();
      if (wallMat === RAIL) play(g.clack, now, 0.75 * k, r);
      else if (wallMat === TYRE) play(g.thump, now, 1.1 * k, r);
      else play(g.hay, now, 0.95 * k, wallMat === SOFT ? r * 0.85 : r);
      if (n > 22) play(g.thud, now + 0.004, 0.75 * clamp((n - 22) / 15, 0.35, 1), 0.72); // a heavy hit has weight
      if (n > 25) play(g.slam, now + 0.006, 0.4 * clamp((n - 25) / 12, 0.3, 1), 1.2); // the hardest boom
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
  };
}
