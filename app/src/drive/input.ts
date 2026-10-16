import * as THREE from 'three';
import type { DriveInput, Surface, Track, TrackFrame, TrafficView, VehicleState } from './types';
import type { Profile } from './vehicles/arcade';

// Keyboard, gamepad and touch merged into one DriveInput, plus an autopilot for ?auto=1 and tests.
//   keys   A/D or arrows steer, W/up throttle, S/down brake (reverse), Space/Shift drift, R restart
//   pad    left stick (deadzone 0.12, |x|^1.6) or d-pad, RT throttle, LT brake, A/RB drift, Start/Y restart
//   touch  one thumb: drag anywhere to steer (6 px deadzone, full lock at 70 px; past that the anchor
//          follows the finger, so steering back never needs a long swipe). The car accelerates by itself.
//          Drift: a second finger, or hold full lock for 150 ms - a tap either way: the drift runs by itself until the
//          car is straight again (centre the thumb or lift it), which fires the boost. There's no touch brake.
// Steering slews 6/s turning in and 12/s coming back; a drift press counts as held for at least 150 ms (a tap: the car
// goes loose on the press and stays loose by itself - holding the button changes nothing). Both run on the sim's steps
// (read(h) once per step), so the DriveInput stream is a function of what's held at each step.

export interface InputSource {
  read(dt: number): DriveInput;
  autopilot(state: VehicleState, track: Track): DriveInput;
  onRestart(cb: () => void): void;
  /** Resolves on the first key, tap, click or pad button (drops the gate, unlocks audio). */
  firstInput: Promise<void>;
  /** The player is on touch (auto-throttle on). */
  readonly touch: boolean;
  /** Haptics: gamepad rumble, or a short buzz on Android touch. strength 0..1. */
  rumble(strength: number, ms: number): void;
}

export const STEER_IN = 6, STEER_OUT = 12; // per s (online play checks a client's steering against STEER_OUT: net/protocol.ts)
const DRIFT_BUFFER = 150; // ms
const TOUCH_DEAD = 6, TOUCH_FULL = 70; // px
const AUTO_DRIFT = 150, LIFT_GRACE = 100, CENTRE_RELEASE = 250; // ms
const PAD_DEAD = 0.12;
const GAME_KEYS = new Set(['Space', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'ShiftLeft', 'ShiftRight']);

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smooth01 = (x: number) => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * (3 - 2 * x));

