import * as THREE from 'three';
import '../style.css';
import { mountNav } from '../nav';
import { tierOf } from '../rarity';
import { createAudio } from './audio';
import { CAMERA, createChaseCamera } from './camera';
import { createFx } from './fx';
import { createHud, type RaceResult } from './hud';
import { createInput } from './input';
import { startLoop } from './loop';
import { loadRig, type Rig } from './rig';
import { buildTrack, courseOf, COURSES, DEFAULT_COURSE, isCourse, type CourseId } from './tracks';
import type { DriveInput, TrackFrame, VehicleFactory, VehicleState } from './types';
import { VEHICLES } from './vehicles';
import { buildWorld } from './world-outdoor';

// /drive.html?car=<id>[&track=sky]: take the car you just ripped for a spin. Two courses (tracks/index.ts COURSES): the meadow
// (the default) - country roads, a dirt stretch and orange Hot Wheels set pieces (the start gate, the big jump, a loop) -
// and the Sky Tower, the crazy one. The top bar's track switch and the results card's "Try <the other one>" reload
// the page on the other course with the same car and knobs; the bar's car picker and Random car keep the course. The
// car waits in the start gate; the first key, tap or button drops it (and unlocks audio). 3 laps, splits against your
// best lap (per car and course), results with Again (instant, no reload) / Rip a pack / Try <the other course>. R
// restarts any time. WRONG WAY when you drive against the lap (the car puts itself back after a few seconds of it).
// Game time never slows or stops (no slow-mo, no hit-stop: the sim stays fixed-step, deterministic and input-driven,
// ready for lockstep multiplayer); a hard hit's drama is the camera's kick and shake, the sound, sparks and haptics.
// URL knobs: ?track=meadow|sky  ?model=arcade
//            ?auto=1 autopilot  ?tune=1 driving sliders (?tune=camera: camera)  ?fps=1
//            ?laps=<1-9>  ?fast=<2-16> runs the sim N x real time (tests)
// For scripts: window.__ready after 3 frames; window.__drive = { state, lap (completed), laps, model, car, course,
// time, phase, lapTimes, stats, info (renderer.info), timeScale(x), frozen } (tests: set frozen + timeScale(0) to hold a
// frame for a screenshot).

const q = new URLSearchParams(location.search);
const CAR = q.get('car') ?? 'skyline-hck01';
const trackQ = q.get('track');
const COURSE: CourseId = isCourse(trackQ) ? trackQ : DEFAULT_COURSE; // ?track=<id> (tracks/ COURSES); anything else: the meadow
const COURSE_DEF = courseOf(COURSE); // its name, colour (the switch's dot, the Try button) and medal pace
const MODEL = VEHICLES[q.get('model') ?? ''] ? q.get('model')! : 'arcade';
const AUTO = q.get('auto') === '1';
const LAPS = Math.min(9, Math.max(1, Math.round(Number(q.get('laps')) || 3)));
const FAST = Math.min(16, Math.max(1, Math.round(Number(q.get('fast')) || 1))); // tests: run the sim N x real time
const KMH = 4.3; // u/s -> km/h at toy scale
// u/s: the medal pace, the autopilot's average speed over 3 laps per course and car (each course's `pars`, in its
// tracks/<course>.ts: a key is any word of the car's id, '*' the stock car's); medals at x1.03 / 1.10 / 1.20 of laps x
// length / PAR. A course without a car's number takes the default course's: the same pace, so its par time is the
// meadow's scaled by the lap's length.
const parIn = (row: Record<string, number>): number | undefined =>
  CAR.toLowerCase().split('-').map((w) => row[w]).find((x) => x !== undefined) ?? row['*'];
const PAR = parIn(COURSE_DEF.pars) ?? parIn(courseOf(DEFAULT_COURSE).pars)!;
const HARD_HIT = 25; // u/s square into a wall: an extra camera kick and a hard buzz (the camera scales its own shake by the hit)
const BOOST_NAMES = ['', 'Boost', 'Super boost', 'Ultra boost', 'Hyper boost!']; // 4: the hidden 'magic max' tier
/** Hay bales are the wall here (the dirt's barriers, and the far edge of every verge; as the vehicle's wallOf). */
const isHay = (f: TrackFrame) => f.edge === 'grass' || (f.edge === 'barrier' && f.surface === 'dirt');

