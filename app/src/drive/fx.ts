import * as THREE from 'three';
import type { Pose } from './camera';
import type { CarSpec, Track, TrackFrame, VehicleState } from './types';

// Driving juice, all GPU-animated: each system is one instanced draw over a ring buffer, and a frame
// only uploads the slots it spawned (no per-frame geometry rebuilds, no allocation).
//   skids   tyre strips at the rear wheels when sliding (|slip| > 6 deg) or braking hard, on asphalt and
//           plastic only; fade 6 s
//   streaks velocity-stretched quads with a white-hot core: drift sparks by tier, tier-up bursts,
//           wall sparks, landing scrapes, perfect-landing ring, boost-start burst, boost speed lines, and
//           debris under full gravity (grass clippings, dirt clods, straw, rubber crumbs)
//           (alpha-blended, not additive: added onto the bright orange track every hue went white)
//   smoke   soft billboards, each with its own colour: tyre smoke, the dust trail on dirt, dust off the
//           verge, rubber puffs off tyre walls, straw dust off hay. A puff that looms over the camera fades
//           out before it fills the screen
//   flame   twin boost flames at the exhaust, in the top-tier colour: view-aligned billboards from
//           nozzle to tip, so from behind they read as glowing discs and from the side as jets
//   trail   the big jump's boost trail: twin ribbons laid from the pipes through the flight (segment by segment,
//           world-fixed, an even brightness along each), in the car's rarity colour, spreading and fading over 1.5 s,
//           and faded where they pass close to the camera - they draw the arc across the sky for the side view
// The big jump (off a 'bigjump' lip): a launch burst (sparks off the lip, a burst out of the pipes, the flames
// flaring, plastic dust left hanging), the trail, wind lines streaming past the car in any long flight, a landing slam
// after a long one (a ring of dust thrown out along the ground, a shock ring, sparks off plastic or asphalt), and a
// perfect landing bursts in the rarity colour - a ring, a fountain, and confetti carried along with the car.
// Surfaces and walls come from the track frame under the car (setTrack): plastic / asphalt / dirt, and a
// rear tyre past the surface's edge where the edge is 'grass' is on the verge. An impact (events.wallHit,
// u/s into the wall) bursts by what the wall is made of: plastic rail - sparks when hard, else a scuff;
// tyre wall - a rubber puff and crumbs, sparks only when very hard; hay bales (the dirt's barriers, and the
// far edge of every verge) - straw and dust. A corner held on a wall while the car runs along it scrapes: a
// stream from that corner (sparks off a rail). Without a track every surface is plastic, as on the original
// toy track.
// Pass the interpolated render pose (e.g. the rig root) as `pose` so effects sit on the drawn car.

export interface Fx {
  update(state: VehicleState, dt: number, pose?: Pose): void;
  reset(): void;
  /** Optional celebration: a confetti burst at a world point (half in the car's rarity colour). */
  confetti(at: THREE.Vector3, count?: number): void;
  /** The track, so the effects know the surface under each tyre and what the walls are made of (call once). */
  setTrack(track: Track): void;
}

const VTOP = 44;
const DEG = Math.PI / 180;
const SKID_N = 1024, SKID_SEG = 0.6, SKID_FADE = 6, SKID_W = 0.26;
const STREAK_N = 768, SMOKE_N = 256, CONFETTI_N = 192, TRAIL_N = 320;
const TRAIL_SEG = 0.9, TRAIL_LIFE = 1.5, TRAIL_W = 0.3; // u between the trail's joints, its life (s) and width (u)
const GRAVITY = -32; // u/s^2 for sparks (toy scale: snappy arcs)
const SPARK_RATE = [0, 95, 130, 170]; // per rear wheel per second, by drift tier
// Colour multipliers stay modest: AgX turns anything much brighter than ~1.5 white, and the tier hue
// (blue / purple / top tier) is the point of the sparks.
const SPARK_I = 1.15, HOT_I = 2.2;
// What a tyre runs on, and what a wall is made of.
const PLASTIC = 0, ASPHALT = 1, DIRT = 2, VERGE = 3;
const RAIL = 0, TYRE = 1, HAY = 2, SOFT = 3;
const SPARK_HIT = [12, 18]; // u/s into a plastic rail / a tyre wall before an impact throws sparks (lighter: a scuff)
const TOUCH = 0.12; // u: a corner this close to a wall is on it
// Debris and dust colours (linear; the smoke shader is unlit and tone-mapped like the scene).
const C_SMOKE = new THREE.Color(0.72, 0.71, 0.7);
const C_SCUFF = new THREE.Color('#efe7df'); // plastic dust off a rail
const C_DUST = new THREE.Color('#ecdfc6'); // the dirt road's dust: much lighter than the road (sunlit), or it vanishes on it
const C_CLOD = new THREE.Color('#8a6438');
const C_VERGE = new THREE.Color('#ddd6b0'); // dry dust off the grass
const C_GRASS = [new THREE.Color('#3f7a26'), new THREE.Color('#a9cc5c'), new THREE.Color('#6fa83c'), new THREE.Color('#5a3d24')]; // + a clod of earth (contrast on the grass)
const C_STRAW = [new THREE.Color('#f2d67e'), new THREE.Color('#dcb550'), new THREE.Color('#c49b3d')];
const C_CHAFF = new THREE.Color('#e8d9a6'); // straw dust
const C_RUBBER = new THREE.Color('#4d4945'); // a puff of tyre-wall rubber (a shade lighter than the road, or it vanishes)
const C_CRUMB = new THREE.Color('#1c1b1a');

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const clamp = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);
const smoothstep = (a: number, b: number, x: number) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};

// ---- ring-buffer pool with partial uploads --------------------------------------------------------
class Pool {
  readonly geo = new THREE.InstancedBufferGeometry();
  readonly attrs: THREE.InstancedBufferAttribute[] = [];
  private head = 0;
  private nr = 0;
  private full = false;
  private readonly lo = new Int32Array(4);
  private readonly hi = new Int32Array(4);
  private readonly ranges: { start: number; count: number }[][] = [];

  constructor(readonly n: number, base: THREE.BufferGeometry, layout: Record<string, number>) {
    this.geo.index = base.index;
    this.geo.setAttribute('position', base.getAttribute('position'));
    for (const [name, size] of Object.entries(layout)) {
      const a = new THREE.InstancedBufferAttribute(new Float32Array(n * size), size);
      a.setUsage(THREE.DynamicDrawUsage);
      this.geo.setAttribute(name, a);
      this.attrs.push(a);
      this.ranges.push([0, 1, 2, 3].map(() => ({ start: 0, count: 0 })));
    }
    this.clear();
  }
  arr(i: number) {
    return this.attrs[i].array as Float32Array;
  }
  next() {
    const i = this.head;
    this.head = (i + 1) % this.n;
    this.touch(i);
    return i;
  }
  touch(i: number) {
    for (let k = 0; k < this.nr; k++) {
      if (i >= this.lo[k] - 1 && i <= this.hi[k] + 1) {
        if (i < this.lo[k]) this.lo[k] = i;
        if (i > this.hi[k]) this.hi[k] = i;
        return;
      }
    }
    if (this.nr < 4) {
      this.lo[this.nr] = this.hi[this.nr] = i;
      this.nr++;
    } else this.full = true;
  }
  /** Kill every slot (birth far in the past). `birth` = [attribute index, component]. */
  clear(birth: [number, number] = [0, 3]) {
    const a = this.attrs[birth[0]];
    const arr = a.array as Float32Array;
    for (let i = 0; i < this.n; i++) arr[i * a.itemSize + birth[1]] = -1e6;
    this.head = 0;
    this.full = true;
  }
  flush() {
    if (!this.nr && !this.full) return;
    // a range still pending from a flush the renderer has not uploaded yet: upload everything
    if (this.attrs[0].updateRanges.length) this.full = true;
    for (let j = 0; j < this.attrs.length; j++) {
      const a = this.attrs[j];
      a.clearUpdateRanges();
      if (!this.full) {
        for (let k = 0; k < this.nr; k++) {
          const r = this.ranges[j][k];
          r.start = this.lo[k] * a.itemSize;
          r.count = (this.hi[k] - this.lo[k] + 1) * a.itemSize;
          a.updateRanges.push(r);
        }
      }
      a.needsUpdate = true;
    }
    this.nr = 0;
    this.full = false;
  }
}

