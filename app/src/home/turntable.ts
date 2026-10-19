import * as THREE from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { loadRig, type Rig } from '../drive/rig';

// The landing's 3D car: the drive page's own car (drive/rig.ts: the GLB with its see-through windows) turning slowly on
// a dark stage - a soft contact shadow, the room's reflections, a pink rim light. Drag to spin it. Loaded only after the
// page's first paint (home/main.ts), over a still of exactly this frame (scripts/render-home.mjs renders the stills with
// this same code: stills.html), so the swap doesn't show. Renders only while on screen.

export const START = 0.62; // rad: the car's turn in the first frame (its front three-quarter; the stills' angle)
const SPIN = 0.24; // rad/s
const FOV = 24;
const EL = 0.19; // rad: the camera's height angle
const FILL = 0.92; // of the frame's width the car's length takes, side on

export interface Turntable {
  /** Show this car (loads its GLB), turned to START. */
  show(car: string): Promise<void>;
  /** The frame as a webp data URL (the stills). */
  still(q?: number): string;
  /** Turning on its own (false: hold the angle - the stills). */
  spin: boolean;
  dispose(): void;
}

function shadowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  const r = g.createRadialGradient(128, 128, 0, 128, 128, 128);
  r.addColorStop(0, 'rgba(0,0,0,0.85)');
  r.addColorStop(0.45, 'rgba(0,0,0,0.5)');
  r.addColorStop(1, 'rgba(0,0,0,0)');
  g.fillStyle = r;
  g.fillRect(0, 0, 256, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

export function createTurntable(canvas: HTMLCanvasElement, o: { interactive?: boolean } = {}): Turntable {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.3;
  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 1.05;
  const key = new THREE.DirectionalLight('#ffffff', 2.8);
  key.position.set(3, 7, 6);
  const rim = new THREE.DirectionalLight('#3dff8b', 1.7); // the brand's green, from behind: a thin outline of the car on the dark
  rim.position.set(-5, 3, -6);
  const rim2 = new THREE.DirectionalLight('#dfe6ff', 3);
  rim2.position.set(6, 2, -5);
  const fill = new THREE.HemisphereLight('#d6deee', '#1a1416', 0.9);
  scene.add(key, rim, rim2, fill);
  const camera = new THREE.PerspectiveCamera(FOV, 1, 0.1, 100);
  const turn = new THREE.Group();
  scene.add(turn);
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(1, 1), new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0.75 }));
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.y = 0.002;
  turn.add(shadow);

  let rig: Rig | null = null, radius = 2.6, centreY = 0.5, angle = START, vel = 0, drag: { x: number; t: number } | null = null;
  let visible = true, running = true, raf = 0, last = performance.now();
  const tt: Turntable = {
    spin: true,
    async show(car: string) {
      const r = await loadRig(car);
      rig?.dispose();
      rig = r;
      turn.add(r.root);
      const { length, width, height } = r.spec;
      shadow.scale.set(length * 1.35, width * 2.1, 1);
      radius = Math.hypot(length / 2, width / 2, height / 2);
      centreY = height * 0.42;
      angle = START;
      vel = 0;
      frame();
    },
    still(q = 0.86) {
      frame();
      return canvas.toDataURL('image/webp', q);
    },
    dispose() {
      running = false;
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      rig?.dispose();
      renderer.dispose();
    },
  };

  function fit() {
    const w = canvas.clientWidth || canvas.width, h = canvas.clientHeight || canvas.height;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // side on, the car's length fills FILL of the width - and never more than the height takes (a tall frame)
    const v = THREE.MathUtils.degToRad(FOV), hz = 2 * Math.atan(Math.tan(v / 2) * camera.aspect);
    const d = Math.max(radius / FILL / Math.tan(hz / 2), (radius * 0.62) / Math.tan(v / 2));
    camera.position.set(0, centreY + Math.sin(EL) * d, Math.cos(EL) * d);
    camera.lookAt(0, centreY, 0);
    camera.updateProjectionMatrix();
  }
  function frame() {
    fit();
    turn.rotation.y = -angle; // (+ turns the nose toward the camera's right: the model's nose is +x)
    renderer.render(scene, camera);
  }
  function tick(now: number) {
    if (!running) return;
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    if (visible && !document.hidden) {
      if (!drag) {
        if (tt.spin) angle += SPIN * dt;
        angle += vel * dt;
        vel *= Math.exp(-dt * 2.2);
      }
      frame();
    }
    raf = requestAnimationFrame(tick);
  }
  // only while on screen
  const io = new IntersectionObserver((e) => (visible = e.some((x) => x.isIntersecting)));
  io.observe(canvas);
  const ro = new ResizeObserver(() => rig && frame());
  ro.observe(canvas);
  if (o.interactive) {
    canvas.style.touchAction = 'pan-y'; // (a vertical swipe still scrolls the page)
    canvas.addEventListener('pointerdown', (e) => {
      drag = { x: e.clientX, t: performance.now() };
      vel = 0;
      canvas.setPointerCapture(e.pointerId);
    });
    canvas.addEventListener('pointermove', (e) => {
      if (!drag) return;
      const now = performance.now(), dx = e.clientX - drag.x, dts = Math.max(0.008, (now - drag.t) / 1000);
      const da = (dx / Math.max(200, canvas.clientWidth)) * Math.PI * 1.6;
      angle += da;
      vel = vel * 0.6 + (da / dts) * 0.4;
      drag = { x: e.clientX, t: now };
    });
    const end = () => {
      drag = null;
      vel = Math.max(-6, Math.min(6, vel));
    };
    canvas.addEventListener('pointerup', end);
    canvas.addEventListener('pointercancel', end);
  }
  raf = requestAnimationFrame(tick);
  return tt;
}