export function createInput(target: HTMLElement): InputSource {
  const out: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };
  const keys = new Set<string>();
  const restartCbs: (() => void)[] = [];
  let touchMode = matchMedia('(pointer: coarse)').matches;
  let clock = 0, lastDriftPress = -1e9, prevDriftHeld = false; // clock: s of sim steps read
  let tapped = false; // a drift press since the last step (a tap quicker than a frame still counts)
  let started = false;
  let resolveFirst = () => {};
  const firstInput = new Promise<void>((r) => (resolveFirst = r));
  const first = () => {
    if (!started) {
      started = true;
      resolveFirst();
    }
  };
  const restart = () => restartCbs.forEach((cb) => cb());

  // ---- keyboard
  const inField = (e: Event) => {
    const t = e.target as HTMLElement | null;
    return !!t && (t.tagName === 'INPUT' || t.tagName === 'SELECT' || t.tagName === 'TEXTAREA' || t.isContentEditable);
  };
  addEventListener('keydown', (e) => {
    if (inField(e) || e.metaKey || e.ctrlKey || e.altKey || e.code === 'Tab' || e.code === 'Escape') return;
    if (GAME_KEYS.has(e.code)) e.preventDefault();
    if (e.repeat) return;
    keys.add(e.code);
    if (e.code === 'Space' || e.code === 'ShiftLeft' || e.code === 'ShiftRight') tapped = true;
    touchMode = false;
    if (e.code === 'KeyR') restart();
    first();
  });
  addEventListener('keyup', (e) => keys.delete(e.code));
  addEventListener('blur', () => keys.clear());

  // ---- touch (pointer events; a mouse click only counts as "start")
  let steerId = -1, anchor = 0, steerX = 0, lastDx = 0, liftedAt = -1e9, fullSince = -1, centredSince = -1;
  let latch = false;
  const others = new Set<number>();
  target.addEventListener('contextmenu', (e) => e.preventDefault());
  target.addEventListener(
    'pointerdown',
    (e) => {
      first();
      if (e.pointerType === 'mouse') return;
      e.preventDefault();
      touchMode = true;
      if (steerId < 0) {
        steerId = e.pointerId;
        steerX = e.clientX;
        // a re-grab right after a lift keeps the stick where it was
        anchor = performance.now() - liftedAt < LIFT_GRACE ? steerX - lastDx : steerX;
        try {
          target.setPointerCapture(e.pointerId);
        } catch {
          // not capturable (synthetic event)
        }
      } else {
        others.add(e.pointerId);
        tapped = true;
      }
    },
    { passive: false },
  );
  target.addEventListener('pointermove', (e) => {
    if (e.pointerId !== steerId) return;
    steerX = e.clientX;
    if (steerX - anchor > TOUCH_FULL) anchor = steerX - TOUCH_FULL;
    else if (anchor - steerX > TOUCH_FULL) anchor = steerX + TOUCH_FULL;
  });
  const lift = (e: PointerEvent) => {
    if (e.pointerId === steerId) {
      lastDx = steerX - anchor;
      steerId = -1;
      liftedAt = performance.now();
    } else others.delete(e.pointerId);
  };
  target.addEventListener('pointerup', lift);
  target.addEventListener('pointercancel', lift);

  // ---- gamepad (polled only once one has been seen)
  let padSeen = false, padRestartPrev = false, padAt = -1e9;
  const pad: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };
  addEventListener('gamepadconnected', () => (padSeen = true));

  const ap = createAutopilot();

  return {
    get touch() {
      return touchMode;
    },
    firstInput,
    onRestart(cb: () => void) {
      restartCbs.push(cb);
    },
    autopilot: ap,
    rumble(strength: number, ms: number) {
      if (touchMode) {
        navigator.vibrate?.(Math.round(ms * 0.5));
        return;
      }
      if (!padSeen) return;
      for (const p of navigator.getGamepads()) {
        const act = (p as (Gamepad & { vibrationActuator?: { playEffect?(t: string, o: object): Promise<unknown> } }) | null)?.vibrationActuator;
        act?.playEffect?.('dual-rumble', { duration: ms, strongMagnitude: strength, weakMagnitude: Math.min(1, strength * 1.4) })?.catch(() => {});
      }
    },
    read(dt: number): DriveInput {
      const now = performance.now();
      let steerT = (keys.has('KeyD') || keys.has('ArrowRight') ? 1 : 0) - (keys.has('KeyA') || keys.has('ArrowLeft') ? 1 : 0);
      let thr = keys.has('KeyW') || keys.has('ArrowUp') ? 1 : 0;
      let brk = keys.has('KeyS') || keys.has('ArrowDown') ? 1 : 0;
      let drift = keys.has('Space') || keys.has('ShiftLeft') || keys.has('ShiftRight');

      if (padSeen && now - padAt >= 8) {
        padAt = now; // poll at most once per frame-ish, not every 1/120 s step
        pad.steer = pad.throttle = pad.brake = 0;
        pad.drift = false;
        let restartNow = false;
        for (const p of navigator.getGamepads()) {
          if (!p || !p.connected) continue;
          const b = (i: number) => p.buttons[i]?.value ?? 0;
          const x = p.axes[0] ?? 0, ax = Math.abs(x);
          let st = ax < PAD_DEAD ? 0 : Math.sign(x) * ((ax - PAD_DEAD) / (1 - PAD_DEAD)) ** 1.6;
          if (b(14) > 0.5) st = -1;
          if (b(15) > 0.5) st = 1;
          if (Math.abs(st) > Math.abs(pad.steer)) pad.steer = st;
          pad.throttle = Math.max(pad.throttle, b(7));
          pad.brake = Math.max(pad.brake, b(6));
          if (b(0) > 0.5 || b(5) > 0.5) pad.drift = true;
          if (b(9) > 0.5 || b(3) > 0.5) restartNow = true;
          let any = ax > 0.5;
          for (let i = 0; i < p.buttons.length && !any; i++) any = p.buttons[i].pressed;
          if (any) {
            touchMode = false;
            first();
          }
        }
        if (restartNow && !padRestartPrev) restart();
        padRestartPrev = restartNow;
      }
      if (padSeen) {
        if (Math.abs(pad.steer) > Math.abs(steerT)) steerT = pad.steer;
        thr = Math.max(thr, pad.throttle);
        brk = Math.max(brk, pad.brake);
        drift ||= pad.drift;
      }

      if (steerId >= 0) {
        const dx = steerX - anchor;
        const raw = Math.sign(dx) * Math.min(1, Math.max(0, Math.abs(dx) - TOUCH_DEAD) / (TOUCH_FULL - TOUCH_DEAD));
        steerT = raw;
        // one thumb: full lock held = drift; back to the middle (or lifted) = release
        if (Math.abs(raw) >= 0.98) {
          if (fullSince < 0) fullSince = now;
          else if (now - fullSince >= AUTO_DRIFT) latch = true;
        } else fullSince = -1;
        if (Math.abs(raw) < 0.3) {
          if (centredSince < 0) centredSince = now;
          else if (now - centredSince > CENTRE_RELEASE) latch = false;
        } else centredSince = -1;
      } else {
        fullSince = centredSince = -1;
        if (now - liftedAt > LIFT_GRACE) latch = false;
      }
      if (others.size > 0 || latch) drift = true;
      if (touchMode) thr = brk > 0 ? 0 : 1; // touch: the car drives itself, you steer

      clock += dt;
      if ((drift || tapped) && !prevDriftHeld) lastDriftPress = clock;
      tapped = false;
      prevDriftHeld = drift;
      out.drift = drift || clock - lastDriftPress < DRIFT_BUFFER / 1000;
      const s = out.steer;
      const rate = steerT * s < 0 || Math.abs(steerT) < Math.abs(s) ? STEER_OUT : STEER_IN;
      out.steer = s + clamp(steerT - s, -rate * dt, rate * dt);
      out.throttle = thr;
      out.brake = brk;
      return out;
    },
  };
}