// ---- shaders ------------------------------------------------------------------------------------------
const OUT = /* glsl */ `
  #include <tonemapping_fragment>
  #include <colorspace_fragment>`;

const STREAK_VS = /* glsl */ `
  attribute vec4 aP; // spawn position, birth time
  attribute vec4 aV; // velocity, life
  attribute vec4 aC; // linear colour (may exceed 1), width
  attribute vec4 aS; // static stretch (world), gravity scale
  uniform float uTime;
  uniform float uGravity;
  uniform float uStreak;
  varying vec3 vColor;
  varying float vA;
  varying vec2 vQ;
  void main() {
    float age = uTime - aP.w;
    if (age < 0.0 || age >= aV.w) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    float t = age / aV.w;
    vec3 g = vec3(0.0, uGravity * aS.w, 0.0);
    vec3 head = aP.xyz + aV.xyz * age + 0.5 * g * age * age;
    vec3 tail = head - (aV.xyz + g * age) * uStreak - aS.xyz;
    vec4 h = modelViewMatrix * vec4(head, 1.0);
    vec4 tl = modelViewMatrix * vec4(tail, 1.0);
    vec2 d = h.xy - tl.xy;
    float l = length(d);
    vec2 dir = l > 1e-5 ? d / l : vec2(0.0, 1.0);
    vec4 p = mix(tl, h, position.x);
  #ifdef TRAIL
    // a ribbon: joints meet end to end (no caps, no fade-in: the newest joint starts at the pipe, under the flame),
    // it spreads as it fades, and fades out near the lens
    float w = aC.w * (1.0 + 1.2 * t);
    p.xy += vec2(-dir.y, dir.x) * position.y * w;
    vA = (1.0 - t) * (1.0 - t) * smoothstep(3.0, 9.0, min(-h.z, -tl.z));
  #else
    float w = abs(aC.w) * (1.0 - 0.5 * t);
    p.xy += vec2(-dir.y, dir.x) * position.y * w + dir * (position.x - 0.5) * w;
    // negative width = symmetric envelope (speed lines: brightest mid-life, as they pass the camera); anything about
    // to cross the lens fades out first (a spark 1 u from it would be a stick across the screen)
    vA = (aC.w < 0.0 ? sin(3.14159 * t) : smoothstep(0.0, 0.06, t) * (1.0 - t)) * smoothstep(0.6, 1.6, min(-h.z, -tl.z));
  #endif
    gl_Position = projectionMatrix * p;
    vColor = aC.rgb;
    vQ = position.xy;
  }`;
const STREAK_FS = /* glsl */ `
  varying vec3 vColor;
  varying float vA;
  varying vec2 vQ;
  void main() {
    float across = 1.0 - abs(vQ.y) * 2.0;
    float peak = max(max(vColor.r, vColor.g), vColor.b);
    vec3 c = mix(vColor, vec3(peak), pow(across, 6.0) * 0.45); // white-hot core, tier-coloured edge
  #ifdef TRAIL
    gl_FragColor = vec4(c, vA * min(1.0, across * 1.6));
  #else
    gl_FragColor = vec4(c, vA * min(1.0, across * 1.6) * (0.35 + 0.65 * vQ.x));
  #endif
    ${OUT}
  }`;

const SMOKE_VS = /* glsl */ `
  attribute vec4 aP; // spawn position, birth
  attribute vec4 aV; // velocity, life
  attribute vec4 aX; // size0, size1, rotation (sign = spin direction), opacity
  attribute vec4 aC; // linear colour, rise (u/s^2; dust barely rises)
  uniform float uTime;
  uniform float uDrag;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vA;
  void main() {
    float age = uTime - aP.w;
    if (age < 0.0 || age >= aV.w) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    float t = age / aV.w;
    vec3 p = aP.xyz + aV.xyz * ((1.0 - exp(-uDrag * age)) / uDrag);
    p.y += 0.5 * aC.w * age * age;
    vec4 mv = modelViewMatrix * vec4(p, 1.0);
    float size = mix(aX.x, aX.y, 1.0 - (1.0 - t) * (1.0 - t));
    // a puff about as big as its distance would fill the screen (and cost a full screen of blending):
    // fade it out as it looms over the lens, and drop it once it's that close or behind the camera
    float loom = 1.0 - smoothstep(0.5, 1.1, size / max(-mv.z, 1e-3));
    if (loom <= 0.0) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    float r = aX.z + age * 0.9 * sign(aX.z);
    float c = cos(r), s = sin(r);
    vec2 q = position.xy;
    mv.xy += vec2(q.x * c - q.y * s, q.x * s + q.y * c) * size;
    gl_Position = projectionMatrix * mv;
    vUv = q + 0.5;
    vColor = aC.rgb;
    vA = aX.w * smoothstep(0.0, 0.1, t) * (1.0 - t) * (1.0 - t) * loom;
  }`;
const SMOKE_FS = /* glsl */ `
  uniform sampler2D uMap;
  varying vec2 vUv;
  varying vec3 vColor;
  varying float vA;
  void main() {
    float a = texture2D(uMap, vUv).a * vA;
    if (a < 0.004) discard;
    gl_FragColor = vec4(vColor, a);
    ${OUT}
  }`;

const SKID_VS = /* glsl */ `
  attribute vec4 aA; // start, birth
  attribute vec4 aB; // end, strength
  attribute vec3 aN; // surface normal
  uniform float uTime;
  uniform float uFade;
  uniform float uWidth;
  varying float vA;
  varying float vY;
  void main() {
    float a = aB.w * clamp(1.0 - (uTime - aA.w) / uFade, 0.0, 1.0);
    vec3 d = aB.xyz - aA.xyz;
    if (a <= 0.0 || dot(d, d) < 1e-8) { gl_Position = vec4(0.0, 0.0, 2.0, 1.0); return; }
    vec3 side = normalize(cross(d, aN));
    vec3 p = mix(aA.xyz, aB.xyz, position.x) + side * position.y * uWidth + aN * 0.012;
    gl_Position = projectionMatrix * modelViewMatrix * vec4(p, 1.0);
    vA = a;
    vY = position.y;
  }`;
const SKID_FS = /* glsl */ `
  varying float vA;
  varying float vY;
  void main() {
    float edge = 1.0 - smoothstep(0.32, 0.5, abs(vY));
    gl_FragColor = vec4(0.012, 0.011, 0.011, vA * edge * 0.55);
    ${OUT}
  }`;

const FLAME_VS = /* glsl */ `
  attribute vec3 aN; // nozzle, car frame
  uniform float uLen;
  uniform float uWidth;
  varying vec2 vUv;
  void main() {
    vec4 h = modelViewMatrix * vec4(aN, 1.0);
    vec4 tl = modelViewMatrix * vec4(aN - vec3(uLen, 0.0, 0.0), 1.0);
    vec2 d = tl.xy - h.xy;
    float l = length(d);
    vec2 dir = l > 1e-5 ? d / l : vec2(0.0, -1.0);
    vec4 p = mix(h, tl, position.x);
    p.xy += vec2(-dir.y, dir.x) * position.y * uWidth + dir * (position.x - 0.35) * uWidth * 0.8;
    gl_Position = projectionMatrix * p;
    vUv = position.xy; // along (0 at the nozzle, 1 at the tip), across (-0.5..0.5)
  }`;
const FLAME_FS = /* glsl */ `
  uniform float uTime;
  uniform float uAlpha;
  uniform vec3 uColor;
  varying vec2 vUv;
  void main() {
    float along = clamp(vUv.x, 0.0, 1.0);
    float width = mix(0.5, 0.08, along);
    float core = 1.0 - smoothstep(0.0, width, abs(vUv.y));
    float flick = 0.8 + 0.2 * sin(uTime * 63.0 - along * 17.0) * sin(uTime * 37.0 + along * 5.0);
    float a = min(1.0, core * 1.4) * pow(1.0 - along, 0.6) * flick * uAlpha;
    float hot = (1.0 - smoothstep(0.0, 0.45, along)) * (1.0 - smoothstep(0.0, width * 0.6, abs(vUv.y)));
    vec3 c = mix(uColor * 1.5, vec3(1.0, 0.94, 0.8) * 1.8, hot);
    gl_FragColor = vec4(c, a);
    ${OUT}
  }`;

