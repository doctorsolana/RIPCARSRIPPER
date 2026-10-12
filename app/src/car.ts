import * as THREE from 'three';

// ---- data from asset-generation/: scripts/extract.py (pack photo), params.json/meta.json (Claude) ----

export interface Extract {
  photo: { src: string; w: number; h: number };
  texture: { src: string; x: number; y: number; w: number; h: number };
  mask: { src: string; x: number; y: number; w: number; h: number };
  bbox: [number, number, number, number];
  groundY: number;
  stations: [number, number, number, number?][]; // [x, top, bottom, nearTop] as photographed
  wheels: { cx: number; cy: number; r: number }[];
  addons: { type: 'wing' | 'bump'; polygon: [number, number][]; plate?: [number, number][] }[];
  paint: string;
}

export type RevealMethod = 'hero' | 'profile';

export interface Params {
  widthRatio: number; // body width / body length
  plan: { front: number; rear: number }; // superellipse exponents of the top-view outline
  cabin: { x: [number, number]; beltline: [[number, number], [number, number]]; roofRatio: number };
  tire: { widthRatio: number; color: string };
  paint: { color?: string; metalness: number; roughness: number; clearcoat: number; clearcoatRoughness: number };
  glass: string;
  wing?: { widthRatio: number };
  realSize?: { l: number; w: number; h: number }; // mm, the real car — reference for widthRatio
  view?: { pitchDeg?: number }; // override: how far above level the pack photo sees the car
  reveal?: RevealMethod;
}

export interface Meta {
  make: string;
  model: string;
  year: number | null;
  line: string;
  series?: string;
  collection?: string;
  rarity: string;
}

export interface CarData {
  id: string;
  base: string;
  extract: Extract;
  params: Params | null; // only for the procedural fallback (cars without a model.glb)
  meta: Meta;
  sideTex: THREE.Texture;
  photoTex: THREE.Texture;
}

export async function loadCar(id: string): Promise<CarData> {
  const base = `${import.meta.env.BASE_URL}cars/${id}/`;
  const json = (f: string) => fetch(base + f).then((r) => r.json());
  const optional = (f: string) => fetch(base + f).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [extract, params, meta] = await Promise.all([json('extract.json'), optional('params.json'), json('meta.json')]);
  const loader = new THREE.TextureLoader();
  const [sideTex, photoTex] = await Promise.all([
    loader.loadAsync(base + extract.texture.src),
    loader.loadAsync(base + extract.photo.src),
  ]);
  for (const t of [sideTex, photoTex]) {
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
  }
  return { id, base, extract, params, meta, sideTex, photoTex };
}

// ---- photo pixel ↔ world mapping -----------------------------------------------------------------
// The photo plane is the world's xy plane: x right, y up, ground under the lowest wheel at y = 0,
// body length = WORLD_LENGTH. The car itself is modelled level; the pack photo sees it from `pitch`
// above, which we reproduce at the end by rolling the car toward the camera (rotation.x = pitch)
// and looking straight down -z. So a model point (x, y, z) lands on photo pixel
// (px(x), py(y·cos − z·sin)) — the relation everything below is built on.

export const WORLD_LENGTH = 4;
const IDENTITY = new THREE.Quaternion();
const DEG = Math.PI / 180;
const TOP_SPAN = 0.9; // over the fenders, the visible top surface spans ~90% of the body width

export class Frame {
  /** s: world units per photo px; (cx, gy): the photo px where the world origin sits */
  constructor(readonly s: number, readonly cx: number, readonly gy: number) {}
  static fromExtract(ex: Extract) {
    return new Frame(WORLD_LENGTH / ex.bbox[2], ex.bbox[0] + ex.bbox[2] / 2, ex.groundY);
  }
  x = (px: number) => (px - this.cx) * this.s;
  y = (py: number) => (this.gy - py) * this.s;
  px = (x: number) => x / this.s + this.cx;
  py = (y: number) => this.gy - y / this.s;
}

