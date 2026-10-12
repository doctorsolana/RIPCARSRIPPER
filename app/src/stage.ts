import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { type CarData, type CarRig, WORLD_LENGTH } from './car';

function radialTexture(stops: [number, string][]) {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const grad = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  for (const [o, col] of stops) grad.addColorStop(o, col);
  g.fillStyle = grad;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

// Additive glow that leaves the canvas alpha alone (plain AdditiveBlending also adds alpha, which
// turns the transparent canvas opaque-black wherever a glow quad is drawn).
const ADDITIVE = {
  blending: THREE.CustomBlending, blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneFactor,
  blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
} as const;

export type Stage = ReturnType<typeof createStage>;

export function createStage(canvas: HTMLCanvasElement, car: CarData, rig: CarRig, opts: { preserve?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, preserveDrawingBuffer: !!opts.preserve });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping; // keeps saturated paints (copper, orange) from going salmon
  renderer.toneMappingExposure = 1.1;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0;

  const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
  scene.add(camera);

  // Rim lights: the director keeps them behind the car relative to the camera every frame.
  const rimL = new THREE.DirectionalLight('#ffffff', 0);
  const rimR = new THREE.DirectionalLight('#ffffff', 0);
  scene.add(rimL, rimR);
  const key = new THREE.DirectionalLight('#ffffff', 0);
  key.position.set(3, 7, 6);
  const hemi = new THREE.HemisphereLight('#c9d4e6', '#0b0b0d', 0);
  scene.add(key, hemi);

  scene.add(rig.root);

  // Floor glow + contact shadow (the shadow turns with the car).
  const floor = new THREE.Mesh(
    new THREE.CircleGeometry(WORLD_LENGTH * 1.8, 64),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(255,255,255,0.55)'], [0.45, 'rgba(255,255,255,0.12)'], [1, 'rgba(255,255,255,0)']]),
      transparent: true, opacity: 0, depthWrite: false, toneMapped: false,
    }),
  );
  floor.rotation.x = -Math.PI / 2;
  floor.position.y = -0.002;
  scene.add(floor);

  const shadow = new THREE.Mesh(
    new THREE.PlaneGeometry(WORLD_LENGTH * 1.25, rig.halfWidth * 2 * 1.7),
    new THREE.MeshBasicMaterial({
      map: radialTexture([[0, 'rgba(0,0,0,0.9)'], [0.55, 'rgba(0,0,0,0.55)'], [1, 'rgba(0,0,0,0)']]),
      transparent: true, opacity: 0, depthWrite: false,
    }),
  );
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.001;
  rig.root.add(shadow);

  // Rarity shockwave ring on the floor.
  const ring = new THREE.Mesh(
    new THREE.RingGeometry(0.96, 1, 96),
    new THREE.MeshBasicMaterial({ color: '#ffffff', transparent: true, opacity: 0, ...ADDITIVE, depthWrite: false, toneMapped: false }),
  );
  ring.rotation.x = -Math.PI / 2;
  ring.position.y = 0.01;
  scene.add(ring);

  // Rising sparks.
  const COUNT = 700;
  const pPos = new Float32Array(COUNT * 3);
  const pVel = new Float32Array(COUNT);
  for (let i = 0; i < COUNT; i++) {
    const a = Math.random() * Math.PI * 2;
    const r = 1.6 + Math.random() * 5;
    pPos.set([Math.cos(a) * r, Math.random() * 4, Math.sin(a) * r], i * 3);
    pVel[i] = 0.25 + Math.random() * 0.9;
  }
  const pGeo = new THREE.BufferGeometry();
  pGeo.setAttribute('position', new THREE.BufferAttribute(pPos, 3));
  const particles = new THREE.Points(
    pGeo,
    new THREE.PointsMaterial({
      size: 0.07, map: radialTexture([[0, 'rgba(255,255,255,1)'], [0.3, 'rgba(255,255,255,0.5)'], [1, 'rgba(255,255,255,0)']]),
      color: '#ffffff', transparent: true, opacity: 0, ...ADDITIVE, depthWrite: false, toneMapped: false,
    }),
  );
  scene.add(particles);
  const sparkSpeed = { value: 1 };

  // The real pack photo, in the same frame the car was built in. Drawn first, behind everything.
  const ex = car.extract;
  const f = rig.frame;
  const cardW = ex.photo.w * f.s;
  const cardH = ex.photo.h * f.s;
  const cardCenter = new THREE.Vector3(f.x(ex.photo.w / 2), f.y(ex.photo.h / 2), 0);
  const card = new THREE.Mesh(
    new THREE.PlaneGeometry(cardW, cardH),
    new THREE.MeshBasicMaterial({ map: car.photoTex, transparent: true, opacity: 0, toneMapped: false, depthWrite: false, depthTest: false }),
  );
  card.position.copy(cardCenter);
  card.renderOrder = -1;
  scene.add(card);

  const shine = new THREE.Mesh(
    new THREE.PlaneGeometry(cardW, cardH),
    new THREE.ShaderMaterial({
      uniforms: { uSweep: { value: -1 }, uOpacity: { value: 0 } },
      vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); }',
      fragmentShader: `uniform float uSweep; uniform float uOpacity; varying vec2 vUv;
        void main(){ float d = vUv.x * 0.8 + vUv.y * 0.45 - uSweep;
          float b = exp(-d*d*180.0) + 0.35*exp(-(d+0.06)*(d+0.06)*900.0);
          gl_FragColor = vec4(vec3(1.0, 0.97, 0.9) * b * uOpacity, 1.0); }`,
      transparent: true, ...ADDITIVE, depthWrite: false, depthTest: false,
    }),
  );
  shine.position.copy(cardCenter);
  shine.renderOrder = 10;
  scene.add(shine);

  function update(dt: number) {
    for (let i = 0; i < COUNT; i++) {
      let y = pPos[i * 3 + 1] + pVel[i] * dt * sparkSpeed.value;
      if (y > 4) y -= 4;
      pPos[i * 3 + 1] = y;
    }
    pGeo.getAttribute('position').needsUpdate = true;
  }

  function resize(w: number, h: number) {
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  return {
    renderer, scene, camera, rimL, rimR, key, hemi, floor, shadow, ring, particles, sparkSpeed,
    card, shine, cardW, cardH, cardCenter, update, resize,
  };
}
