import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadRig, type Rig } from '../drive/rig';

// The garage's 3D car: the inspector's orbit view (drag to turn round it, scroll or pinch to zoom) with the landing's
// turntable look - the drive page's own car (drive/rig.ts: the GLB with its see-through windows) on a dark stage, a
// soft contact shadow on a lit floor, the room's reflections, the brand's green rim light. It turns slowly by itself
// until it's touched, and again a few seconds after. One car at a time: a car picked while another is still loading
// replaces it, and the one it replaces is freed (geometry, materials, textures). Renders only while on screen.

const FOV = 26;
const EL = 0.2; // rad: the camera's height angle at the start
const START = 0.62; // rad: the car's front three-quarter (the landing's stills' angle)
const IDLE = 4; // s after a drag before it turns by itself again

export interface Viewer {
  /** Show this car (its GLB loads; the one before is freed). Resolves when it's on screen, or false if another car was
   *  asked for meanwhile or it failed to load. */
  show(car: string): Promise<boolean>;
  /** Show nothing (a car the game has no model of). */
  clear(): void;
  dispose(): void;
}

function floorTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 512;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(256, 256, 0, 256, 256, 256);
  r.addColorStop(0, 'rgba(120, 128, 160, 0.15)');
  r.addColorStop(0.4, 'rgba(120, 128, 160, 0.05)');
  r.addColorStop(0.75, 'rgba(120, 128, 160, 0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 512, 512);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,0.9)');
  r.addColorStop(0.45, 'rgba(0,0,0,0.55)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createViewer(canvas: HTMLCanvasElement): Viewer {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.3;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const env = pmrem.fromScene(new RoomEnvironment(), 0.04);
  pmrem.dispose();
  scene.environment = env.texture;
  scene.environmentIntensity = 1.05;
  const key = new THREE.DirectionalLight('#ffffff', 2.8);
  key.position.set(3, 7, 6);
  const rim = new THREE.DirectionalLight('#3dff8b', 1.6);
  rim.position.set(-5, 3, -6);
  const rim2 = new THREE.DirectionalLight('#dfe6ff', 2.6);
  rim2.position.set(6, 2, -5);
  scene.add(key, rim, rim2, new THREE.HemisphereLight('#d6deee', '#1a1416', 0.9));

  const floorTex = floorTexture(), shadowTex = shadowTexture();
  const floor = new THREE.Mesh(new THREE.CircleGeometry(1, 64), new THREE.MeshBasicMaterial({ map: floorTex, transparent: true, depthWrite: false }));
  floor.rotation.x = -Math.PI / 2;
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTex, transparent: true, depthWrite: false, opacity: 0.8 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  const stage = new THREE.Group();
  stage.add(floor, shadow);
  scene.add(stage);

  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.05, 100);
  const controls = new OrbitControls(camera, canvas);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.enablePan = false;
  controls.rotateSpeed = 0.7;
  controls.minPolarAngle = 0.25;
  controls.maxPolarAngle = 1.5; // (just above the floor)
  controls.autoRotate = true;
  controls.autoRotateSpeed = -0.9;
  let idleT = 0, touching = false;
  controls.addEventListener('start', () => ((touching = true), (controls.autoRotate = false)));
  controls.addEventListener('end', () => ((touching = false), (idleT = 0)));

  let rig: Rig | null = null, want = '', radius = 2.4, height = 1.2;
  let visible = true, running = true, raf = 0, last = performance.now();

  /** The camera at its start for the car on show: front three-quarter, the car's length taking ~70% of the width. */
  function frameCar() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    const v = THREE.MathUtils.degToRad(FOV), hz = 2 * Math.atan(Math.tan(v / 2) * (w / h));
    const d = Math.max(radius / 0.74 / Math.tan(hz / 2), (radius * 0.78) / Math.tan(v / 2));
    controls.target.set(0, height * 0.42, 0);
    camera.position.set(Math.sin(START) * Math.cos(EL) * d, height * 0.42 + Math.sin(EL) * d, Math.cos(START) * Math.cos(EL) * d);
    controls.minDistance = radius * 1.25;
    controls.maxDistance = d * 1.8;
    controls.update();
  }
  function fit() {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }
  function tick(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (visible && !document.hidden) {
      if (!touching && !controls.autoRotate && (idleT += dt) > IDLE) controls.autoRotate = true;
      controls.update(dt);
      renderer.render(scene, camera);
    }
    raf = requestAnimationFrame(tick);
  }
  const io = new IntersectionObserver((e) => (visible = e.some((x) => x.isIntersecting)));
  io.observe(canvas);
  let lastW = 0, lastH = 0;
  const ro = new ResizeObserver(() => {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    fit();
    // a real change of shape (a phone turned, the window resized) frames the car again; the first one too
    if (rig && (Math.abs(w - lastW) > 40 || Math.abs(h - lastH) > 40)) frameCar();
    (lastW = w), (lastH = h);
  });
  ro.observe(canvas);
  fit();
  raf = requestAnimationFrame(tick);

  return {
    async show(car: string) {
      want = car;
      let r: Rig;
      try {
        r = await loadRig(car);
      } catch {
        return false;
      }
      if (want !== car || !running) {
        r.dispose(); // (another car was asked for while this one loaded)
        return false;
      }
      rig?.dispose();
      rig?.root.removeFromParent();
      rig = r;
      scene.add(r.root);
      const { length, width, height: hgt } = r.spec;
      shadow.scale.set(length * 1.3, width * 2, 1);
      floor.scale.setScalar(length * 1.6);
      radius = Math.hypot(length / 2, width / 2, hgt / 2);
      height = hgt;
      fit();
      frameCar();
      (lastW = canvas.clientWidth), (lastH = canvas.clientHeight);
      controls.autoRotate = true;
      idleT = 0;
      return true;
    },
    clear() {
      want = '';
      rig?.dispose();
      rig?.root.removeFromParent();
      rig = null;
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      controls.dispose();
      rig?.dispose();
      floorTex.dispose();
      shadowTex.dispose();
      env.dispose();
      renderer.dispose();
    },
  };
}
