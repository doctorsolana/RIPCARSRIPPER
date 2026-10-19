import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { splitGlass } from './glass';
import { mountNav } from './nav';
import { tierOf } from './rarity';

// /inspect.html[?car=<id>&tab=p3d|pviews|preveal|pinfo] - every car the pipeline built, one place.
interface Entry { id: string; make: string; model: string; year: number | null; rarity: string; modelled: boolean; passed: boolean | null; versions?: string[]; source?: string | null }

const $ = (id: string) => document.getElementById(id)!;
const q = new URLSearchParams(location.search);
const nav = await mountNav('inspect');
const { cars } = (await fetch('/cars/index.json').then((r) => r.json())) as { cars: Entry[] };

// ---- 3D viewer ----
const host = $('p3d');
const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.toneMapping = THREE.AgXToneMapping;
host.prepend(renderer.domElement);
const scene = new THREE.Scene();
scene.background = new THREE.Color('#0d0e12');
scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
scene.environmentIntensity = 0.6;
const key = new THREE.DirectionalLight('#ffffff', 1.4);
key.position.set(4, 8, 6);
scene.add(key, new THREE.HemisphereLight('#c9d4e6', '#202024', 0.6), new THREE.GridHelper(8, 16, '#33353f', '#22242c'));
const camera = new THREE.PerspectiveCamera(30, 1, 0.05, 200);
camera.position.set(6, 2.6, 7);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 0.55, 0);
controls.enableDamping = true;
const root = new THREE.Group();
scene.add(root);
const loader = new GLTFLoader();
const clay = new THREE.MeshStandardMaterial({ color: '#c8c8c8', roughness: 0.6 });
let originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
let clayOn = false, wire = false, spin = true;

function applyLook() {
  originals.forEach((mat, m) => {
    m.material = clayOn ? clay : mat;
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((x) => ((x as THREE.MeshStandardMaterial).wireframe = wire));
    if (m.name.endsWith('_glass')) m.visible = !clayOn;
  });
}

async function show3d(id: string, modelled: boolean) {
  root.clear();
  originals = new Map();
  if (!modelled) return;
  const gltf = await loader.loadAsync(`/cars/${id}/model.glb`);
  root.add(gltf.scene);
  const body = gltf.scene.getObjectByName('body');
  if (body instanceof THREE.Mesh) splitGlass(body);
  gltf.scene.traverse((o) => o instanceof THREE.Mesh && originals.set(o, o.material));
  applyLook();
}

const toggle = (id: string, f: () => boolean) => {
  const b = $(id);
  b.addEventListener('click', () => b.classList.toggle('on', f()));
};
toggle('t-clay', () => ((clayOn = !clayOn), applyLook(), clayOn));
toggle('t-wire', () => ((wire = !wire), applyLook(), wire));
toggle('t-spin', () => (spin = !spin));
document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    const [az, el] = b.dataset.view!.split(',').map(Number);
    const d = camera.position.distanceTo(controls.target);
    root.rotation.y = 0;
    spin = false;
    $('t-spin').classList.remove('on');
    camera.position.set(d * Math.sin(az) * Math.cos(el), controls.target.y + d * Math.sin(el), d * Math.cos(az) * Math.cos(el));
  }),
);

function resize() {
  const { clientWidth: w, clientHeight: h } = host;
  if (!w || !h) return;
  renderer.setSize(w, h, false);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
}
new ResizeObserver(resize).observe(host);
const clock = new THREE.Clock();
renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (spin) root.rotation.y += dt * 0.5;
  controls.update();
  renderer.render(scene, camera);
});