function newFrame(): TrackFrame {
  return {
    s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
    right: new THREE.Vector3(0, 0, 1), kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
  };
}

// What the autopilot knows of the arcade model (its defaults; it only needs to be good, not optimal) - and of the car:
// the profile the model hangs on its state (cornering, brakes, slide, steering; without one, the stock car's).
const VTOP = 44, YAW_LOW = 3, YAW_HIGH = 1.3, YAW_RAMP = 3.2, G = 24, BANK_ASSIST = 1.5;
const SURF_YAW: Record<Surface, number> = { plastic: 1, asphalt: 1.06, dirt: 0.93 };
const GRASS_YAW = 0.75;
// Loose (a drift), the travel bends at LOOSE_GRIP x the surface's share x the slip (rad/s per rad; x LOOSE_THR on the
// throttle, LOOSE_LIFT off it) and the steering's yaw is LOOSE_YAW x grip's; it plans a drifted corner at PLAN_SLIP deg
// on the throttle (the soft limit is ~35; both x the car's angle).
const LOOSE_GRIP = 3.2, LOOSE_THR = 0.8, LOOSE_LIFT = 1.3, LOOSE_YAW = 1.25, PLAN_SLIP = 28, MAX_SLIP = 33;
const SURF_DRIFT: Record<Surface, number> = { plastic: 1, asphalt: 1.15, dirt: 0.9 };
const DRIFT_TURN = 0.6; // rad: it drifts corners turning at least this far ...
const DRIFT_R = 70; // ... at least this tight (u)
const BRAKE = 42; // u/s^2 it plans to brake with (the stock car manages ~65), x the car's brakes, less a downhill's pull
const DEG = Math.PI / 180;
// Online bots in traffic (opts.traffic; the server's): it plans for one step a call (the sim's 1/120 s) ...
const STEP = 1 / 120;
const EDGE = 0.4; // ... keeps this far off the rails (u) ...
const ROOM = 0.8; // ... and this much room beside another car (u, body to body) ...
const MERGE = 1.5; // ... eases back toward the line at most this fast (u/s: off the grid, after a pass) ...
const SHIFT = 6; // ... moves its target across the road at most this fast around other cars (u/s) ...
const SLOT = 0.25; // ... picking it from slots this far apart (u)
type Sense = Pick<Profile, 'turn' | 'brake' | 'slide' | 'angle' | 'steer' | 'float' | 'dirt'>;
const STOCK: Sense = { turn: 1, brake: 1, slide: 1, angle: 1, steer: 1, float: 1, dirt: 1 };

/** A surface's share of the car's turn and of its slide's grip (the dirt's as this car copes with it). */
const surfYaw = (s: Surface, c: Sense) => (s === 'dirt' ? Math.min(1, SURF_YAW.dirt * c.dirt) : SURF_YAW[s] ?? 1);
const surfDrift = (s: Surface, c: Sense) => (s === 'dirt' ? Math.min(1, SURF_DRIFT.dirt * c.dirt) : SURF_DRIFT[s] ?? 1);

/** The most yaw the car has in grip at speed v (rad/s), sy = the surface's share x the car's turn: down to YAW_HIGH at
 *  VTOP, and past it as 1/v. */
const yawCap = (v: number, sy: number) => sy * Math.min(v / YAW_RAMP, v < VTOP ? YAW_LOW + ((YAW_HIGH - YAW_LOW) * v) / VTOP : (YAW_HIGH * VTOP) / v);

/** The fastest the yaw lets a corner of curvature k (1/u) go: v k <= yawCap(v) + the bank's help (~1.5 g sin(bank) / v)
 *  solved for v (sb = sin of the bank into the turn). */