function quad(x0: number, x1: number) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute([x0, -0.5, 0, x1, -0.5, 0, x1, 0.5, 0, x0, 0.5, 0], 3));
  g.setIndex([0, 1, 2, 0, 2, 3]);
  return g;
}

function puffTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  const blobs = [[32, 32, 27, 0.6], [24, 28, 15, 0.45], [40, 26, 14, 0.45], [30, 40, 15, 0.4], [42, 38, 12, 0.35], [22, 38, 11, 0.3]];
  for (const [x, y, r, a] of blobs) {
    const grad = g.createRadialGradient(x, y, 0, x, y, r);
    grad.addColorStop(0, `rgba(255,255,255,${a})`);
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    g.fillStyle = grad;
    g.fillRect(0, 0, 64, 64);
  }
  return new THREE.CanvasTexture(c);
}

function streakMaterial(blending: THREE.Blending, streak: number, trail = false) {
  return new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uGravity: { value: GRAVITY }, uStreak: { value: streak } },
    defines: trail ? { TRAIL: '' } : {},
    vertexShader: STREAK_VS,
    fragmentShader: STREAK_FS,
    transparent: true,
    depthWrite: false,
    blending,
    side: THREE.DoubleSide,
  });
}

function mesh(geo: THREE.BufferGeometry, mat: THREE.Material, order: number) {
  const m = new THREE.Mesh(geo, mat);
  m.frustumCulled = false;
  m.renderOrder = order;
  return m;
}

const newFrame = (): TrackFrame => ({
  s: 0, p: new THREE.Vector3(), t: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0),
  right: new THREE.Vector3(0, 0, 1), kappa: 0, kappaN: 0, width: 8, surface: 'plastic', edge: 'rail', shoulder: 0,
});