interface Best { lap?: number; total?: number; splits?: number[]; air?: number } // air: the longest flight (s), landed
/** Bests are kept per car and per course: the key carries the course (the meadow's has none - it predates track 2, and
 *  keeps the bests already set: ripcars.drive.<car>.<length>, the sky's ripcars.drive.<car>.sky.<length>) and the lap's
 *  length, so a new layout starts afresh (a best from an older, shorter course would stand unbeatable and skew every
 *  split). */
const bestKey = (lapLength: number) =>
  `ripcars.drive.${CAR}.${COURSE === DEFAULT_COURSE ? '' : `${COURSE}.`}${Math.round(lapLength)}`;
/** This page on a course: the same car and knobs (the meadow is the bare URL, as before track 2). */
function courseHref(id: CourseId) {
  const p = new URLSearchParams(location.search);
  if (id === DEFAULT_COURSE) p.delete('track');
  else p.set('track', id);
  const s = p.toString();
  return `${location.pathname}${s ? `?${s}` : ''}`;
}
function loadBest(key: string): Best {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '{}') ?? {};
  } catch {
    return {};
  }
}
function saveBest(key: string, b: Best) {
  try {
    localStorage.setItem(key, JSON.stringify(b));
  } catch {
    // private mode / storage off: the best only lasts this visit
  }
}