// ---- material: one shader for every car part ------------------------------------------------------
// diffuse = mix(paint|glass, texture, sideness·uTex). uReveal blacks it out (silhouette stage), uRim adds
// a fresnel edge glow, uTex fades the texture in (profile reveal), and uUnlit swaps the final lit colour
// for the raw pack-photo texel so the hand-off to the real photo is seamless. The procedural car's
// texture *is* the photo; a modelled car instead gets the photo projected through the final camera
// (`photo`: object space -> photo uv), glued to the car like a decal.

export interface CarUniforms {
  uReveal: { value: number };
  uUnlit: { value: number };
  uRim: { value: number };
  uRimColor: { value: THREE.Color };
  uTex: { value: number };
}

export function carMaterial(
  u: CarUniforms,
  opts: {
    map?: THREE.Texture | null; color?: string; paint: string; glass: string; metalness: number; roughness: number;
    clearcoat?: number; clearcoatRoughness?: number; photo?: { map: THREE.Texture; matrix: THREE.Matrix4 };
    materialMap?: THREE.Texture | null; // glTF metallicRoughness map (G roughness, B metalness): where the glass is
  },
) {
  const m = new THREE.MeshPhysicalMaterial({
    map: opts.map ?? null,
    color: opts.color ?? '#ffffff',
    roughnessMap: opts.materialMap ?? null,
    metalnessMap: opts.materialMap ?? null,
    metalness: opts.materialMap ? 1 : opts.metalness, // with a map, the map holds the values
    roughness: opts.materialMap ? 1 : opts.roughness,
    clearcoat: opts.clearcoat ?? 0,
    clearcoatRoughness: opts.clearcoatRoughness ?? 0.1,
    specularIntensity: 0.6, // tames grazing-angle glare on roofs and hoods
    transparent: true,
  });
  const local = {
    uPaint: { value: new THREE.Color(opts.paint) },
    uGlass: { value: new THREE.Color(opts.glass) },
    uPhotoMap: { value: opts.photo?.map ?? null },
    uPhotoMatrix: { value: opts.photo?.matrix ?? new THREE.Matrix4() },
  };
  if (opts.photo) m.defines = { ...m.defines, PHOTO_PROJ: '' };
  m.onBeforeCompile = (sh) => {
    Object.assign(sh.uniforms, u, local);
    sh.vertexShader = sh.vertexShader
      .replace(
        '#include <common>',
        `#include <common>
        attribute float aSide; attribute float aGlass; varying float vSide; varying float vGlass;
        #ifdef PHOTO_PROJ
          uniform mat4 uPhotoMatrix; varying vec2 vPhotoUv;
        #endif`,
      )
      .replace(
        '#include <begin_vertex>',
        `#include <begin_vertex>
        vSide = aSide; vGlass = aGlass;
        #ifdef PHOTO_PROJ
          vPhotoUv = (uPhotoMatrix * vec4(transformed, 1.0)).xy;
        #endif`,
      );
    sh.fragmentShader = sh.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
        uniform vec3 uPaint; uniform vec3 uGlass; uniform float uReveal; uniform float uUnlit;
        uniform float uRim; uniform vec3 uRimColor; uniform float uTex;
        varying float vSide; varying float vGlass;
        vec3 gTexel;
        #ifdef PHOTO_PROJ
          uniform sampler2D uPhotoMap; varying vec2 vPhotoUv;
        #endif`,
      )
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        gTexel = diffuseColor.rgb;
        diffuseColor.rgb = mix(mix(uPaint, uGlass, vGlass), gTexel, vSide * uTex) * uReveal;`,
      )
      // The photo already has its own reflections baked in, so photo-textured surfaces get less metal.
      .replace('#include <metalnessmap_fragment>', '#include <metalnessmap_fragment>\nmetalnessFactor *= mix(1.0, 0.3, vSide * uTex);')
      .replace(
        '#include <opaque_fragment>',
        `outgoingLight += uRimColor * uRim * pow(1.0 - saturate(dot(normal, normalize(vViewPosition))), 4.0);
        #include <opaque_fragment>`,
      )
      .replace(
        '#include <colorspace_fragment>',
        `#ifdef PHOTO_PROJ
          gTexel = texture2D(uPhotoMap, vPhotoUv).rgb;
        #endif
        gl_FragColor.rgb = mix(gl_FragColor.rgb, gTexel, uUnlit);
        #include <colorspace_fragment>`,
      );
  };
  return m;
}