export function createFx(scene: THREE.Scene, car: CarSpec, topTierColor: THREE.Color): Fx {
  let time = 0;
  let track: Track | null = null;

  // -- streaks (sparks, bursts, speed lines)
  const streaks = new Pool(STREAK_N, quad(0, 1), { aP: 4, aV: 4, aC: 4, aS: 4 });
  const streakMat = streakMaterial(THREE.NormalBlending, 0.03);
  scene.add(mesh(streaks.geo, streakMat, 3));
  const [sP, sV, sC, sS] = [0, 1, 2, 3].map((i) => streaks.arr(i));

  // -- the big jump's boost trail: its own pool and material (an even ribbon, faded near the lens), hidden when spent
  const trail = new Pool(TRAIL_N, quad(0, 1), { aP: 4, aV: 4, aC: 4, aS: 4 });
  const trailMat = streakMaterial(THREE.NormalBlending, 0, true);
  const trailMesh = mesh(trail.geo, trailMat, 2);
  scene.add(trailMesh);
  const [tP, tV, tC, tS] = [0, 1, 2, 3].map((i) => trail.arr(i));

  // -- confetti (the finish, a perfect big-jump landing): the streak shader without the streak, slow gravity. Built up
  // front (its program is the streaks'), hidden when spent
  const confettiPool = new Pool(CONFETTI_N, quad(0, 1), { aP: 4, aV: 4, aC: 4, aS: 4 });
  const confettiMat = streakMaterial(THREE.NormalBlending, 0);
  const confettiMesh = mesh(confettiPool.geo, confettiMat, 2);
  scene.add(confettiMesh);
  const [cP, cV, cC, cS] = [0, 1, 2, 3].map((i) => confettiPool.arr(i));
  const PALETTE = ['#ff3d6e', '#ffb020', '#3d8bff', '#a35cff', '#ffffff', '#4ade80'].map((c) => new THREE.Color(c));

  // -- smoke and dust (every puff has its own colour and rise)
  const smoke = new Pool(SMOKE_N, quad(-0.5, 0.5), { aP: 4, aV: 4, aX: 4, aC: 4 });
  const puffMap = puffTexture();
  const smokeMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uDrag: { value: 2.6 }, uMap: { value: puffMap } },
    vertexShader: SMOKE_VS,
    fragmentShader: SMOKE_FS,
    transparent: true,
    depthWrite: false,
  });
  scene.add(mesh(smoke.geo, smokeMat, 2));
  const [mP, mV, mX, mC] = [0, 1, 2, 3].map((i) => smoke.arr(i));

  // -- skid marks
  const skids = new Pool(SKID_N, quad(0, 1), { aA: 4, aB: 4, aN: 3 });
  const skidMat = new THREE.ShaderMaterial({
    uniforms: { uTime: { value: 0 }, uFade: { value: SKID_FADE }, uWidth: { value: SKID_W } },
    vertexShader: SKID_VS,
    fragmentShader: SKID_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
    polygonOffset: true,
    polygonOffsetFactor: -2,
    polygonOffsetUnits: -2,
  });
  scene.add(mesh(skids.geo, skidMat, 1));
  const [kA, kB, kN] = [0, 1, 2].map((i) => skids.arr(i));

  // -- boost flames: one billboard per exhaust pipe (nozzles in the car frame), drawn in the car's pose
  const rearWheels = car.wheels.filter((w) => w.name.includes('rear'));
  const hubY = rearWheels.length ? rearWheels.reduce((s, w) => s + w.centre[1], 0) / rearWheels.length : 0.3;
  const groundY = car.wheels.length ? Math.min(...car.wheels.map((w) => w.centre[1] - w.r)) : 0;
  const exhaust = new THREE.Vector3(-car.length / 2 + 0.08, Math.max(0.22, hubY - groundY), 0); // between the pipes
  const pipe = Math.min(0.32, car.width * 0.21);
  const flameGeo = new THREE.InstancedBufferGeometry();
  flameGeo.index = quad(0, 1).index;
  flameGeo.setAttribute('position', quad(0, 1).getAttribute('position'));
  flameGeo.setAttribute('aN', new THREE.InstancedBufferAttribute(new Float32Array([exhaust.x, exhaust.y, -pipe, exhaust.x, exhaust.y, pipe]), 3));
  const flameMat = new THREE.ShaderMaterial({
    uniforms: {
      uTime: { value: 0 }, uAlpha: { value: 0 }, uLen: { value: 1.6 }, uWidth: { value: Math.min(0.5, car.height * 0.42) },
      uColor: { value: topTierColor.clone() },
    },
    vertexShader: FLAME_VS,
    fragmentShader: FLAME_FS,
    transparent: true,
    depthWrite: false,
    side: THREE.DoubleSide,
  });
  const flameRig = new THREE.Group(); // follows the car pose
  const flames = mesh(flameGeo, flameMat, 3);
  flameRig.add(flames);
  flameRig.visible = false;
  scene.add(flameRig);

  // rear tyre contacts in the rig frame (the rig puts the lowest tyre on y = 0)
  const rearLocal = (rearWheels.length ? rearWheels : [{ centre: [-1.1, 0.3, -0.6] }, { centre: [-1.1, 0.3, 0.6] }])
    .map((w) => new THREE.Vector3(w.centre[0], 0, w.centre[2]));
  const allLocal = (car.wheels.length ? car.wheels.map((w) => w.centre) : [[1.2, 0, 0.6], [1.2, 0, -0.6], [-1.1, 0, 0.6], [-1.1, 0, -0.6]])
    .map((c) => new THREE.Vector3(c[0], 0, c[2]));
  const wp = rearLocal.map(() => new THREE.Vector3());
  const ap = allLocal.map(() => new THREE.Vector3());

  // skid strips, one per rear wheel: the head slot is extended every frame until it is SKID_SEG long
  const strips = rearLocal.map(() => ({ on: false, last: new THREE.Vector3(), head: -1 }));
  // per rear wheel: spawn accumulators (tyre smoke, dust, debris) and the ground under it
  const smokeAcc = new Float32Array(wp.length), dustAcc = new Float32Array(wp.length), bitAcc = new Float32Array(wp.length);
  const gnd = new Uint8Array(wp.length);
  // the car's half length and width (the vehicle keeps the same footprint off the walls)
  const L2 = (car.length || 4) / 2, W2 = (car.width || 1.5) / 2;
  // the nearer wall, from probe(): material, clearance (u), the corner that would touch it, its normal into
  // the road and its direction
  const fr = newFrame();
  let surf = PLASTIC, wallMat = RAIL, wallGap = Infinity, hAbove = 0, scrapeHold = 0, scrapeAcc = 0, hitT = -1, hitN = 0;
  const contact = new THREE.Vector3(), inward = new THREE.Vector3(), along = new THREE.Vector3(1, 0, 0);

  const colours = [
    new THREE.Color('#ffffff'),
    new THREE.Color('#3d8bff'),
    new THREE.Color('#a855f7'),
    topTierColor.clone(),
  ];
  const col = new THREE.Color();
  // warm colours vanish on the orange track: 'hot' is kept close to white
  const hot = new THREE.Color(1, 0.86, 0.55);
  const nose = new THREE.Vector3(), upv = new THREE.Vector3(), side = new THREE.Vector3(), dir = new THREE.Vector3();
  const tmp = new THREE.Vector3(), prevVel = new THREE.Vector3(), dv = new THREE.Vector3(), q1 = new THREE.Vector3();
  let sparkAcc = 0, lineAcc = 0, flameA = 0, havePrev = false;
  // the big jump: the track's 'bigjump' spans [s0, s1, ...]; time aloft, whether this flight left a big jump's lip; the
  // trail's last joint per pipe; the flames' flare off the lip; wind lines due; when the trail and confetti are spent
  const lips: number[] = [];
  let airT = 0, bigAir = false, trailHave = false, flareT = 0, windAcc = 0, trailUntil = -1, confettiUntil = -1;
  const joints = [new THREE.Vector3(), new THREE.Vector3()], pipeP = new THREE.Vector3(), wdir = new THREE.Vector3();
  const b1 = new THREE.Vector3(), b2 = new THREE.Vector3(), ldir = new THREE.Vector3();
  const trailCol = topTierColor.clone().multiplyScalar(1.3);

  function streak(
    x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, width: number,
    c: THREE.Color, intensity: number, grav: number, born = time, sx = 0, sy = 0, sz = 0,
  ) {
    const i = streaks.next(), j = i * 4;
    sP[j] = x, sP[j + 1] = y, sP[j + 2] = z, sP[j + 3] = born;
    sV[j] = vx, sV[j + 1] = vy, sV[j + 2] = vz, sV[j + 3] = life;
    sC[j] = c.r * intensity, sC[j + 1] = c.g * intensity, sC[j + 2] = c.b * intensity, sC[j + 3] = width;
    sS[j] = sx, sS[j + 1] = sy, sS[j + 2] = sz, sS[j + 3] = grav;
  }

  function puff(
    p: THREE.Vector3, vx: number, vy: number, vz: number, s0: number, s1: number, life: number, opacity: number, born = time,
    c: THREE.Color = C_SMOKE, rise = 1.4,
  ) {
    const i = smoke.next(), j = i * 4;
    mP[j] = p.x + upv.x * 0.15, mP[j + 1] = p.y + upv.y * 0.15, mP[j + 2] = p.z + upv.z * 0.15, mP[j + 3] = born;
    mV[j] = vx, mV[j + 1] = vy, mV[j + 2] = vz, mV[j + 3] = life;
    mX[j] = s0, mX[j + 1] = s1, mX[j + 2] = (Math.random() < 0.5 ? -1 : 1) * rand(0.1, Math.PI), mX[j + 3] = opacity;
    mC[j] = c.r, mC[j + 1] = c.g, mC[j + 2] = c.b, mC[j + 3] = rise;
  }

  /** A low dust cloud off p: carried along a little, spread out sideways (`out`, u/s) and up. */
  function dust(p: THREE.Vector3, v: THREE.Vector3, out: number, c: THREE.Color, s0: number, s1: number, life: number, opacity: number, born: number) {
    const u = rand(1.2, 2.8);
    puff(
      p, v.x * 0.5 + side.x * out + upv.x * u + rand(-0.8, 0.8), v.y * 0.5 + side.y * out + upv.y * u,
      v.z * 0.5 + side.z * out + upv.z * u + rand(-0.8, 0.8), s0, s1, life, opacity, born, c, 0.3,
    );
  }

  /** A bit of debris off p under full gravity: carried with the car (`carry` x v), out along `o` (`out` u/s) and up. */
  function debris(
    p: THREE.Vector3, v: THREE.Vector3, carry: number, o: THREE.Vector3, out: number, up: number, c: THREE.Color,
    width: number, life: number, grav: number, born: number,
  ) {
    streak(
      p.x + rand(-0.15, 0.15), p.y + rand(-0.05, 0.1), p.z + rand(-0.15, 0.15),
      v.x * carry + o.x * out + upv.x * up + rand(-1.5, 1.5), v.y * carry + o.y * out + upv.y * up + rand(-1, 1),
      v.z * carry + o.z * out + upv.z * up + rand(-1.5, 1.5), life, width, c, 1, grav, born,
    );
  }

  /** Reads the frame under the car: the ground under each rear tyre, then the nearer wall - its material, the
   *  car's clearance to it and the corner that would touch it. Null without a track (all plastic, no walls known). */
  function probe(state: VehicleState, P: THREE.Vector3): TrackFrame | null {
    if (!track) {
      gnd.fill(PLASTIC);
      surf = PLASTIC;
      wallMat = RAIL;
      wallGap = Infinity;
      return null;
    }
    const f = track.frameAt(state.trackS, fr);
    surf = f.surface === 'asphalt' ? ASPHALT : f.surface === 'dirt' ? DIRT : PLASTIC;
    for (let k = 0; k < wp.length; k++) gnd[k] = groundAt(f, surf, wp[k]);
    // walls: the rails or barrier at the surface's edge, or the soft limit past a grass verge
    const half = f.width * 0.5, lim = f.edge === 'grass' ? half + Math.max(0, f.shoulder || 0) : half;
    q1.subVectors(P, f.p);
    const dc = q1.dot(f.right);
    hAbove = q1.dot(f.up);
    const nr = nose.dot(f.right), sr = side.dot(f.right);
    const reach = L2 * Math.abs(nr) + W2 * Math.abs(sr); // the car's half extent across the track
    const gapR = lim - dc - reach, gapL = lim + dc - reach;
    const ws = gapR < gapL ? 1 : -1;
    wallGap = Math.min(gapR, gapL);
    // as the vehicle's wallOf; track.ts lines the far edge of every verge with hay bales, so that is straw too (SOFT, a
    // bare grass limit, is kept for a course without them)
    wallMat = f.edge === 'grass' || (f.edge === 'barrier' && surf === DIRT) ? HAY : f.edge === 'barrier' ? TYRE : RAIL;
    // the corner reaching furthest toward that wall (mid-flank while the car runs parallel to it), bumper high
    contact.copy(P)
      .addScaledVector(nose, L2 * clamp(nr * ws * 12, -1, 1))
      .addScaledVector(side, sr * ws < 0 ? -W2 : W2)
      .addScaledVector(upv, 0.35);
    inward.copy(f.right).multiplyScalar(-ws);
    along.copy(f.t);
    return f;
  }

  function groundAt(f: TrackFrame, surf: number, p: THREE.Vector3) {
    return f.edge === 'grass' && Math.abs(q1.subVectors(p, f.p).dot(f.right)) > f.width * 0.5 + 0.05 ? VERGE : surf;
  }

  /** An impact on a wall at `at`, `n` u/s into it; `inn` points from the wall into the road. */
  function wallBurst(mat: number, at: THREE.Vector3, inn: THREE.Vector3, n: number, V: THREE.Vector3) {
    const k = smoothstep(2, 26, n);
    if (mat === RAIL || mat === TYRE) {
      if (n >= SPARK_HIT[mat]) {
        const cnt = Math.round(clamp(10 + n * 1.6, 10, 48) * (mat === RAIL ? 1 : 0.5));
        for (let i = 0; i < cnt; i++) {
          // along the wall and up, a little back off it: they clear the car's flank in a few frames
          const u = rand(3, 9), o = rand(-0.5, 1.5);
          streak(
            at.x, at.y, at.z,
            V.x * 0.5 + inn.x * o + upv.x * u + rand(-1.5, 1.5),
            V.y * 0.5 + inn.y * o + upv.y * u + rand(-1, 1),
            V.z * 0.5 + inn.z * o + upv.z * u + rand(-1.5, 1.5),
            rand(0.25, 0.6), rand(0.05, 0.09), hot, HOT_I, 0.7,
          );
        }
      }
      if (mat === RAIL) {
        // a scuff of plastic dust
        for (let i = 0, m = 1 + Math.round(2 * k); i < m; i++) puff(at, V.x * 0.2 + inn.x * 0.8, V.y * 0.2 + 0.6, V.z * 0.2 + inn.z * 0.8, 0.35, 1.3 + k, 0.7, 0.25 + 0.2 * k, time, C_SCUFF, 0.8);
      } else {
        // the tyres give: a dark puff of rubber and a spray of crumbs
        for (let i = 0, m = 2 + Math.round(4 * k); i < m; i++) {
          const o = rand(1, 3), u = rand(0.4, 1.8);
          puff(at, V.x * 0.15 + inn.x * o + upv.x * u + rand(-0.8, 0.8), V.y * 0.15 + inn.y * o + upv.y * u, V.z * 0.15 + inn.z * o + upv.z * u + rand(-0.8, 0.8), rand(0.4, 0.6), rand(1.6, 2.4) + k, rand(0.7, 1.1), 0.55 + 0.15 * k, time, C_RUBBER, 0.6);
        }
        for (let i = 0, m = 4 + Math.round(n * 0.5); i < m; i++) debris(at, V, 0.4, inn, rand(1, 4), rand(2, 6), C_CRUMB, rand(0.06, 0.09), rand(0.3, 0.55), 1, time);
      }
    } else {
      // hay bales, or the soft limit past the verge: straw (or grass) flies, dust hangs
      const hay = mat === HAY;
      for (let i = 0, m = Math.round(clamp((hay ? 14 : 8) + n * (hay ? 1.4 : 0.9), 0, 60)); i < m; i++) {
        debris(at, V, 0.35, inn, rand(1, 4.5), rand(3, 9), hay ? C_STRAW[i % 3] : C_GRASS[i % 4], rand(0.07, 0.11), rand(0.5, 0.9), hay ? 0.55 : 1, time);
      }
      for (let i = 0, m = 2 + Math.round(3 * k); i < m; i++) {
        const o = rand(0.5, 2);
        puff(at, V.x * 0.2 + inn.x * o, V.y * 0.2 + rand(0.4, 1.4), V.z * 0.2 + inn.z * o, rand(0.5, 0.8), rand(2, 3) + k, rand(1, 1.5), 0.4, time, hay ? C_CHAFF : C_VERGE, 0.3);
      }
    }
  }

  /** One piece of a wall scrape at p (born at `born`): sparks off a rail, crumbs off tyres, straw or grass. */
  function scrapeBit(V: THREE.Vector3, p: THREE.Vector3, born: number) {
    if (wallMat === RAIL) {
      // a rooster tail: dragged along a little, fanned up and out of the car's flank into view
      const u = rand(2.5, 7), o = rand(0.2, 2), carry = rand(0.25, 0.6);
      col.copy(hot).lerp(colours[0], Math.random() < 0.25 ? 0.7 : 0.3);
      streak(
        p.x, p.y, p.z,
        V.x * carry + inward.x * o + upv.x * u + rand(-1, 1), V.y * carry + inward.y * o + upv.y * u + rand(-0.6, 0.6),
        V.z * carry + inward.z * o + upv.z * u + rand(-1, 1), rand(0.25, 0.5), rand(0.07, 0.11), col, HOT_I, 0.45, born,
      );
      if (Math.random() < 0.04) puff(p, V.x * 0.3 + inward.x, V.y * 0.3 + 0.5, V.z * 0.3 + inward.z, 0.3, 1.2, 0.6, 0.22, born, C_SCUFF, 0.8);
    } else if (wallMat === TYRE) {
      debris(p, V, 0.5, inward, rand(0.5, 2.5), rand(1.5, 4.5), C_CRUMB, rand(0.07, 0.11), rand(0.25, 0.45), 1, born);
      if (Math.random() < 0.2) puff(p, V.x * 0.3 + inward.x, V.y * 0.3 + 0.5, V.z * 0.3 + inward.z, 0.35, 1.6, 0.8, 0.35, born, C_RUBBER, 0.6);
    } else {
      const hay = wallMat === HAY;
      debris(p, V, 0.45, inward, rand(0.5, 3), rand(2, 6), hay ? C_STRAW[(Math.random() * 3) | 0] : C_GRASS[(Math.random() * 4) | 0], rand(0.06, 0.09), rand(0.4, 0.8), hay ? 0.55 : 1, born);
      if (Math.random() < 0.2) puff(p, V.x * 0.3 + inward.x, V.y * 0.3 + 0.6, V.z * 0.3 + inward.z, 0.5, 2.2, 1.1, 0.3, born, hay ? C_CHAFF : C_VERGE, 0.3);
    }
  }

  /** Spark spray with velocity = car * carry + backward/outward/up kick, coloured c. Low gravity so
   *  the arcs stay above the track (they are depth-tested against it) for most of their life. */
  function spray(p: THREE.Vector3, v: THREE.Vector3, carry: number, back: number, out: number, outSign: number, upK: number, c: THREE.Color, born: number) {
    const b = rand(back * 0.5, back), o = rand(0, out) * outSign, u = rand(upK * 0.45, upK);
    const white = Math.random() < 0.18 ? 0.6 : 0; // a few white-hot ones
    col.setRGB(c.r + (1 - c.r) * white, c.g + (1 - c.g) * white, c.b + (1 - c.b) * white);
    streak(
      p.x, p.y + 0.04, p.z,
      v.x * carry - nose.x * b + side.x * o + upv.x * u + rand(-1.5, 1.5),
      v.y * carry - nose.y * b + side.y * o + upv.y * u + rand(-1, 1),
      v.z * carry - nose.z * b + side.z * o + upv.z * u + rand(-1.5, 1.5),
      rand(0.2, 0.45), rand(0.075, 0.125), col, white ? HOT_I : SPARK_I, 0.45, born,
    );
  }

  function breakStrips() {
    for (const st of strips) {
      st.on = false;
      st.head = -1;
    }
  }

  function layStrip(k: number, on: boolean, p: THREE.Vector3, n: THREE.Vector3, strength: number) {
    const st = strips[k];
    if (!on) {
      st.on = false;
      st.head = -1;
      return;
    }
    if (!st.on || p.distanceToSquared(st.last) > 16) {
      st.on = true;
      st.last.copy(p);
      st.head = -1;
      return;
    }
    let i = st.head;
    if (i < 0) {
      i = st.head = skids.next();
      const j = i * 4;
      kA[j] = st.last.x, kA[j + 1] = st.last.y, kA[j + 2] = st.last.z, kA[j + 3] = time;
    } else skids.touch(i);
    const j = i * 4, q = i * 3;
    kB[j] = p.x, kB[j + 1] = p.y, kB[j + 2] = p.z, kB[j + 3] = strength;
    kN[q] = n.x, kN[q + 1] = n.y, kN[q + 2] = n.z;
    if (p.distanceToSquared(st.last) >= SKID_SEG * SKID_SEG) {
      st.last.copy(p);
      st.head = -1;
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

  /** Off a big jump's lip: sparks as the rear tyres leave it, a burst out of the pipes in the rarity colour, the flames
   *  flare, plastic dust and tyre smoke left hanging at the lip. The sparks and the burst carry most of the car's speed,
   *  so they fan out behind it in view (thrown back at its speed they'd be past the chase camera in a few frames). */
  function launchBurst(P: THREE.Vector3, Q: THREE.Quaternion, V: THREE.Vector3) {
    for (let i = 0; i < 48; i++) {
      const w = wp[i % wp.length], b = rand(3, 9), o = rand(-6, 6), u = rand(-2, 4);
      streak(
        w.x, w.y + 0.05, w.z,
        V.x * 0.72 - nose.x * b + side.x * o + upv.x * u, V.y * 0.72 - nose.y * b + side.y * o + upv.y * u,
        V.z * 0.72 - nose.z * b + side.z * o + upv.z * u, rand(0.35, 0.7), rand(0.06, 0.1), hot, HOT_I, 0.8,
      );
    }
    tmp.copy(exhaust).applyQuaternion(Q).add(P);
    for (let i = 0; i < 30; i++) {
      col.copy(i % 3 ? topTierColor : hot);
      const b = rand(6, 14);
      streak(tmp.x, tmp.y, tmp.z, V.x * 0.75 - nose.x * b + rand(-4, 4), V.y * 0.75 - nose.y * b + rand(-2, 4), V.z * 0.75 - nose.z * b + rand(-4, 4), rand(0.35, 0.6), 0.1, col, HOT_I, 0.4);
    }
    for (let k = 0; k < wp.length; k++) {
      for (let i = 0; i < 3; i++) puff(wp[k], V.x * 0.12 + rand(-1.2, 1.2), rand(0.4, 1.6), V.z * 0.12 + rand(-1.2, 1.2), 0.5, rand(2.4, 3.4), rand(0.9, 1.3), 0.5, time, i ? C_SCUFF : C_SMOKE, 0.6);
    }
    flareT = 0.8;
  }

  /** One joint of the trail from each pipe, once the pipe is TRAIL_SEG past the last. */
  function layTrail(P: THREE.Vector3, Q: THREE.Quaternion) {
    for (let k = 0; k < 2; k++) {
      pipeP.set(exhaust.x, exhaust.y, k ? pipe : -pipe).applyQuaternion(Q).add(P);
      const J = joints[k];
      if (!trailHave) J.copy(pipeP);
      else if (pipeP.distanceToSquared(J) >= TRAIL_SEG * TRAIL_SEG) {
        const j = trail.next() * 4;
        tP[j] = pipeP.x, tP[j + 1] = pipeP.y, tP[j + 2] = pipeP.z, tP[j + 3] = time;
        tV[j] = tV[j + 1] = tV[j + 2] = 0, tV[j + 3] = TRAIL_LIFE;
        tC[j] = trailCol.r, tC[j + 1] = trailCol.g, tC[j + 2] = trailCol.b, tC[j + 3] = TRAIL_W;
        tS[j] = pipeP.x - J.x, tS[j + 1] = pipeP.y - J.y, tS[j + 2] = pipeP.z - J.z, tS[j + 3] = 0;
        J.copy(pipeP);
      }
    }
    trailHave = true;
    trailUntil = time + TRAIL_LIFE;
  }

  /** A long flight comes down (k 0..1: how hard): a ring of dust thrown out along the ground, a shock ring of white
   *  streaks, sparks off plastic or asphalt (clods or grass off a soft surface). */
  function landingSlam(P: THREE.Vector3, Q: THREE.Quaternion, V: THREE.Vector3, f: TrackFrame | null, k: number) {
    const gl = f ? groundAt(f, surf, P) : PLASTIC;
    const c = gl === PLASTIC ? C_SCUFF : gl === ASPHALT ? C_SMOKE : gl === DIRT ? C_DUST : C_VERGE;
    for (let i = 0, n = 10 + Math.round(14 * k); i < n; i++) {
      const a = (i / n) * Math.PI * 2 + rand(0, 0.3), sp = rand(5, 9) * (0.8 + 0.6 * k), u = rand(0.3, 1);
      ldir.copy(nose).multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      tmp.copy(P).addScaledVector(ldir, 1.5);
      puff(
        tmp, V.x * 0.35 + ldir.x * sp + upv.x * u, V.y * 0.35 + ldir.y * sp + upv.y * u, V.z * 0.35 + ldir.z * sp + upv.z * u,
        0.7, rand(2.6, 3.6) + 1.6 * k, rand(0.9, 1.4), 0.4 + 0.15 * k, time, c, 0.35,
      );
    }
    for (let i = 0; i < 24; i++) {
      // (slower straight back, toward the chase camera: a spray of sticks across the lens otherwise)
      const a = (i / 24) * Math.PI * 2, back = smoothstep(-0.5, -0.95, Math.cos(a)), sp = rand(11, 16) * (0.7 + 0.3 * k) * (1 - 0.6 * back);
      ldir.copy(nose).multiplyScalar(Math.cos(a)).addScaledVector(side, Math.sin(a));
      streak(P.x + upv.x * 0.15, P.y + upv.y * 0.15, P.z + upv.z * 0.15, V.x * 0.85 + ldir.x * sp, V.y * 0.85 + ldir.y * sp, V.z * 0.85 + ldir.z * sp, 0.16, 0.055, colours[0], 1.2, 0);
    }
    for (let i = 0, m = 20 + Math.round(36 * k); i < m; i++) {
      const w = ap[i % ap.length].copy(allLocal[i % ap.length]).applyQuaternion(Q).add(P);
      ldir.copy(allLocal[i % ap.length]).setY(0).normalize().applyQuaternion(Q);
      if (gl <= ASPHALT) {
        // (carried along with the car: thrown back at its speed they'd cross the chase camera's lens)
        const o = rand(2, 7), u = rand(1.5, 5);
        streak(w.x, w.y + 0.05, w.z, V.x * 0.85 + ldir.x * o + upv.x * u, V.y * 0.85 + ldir.y * o + upv.y * u, V.z * 0.85 + ldir.z * o + upv.z * u, rand(0.25, 0.5), rand(0.06, 0.1), hot, HOT_I, 0.8);
      } else if (i % 2) debris(w, V, 0.5, ldir, rand(1, 5), rand(3, 8), gl === DIRT ? C_CLOD : C_GRASS[i % 4], rand(0.08, 0.13), rand(0.35, 0.6), 1, time);
    }
  }

  /** Confetti at `at`: carried along with velocity V x carry, thrown up and out; half in the rarity colour. */
  function confettiBurst(at: THREE.Vector3, V: THREE.Vector3 | null, carry: number, count: number) {
    for (let n = 0; n < Math.min(count, CONFETTI_N); n++) {
      const j = confettiPool.next() * 4;
      const a = rand(0, Math.PI * 2), r = rand(2, 7);
      col.copy(n % 2 ? topTierColor : PALETTE[(n >> 1) % PALETTE.length]);
      cP[j] = at.x, cP[j + 1] = at.y, cP[j + 2] = at.z, cP[j + 3] = time;
      cV[j] = (V ? V.x * carry : 0) + Math.cos(a) * r, cV[j + 1] = (V ? V.y * carry : 0) + rand(9, 17), cV[j + 2] = (V ? V.z * carry : 0) + Math.sin(a) * r;
      cV[j + 3] = rand(1.6, 2.4);
      cC[j] = col.r, cC[j + 1] = col.g, cC[j + 2] = col.b, cC[j + 3] = rand(0.1, 0.16);
      cS[j] = rand(-0.12, 0.12), cS[j + 1] = rand(-0.12, 0.12), cS[j + 2] = rand(-0.12, 0.12), cS[j + 3] = 0.3;
    }
    confettiUntil = Math.max(confettiUntil, time + 2.5);
  }

  function update(state: VehicleState, dtIn: number, pose?: Pose) {
    const dt = clamp(dtIn, 0, 0.1);
    time += dt;
    const P = pose ? pose.position : state.position;
    const Q = pose ? pose.quaternion : state.quaternion;
    const V = state.velocity;
    const ev = state.events;
    nose.set(1, 0, 0).applyQuaternion(Q);
    upv.set(0, 1, 0).applyQuaternion(Q);
    side.set(0, 0, 1).applyQuaternion(Q);
    for (let i = 0; i < wp.length; i++) wp[i].copy(rearLocal[i]).applyQuaternion(Q).add(P);
    if (ev.respawn) breakStrips();
    const f = probe(state, P);

    const sp = state.speed;
    // Slip is the vehicle's, or the pose's when that's bigger (a spin-out swings the nose further than a drift's
    // clamp). Folded onto the line of travel: a car sliding backwards rolls, one going sideways scrubs.
    let slipAbs = Math.abs(state.slip);
    if (sp > 3) {
      const a = Math.abs(Math.atan2(V.dot(side), V.dot(nose)));
      slipAbs = Math.max(slipAbs, Math.min(a, Math.PI - a));
    }
    const slipDeg = slipAbs / DEG;
    const g = state.grounded;
    // Air: time aloft. A flight off a big jump's lip bursts at the lip and lays the trail all the way down.
    const airWas = airT, wasBig = bigAir;
    airT = g ? 0 : airT + dt;
    if (ev.airborne && !g) {
      bigAir = sp > 15 && onLip(state.trackS);
      trailHave = false;
      if (bigAir) launchBurst(P, Q, V);
    }
    if (g) bigAir = false;
    else if (bigAir) layTrail(P, Q);
    // wind lines streaming past the car in a long flight: world-fixed, stretched along it, in a ring round its path
    if (!g && airT > 0.12 && sp > 18) {
      windAcc += (bigAir ? 110 : 60) * smoothstep(18, 48, sp) * dt;
      wdir.copy(V).multiplyScalar(1 / sp);
      b1.copy(side).addScaledVector(wdir, -side.dot(wdir)).normalize();
      b2.crossVectors(wdir, b1);
      const Ls = sp * 0.07;
      while (windAcc >= 1) {
        windAcc -= 1;
        const a = rand(0, Math.PI * 2), r = rand(1.1, 2.6);
        tmp.copy(P).addScaledVector(wdir, rand(0, 6)).addScaledVector(b1, Math.cos(a) * r).addScaledVector(b2, Math.sin(a) * r * 0.8).addScaledVector(upv, 0.45);
        // (dead by the time the chase camera, ~0.14 s behind the car, comes through)
        streak(tmp.x, tmp.y, tmp.z, 0, 0, 0, 0.14, -0.03, colours[0], 1.05, 0, time, wdir.x * Ls, wdir.y * Ls, wdir.z * Ls);
      }
    } else windAcc = 0;
    const braking = g && sp > 6 && state.accelLocal.x < -32;
    const sliding = g && sp > 3 && slipDeg > 6;
    // the rear slides toward the outside of the turn: travel is on that side of the nose
    const outSign = V.dot(side) < 0 ? -1 : 1;

    // Tyres: skids and smoke on asphalt and plastic, a dust trail on dirt, grass and dust thrown up off the
    // verge. Spawns are spread over the frame so low frame rates don't clump them.
    const strength = sliding ? 0.4 + 0.5 * smoothstep(6, 22, slipDeg) : 0.55;
    const slideK = smoothstep(8, 26, slipDeg);
    for (let k = 0; k < wp.length; k++) {
      const gk = gnd[k], w = wp[k];
      layStrip(k, gk <= ASPHALT && (sliding || braking), w, upv, strength);
      if (!g || sp < 3) {
        smokeAcc[k] = dustAcc[k] = bitAcc[k] = 0;
        continue;
      }
      if (gk <= ASPHALT) {
        smokeAcc[k] += (sp > 5 ? 21 * slideK + (braking ? 7 : 0) : 0) * dt;
      } else if (gk === DIRT) {
        dustAcc[k] += ((4 + 0.5 * sp) * (1 + 1.4 * slideK) + (braking ? 8 : 0)) * dt;
        bitAcc[k] += (24 * slideK + (braking ? 6 : 0)) * dt;
      } else {
        dustAcc[k] += (2 + 0.25 * sp) * (1 + slideK) * dt;
        bitAcc[k] += (8 + 0.8 * sp) * (1 + 1.2 * slideK) * dt;
      }
      while (smokeAcc[k] >= 1) {
        smokeAcc[k] -= 1;
        const fr0 = Math.random();
        tmp.copy(w).addScaledVector(V, -fr0 * dt);
        puff(tmp, V.x * 0.3 + rand(-1, 1), V.y * 0.3 + rand(0.4, 1.4), V.z * 0.3 + rand(-1, 1), rand(0.45, 0.7), rand(2, 3), rand(0.8, 1.3), 0.8, time - fr0 * dt);
      }
      while (dustAcc[k] >= 1) {
        dustAcc[k] -= 1;
        const fr0 = Math.random();
        tmp.copy(w).addScaledVector(V, -fr0 * dt);
        const out = rand(-1.5, 1.5) + slideK * outSign * rand(0, 2);
        if (gk === DIRT) dust(tmp, V, out, C_DUST, rand(0.8, 1.1), rand(2.8, 4), rand(1.1, 1.8), rand(0.45, 0.6), time - fr0 * dt);
        else dust(tmp, V, out, C_VERGE, rand(0.6, 0.8), rand(2, 2.8), rand(0.8, 1.2), rand(0.32, 0.42), time - fr0 * dt);
      }
      while (bitAcc[k] >= 1) {
        bitAcc[k] -= 1;
        const fr0 = Math.random();
        tmp.copy(w).addScaledVector(V, -fr0 * dt);
        // flung up off the tread, out with the slide: nearly still on the ground (short, chunky streaks), the car drives off
        dir.copy(side).multiplyScalar(rand(-1.5, 1.5) + slideK * outSign * rand(0, 2.5)).addScaledVector(nose, -rand(1, 4));
        const c = gk === DIRT ? C_CLOD : C_GRASS[(Math.random() * 4) | 0];
        debris(tmp, V, 0.2, dir, 1, rand(3, 8), c, rand(0.1, 0.16), rand(0.35, 0.6), 1, time - fr0 * dt);
      }
    }

    // drift sparks, coloured by tier
    if (state.drifting && g && state.driftTier > 0) {
      sparkAcc += SPARK_RATE[state.driftTier] * wp.length * dt;
      const c = colours[state.driftTier];
      while (sparkAcc >= 1) {
        sparkAcc -= 1;
        const f = Math.random();
        tmp.copy(wp[(Math.random() * wp.length) | 0]).addScaledVector(V, -f * dt);
        spray(tmp, V, 0.55, 8, 4.5, outSign, 4.8, c, time - f * dt); // a low fan back and out
      }
    } else sparkAcc = 0;

    if (ev.tierUp) {
      const c = colours[ev.tierUp];
      for (let n = 0; n < 30; n++) {
        const a = rand(0, Math.PI * 2), s = rand(5, 11);
        const w = wp[n % wp.length];
        dir.copy(nose).multiplyScalar(Math.cos(a) * s).addScaledVector(side, Math.sin(a) * s).addScaledVector(upv, rand(2.5, 6));
        streak(w.x, w.y + 0.05, w.z, V.x * 0.5 + dir.x, V.y * 0.5 + dir.y, V.z * 0.5 + dir.z, rand(0.3, 0.55), rand(0.07, 0.11), c, 1.8, 0.5);
      }
    }

    // Walls. An impact bursts at the corner that hit, by what the wall is made of (a light knock between
    // bursts only counts when it's much harder). Without the wall's geometry: the side the hit pushed away from.
    const hit = ev.wallHit ?? 0;
    if (hit > 2 && (time - hitT > 0.09 || hit > hitN * 1.5)) {
      hitT = time;
      hitN = hit;
      if (wallGap < 1) wallBurst(wallMat, contact, inward, hit, V);
      else if (havePrev) {
        dv.copy(V).sub(prevVel);
        const s = dv.dot(side) > 0 ? -1 : 1; // pushed left => contact on the right
        tmp.copy(P).addScaledVector(side, s * (W2 + 0.08)).addScaledVector(nose, L2 * 0.56).addScaledVector(upv, 0.35);
        dir.copy(side).multiplyScalar(-s);
        wallBurst(wallMat, tmp, dir, hit, V);
      }
    }
    // A scrape: a corner held on the wall while the car runs along it. The hold rides out the small bounces
    // off the wall that keep the car from sticking to it.
    const vAlong = Math.abs(V.dot(along));
    scrapeHold = f && wallGap < TOUCH && sp > 4 && hAbove < 1.2 ? 0.12 : Math.max(0, scrapeHold - dt);
    if (scrapeHold > 0 && vAlong > 5) {
      scrapeAcc += (wallMat === RAIL ? 50 + 4 * vAlong : wallMat === TYRE ? 16 + 0.9 * vAlong : 20 + 1.2 * vAlong) * dt;
      while (scrapeAcc >= 1) {
        scrapeAcc -= 1;
        const fr0 = Math.random();
        scrapeBit(V, tmp.copy(contact).addScaledVector(V, -fr0 * dt), time - fr0 * dt);
      }
    } else scrapeAcc = 0;

    // landing: dust from every tyre (of the ground it lands on), a scrape of sparks off a hard surface when it was
    // hard (clods or grass off a soft one), a gold ring when perfect
    if (ev.landed && ev.landed > 5) {
      let soft = -1; // the ground of a tyre that came down on dirt or the verge
      for (let i = 0; i < ap.length; i++) {
        ap[i].copy(allLocal[i]).applyQuaternion(Q).add(P);
        dir.copy(allLocal[i]).setY(0).normalize().applyQuaternion(Q);
        const gi = f ? groundAt(f, surf, ap[i]) : PLASTIC;
        if (gi <= ASPHALT) puff(ap[i], V.x * 0.25 + dir.x * 2.5, 0.6, V.z * 0.25 + dir.z * 2.5, 0.5, rand(2, 2.8), rand(0.7, 1.1), 0.45);
        else {
          soft = gi;
          const c = gi === DIRT ? C_DUST : C_VERGE;
          for (let m = 0; m < 2; m++) puff(ap[i], V.x * 0.25 + dir.x * rand(2, 4), rand(0.4, 1.2), V.z * 0.25 + dir.z * rand(2, 4), 0.6, rand(2.6, 3.6), rand(1.1, 1.6), 0.4, time, c, 0.3);
        }
      }
      if (ev.landed > 14) {
        for (let i = 0; i < 14; i++) {
          const w = wp[i % wp.length];
          if (soft < 0) spray(w, V, 0.7, 7, 2.5, i % 2 ? 1 : -1, 3, hot, time);
          else debris(w, V, 0.5, side, rand(-3, 3), rand(3, 7), soft === DIRT ? C_CLOD : C_GRASS[i % 4], rand(0.08, 0.13), rand(0.35, 0.6), 1, time);
        }
      }
    }
    // after a long flight, the slam (harder the longer the air and the harder the touchdown)
    if (ev.landed && (airWas > 0.6 || ev.landed > 12)) {
      landingSlam(P, Q, V, f, clamp(smoothstep(0.5, 2.4, airWas) + 0.5 * smoothstep(10, 24, ev.landed), 0, 1));
    }
    // a perfect landing: a ring in the car's rarity colour (and white); off a big jump also a fountain and confetti
    // carried along with the car
    if (ev.perfectLanding) {
      for (let n = 0; n < 36; n++) {
        const a = (n / 36) * Math.PI * 2, s = rand(8, 13);
        dir.copy(nose).multiplyScalar(Math.cos(a) * s).addScaledVector(side, Math.sin(a) * s).addScaledVector(upv, rand(1, 3.5));
        col.copy(n % 3 ? topTierColor : colours[0]);
        streak(P.x, P.y + 0.2, P.z, V.x * 0.7 + dir.x, V.y * 0.7 + dir.y, V.z * 0.7 + dir.z, rand(0.4, 0.6), 0.09, col, HOT_I, 0.4);
      }
      if (wasBig || airWas > 1.2) {
        for (let n = 0; n < 30; n++) {
          const a = rand(0, Math.PI * 2), r = rand(1.5, 5);
          dir.copy(nose).multiplyScalar(Math.cos(a) * r).addScaledVector(side, Math.sin(a) * r).addScaledVector(upv, rand(9, 16));
          col.copy(n % 3 ? topTierColor : colours[0]);
          streak(P.x, P.y + 0.5, P.z, V.x * 0.8 + dir.x, V.y * 0.8 + dir.y, V.z * 0.8 + dir.z, rand(0.6, 0.9), rand(0.08, 0.12), col, HOT_I, 0.6);
        }
        confettiBurst(tmp.copy(P).addScaledVector(upv, 0.8), V, 0.8, 110);
      }
    }

    // boost: flames, a burst out of the pipes as it lights, speed lines streaming past
    // (off a big jump's lip they flare: longer, for 0.8 s, boost or not)
    flareT = Math.max(0, flareT - dt);
    const flameOn = state.boosting || flareT > 0;
    flameA += ((flameOn ? 1 : 0) - flameA) * (1 - Math.exp(-dt / (flameOn ? 0.04 : 0.09)));
    flameRig.visible = flameA > 0.01;
    if (flameRig.visible) {
      flameRig.position.copy(P);
      flameRig.quaternion.copy(Q);
      const len = (1.05 + 0.25 * Math.sin(time * 41) + 0.15 * Math.sin(time * 97)) * (0.4 + 0.6 * flameA) * (1 + 0.7 * smoothstep(0, 0.8, flareT));
      flameMat.uniforms.uLen.value = len * 1.8;
      flameMat.uniforms.uAlpha.value = flameA;
      flameMat.uniforms.uTime.value = time;
    }
    if (ev.boostStart) {
      tmp.copy(exhaust).applyQuaternion(Q).add(P);
      for (let i = 0; i < 18; i++) {
        col.copy(i % 2 ? hot : topTierColor);
        streak(
          tmp.x, tmp.y, tmp.z,
          V.x * 0.6 - nose.x * rand(8, 15) + rand(-2.5, 2.5), V.y * 0.6 - nose.y * rand(8, 15) + rand(0, 3), V.z * 0.6 - nose.z * rand(8, 15) + rand(-2.5, 2.5),
          rand(0.2, 0.4), 0.08, col, HOT_I, 0.5,
        );
      }
    }
    if (state.boosting || state.speed > VTOP * 1.08) {
      // world-fixed streaks seeded around where the chase camera is about to pass: they whip by it
      lineAcc += 90 * dt;
      const sp = Math.max(state.speed, 1);
      dir.copy(V).multiplyScalar(1 / sp);
      while (lineAcc >= 1) {
        lineAcc -= 1;
        // a tube around the camera's path (behind and above the car), never closer than ~2.5 u to it
        const a = rand(0, Math.PI * 2), r = rand(2.6, 5), ahead = rand(-3, 12);
        tmp.copy(P).addScaledVector(dir, ahead).addScaledVector(side, Math.cos(a) * r).addScaledVector(upv, 1.8 + Math.sin(a) * r * 0.7);
        const L = sp * 0.06;
        streak(tmp.x, tmp.y, tmp.z, 0, 0, 0, 0.3, -0.025, colours[0], 1.1, 0, time, dir.x * L, dir.y * L, dir.z * L);
      }
    } else lineAcc = 0;

    prevVel.copy(V);
    havePrev = true;
    streakMat.uniforms.uTime.value = time;
    smokeMat.uniforms.uTime.value = time;
    skidMat.uniforms.uTime.value = time;
    streaks.flush();
    smoke.flush();
    skids.flush();
    trailMesh.visible = time < trailUntil;
    if (trailMesh.visible) {
      trailMat.uniforms.uTime.value = time;
      trail.flush();
    }
    confettiMesh.visible = time < confettiUntil;
    if (confettiMesh.visible) {
      confettiMat.uniforms.uTime.value = time;
      confettiPool.flush();
    }
  }

  function reset() {
    streaks.clear();
    smoke.clear();
    skids.clear();
    trail.clear();
    confettiPool.clear();
    breakStrips();
    sparkAcc = lineAcc = flameA = scrapeAcc = scrapeHold = hitN = airT = flareT = windAcc = 0;
    bigAir = trailHave = false;
    trailUntil = confettiUntil = -1;
    smokeAcc.fill(0);
    dustAcc.fill(0);
    bitAcc.fill(0);
    hitT = -1;
    flameRig.visible = false;
    havePrev = false;
  }

  return {
    update, reset,
    confetti(at: THREE.Vector3, count = 120) {
      confettiBurst(at, null, 0, count);
    },
    setTrack(t: Track) {
      track = t;
      lips.length = 0;
      for (const g of t.tags) if (g.tag === 'bigjump') lips.push(g.s0, g.s1);
    },
  };
}