function yawSpeed(k: number, sy: number, sb: number) {
  const a = k + (sy * (YAW_LOW - YAW_HIGH)) / VTOP, b = sy * YAW_LOW, c = BANK_ASSIST * G * Math.max(0, sb);
  const v = (b + Math.sqrt(b * b + 4 * a * c)) / (2 * a);
  return v < VTOP ? v : Math.sqrt((sy * YAW_HIGH * VTOP + c) / k);
}

/** The fastest a corner goes: in grip; in a drift (kl = the slide's grip on the throttle, 0: no drift) the travel bends
 *  at kl x the planned slip (rad), if that's faster - as long as the nose, loose, keeps up. */
function cornerSpeed(k: number, sy: number, sb: number, kl: number, slip: number) {
  const grip = 0.97 * yawSpeed(k, sy, sb);
  return kl > 0 ? Math.max(grip, Math.min((kl * slip) / k, 0.97 * yawSpeed(k, sy * LOOSE_YAW, sb))) : grip;
}

/** A driver for ?auto=1, lap tests and the victory lap. It holds the centre line in track space (so it works round the
 *  loop): the curvature just ahead fed forward, less what a bank turns by itself, plus a correction of heading and
 *  offset toward the line, looking further ahead (gentler) on the wide roads - it doesn't cut corners into the inside
 *  wall. It plans its speed from the curvature up to 72 u ahead - each corner's speed (with this car's grip) plus what
 *  its brakes can shed before it, less a downhill's pull, skipping a jump's gap (no road there) - so it brakes into the
 *  tight ones, and hard off a hill. It drifts the corners that turn far enough and tight enough, once each (drift:
 *  'auto'; 'off' never, 'all' every corner it can; never one ending just before a big jump's run-up): a tap of Space
 *  at the turn-in, then it drives the loose car - the slip that bends the travel as the road wants, steered for through
 *  the yaw, gentler on a floaty car - and straightens out of the corner, which ends the drift by itself (it never taps
 *  mid-drift: that keeps a drift going). Into a big jump it lines up on the centre line, runs flat out over the booster
 *  and holds it straight up the ramp (no drift, no brake: the jump is its own speed and line; on track 2 the whole
 *  in-run, tag 'inrun', and the climb, tag 'climb', from 40 u before its pads), and it never steers in the air. A
 *  narrow booster pad ahead (a tag with d0..d1) it lines up on its middle. Deterministic: a function of the state and
 *  track.
 *  With `traffic` (online play's server bots: a function of the race's state, the other cars as the bot sees them) it
 *  races like a decent player, not a ghost: off the grid it keeps its lane and eases toward the line (MERGE: no dive
 *  across the pack), and it picks its line across the road among slots (SLOT apart) - near the line and where it's
 *  steering already, clear of the cars beside it (ROOM between them, and never across one), clear of the ones it's
 *  catching where they'll be - inside the narrowest the road gets over the next stretch (a funnel ahead squeezes it in
 *  early). Boxed in - no slot clear of a car beside it - it gives way to the one that has the place (ahead, or level and
 *  nearer the line): it lifts, and brakes while the road narrows, and tucks in behind; the one with the place keeps it.
 *  A car ahead in its path that it's catching: it follows at a gap rather than run into it - easing off the throttle
 *  smoothly (no on-off flicker: the pages predict a bot on the input it was last on), braking when well over - unless
 *  it's going round it. No drift with a car close by. Without `traffic` none of this runs (single player, ?auto=1:
 *  exactly as before). */
