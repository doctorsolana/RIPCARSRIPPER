import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { carFile } from '../catalog';
import { splitGlass } from '../glass';
import type { CarSpec, VehicleState, WheelSpec } from './types';

// The revealed car as a drivable rig. The GLB is used exactly as the inspector shows it (its own
// MeshStandardMaterial plus see-through glass), regrouped as
//   root -> model (ride height) -> tilt (pitch/roll/heave springs, pivot at the axle centre) -> body
//                               -> wheel pivot -> steer (rotation.y, fronts only) -> spin (rotation.z) -> wheel
// Model frame: nose +x, up +y, right +z. The lowest tyre touches y = 0 of `root`, so the vehicle
// puts the model origin on the driving surface. The main loop sets root's transform from the pose.

export interface Rig {
  root: THREE.Group;
  spec: CarSpec;
  update(state: VehicleState, dt: number): void;
  dispose(): void;
}

const VTOP = 44; // nominal top speed (u/s) that the speed-scaled visuals are tuned against
const DEG = Math.PI / 180;
const H_SPRING = 1 / 120;
const MAX_SPIN_STEP = 0.6; // rad per rendered frame: more reads as spinning backwards (wagon wheel)
const TAU = Math.PI * 2;

interface Wheel { spin: THREE.Group; steer: THREE.Group | null; sign: number; rear: boolean; theta: number }
interface Spr { x: number; v: number }

const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** The glass pass draws the whole body again and its shader throws away every texel that isn't glass (roughness G
 *  under 0.2), so ~13k triangles go through it for the ~1k that reach a window. Keep just those: read the map small
 *  (384 px, glass taken generously and grown by a pixel so a window's edge is never lost) and keep each triangle with
 *  a glass sample on a grid over it (finer for bigger triangles). Keeping a few too many costs nothing visible; if the
 *  map can't be read (no image, a transformed map, a canvas that won't give pixels) the glass keeps the full body. */
function trimGlass(glass: THREE.Mesh) {
  const t = (glass.material as THREE.MeshStandardMaterial).roughnessMap;
  const img = t?.image as (CanvasImageSource & { width: number; height: number }) | undefined;
  const g = glass.geometry, uv = g.getAttribute('uv'), index = g.index;
  if (!t || !img?.width || !uv || !index || t.channel !== 0 || t.rotation !== 0 || t.offset.lengthSq() !== 0 || t.repeat.x !== 1 || t.repeat.y !== 1) return;
  const N = 384, mask = new Uint8Array(N * N);
  try {
    const cv = document.createElement('canvas');
    cv.width = cv.height = N;
    const cx = cv.getContext('2d', { willReadFrequently: true })!;
    cx.drawImage(img, 0, 0, N, N);
    const px = cx.getImageData(0, 0, N, N).data;
    for (let i = 0; i < N * N; i++) {
      if (px[i * 4 + 1] >= 77) continue; // G < 0.3: glass, or blended with it
      const x = i % N, y = (i / N) | 0;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) mask[((y + dy + N) % N) * N + ((x + dx + N) % N)] = 1;
    }
  } catch {
    return;
  }
  const wrap = (x: number) => x - Math.floor(x); // the map repeats
  const at = (u: number, v: number) =>
    mask[Math.min(N - 1, Math.floor(wrap(t.flipY ? 1 - v : v) * N)) * N + Math.min(N - 1, Math.floor(wrap(u) * N))] === 1;
  const keep: number[] = [];
  for (let i = 0; i < index.count; i += 3) {
    const a = index.getX(i), b = index.getX(i + 1), c = index.getX(i + 2);
    const ua = uv.getX(a), va = uv.getY(a), ub = uv.getX(b), vb = uv.getY(b), uc = uv.getX(c), vc = uv.getY(c);
    const edge = Math.max(Math.hypot(ub - ua, vb - va), Math.hypot(uc - ub, vc - vb), Math.hypot(ua - uc, va - vc)) * N;
    const n = Math.min(24, Math.max(1, Math.ceil(edge / 1.5)));
    let hit = false;
    for (let p = 0; p <= n && !hit; p++) for (let q = 0; q <= n - p && !hit; q++) {
      const r = n - p - q;
      hit = at((p * ua + q * ub + r * uc) / n, (p * va + q * vb + r * vc) / n);
    }
    if (hit) keep.push(a, b, c);
  }
  const sub = new THREE.BufferGeometry(); // the body's own attributes (one GPU copy), just the windows' triangles
  for (const [name, attr] of Object.entries(g.attributes)) sub.setAttribute(name, attr);
  sub.setIndex(keep);
  sub.boundingSphere = g.boundingSphere ? g.boundingSphere.clone() : null;
  if (!sub.boundingSphere) sub.computeBoundingSphere();
  glass.geometry = sub;
}