// ---- helpers -------------------------------------------------------------------------------------------

const smooth = (e0: number, e1: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
};

function movingAvg(v: number[], win: number) {
  const h = win >> 1;
  return v.map((_, i) => {
    let sum = 0, n = 0;
    for (let k = Math.max(0, i - h); k <= Math.min(v.length - 1, i + h); k++) (sum += v[k]), n++;
    return sum / n;
  });
}

export function constAttrs(geo: THREE.BufferGeometry, side: number) {
  const c = geo.getAttribute('position').count;
  geo.setAttribute('aSide', new THREE.BufferAttribute(new Float32Array(c).fill(side), 1));
  geo.setAttribute('aGlass', new THREE.BufferAttribute(new Float32Array(c), 1));
  return geo;
}

// A generic sports-coupe side profile, in wheelbase units: [u along the car (0 = rear axle, 1 = front
// axle), height above ground]. The profile reveal starts as this and morphs into the real car.
const GENERIC_TOP: [number, number][] = [
  [-0.34, 0.16], [-0.31, 0.23], [-0.2, 0.26], [-0.02, 0.28], [0.16, 0.35], [0.33, 0.44], [0.5, 0.465],
  [0.62, 0.45], [0.78, 0.33], [0.96, 0.27], [1.13, 0.24], [1.25, 0.2], [1.3, 0.12],
];

// ---- the build -----------------------------------------------------------------------------------------

export interface CarRig {
  root: THREE.Group; // turntable yaw, pivot at the car's centre
  photoQuat?: THREE.Quaternion; // modelled cars: the pack-photo pose (level group at k = 0)
  photoStretch?: number; // ...and the lengthwise stretch that absorbs the sheet's proportions
  level: THREE.Group; // photo pose (pitch roll + photo tilt) ↔ level on the turntable
  body: THREE.Mesh; // morphTargetInfluences[0]: 1 = generic coupe, 0 = this car
  wing: THREE.Group; // scale.y 0 → 1 pops the wing up
  wheels: THREE.Group[]; // spin about z
  uniforms: CarUniforms;
  materials: THREE.Material[];
  frame: Frame;
  pitch: number;
  levelAngle: number;
  levelLift: number;
  halfWidth: number;
  height: number;
  method: RevealMethod;
}