export function createAutopilot(opts: { drift?: 'auto' | 'off' | 'all'; lane?: -1 | 1; traffic?: () => TrafficView } = {}) {
  const mode = opts.drift ?? 'auto';
  // A lane split (track.split): it takes a lane as it comes up to the island - the side it's clearly on, else the other
  // one from last time (so a lap takes each in turn; `lane` fixes one) - and keeps to its middle until the lanes rejoin.
  let lane = 0, lastLane: number = opts.lane ? -opts.lane : 1;
  const out: DriveInput = { steer: 0, throttle: 1, brake: 0, drift: false };
  const f0 = newFrame(), f1 = newFrame();
  const nose = new THREE.Vector3(), tmp = new THREE.Vector3();
  let cur = -1, tapped = false;
  // in traffic (opts.traffic): the offset it keeps (u across), the one it steers for, where it was a step ago; scratch
  // for the cars near it (offset across where they'll be, room needed, beside it now, how far ahead, catching speed)
  const TR = opts.traffic;
  let hold = 0, aimT = 0, lastS = NaN;
  const nd = new Float64Array(16), nw = new Float64Array(16), nds = new Float64Array(16), ncl = new Float64Array(16);
  const nby = new Uint8Array(16), nk = new Int16Array(16);
  // Per track, once: flags (a jump's gap, a big jump's run-up from 40 u before its booster to the lip) and the
  // corners - runs of curvature one way (R < 150), each with its end, how far it turns and its tightest curvature, and
  // whether it ends close before a big jump's run-up (taken in grip: a slide still settling there launches crooked) -
  // and which corner each frame is in (-1: none).
  const GAP = 1, RUN = 2;
  let prepped: Track | null = null, flags = new Uint8Array(0), corner = new Int16Array(0), ds = 0.5;
  let kicks: { s0: number; s1: number; lane: number }[] = []; // a split's lanes' kickers: it holds straight up them
  let aims: { s0: number; s1: number; d: number; lane?: number }[] = []; // narrow booster pads (d0..d1): it lines up on their middle
  let cS1 = new Float64Array(0), cTurn = new Float64Array(0), cK = new Float64Array(0), cCalm = new Uint8Array(0);
  const idx = (s: number) => {
    const n = flags.length;
    return ((Math.round(s / ds) % n) + n) % n;
  };
  const prep = (track: Track) => {
    if (prepped === track) return;
    const fs = track.frames, n = fs.length, L = track.length;
    ds = L / n;
    flags = new Uint8Array(n);
    for (let i = 0; i < n; i++) if (track.tagAt(i * ds) === 'gap') flags[i] |= GAP;
    const back = (a: number, b: number) => (((a - b) % L) + L) % L; // how far b lies before a
    for (const j of track.tags) {
      if (j.tag !== 'bigjump') continue;
      let from = j.s0 - 60, near = 200; // its booster: the nearest before the lip (none: the last 60 u)
      for (const g of track.tags) if (g.tag === 'booster' && back(j.s0, g.s0) < near) (near = back(j.s0, g.s0)), (from = g.s0);
      for (let x = from - 40; back(j.s0, x) > 0.5 && back(j.s0, x) < 300; x += ds) flags[idx(x)] |= RUN;
    }
    // a big jump's in-run (tag 'inrun', track 2's): the whole descent is run-up - flat out, straight, no drift
    for (const g of track.tags) if (g.tag === 'inrun') for (let x = g.s0; back(g.s1, x) > 0.5 && back(g.s1, x) < L / 2; x += ds) flags[idx(x)] |= RUN;
    // ... and track 2's climb (tag 'climb': up the wall and over) is one too, from 40 u before the pads that run up to it
    for (const g of track.tags) {
      if (g.tag !== 'climb') continue;
      let from = g.s0 - 40;
      for (const b of track.tags) if (b.tag === 'booster' && back(g.s0, b.s0) < 120) from = Math.min(from, g.s0 - back(g.s0, b.s0) - 40);
      for (let x = from; back(g.s1, x) > 0.5 && back(g.s1, x) < L / 2; x += ds) flags[idx(x)] |= RUN;
    }
    kicks = track.tags.filter((g) => g.tag === 'kicker' && g.lane !== undefined).map((g) => ({ s0: g.s0, s1: g.s1, lane: g.lane! }));
    aims = track.tags.filter((g) => g.tag === 'booster' && g.d0 !== undefined).map((g) => ({ s0: g.s0, s1: g.s1, d: (g.d0! + (g.d1 ?? g.d0!)) / 2, lane: g.lane }));
    // the corners (a run may wrap round the lap's start: begin the scan where the road is straight)
    const bend = (i: number) => {
      const k = fs[i % n].kappa, tg = track.tagAt((i % n) * ds);
      return Math.abs(k) > 1 / 150 && tg !== 'loop' && tg !== 'climb' && tg !== 'gap' ? Math.sign(k) : 0;
    };
    let i0 = 0;
    while (i0 < n && bend(i0) !== 0) i0++;
    corner = new Int16Array(n).fill(-1);
    const s1s: number[] = [], turns: number[] = [], ks: number[] = [];
    for (let i = i0; i < i0 + n; ) {
      const sg = bend(i);
      if (!sg) {
        i++;
        continue;
      }
      const c = s1s.length;
      let j = i, turn = 0, kmax = 0;
      for (; j < i0 + n && bend(j) === sg; j++) {
        corner[j % n] = c;
        turn += fs[j % n].kappa * ds;
        kmax = Math.max(kmax, Math.abs(fs[j % n].kappa));
      }
      s1s.push(j * ds), turns.push(turn), ks.push(kmax);
      i = j;
    }
    cS1 = Float64Array.from(s1s), cTurn = Float64Array.from(turns), cK = Float64Array.from(ks);
    cCalm = Uint8Array.from(s1s, (e) => {
      for (let x = 0; x <= 90; x += 2) if (flags[idx(e + x)] & RUN) return 1;
      return 0;
    });
    prepped = track;
  };
  /** Whether it drifts corner c. */
  const drifts = (c: number) =>
    c >= 0 && mode !== 'off' && !cCalm[c] && Math.abs(cTurn[c]) >= (mode === 'all' ? 0.3 : DRIFT_TURN) && cK[c] >= 1 / DRIFT_R;
  /** How far (u) the end of corner c lies ahead of s. */
  const toEnd = (c: number, s: number, L: number) => {
    const x = (((cS1[c] - s) % L) + L) % L;
    return x > L / 2 ? x - L : x;
  };

  return (st: VehicleState, track: Track): DriveInput => {
    prep(track);
    const car = (st as VehicleState & { profile?: Sense }).profile ?? STOCK;
    const L = track.length;
    const f = track.frameAt(st.trackS, f0);
    nose.set(1, 0, 0).applyQuaternion(st.quaternion);
    const psi = Math.atan2(nose.dot(f.right), nose.dot(f.t));
    const d = tmp.subVectors(st.position, f.p).dot(f.right);
    const v = Math.max(st.speed, 1);
    const phi = psi - st.slip; // direction of travel relative to the track
    const verge = f.edge === 'grass' && Math.abs(d) > f.width * 0.5;
    const yawMax = yawCap(v, (verge ? GRASS_YAW : surfYaw(f.surface, car)) * car.turn);
    const sd = surfDrift(f.surface, car) * car.slide;
    const maxSlip = ((MAX_SLIP + 1) * car.angle - 1) * DEG;
    // the curvature just ahead (past the yaw's lag; a drift's slip takes longer) to feed forward; a bank turns the car
    // by itself
    const x0 = v * (st.drifting ? 0.16 * car.float : 0.07 * car.steer);
    let kff = 0;
    for (let i = 0; i < 3; i++) kff += track.frameAt(st.trackS + x0 + i * 3, f1).kappa / 3;
    const bank = (BANK_ASSIST * G * -f.right.y * v) / (v * v + 25);
    // ... and a correction of the heading and offset toward the centre line, gentler on the wide roads - and on the
    // wide plastic (track 2's stadium decks, over 16 u: the channel's quick correction weaves there at speed)
    let wp = f.surface === 'plastic' ? smooth01((f.width - 16) / 2) : 0;
    const la = f.surface === 'plastic' ? 7 + v * 0.1 + (5 + v * 0.15) * wp : 10 + v * 0.2;
    // (in a split - from 30 u before the island's point - the middle of its lane is the line)
    let aim: number | null = null, held = false; // (held: lined up straight for a kicker - traffic leaves it be)
    const sp = track.split;
    if (sp) {
      const x = (((st.trackS - sp.s0) % L) + L) % L;
      if (x > L - 30 || x < sp.s1 - sp.s0) {
        if (lane === 0) lane = opts.lane ?? (d > 1.5 ? 1 : d < -1.5 ? -1 : -lastLane);
        aim = lane * sp.centre(st.trackS);
        // (each lane is a channel of its own, as the line's correction goes; up its kicker - and the 14 u before it -
        // it holds the heading straight along the lane, whatever its line: the jump flies off the way it's pointed)
        wp = 0;
        for (const g of kicks) {
          const y = (((g.s0 - st.trackS) % L) + L) % L;
          if (g.lane === lane && (y < 14 || y > L - (g.s1 - g.s0))) (aim = d), (held = true);
        }
      } else if (lane !== 0) (lastLane = lane), (lane = 0);
    }
    // (toward a narrow booster pad ahead - within 70 u, or on it - its middle is the line; a lane's only in that lane)
    for (let i = 0; i < aims.length; i++) {
      const g = aims[i], x = (((g.s0 - st.trackS) % L) + L) % L;
      if ((x < 70 || x > L - (g.s1 - g.s0)) && (g.lane === undefined || g.lane === lane)) (aim = g.d), (held = false);
    }
    // (online bots: room for the other cars - the line it takes across the road, giving way, following)
    let cut = 1, push = 0, crowd = false;
    if (TR) {
      const { me, cars } = TR();
      const s0 = st.trackS;
      let jump = s0 - lastS;
      if (jump > L / 2) jump -= L;
      else if (jump < -L / 2) jump += L;
      if (!(Math.abs(jump) < 8)) (hold = d), (aimT = d); // (the grid, a respawn: from where it is)
      lastS = s0;
      // the road it can take: the narrowest it gets over the next ~0.9 s (its lane's, in a split), less a car's width
      const look = 8 + 0.9 * v;
      let lo = -1e9, hi = 1e9;
      for (let x = 0; x <= look; x += 3) {
        const g = track.frameAt(s0 + x, f1);
        const half = g.width * 0.5 - me.hw - EDGE;
        let l = -half, h = half;
        if (lane !== 0 && sp) {
          const e = sp.island(s0 + x) + me.hw + EDGE;
          if (lane < 0) h = Math.min(h, -e);
          else l = Math.max(l, e);
        }
        if (l > lo) lo = l;
        if (h < hi) hi = h;
      }
      if (lo > hi) lo = hi = (lo + hi) / 2;
      // the offset it keeps: a lane's middle or a pad's at once; else it eases toward the line - off the grid it
      // merges, after a pass it drifts back, never a dive across the road
      const base = Math.max(lo, Math.min(hi, aim ?? 0));
      hold = aim !== null ? base : Math.max(lo, Math.min(hi, aimT + Math.max(-MERGE * STEP, Math.min(MERGE * STEP, base - aimT))));
      // the cars that matter: beside it (any overlap along), or ahead and being caught within 1.5 s (where they'll be)
      let nn = 0;
      for (let k = 0; k < cars.length && nn < 16; k++) {
        const j = cars[k];
        if (j === me || j.gone || (me.lane !== 0 && j.lane !== 0 && j.lane !== me.lane)) continue;
        let ds = j.s - s0;
        if (ds > L / 2) ds -= L;
        else if (ds < -L / 2) ds += L;
        const Ls = me.hl + j.hl;
        if (ds < -Ls - 0.5 || ds > 40) continue;
        if (Math.abs(ds) < 12 && Math.abs(j.d - d) < 4) crowd = true;
        const by = ds <= Ls + 0.5, cl = me.vs - j.vs;
        const t = by ? 0 : cl > 0.3 ? (ds - Ls) / cl : 9;
        if (!by && t > 1.5) {
          if (ds > 0) (nds[nn] = ds), (ncl[nn] = cl), (nd[nn] = j.d), (nw[nn] = me.hw + j.hw + 0.25), (nby[nn] = 2), (nk[nn] = k), nn++;
          continue;
        }
        nd[nn] = j.d + j.vd * Math.min(t, 0.4);
        nw[nn] = me.hw + j.hw + ROOM;
        nds[nn] = ds;
        ncl[nn] = cl;
        nby[nn] = by ? 1 : 0;
        nk[nn] = k;
        nn++;
      }
      // its slot across the road: near what it keeps and where it's steering already, clear of the cars beside it (and
      // never across one), clear of those it's catching where they'll be (what it keeps, exactly, or a slot SLOT apart)
      let best = Infinity, bestC = hold, bestHard = 0, near = 0;
      for (let q = 0; q < nn; q++) if (nby[q] !== 2) near++;
      for (let c = hold, i = -1; near && c <= hi + 1e-9; c = lo + ++i * SLOT) {
        let cost = (c - hold) * (c - hold) * 0.4 + (c - aimT) * (c - aimT) * 0.2, hard = 0;
        for (let q = 0; q < nn; q++) {
          if (nby[q] === 2) continue;
          const g = Math.abs(c - nd[q]);
          if (nby[q] === 1) {
            if (g < nw[q]) hard += (nw[q] - g) * 10;
            if ((c - nd[q]) * (d - nd[q]) < 0) hard += 10;
          } else if (g < nw[q]) cost += ((nw[q] - g) * 4) / (1 + (2 * (nds[q] - me.hl)) / Math.max(ncl[q], 0.3));
        }
        if (cost + hard < best) (best = cost + hard), (bestC = c), (bestHard = hard);
      }
      // boxed in: give way to a car beside it that has the place - ahead, or level and nearer the line - lifting off,
      // and braking while the road closes in (it tucks in behind); the one with the place keeps it
      if (bestHard > 0) {
        for (let q = 0; q < nn; q++) {
          if (nby[q] !== 1) continue;
          if (Math.abs(bestC - nd[q]) >= nw[q] && (bestC - nd[q]) * (d - nd[q]) >= 0) continue;
          const ds = nds[q];
          if (ds > 0.5 || (ds > -0.5 && (Math.abs(nd[q]) < Math.abs(d) || (Math.abs(nd[q]) === Math.abs(d) && nk[q] < cars.indexOf(me))))) {
            cut = 0;
            if (me.vs > 3 && hi - lo < 2 * nw[q]) push = Math.max(push, 0.35);
          }
        }
      }
      // (alone on the road it steers for what it keeps; around others its slot moves over at most SHIFT)
      aimT = near ? aimT + Math.max(-SHIFT * STEP, Math.min(SHIFT * STEP, bestC - aimT)) : hold;
      if (!held) aim = aimT;
      // a car ahead in its path, being caught: follow it at a gap (1 u + 0.1 s) - easing off the throttle around the
      // speed that keeps the gap (smoothly: no on-off flicker), braking when well over
      for (let q = 0; q < nn; q++) {
        if (nds[q] <= 0) continue;
        const k = nk[q], j = cars[k], gap = nds[q] - me.hl - j.hl, cl = me.vs - j.vs;
        const tC = cl > 0.1 ? Math.max(0, gap) / cl : 9;
        const dAt = d + (aimT - d) * Math.min(1, tC / 0.6);
        if (Math.abs(j.d - dAt) >= me.hw + j.hw + 0.25) continue;
        const over = me.vs - (j.vs + Math.max(0, gap - 1 - 0.1 * Math.max(0, me.vs)) * 1.6);
        cut = Math.min(cut, Math.max(0, Math.min(1, 0.5 - over / 4)));
        if (over > 3) push = Math.max(push, Math.min(1, (over - 3) / 10));
      }
    }
    const err = (aim === null ? Math.atan2(-d, la) : Math.atan2(aim - d, la)) - phi;

    // speed: the slowest of what the corners ahead allow, each plus what braking can shed before reaching it (less
    // while a slope pulls the car on: past its top speed off a hill, the corners come up fast)
    let vWant = 99;
    const brake = BRAKE * car.brake + G * Math.min(0, f.t.y);
    for (let x = 2; x <= 72; x += 2) {
      const i = idx(st.trackS + x);
      if (flags[i] & GAP) continue; // in the air there: nothing to corner on
      const g = track.frameAt(st.trackS + x, f1);
      const k = Math.abs(g.kappa);
      if (k < 0.012) continue; // R > 80: flat out
      const kl = drifts(corner[i]) ? LOOSE_GRIP * LOOSE_THR * surfDrift(g.surface, car) * car.slide : 0;
      const vc = cornerSpeed(k, surfYaw(g.surface, car) * car.turn, -g.right.y * Math.sign(g.kappa), kl, PLAN_SLIP * car.angle * DEG);
      vWant = Math.min(vWant, Math.sqrt(vc * vc + 2 * brake * Math.max(0, x - 6)));
    }
    const runUp = (flags[idx(st.trackS)] & RUN) !== 0; // a big jump's run-up: flat out, straight at the booster

    // on the throttle unless the corners ahead want it slower: then lift, and brake when well over (a drift holds on)
    const over = runUp ? 0 : v - vWant;
    out.throttle = over > 0 && !(st.drifting && over < 4) ? 0 : 1;
    out.brake = over > 2 && st.grounded ? Math.min(1, over / 6) : 0;
    if (TR) {
      if (out.throttle > cut) out.throttle = cut;
      if (push > out.brake && st.grounded && v > 3) out.brake = push;
    }

    let steer: number;
    out.drift = false;
    if (st.drifting) {
      // Loose: the travel bends at the rear's grip on the slip, so the road's bend wants a slip; the yaw is what moves
      // the slip there (the travel's turn plus closing the gap), and the steering asks for that yaw. More bend than the
      // slide gives on the throttle: it lifts (the tail tucks in, the line tightens). Out of the corner the road wants
      // none: it straightens - its line corrected gently there (through the lagging slip a full correction weaves at
      // speed) - and the drift ends by itself once the slide has settled (a tap would keep it going).
      const want = v * kff - bank + (err * (corner[idx(st.trackS + x0)] < 0 ? 1 : 3)) / car.float;
      if (Math.abs(want) > 0.85 * LOOSE_GRIP * sd * LOOSE_THR * maxSlip) out.throttle = 0;
      const kl = LOOSE_GRIP * sd * (out.throttle > 0 ? LOOSE_THR : LOOSE_LIFT);
      const b = clamp(want / kl, -maxSlip, maxSlip);
      steer = clamp((want + ((b - st.slip) * 4) / car.float) / (LOOSE_YAW * yawMax), -1, 1);
    } else {
      steer = clamp((v * kff - bank) / yawMax + err * 2.5, -1, 1);
      // a tap at the turn-in of a corner it drifts: the corner starts within reach and the wheel is already turning in
      // (one drift per corner: a slide that ended early - a floaty car caught it straight - isn't started again there)
      tapped = false;
      if (cur >= 0 && toEnd(cur, st.trackS, L) < 0) cur = -1;
      const reach = 2 + v * 0.12;
      for (let x = 0; x <= reach && !out.drift; x += 2) {
        const c = corner[idx(st.trackS + x)];
        if (c < 0 || c === cur || !drifts(c) || toEnd(c, st.trackS, L) < v * 0.6) continue;
        // ... and the slide can hold the corner at this speed
        const g = track.frameAt(st.trackS + x, f1);
        if (v * cK[c] > 1.1 * LOOSE_GRIP * LOOSE_THR * surfDrift(g.surface, car) * car.slide * maxSlip) continue;
        const sg = Math.sign(cTurn[c]);
        if (!runUp && st.grounded && v > 18 && steer * sg > 0.15 && !crowd) (out.drift = true), (cur = c);
      }
    }
    out.steer = st.grounded ? steer : 0; // never steers in the air
    return out;
  };
}