// ---- report ----
const fmt = (v: unknown) => (typeof v === 'number' ? (Math.abs(v) < 10 ? v.toFixed(3) : String(Math.round(v))) : String(v));
async function showInfo(id: string) {
  const get = (f: string) => fetch(`/cars/${id}/${f}`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [model, align, hints, meta] = await Promise.all([get('model.json'), get('alignment.json'), get('hints.json'), get('meta.json')]);
  const el = $('pinfo');
  if (!model) {
    el.innerHTML = '<p>No model built for this car yet (procedural fallback only).</p>';
    return;
  }
  const checks = Object.entries(model.checks as Record<string, boolean>)
    .map(([k, ok]) => `<tr><td>${k}</td><td class="${ok ? 'pass' : 'fail'}">${ok ? 'pass' : 'fail'}</td></tr>`).join('');
  const views = Object.keys(model.silhouette_iou)
    .map((v) => `<tr><td>${v}</td><td>${fmt(model.silhouette_iou[v])}</td><td>${fmt(model.view_match?.[v]?.colour_dE ?? '—')}</td></tr>`).join('');
  const notes = (hints?.notes ?? []).map((n: string) => `<li>${n}</li>`).join('') || '<li>none — fully automatic</li>';
  el.innerHTML = `
    <h3>Build</h3>
    <table>
      <tr><th>Mesh</th><td>${model.source ? `generated, repainted from the sheet (${model.source} ← ${model.made_from ?? '?'}) · glass ${model.glass_source ?? '—'}` : 'built by the ripcars scripts from the sheet'}</td></tr>
      <tr><th>Size</th><td>${(model.glb.bytes / 1e6).toFixed(2)} MB · ${model.glb.triangles.toLocaleString()} triangles</td></tr>
      <tr><th>Car</th><td>${meta?.make ?? ''} ${meta?.model ?? ''} · ${meta?.year ?? ''} · ${meta?.line ?? ''}</td></tr>
      <tr><th>Landing pose</th><td>${align ? `pitch ${align.pitch_deg.toFixed(1)}° · yaw ${align.yaw_deg.toFixed(1)}° · stretch ${align.stretch?.toFixed(3) ?? '1'} · pack-photo match ${fmt(align.iou)}` : '—'}</td></tr>
      <tr><th>Wing</th><td>${model.wing ? 'separate parts' : 'none / part of the body'}</td></tr>
      <tr><th>Cabin from windows</th><td>${model.cabin_from_glass ? 'yes' : 'no'}</td></tr>
    </table>
    <h3>Checks</h3><table>${checks}</table>
    <h3>Match per sheet view</h3>
    <table><tr><th>View</th><th>Outline match (IoU, 1 = exact)</th><th>Colour difference (ΔE, lower = closer)</th></tr>${views}</table>
    <h3>Manual retouches (hints.json notes)</h3><ul>${notes}</ul>`;
}

// ---- tabs, list, selection ----
let current = '';
let tab = q.get('tab') ?? 'p3d';
function setTab(t: string) {
  tab = t;
  document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.classList.toggle('on', b.dataset.tab === t));
  document.querySelectorAll('.pane').forEach((p) => p.classList.toggle('on', p.id === t));
  loadFrames();
  syncUrl();
  resize();
}
// snapshots are local working files (git-ignored): a fresh clone only has each car's current model
const exists = (url: string) =>
  fetch(url, { method: 'HEAD' }).then((r) => r.ok && !(r.headers.get('content-type') ?? '').includes('html')).catch(() => false);

async function loadFrames() {
  const frame = (pane: string, src: string) => {
    const f = $(pane).querySelector('iframe')!;
    if (tab === pane && f.dataset.src !== src) f.src = f.dataset.src = src; // load lazily, once per car
  };
  frame('pviews', `/views.html?car=${current}`);
  frame('preveal', `/rip.html?car=${current}`);
  const car = current;
  const entry = cars.find((c) => c.id === car);
  // every version of this car side by side: the current model, then the snapshots this checkout has
  // (minus the one that was promoted to model.glb: that one is "current")
  const promoted = entry?.source?.replace(/^snapshots\/|\.glb$/g, '');
  const named = (entry?.versions ?? []).filter((v) => v !== promoted);
  const found = await Promise.all(named.map(async (v) => (await exists(`/cars/${car}/snapshots/${v}.glb`)) || (await exists(`/cars/${car}/snapshots/${v}.fbx`))));
  if (car !== current) return; // another car was picked meanwhile
  const versions = ['current', ...named.filter((_, i) => found[i])];
  frame('pcompare', `/compare.html?car=${car}&m=${versions.join(',')}&refs=1`);
}
function syncUrl() {
  history.replaceState(null, '', `?car=${current}&tab=${tab}`);
}
document.querySelectorAll<HTMLButtonElement>('.tabs button').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab!)));

function select(id: string) {
  const c = cars.find((x) => x.id === id) ?? cars[0];
  current = c.id;
  nav.setCar(c.id);
  document.querySelectorAll('.car').forEach((b) => b.classList.toggle('on', (b as HTMLElement).dataset.id === c.id));
  $('name').textContent = `${c.make} ${c.model}${c.year ? ` · ${c.year}` : ''}`;
  show3d(c.id, c.modelled);
  showInfo(c.id);
  loadFrames();
  syncUrl();
}

for (const c of cars) {
  const b = document.createElement('button');
  b.className = 'car';
  b.dataset.id = c.id;
  const tier = tierOf(c.rarity);
  const status = c.passed === null ? 'no model' : c.passed ? 'checks pass' : 'needs review';
  const colour = c.passed === null ? '#8b90a0' : c.passed ? '#3dff8b' : '#ffb020';
  b.innerHTML = `<b>${c.make} ${c.model}</b><small><span class="dot" style="background:${colour}"></span>${status} · <span style="color:${tier.color}">${tier.label}</span></small>`;
  b.addEventListener('click', () => select(c.id));
  $('list').append(b);
}
select(q.get('car') ?? (cars.find((c) => c.modelled) ?? cars[0]).id); // default: the first car with a model
setTab(tab);
(window as any).__ready = true; // for scripts/shoot.mjs