export function buildCar(car: CarData, methodOverride?: RevealMethod | null): CarRig {
  const ex = car.extract;
  const p = car.params!;
  const f = Frame.fromExtract(ex);
  const [bx, , bw] = ex.bbox;
  const halfW = (p.widthRatio * WORLD_LENGTH) / 2;
  const tireW = p.tire.widthRatio * WORLD_LENGTH;
  const paint = p.paint.color ?? ex.paint;
  const N = ex.stations.length;

  const uniforms: CarUniforms = {
    uReveal: { value: 1 },
    uUnlit: { value: 0 },
    uRim: { value: 0 },
    uRimColor: { value: new THREE.Color('#ffffff') },
    uTex: { value: 1 },
  };
  const bodyMat = carMaterial(uniforms, { map: car.sideTex, paint, glass: p.glass, ...p.paint });
  const rubberMat = carMaterial(uniforms, { color: p.tire.color, paint, glass: p.glass, metalness: 0, roughness: 0.85 });
  const chassisMat = carMaterial(uniforms, { color: '#0a0a0a', paint, glass: p.glass, metalness: 0, roughness: 0.9 });
  const wheelMat = carMaterial(uniforms, { map: car.sideTex, paint, glass: p.glass, metalness: 0.4, roughness: 0.45 });

  // ---- cross-section model ----
  const plan = (xpx: number) => {
    const t = 2 * Math.min(0.997, Math.max(0.003, (xpx - bx) / bw)) - 1;
    const k = t > 0 ? p.plan.front : p.plan.rear;
    return Math.pow(1 - Math.pow(Math.abs(t), k), 1 / k);
  };
  const fall = bw * 0.03;
  const cabinW = (xpx: number) =>
    smooth(p.cabin.x[0] - fall, p.cabin.x[0] + fall, xpx) * (1 - smooth(p.cabin.x[1] - fall, p.cabin.x[1] + fall, xpx));
  const [[b0x, b0y], [b1x, b1y]] = p.cabin.beltline;
  const beltPx = (xpx: number) => b0y + ((xpx - b0x) / (b1x - b0x)) * (b1y - b0y);

  // A slice: sill of half-width Wb at height yb, flanks tucking in to a top of half-width wt at shoulder
  // height ys, rounded corners, slight crown. Fixed point counts per segment so vertex j sits on the same
  // feature in every slice (and in the generic morph target).
  const SEG = { bottom: 3, corner: 3, wall: 8, shoulder: 4, top: 4 };
  const HALF = 1 + SEG.bottom + SEG.corner + SEG.wall + SEG.shoulder + SEG.top; // bottom centre … top centre
  const M = 2 * HALF - 2;
  const RY = new Float64Array(M), RZ = new Float64Array(M);
  const radii = (yb: number, ys: number, Wb: number, wt: number) => ({
    rb: Math.min(0.3 * Wb, 0.22 * (ys - yb)),
    rs: Math.min(0.4 * wt, 0.3 * (ys - yb)),
  });
  function ring(yb: number, ys: number, Wb: number, wt: number, rb: number, rs: number, ybWall = yb) {
    const crown = 0.05 * wt;
    const hz: number[] = [0], hy: number[] = [yb];
    const push = (z: number, y: number) => (hz.push(z), hy.push(y));
    for (let k = 1; k <= SEG.bottom; k++) push(((Wb - rb) * k) / SEG.bottom, yb);
    for (let k = 1; k <= SEG.corner; k++) {
      const a = -Math.PI / 2 + (Math.PI / 2) * (k / SEG.corner);
      push(Wb - rb + rb * Math.cos(a), yb + rb + rb * Math.sin(a));
    }
    // Wall rows are spaced from the smooth sill line (ybWall); over a wheel arch the ones below the arch
    // top just collapse onto it, so the arch never bends the panel above it.
    const y0 = ybWall + rb, y1 = ys - rs;
    for (let k = 1; k <= SEG.wall; k++)
      push(Wb + (wt - Wb) * smooth(0.3, 1, k / SEG.wall), Math.max(yb + rb, y0 + ((y1 - y0) * k) / SEG.wall));
    for (let k = 1; k <= SEG.shoulder; k++) {
      const a = (Math.PI / 2) * (k / SEG.shoulder);
      push(wt - rs + rs * Math.cos(a), ys - rs + rs * Math.sin(a));
    }
    for (let k = 1; k <= SEG.top; k++) {
      const t = k / SEG.top;
      push((wt - rs) * (1 - t), ys + crown * (1 - (1 - t) ** 2));
    }
    // near half bottom centre → top centre, then the far half mirrored back down (shared ends once)
    let j = 0;
    for (let k = 0; k < HALF; k++, j++) (RZ[j] = hz[k]), (RY[j] = hy[k]);
    for (let k = HALF - 2; k >= 1; k--, j++) (RZ[j] = -hz[k]), (RY[j] = hy[k]);
  }

  // ---- from photographed edges to the true car ----------------------------------------------------
  // The pack camera looks down at `pitch`, so a point (x, y, z) photographs at height y·cos − z·sin.
  // Three measured lines per station: the silhouette top is the FAR shoulder, extract.py's tracked
  // near top edge is the NEAR shoulder, the silhouette bottom is the near sill. Hence
  //   far − near = 2·wt·sin  (how wide the top is here)      far = ys·cos + wt·sin  (shoulder height)
  const obsTop = ex.stations.map((s) => f.y(s[1]));
  const obsBot = ex.stations.map((s) => f.y(s[2]));
  const obsNear = ex.stations.map((s) => f.y(s[3] ?? s[1]));
  const xs = ex.stations.map((s) => s[0]);
  const WB = xs.map((x) => halfW * plan(x));

  // Pitch: over the fenders the top spans ~90% of the body width, so band = 2·0.9·W·sin(pitch).
  // Claude can override with a measured view.pitchDeg.
  let pitch: number;
  if (p.view?.pitchDeg != null) pitch = p.view.pitchDeg * DEG;
  else {
    const r = xs
      .map((x, i) => ({ u: (x - bx) / bw, v: (obsTop[i] - obsNear[i]) / (2 * TOP_SPAN * WB[i]) }))
      .filter((o) => o.u > 0.08 && o.u < 0.92)
      .map((o) => o.v)
      .sort((a, b) => a - b);
    pitch = Math.asin(Math.min(0.45, Math.max(0, r[Math.floor(r.length * 0.75)] ?? 0)));
  }
  const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
  const kRound = (cosP + sinP - 1) / cosP; // rounded corners pull projected extremes in by r·(cos+sin−1)

  // The near edge is tracked to ±1–2 px, and dividing by 2·sin(pitch) amplifies that ~2.4× — smooth it.
  const WT = movingAvg(
    xs.map((_, i) => Math.min(0.98 * WB[i], Math.max(0.2 * WB[i], sinP > 0.02 ? (obsTop[i] - obsNear[i]) / (2 * sinP) : 0.85 * WB[i]))),
    9,
  );
  const YB: number[] = [], YS: number[] = [];
  for (let i = 0; i < N; i++) {
    const wt = WT[i];
    let ys = (obsTop[i] - wt * sinP) / cosP;
    let yb = (obsBot[i] + WB[i] * sinP) / cosP;
    if (ys - yb < 0.01) ys = yb + 0.01;
    const { rb, rs } = radii(yb, ys, WB[i], wt);
    ys += rs * kRound;
    yb -= rb * kRound;
    YB.push(yb), YS.push(ys);
  }
  const roofT = Math.max(...YS);
  const wheelsT = ex.wheels.map((w) => {
    const zw = halfW * plan(w.cx) - tireW * 0.5;
    // The photographed circle is the tyre's outer face, at z = zw + tireW/2.
    return { x: f.x(w.cx), y: (f.y(w.cy) + (zw + tireW / 2) * sinP) / cosP, r: w.r * f.s, zw, src: w };
  });

  // ---- body (true shape) + generic coupe as a morph target -------------------------------------------
  function loft(yb: number[], ys: number[], wb: number[], wt: number[], worldX: (i: number) => number) {
    // Smooth sill: the bottom line with the wheel arches bridged over.
    const inArch = (i: number) => wheelsT.some((w) => Math.abs(worldX(i) - w.x) < w.r * 1.15);
    const keep = yb.map((_, i) => i).filter((i) => !inArch(i));
    const sill = yb.map((v, i) => {
      if (!inArch(i)) return v;
      const lo = keep.filter((k) => k < i).pop(), hi = keep.find((k) => k > i);
      if (lo == null || hi == null) return yb[lo ?? hi ?? i];
      return THREE.MathUtils.lerp(yb[lo], yb[hi], (i - lo) / (hi - lo));
    });
    // Corner radii follow a smoothed panel height, so arches and noise don't ripple the shoulders.
    const h = movingAvg(ys.map((y, i) => y - sill[i]), 15);
    const pos: number[] = [];
    for (let i = 0; i < N; i++) {
      const r = radii(0, Math.min(h[i], ys[i] - yb[i]), wb[i], wt[i]); // never larger than the slice itself
      ring(yb[i], ys[i], wb[i], wt[i], r.rb, r.rs, Math.min(sill[i], yb[i]));
      for (let j = 0; j < M; j++) pos.push(worldX(i), RY[j], RZ[j]);
    }
    for (const i of [0, N - 1]) pos.push(worldX(i), (ys[i] + yb[i]) / 2, 0);
    return pos;
  }
  const idx: number[] = [];
  for (let i = 0; i < N - 1; i++)
    for (let j = 0; j < M; j++) {
      const a = i * M + j, b = i * M + ((j + 1) % M), c = (i + 1) * M + j, d = (i + 1) * M + ((j + 1) % M);
      idx.push(a, c, b, b, c, d);
    }
  for (const [ring_, ci, flip] of [[0, N * M, false], [N - 1, N * M + 1, true]] as const)
    for (let j = 0; j < M; j++) {
      const a = ring_ * M + j, b = ring_ * M + ((j + 1) % M);
      flip ? idx.push(ci, b, a) : idx.push(ci, a, b);
    }

  const bodyGeo = new THREE.BufferGeometry();
  bodyGeo.setAttribute('position', new THREE.Float32BufferAttribute(loft(YB, YS, WB, WT, (i) => f.x(xs[i])), 3));
  bodyGeo.setIndex(idx);
  bodyGeo.computeVertexNormals();

  const [rw, fw] = wheelsT;
  {
    const wb = fw.x - rw.x;
    const ground = (x: number) => THREE.MathUtils.lerp(rw.y - rw.r, fw.y - fw.r, (x - rw.x) / wb);
    const curve = new THREE.SplineCurve(GENERIC_TOP.map(([u, h]) => new THREE.Vector2(u, h)));
    const dense = curve.getSpacedPoints(400);
    const topAt = (u: number) => {
      let k = 1;
      while (k < dense.length - 1 && dense[k].x < u) k++;
      const a = dense[k - 1], b = dense[k];
      return THREE.MathUtils.lerp(a.y, b.y, (u - a.x) / Math.max(1e-6, b.x - a.x));
    };
    const scale = (roofT - ground(0)) / (Math.max(...GENERIC_TOP.map((g) => g[1])) * wb);
    const u0 = GENERIC_TOP[0][0], u1 = GENERIC_TOP[GENERIC_TOP.length - 1][0];
    const gx = Array.from({ length: N }, (_, i) => rw.x + (u0 + ((u1 - u0) * i) / (N - 1)) * wb);
    const gYS: number[] = [], gYB: number[] = [], gWT: number[] = [];
    const rArch = Math.max(rw.r, fw.r) * 1.02;
    gx.forEach((x, i) => {
      const u = (x - rw.x) / wb, g = ground(x);
      const top = g + topAt(u) * wb * scale;
      let bot = g + Math.max(rw.r, fw.r) * 0.6;
      for (const w of [rw, fw]) {
        const dx = x - w.x;
        if (Math.abs(dx) < rArch) bot = Math.max(bot, w.y + Math.sqrt(rArch * rArch - dx * dx));
      }
      const end = Math.min(u - u0, u1 - u) / (u1 - u0);
      bot += (1 - smooth(0, 0.05, end)) * (top - bot) * 0.45;
      gYS.push(top);
      gYB.push(Math.min(bot, top - 0.01));
      gWT.push(WB[i] * (0.9 - 0.25 * smooth(0.12, 0.3, u) * (1 - smooth(0.68, 0.86, u)))); // generic greenhouse over its own roof
    });
    const gGeo = new THREE.BufferGeometry();
    gGeo.setAttribute('position', new THREE.Float32BufferAttribute(loft(gYB, gYS, WB, gWT, (i) => gx[i]), 3));
    gGeo.setIndex(idx);
    gGeo.computeVertexNormals();
    bodyGeo.morphAttributes.position = [gGeo.getAttribute('position')];
    bodyGeo.morphAttributes.normal = [gGeo.getAttribute('normal')];
  }

  // Planar-project the photo through the photo's own (pitched) camera; the far side borrows the near
  // side's pixels mirrored. Each vertex is tagged with how squarely the photo saw it.
  const beltAtX = (x: number) => {
    const xpx = f.px(x);
    return (f.y(beltPx(xpx)) + halfW * plan(xpx) * sinP) / cosP;
  };
  function project(geo: THREE.BufferGeometry, glass = false) {
    if (!geo.getAttribute('normal')) geo.computeVertexNormals();
    const pos = geo.getAttribute('position');
    const nrm = geo.getAttribute('normal');
    const t = ex.texture;
    const uv = new Float32Array(pos.count * 2);
    const side = new Float32Array(pos.count);
    const gl = new Float32Array(pos.count);
    for (let i = 0; i < pos.count; i++) {
      const x = pos.getX(i), y = pos.getY(i), z = pos.getZ(i);
      const xpx = f.px(x);
      const ypx = f.py(y * cosP - Math.abs(z) * sinP);
      uv[i * 2] = (xpx - t.x) / t.w;
      uv[i * 2 + 1] = 1 - (ypx - t.y) / t.h;
      const nz = z < 0 ? -nrm.getZ(i) : nrm.getZ(i);
      side[i] = smooth(0.12, 0.5, nrm.getY(i) * sinP + nz * cosP); // tops only partly: they're mostly blister reflection
      if (glass) {
        const belt = beltAtX(x);
        const above = smooth(0, 1, (y - belt) / Math.max(1e-4, roofT - belt));
        gl[i] = cabinW(xpx) * above * smooth(0.25, 0.5, Math.abs(nrm.getX(i))) * (1 - side[i]);
      }
    }
    geo.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
    geo.setAttribute('aSide', new THREE.BufferAttribute(side, 1));
    geo.setAttribute('aGlass', new THREE.BufferAttribute(gl, 1));
    return geo;
  }
  project(bodyGeo, true);

  const level = new THREE.Group();
  const body = new THREE.Mesh(bodyGeo, bodyMat);
  body.morphTargetInfluences = [0];
  level.add(body);

  // ---- wing: the photographed wing is the far endplate lifted + near endplate dropped, so squash it
  // vertically about its centre by 2·w·sin(pitch); endplates carry that outline, the plate spans them.
  const wingHalf = halfW * (p.wing?.widthRatio ?? 0.85);
  const wing = new THREE.Group();
  for (const a of ex.addons.filter((a) => a.type === 'wing')) {
    const ys = a.polygon.map(([, y]) => f.y(y));
    const yMid = (Math.max(...ys) + Math.min(...ys)) / 2;
    const h = Math.max(...ys) - Math.min(...ys);
    const k = Math.max(0.3, (h - 2 * wingHalf * sinP) / h);
    const shapeOf = (poly: [number, number][]) =>
      new THREE.Shape(poly.map(([x, y]) => new THREE.Vector2(f.x(x), (yMid + (f.y(y) - yMid) * k) / cosP)));
    const base = Math.min(...a.polygon.map(([, y]) => (yMid + (f.y(y) - yMid) * k) / cosP));
    wing.position.y = base;
    const plateT = 0.025;
    const part = (poly: [number, number][], z0: number, depth: number) => {
      const g = new THREE.ExtrudeGeometry(shapeOf(poly), { depth, bevelEnabled: false });
      g.translate(0, 0, z0);
      project(g); // project at the final height, then hang it off the pivot at the wing's base
      g.translate(0, -base, 0);
      wing.add(new THREE.Mesh(g, bodyMat));
    };
    part(a.polygon, wingHalf - plateT, plateT);
    part(a.polygon, -wingHalf, plateT);
    if (a.plate) part(a.plate, -wingHalf, wingHalf * 2);
  }
  level.add(wing);

  // ---- chassis: dark block between the wheels so you can't see through the arch tunnels ----
  if (rw && fw) {
    const between = YB.filter((_, i) => f.x(xs[i]) > rw.x + rw.r && f.x(xs[i]) < fw.x - fw.r);
    const sill = Math.max(...between);
    const top = Math.max(rw.y, fw.y) + Math.max(rw.r, fw.r) * 0.6;
    const g = new THREE.BoxGeometry(fw.x + fw.r - (rw.x - rw.r), top - sill, halfW * 1.5);
    g.translate((rw.x - rw.r + fw.x + fw.r) / 2, (sill + top) / 2, 0);
    level.add(new THREE.Mesh(constAttrs(g, 1), chassisMat));
  }

  // ---- wheels: tread + a face disc that samples the photo's own rim, so the real wheel design spins ----
  const wheels: THREE.Group[] = [];
  for (const w of wheelsT) {
    for (const sgn of [1, -1]) {
      const hub = new THREE.Group();
      hub.position.set(w.x, w.y, sgn * w.zw);
      const spin = new THREE.Group();
      hub.add(spin);
      const tread = new THREE.CylinderGeometry(w.r, w.r, tireW, 48, 1, true);
      tread.rotateX(Math.PI / 2);
      spin.add(new THREE.Mesh(constAttrs(tread, 1), rubberMat));
      const face = new THREE.CircleGeometry(w.r, 64);
      const fp = face.getAttribute('position');
      const fuv = face.getAttribute('uv');
      const { cx, cy } = w.src;
      for (let i = 0; i < fp.count; i++) {
        fuv.setXY(i, (cx + fp.getX(i) / f.s - ex.texture.x) / ex.texture.w, 1 - (cy - fp.getY(i) / f.s - ex.texture.y) / ex.texture.h);
      }
      if (sgn < 0) face.rotateY(Math.PI);
      face.translate(0, 0, (sgn * tireW) / 2);
      spin.add(new THREE.Mesh(constAttrs(face, 1), wheelMat));
      const back = new THREE.CircleGeometry(w.r * 0.98, 32);
      if (sgn > 0) back.rotateY(Math.PI);
      back.translate(0, 0, (-sgn * tireW) / 2);
      spin.add(new THREE.Mesh(constAttrs(back, 1), rubberMat));
      level.add(hub);
      wheels.push(spin);
    }
  }

  // ---- turntable levelling: undo the photo's in-plane tilt and put both tyres on y = 0 ----
  const levelAngle = rw && fw ? Math.atan2(rw.y - fw.y, fw.x - rw.x) : 0;
  const bottoms = wheelsT.map((w) => w.x * Math.sin(levelAngle) + w.y * Math.cos(levelAngle) - w.r);
  const levelLift = bottoms.length ? -Math.min(...bottoms) : 0;

  const root = new THREE.Group();
  root.add(level);
  const rig: CarRig = {
    root, level, body, wing, wheels, uniforms,
    materials: [bodyMat, rubberMat, chassisMat, wheelMat],
    frame: f, pitch, levelAngle, levelLift,
    halfWidth: halfW,
    height: roofT,
    method: methodOverride ?? p.reveal ?? 'profile',
  };
  setLevel(rig, 0);
  return rig;
}

/** 0 = photo pose (rolled toward the camera, tilted like the photo), 1 = level on the turntable floor. */
export function setLevel(rig: CarRig, k: number) {
  if (rig.photoQuat) {
    rig.level.quaternion.slerpQuaternions(rig.photoQuat, IDENTITY, k);
    rig.level.scale.x = 1 + ((rig.photoStretch ?? 1) - 1) * (1 - k);
    return;
  }
  rig.level.rotation.x = rig.pitch * (1 - k);
  rig.level.rotation.z = rig.levelAngle * k;
  rig.level.position.y = rig.levelLift * k;
}

export function setOpacity(rig: CarRig, o: number) {
  for (const m of rig.materials) m.opacity = o;
  rig.root.visible = o > 0.001;
}