export async function loadRig(carId: string): Promise<Rig> {
  const json = (f: string) => fetch(carFile(carId, f)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [info, meta, gltf] = await Promise.all([json('model.json'), json('meta.json'), new GLTFLoader().loadAsync(carFile(carId, 'model.glb'))]);
  const model = gltf.scene;
  const body = (model.getObjectByName('body') as THREE.Mesh | undefined) ?? (model.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh);
  const pivots = model.children.filter((o) => o.name.startsWith('wheel_'));

  const wheelsSpec: WheelSpec[] = Array.isArray(info?.wheels)
    ? info.wheels.map((w: WheelSpec) => ({ name: w.name, centre: [w.centre[0], w.centre[1], w.centre[2]], r: w.r }))
    : pivots.map((p) => ({ name: p.name, centre: [p.position.x, p.position.y, p.position.z], r: p.position.y }));
  const dims = info?.dimensions ?? {};
  const spec: CarSpec = {
    id: carId,
    length: dims.length ?? 4,
    width: dims.width ?? 1.5,
    height: dims.height ?? 1.2,
    wheels: wheelsSpec,
    meta: meta ?? {},
  };

  // Ride height: tyre bottoms sit a hair off y = 0 in the GLB (+0.02 .. -0.01); put the lowest on it.
  const ground = wheelsSpec.length ? Math.min(...wheelsSpec.map((w) => w.centre[1] - w.r)) : 0;
  model.position.y = -ground;
  const axle = new THREE.Vector3();
  for (const w of wheelsSpec) axle.add(new THREE.Vector3(...w.centre));
  if (wheelsSpec.length) axle.divideScalar(wheelsSpec.length);
  else axle.set(0, 0.3, 0);
  axle.z = 0;

  // Body in a tilt group pivoting at the axle centre; the wheels stay planted.
  model.updateMatrixWorld(true);
  const tilt = new THREE.Group();
  tilt.name = 'tilt';
  tilt.position.copy(axle);
  model.add(tilt);
  model.updateMatrixWorld(true);
  if (body) {
    tilt.attach(body);
    const glass = splitGlass(body); // see-through windows into a dark cabin (glass mesh is a child of the body)
    if (glass) trimGlass(glass);
  }

  const wheels: Wheel[] = [];
  for (const pivot of pivots) {
    const steer = new THREE.Group();
    const spin = new THREE.Group();
    for (const c of pivot.children.slice()) spin.add(c);
    steer.add(spin);
    pivot.add(steer);
    const front = pivot.name.includes('front');
    // left pivots are turned 180 deg about y: the same steer sign turns them the same way, spin flips
    wheels.push({ spin, steer: front ? steer : null, sign: pivot.name.endsWith('left') ? -1 : 1, rear: !front, theta: 0 });
  }

  const root = new THREE.Group();
  root.name = `car-${carId}`;
  root.add(model);

  // Per-car flavour (feel only): the Impala floats on soft hydraulics and hops into drifts,
  // the race Porsche sits stiff.
  const name = `${carId} ${String((meta as Record<string, unknown> | null)?.model ?? '')}`.toLowerCase();
  const lowrider = name.includes('impala');
  const racer = name.includes('gt3') || name.includes('roxy');
  const omega = lowrider ? 7.5 : racer ? 13 : 11;
  const zeta = lowrider ? 0.3 : 0.5;
  const hop = lowrider ? 2.1 : 0.75; // u/s of heave kick when a drift starts
  const heaveMin = -0.075, heaveMax = lowrider ? 0.16 : 0.06;

  const pitch: Spr = { x: 0, v: 0 }, roll: Spr = { x: 0, v: 0 }, heave: Spr = { x: 0, v: 0 };
  const spring = (s: Spr, target: number, h: number) => {
    s.v += (-2 * zeta * omega * s.v - omega * omega * (s.x - target)) * h;
    s.x += s.v * h;
  };
  const inv = new THREE.Quaternion();
  const vl = new THREE.Vector3();
  let steerAngle = 0, driftW = 0, wasDrifting = false;

  function update(state: VehicleState, dt: number) {
    const h = clamp(dt, 0, 0.1);
    const k = Math.min(state.speed / VTOP, 1);

    // Front wheels: steer that tightens with speed; in a drift they counter-steer toward the
    // direction of travel (the strongest drift cue), with a little of the player's input on top.
    inv.copy(state.quaternion).invert();
    vl.copy(state.velocity).applyQuaternion(inv);
    driftW += ((state.drifting && state.grounded ? 1 : 0) - driftW) * (1 - Math.exp(-h / 0.07));
    const grip = state.steerVisual * (28 + (9 - 28) * k) * DEG;
    const travel = vl.x > 2 ? Math.atan2(vl.z, vl.x) : 0; // + = travelling to the right of the nose
    const counter = clamp(travel * 0.9 + state.steerVisual * 10 * DEG, -34 * DEG, 34 * DEG);
    steerAngle += (grip + (counter - grip) * driftW - steerAngle) * (1 - Math.exp(-h / 0.035));

    const rearBoost = 1 + 0.35 * driftW; // rears spin up in a drift
    for (const w of wheels) {
      if (w.steer) w.steer.rotation.y = -steerAngle; // +y turns the nose left, so right steer is negative
      const step = clamp(state.wheelSpinRate * h * (w.rear ? rearBoost : 1), -MAX_SPIN_STEP, MAX_SPIN_STEP);
      w.theta = (w.theta + step) % TAU;
      w.spin.rotation.z = -w.sign * w.theta; // rolling forward is negative z on the right side
    }

    // Body: pitch from longitudinal accel (nose up when accelerating), roll away from the turn,
    // heave against vertical load; all on springs. Airborne the suspension droops (body up).
    const ev = state.events;
    if (ev.landed) {
      const v = Math.min(ev.landed, 25);
      heave.v -= v * 0.1;
      pitch.v -= v * 0.012;
    }
    if (state.drifting && !wasDrifting && state.grounded) heave.v += hop;
    wasDrifting = state.drifting;
    const a = state.accelLocal;
    const air = !state.grounded;
    const tp = air ? 0 : clamp(a.x * 0.1 * DEG, -3 * DEG, 3 * DEG);
    const tr = air ? 0 : clamp(-a.z * 0.08 * DEG, -4.5 * DEG, 4.5 * DEG);
    const th = air ? 0.035 : clamp(-a.y * 0.0008, -0.05, 0.035);
    for (let t = h; t > 1e-6; t -= H_SPRING) {
      const s = Math.min(t, H_SPRING);
      spring(pitch, tp, s);
      spring(roll, tr, s);
      spring(heave, th, s);
    }
    if (heave.x < heaveMin) {
      heave.x = heaveMin; // bump stop
      heave.v = Math.max(heave.v, 0);
    } else if (heave.x > heaveMax) {
      heave.x = heaveMax;
      heave.v = Math.min(heave.v, 0);
    }
    tilt.rotation.set(roll.x, 0, pitch.x);
    tilt.position.y = axle.y + heave.x;
  }

  function dispose() {
    root.removeFromParent();
    const seen = new Set<unknown>();
    root.traverse((o) => {
      if (!(o instanceof THREE.Mesh)) return;
      if (!seen.has(o.geometry)) {
        seen.add(o.geometry);
        o.geometry.dispose();
      }
      for (const m of Array.isArray(o.material) ? o.material : [o.material]) {
        if (seen.has(m)) continue;
        seen.add(m);
        for (const v of Object.values(m)) {
          if (v instanceof THREE.Texture && !seen.has(v)) {
            seen.add(v);
            v.dispose();
          }
        }
        m.dispose();
      }
    });
  }

  return { root, spec, update, dispose };
}