async function main() {
  const hud = createHud(document.getElementById('hud')!);
  hud.setCourse(COURSE_DEF.name, COURSE_DEF.color);
  // the top bar: a track switch before the car picker (both reload the page, keeping the other's pick and the knobs)
  const options = COURSES.map((c) => ({ name: c.name, href: courseHref(c.id), on: c.id === COURSE, title: c.blurb, color: c.color }));
  mountNav('drive', { switch: { label: 'Track', options } }).then((n) => n.setCar(CAR));
  const canvas = document.getElementById('c') as HTMLCanvasElement;

  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(devicePixelRatio, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor('#0d0e12');

  const scene = new THREE.Scene();
  const track = buildTrack(COURSE);
  scene.add(track.object);
  const world = buildWorld(scene, renderer, track);

  let rig: Rig, create: VehicleFactory;
  try {
    const [r, m] = await Promise.all([loadRig(CAR), VEHICLES[MODEL]()]);
    rig = r;
    create = m.create;
  } catch (err) {
    console.error(err);
    hud.error(`No drivable 3D model for <b>${CAR}</b> yet.<br><a href="/">Rip a pack</a> and take a modelled car for a spin.`);
    document.getElementById('boot')?.remove();
    Object.assign(window as any, { __ready: true });
    return;
  }
  scene.add(rig.root);
  const vehicle = await create(track, rig.spec);
  const st = vehicle.state;
  const meta = rig.spec.meta as { make?: string; model?: string; rarity?: string };
  const tier = tierOf(String(meta.rarity ?? 'common'));
  const carName = [meta.make, meta.model].filter(Boolean).join(' ') || CAR;
  hud.setCar(carName, tier.color);
  document.title = `Drive · ${carName} · ${COURSE_DEF.name} · RIPCARS`;

  const cam = createChaseCamera();
  scene.add(cam.camera); // anything parented to the camera renders too
  const fx = createFx(scene, rig.spec, new THREE.Color(tier.color));
  const audio = createAudio();
  fx.setTrack(track); // the surface under each tyre and what the walls are made of
  audio.setTrack(track);
  audio.setCar(rig.spec); // its own engine
  const input = createInput(canvas);
  hud.onMute((m) => audio.setMuted(m));
  const tune = q.get('tune'); // a dev tool: its code only loads when asked for
  if (tune === '1' || tune === 'camera') import('./tune').then((t) => t.mountTune(tune === '1' ? vehicle.tuning : CAMERA, tune === '1' ? MODEL : 'camera'));

  // What the modules see each frame: the sim state with its pose interpolated between the last two steps.
  const prevP = new THREE.Vector3(), prevQ = new THREE.Quaternion();
  const rs: VehicleState = {
    ...st, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), accelLocal: new THREE.Vector3(),
  };
  const snap = () => {
    prevP.copy(st.position);
    prevQ.copy(st.quaternion);
  };
  function sync(alpha: number) {
    rs.position.lerpVectors(prevP, st.position, alpha);
    rs.quaternion.slerpQuaternions(prevQ, st.quaternion, alpha);
    rs.velocity.copy(st.velocity);
    rs.accelLocal.copy(st.accelLocal);
    rs.speed = st.speed;
    rs.steerVisual = st.steerVisual;
    rs.wheelSpinRate = st.wheelSpinRate;
    rs.slip = st.slip;
    rs.drifting = st.drifting;
    rs.driftTier = st.driftTier;
    rs.boosting = st.boosting;
    rs.boostStack = st.boostStack;
    rs.grounded = st.grounded;
    rs.trackS = st.trackS;
    rs.lapDelta = st.lapDelta;
    rs.events = st.events;
    rs.wrongWay = st.wrongWay;
    rig.root.position.copy(rs.position);
    rig.root.quaternion.copy(rs.quaternion);
  }
  const clearEvents = () => {
    const e = st.events;
    e.wallHit = e.landed = undefined;
    e.perfectLanding = e.boostStart = e.airborne = e.respawn = e.spinOut = e.stackUp = undefined;
    e.tierUp = undefined;
  };

  // ---- race state
  const IDLE: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };
  let input0: DriveInput = IDLE;
  let phase: 'gate' | 'race' | 'done' = 'gate';
  let time = 0, lapStart = 0, lapMax = 0, nextSplit = 1, lastTier = 0, far = false, wrong = false;
  let clock = 0, airFrom = -1; // sim time (every step, any phase), and when the car last left the ground
  // flights timed in the sim's steps (off the ground to touching down): this race's longest, and one that just beat
  // the record (for the landing's toast; 0: none). Only a flight that lands counts (a miss is put back, not timed).
  let wasGrounded = true, flyFrom = 0, raceAir = 0, recordAir = 0;
  const AIR_MIN = 0.9; // s: a flight shorter than this is a hop, not a record
  const hitF = track.frameAt(0); // scratch: the frame at a hard hit (what the wall is made of)
  const lapTimes: number[] = [], splits = [0, 0];
  const BEST = bestKey(track.length);
  const best = loadBest(BEST);
  let bestAtStart: Best = { ...best };
  const L = track.length;
  const rel = (s: number) => (((s - track.start) % L) + L) % L;
  const drive = {
    state: st, lap: 0, laps: LAPS, model: MODEL, car: CAR, course: COURSE, time: 0, phase: phase as string,
    lapTimes,
    timeScale(_x: number) {}, // tests: slow or stop the sim
    frozen: false, // tests: hold the frame exactly as it is (sim, camera and effects) for a screenshot
    stats: { respawn: 0, air: 0, perfect: 0, hardHit: 0, spinOut: 0, wrongWay: 0 }, // tests: event counts (per rendered frame)
    info: renderer.info, // tests: draw calls and triangles of the last frame
  };
  Object.assign(window as any, { __drive: drive });

  function reset(go: boolean) {
    vehicle.reset(track.start);
    clearEvents();
    snap();
    sync(1);
    cam.reset(rs, track, rig.root);
    fx.reset();
    time = lapStart = lapMax = 0;
    far = false;
    nextSplit = 1;
    lapTimes.length = 0;
    raceAir = recordAir = 0;
    wasGrounded = true;
    bestAtStart = { ...best };
    hud.hideResults();
    hud.setLap(1, LAPS);
    hud.setTimes(0, 0, best.lap ?? null);
    phase = 'gate';
    hud.gate(!go, input.touch);
    if (go) start();
  }
  function start() {
    phase = 'race';
    hud.gate(false, input.touch);
    hud.toast('Go!', tier.color);
  }

  function onLap(t: number) {
    lapTimes.push(t);
    if (best.lap != null) hud.split(t - best.lap); // the lap against your best, at the line
    if (best.lap == null || t < best.lap) {
      if (best.lap != null) hud.toast('Best lap', tier.color);
      best.lap = t;
      best.splits = [...splits];
      saveBest(BEST, best);
    }
  }
  function onSplit(i: number) {
    const ref = best.splits?.[i]; // your best lap so far, this race included
    if (ref) hud.split(splits[i] - ref);
  }
  function finish() {
    phase = 'done';
    const total = time;
    hud.setTimes(lapTimes[lapTimes.length - 1], total, best.lap ?? null, true);
    const bestLap = Math.min(...lapTimes);
    const newBestTotal = best.total == null || total < best.total;
    if (newBestTotal) {
      best.total = total;
      saveBest(BEST, best);
    }
    const ratio = total / ((LAPS * L) / PAR);
    const result: RaceResult = {
      total, laps: [...lapTimes], bestLap,
      newBestLap: bestAtStart.lap != null && bestLap < bestAtStart.lap,
      newBestTotal: newBestTotal && bestAtStart.total != null,
      medal: ratio <= 1.03 ? 'gold' : ratio <= 1.1 ? 'silver' : ratio <= 1.2 ? 'bronze' : null,
      air: raceAir >= AIR_MIN ? raceAir : undefined, airRecord: best.air,
      newAir: raceAir >= AIR_MIN && bestAtStart.air != null && raceAir > bestAtStart.air,
    };
    const next = COURSES[(COURSES.findIndex((c) => c.id === COURSE) + 1) % COURSES.length]; // the other course
    const other = next.id === COURSE ? undefined : { name: next.name, href: courseHref(next.id), color: next.color };
    hud.results(result, () => reset(true), () => (location.href = `/?car=${encodeURIComponent(CAR)}`), other);
    fx.confetti(st.position, 160);
  }

  input.onRestart(() => reset(true));
  input.firstInput.then(() => {
    audio.unlock();
    if (phase === 'gate') start();
  });
  addEventListener('keydown', (e) => {
    if (phase === 'done' && (e.code === 'Enter' || e.code === 'NumpadEnter')) reset(true);
  });

  // ---- view
  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    cam.resize(w, h);
  };
  addEventListener('resize', resize);
  resize();
  reset(AUTO);
  await renderer.compileAsync(scene, cam.camera).catch(() => {}); // no shader hitch on the first frame
  document.getElementById('boot')?.remove();

  let frames = 0, ftAvg = 1 / 60, cooldown = 3;
  const adaptive = !navigator.webdriver; // headless runs are slow by nature; keep their resolution
  const showFps = q.get('fps') === '1';

  const loop = startLoop({
    maxSteps: 8 * FAST,
    step(h) {
      if (drive.frozen) return;
      let inp: DriveInput;
      if (phase === 'race') inp = AUTO ? input.autopilot(st, track) : input.read(h);
      else if (phase === 'done') {
        input.read(h); // keep polling pads (restart)
        inp = input.autopilot(st, track); // a victory lap behind the results
        inp.throttle = 0.6;
      } else {
        input.read(h); // the gate: wait for the first input (pads are polled here)
        input0 = IDLE;
        return;
      }
      input0 = inp;
      snap();
      vehicle.step(h, inp);
      clock += h;
      if (st.events.respawn) snap(); // no streak across a teleport
      if (phase !== 'race') return;
      time += h;
      // the flight record (per car and course, kept with the bests): announced when one from an earlier race is beaten
      if (wasGrounded && !st.grounded) flyFrom = clock;
      else if (!wasGrounded && st.grounded && !st.events.respawn) {
        const air = clock - flyFrom;
        if (air >= AIR_MIN) {
          raceAir = Math.max(raceAir, air);
          if (best.air == null || air > best.air) {
            if (bestAtStart.air != null) recordAir = air; // (a first race only sets it)
            best.air = air;
            saveBest(BEST, best);
          }
        }
      }
      wasGrounded = st.grounded;
      // A lap counts when the car crosses the line forward having been round the far side since the last one: no
      // lap for starting on the line (a reset can land a hair behind it) or for backing over it and driving on again.
      const r = rel(st.trackS);
      if (r > L * 0.5 && r < L * 0.9) far = true;
      if (st.lapDelta > 0 && far) {
        far = false;
        lapMax++;
        onLap(time - lapStart);
        lapStart = time;
        nextSplit = 1;
        if (lapMax >= LAPS) finish();
        else hud.setLap(lapMax + 1, LAPS);
      } else if (nextSplit <= 2) {
        const at = (nextSplit * L) / 3;
        if (r >= at && r < at + 40) {
          splits[nextSplit - 1] = time - lapStart;
          onSplit(nextSplit - 1);
          nextSplit++;
        }
      }
    },

    render(alpha, dt) {
      if (drive.frozen) return void renderer.render(scene, cam.camera);
      sync(alpha);
      rig.update(rs, dt);
      world.update(rs, dt);
      cam.update(rs, dt, track, rig.root);
      fx.update(rs, dt, rig.root);
      audio.update(rs, input0, dt);

      const ev = st.events, n = drive.stats;
      if (ev.respawn) n.respawn++;
      if (ev.airborne) n.air++;
      if (ev.perfectLanding) n.perfect++;
      if (ev.spinOut) n.spinOut++;
      // how long the car was in the air, on the frame it lands (a big flight's landing says so)
      if (ev.airborne) airFrom = clock;
      const air = ev.landed !== undefined && airFrom >= 0 ? clock - airFrom : 0;
      if (ev.landed !== undefined || ev.respawn) airFrom = -1;
      if (ev.wallHit && ev.wallHit > HARD_HIT) {
        n.hardHit++;
        // on top of the camera's own shake for the hit - not for hay, which swallows it (that shake still says how hard)
        const hay = isHay(track.frameAt(st.trackS, hitF));
        if (!hay) cam.addTrauma(Math.min(0.35, 0.15 + (ev.wallHit - HARD_HIT) * 0.02));
        input.rumble(ev.spinOut ? 1 : hay ? 0.5 : 0.8, ev.spinOut ? 160 : 90);
      } else if (ev.wallHit && ev.wallHit > 8) input.rumble(Math.min(0.6, ev.wallHit / 40), 50);
      // a long flight comes down with a thump (the big jump's ramp takes it gently, ~6 u/s: under a plain landing's 8)
      else if (air > 1.5) input.rumble(Math.min(1, 0.45 + 0.2 * air), 150);
      else if (ev.landed && ev.landed > 8) input.rumble(Math.min(1, ev.landed / 25), 70);
      else if (ev.boostStart) input.rumble(0.3, 120);
      const big = air > 1.5 ? ` ${air.toFixed(1)} s` : '';
      const stackX = ev.stackUp ? ` x${ev.stackUp}` : ''; // a boost stacked onto one still running
      if (recordAir > 0) {
        hud.toast(`${ev.perfectLanding ? 'Perfect!' : 'Big air'} ${recordAir.toFixed(1)} s, record!`, '#ffd23d');
        recordAir = 0;
      } else if (ev.perfectLanding) hud.toast(`Perfect!${big}${stackX}`, '#3ddc84');
      else if (big) hud.toast(`Big air${big}`);
      else if (ev.tierUp === 4) hud.toast('Max drift!', '#fff', 'max'); // the hidden tier: a surprise
      else if (ev.boostStart && lastTier > 0) {
        const c = lastTier === 4 ? '#fff' : lastTier === 3 ? tier.color : lastTier === 2 ? '#a35cff' : '#3d8bff';
        hud.toast(BOOST_NAMES[lastTier] + stackX, c, lastTier === 4 ? 'max' : undefined);
      } else if (stackX) hud.toast(`Boost${stackX}`, '#ffb000');
      if (ev.respawn) hud.flash();
      lastTier = st.driftTier;
      clearEvents();
      const w = phase === 'race' && !!st.wrongWay;
      if (w !== wrong) {
        wrong = w;
        if (w) n.wrongWay++;
        hud.wrongWay(w);
      }

      hud.setSpeed(st.speed * KMH);
      if (phase === 'race') hud.setTimes(time - lapStart, time, best.lap ?? null);
      drive.lap = lapMax;
      drive.time = time;
      drive.phase = phase;
      renderer.render(scene, cam.camera);

      if (++frames === 3) Object.assign(window as any, { __ready: true });
      if (showFps) hud.fps(dt);
      if (adaptive && frames > 90) {
        // keep 60 fps on mid phones: drop the resolution a notch while frames run long
        ftAvg += (dt - ftAvg) * 0.05;
        cooldown -= dt;
        if (cooldown <= 0 && ftAvg > 0.018 && dpr > 0.75) {
          dpr = Math.max(0.75, dpr - 0.25);
          renderer.setPixelRatio(dpr);
          resize();
          cooldown = 2;
          ftAvg = 1 / 60;
        }
      }
    },
  });
  if (FAST > 1) loop.setTimeScale(FAST);
  drive.timeScale = (x: number) => loop.setTimeScale(x * FAST);
}

main();
