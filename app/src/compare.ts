import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { FBXLoader } from 'three/examples/jsm/loaders/FBXLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { splitGlass } from './glass';

// Side-by-side model review, every pane orbiting together:
//   /compare.html?car=<id>&m=current,tripo-multiview-clean,tripo-multiview-guided[&refs=1]
//   (or the older &a=<name>&b=<name>). A name is a model in /cars/<id>/snapshots/<name>.glb|.fbx;
//   "current" is /cars/<id>/model.glb. refs=1 adds the reference images the models were made from.
const q = new URLSearchParams(location.search);
const car = q.get('car') ?? 'skyline-hck01';
const sides = q.get('m') ? q.get('m')!.split(',') : [q.get('a') ?? 'current', q.get('b')].filter((n): n is string => !!n);
const refs: [string, string][] = q.get('refs') === '1'
  ? [['Reference sheet: right side', `/cars/${car}/review/side.jpg`],
     ['Reference sheet: left side', `/cars/${car}/review/left.jpg`],
     ['ChatGPT sheet: top', `/cars/${car}/review/top.jpg`]]
  : [];
const viewsEl = document.getElementById('views')!;
const total = sides.length + refs.length;
viewsEl.style.setProperty('--cols', String(total <= 2 ? total : total <= 4 ? 2 : 3));
const paneIds = sides.map((_, i) => {
  const d = document.createElement('div');
  d.className = 'view';
  d.id = `v${i}`;
  d.innerHTML = `<div class="tag"><b id="l${i}"></b><span id="s${i}"></span></div>`;
  viewsEl.append(d);
  return d.id;
});
for (const [title, src] of refs) {
  const d = document.createElement('div');
  d.className = 'view ref';
  d.innerHTML = `<img alt="${title}" src="${src}"><div class="tag"><b>${title}</b><span>reference</span></div>`;
  d.querySelector('img')!.addEventListener('error', () => d.remove());
  viewsEl.append(d);
}
const NAMES: Record<string, string> = { scripted: 'Scripts (retouched)' };
const label = (n: string) => NAMES[n] ?? (n.startsWith('tripo-') ? `Tripo P2 · ${n.slice(6)}` : n);
const url = (n: string) => `/cars/${car}/${n === 'current' ? 'model' : `snapshots/${n}`}`;

const camera = new THREE.PerspectiveCamera(Number(q.get('fov') ?? 30), 1, 0.05, 400); // ?fov=2 ~ orthographic
camera.position.set(6, 2.6, 7);
const controls = new OrbitControls(camera, document.getElementById('views')!);
controls.target.set(0, 0.55, 0);
// ?view=az,el,dist[,tx,ty,tz] - start camera (radians, model units)
if (q.get('view')) {
  const [az, el, d, tx = 0, ty = 0.55, tz = 0] = q.get('view')!.split(',').map(Number);
  controls.target.set(tx, ty, tz);
  camera.position.set(tx + d * Math.sin(az) * Math.cos(el), ty + d * Math.sin(el), tz + d * Math.cos(az) * Math.cos(el));
}
controls.enableDamping = true;
controls.update();

interface Side {
  el: HTMLElement;
  renderer: THREE.WebGLRenderer;
  scene: THREE.Scene;
  root: THREE.Group;
}

const panes: Side[] = paneIds.map((id) => {
  const el = document.getElementById(id)!;
  const renderer = new THREE.WebGLRenderer({ antialias: true });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.AgXToneMapping;
  el.prepend(renderer.domElement);
  const scene = new THREE.Scene();
  scene.background = new THREE.Color('#0d0e12');
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  scene.environmentIntensity = 0.6;
  const key = new THREE.DirectionalLight('#ffffff', 1.4);
  key.position.set(4, 8, 6);
  scene.add(key, new THREE.HemisphereLight('#c9d4e6', '#202024', 0.6));
  const grid = new THREE.GridHelper(8, 16, '#33353f', '#22242c');
  if (!q.get('nogrid')) scene.add(grid);
  const root = new THREE.Group();
  scene.add(root);
  return { el, renderer, scene, root };
});

const loader = new GLTFLoader();
const fbx = new FBXLoader();

// Models from other tools (Tripo FBX) come in their own units and facing: bring them into our frame -
// longest horizontal axis along x, length 4, centred, wheels on the ground. ?flip=<name> turns one 180°.
function normalise(obj: THREE.Object3D, name: string) {
  const box = new THREE.Box3().setFromObject(obj);
  const size = box.getSize(new THREE.Vector3());
  if (size.z > size.x) obj.rotation.y = Math.PI / 2;
  if ((q.get('flip') ?? '').split(',').includes(name)) obj.rotation.y += Math.PI;
  obj.updateMatrixWorld(true);
  const b2 = new THREE.Box3().setFromObject(obj);
  const s2 = b2.getSize(new THREE.Vector3());
  const k = 4 / s2.x;
  obj.scale.multiplyScalar(k);
  obj.updateMatrixWorld(true);
  const b3 = new THREE.Box3().setFromObject(obj);
  const c = b3.getCenter(new THREE.Vector3());
  obj.position.sub(new THREE.Vector3(c.x, b3.min.y, c.z));
}

async function load(name: string): Promise<THREE.Object3D> {
  for (const ext of ['.glb', '.fbx']) {
    const ok = await fetch(url(name) + ext, { method: 'HEAD' }).then((r) => r.ok && !(r.headers.get('content-type') ?? '').includes('html'));
    if (!ok) continue;
    if (ext === '.glb') return (await loader.loadAsync(url(name) + ext)).scene;
    const obj = await fbx.loadAsync(url(name) + ext);
    const holder = new THREE.Group();
    holder.add(obj);
    normalise(holder, name);
    return holder;
  }
  throw new Error('missing');
}

await Promise.all(
  sides.map(async (name, i) => {
    const tag = (s: string) => document.getElementById(s + i)!;
    tag('l').textContent = label(name);
    try {
      const gltf = { scene: await load(name) };
      panes[i].root.add(gltf.scene);
      const body = gltf.scene.getObjectByName('body');
      if (body instanceof THREE.Mesh && q.get('glass') !== '0') splitGlass(body); // ?glass=0: opaque windows
      let tris = 0;
      const seen = new Set<THREE.BufferGeometry>(); // the glass pass reuses the body's geometry
      gltf.scene.traverse((o) => {
        if (o instanceof THREE.Mesh && !seen.has(o.geometry)) {
          seen.add(o.geometry);
          tris += (o.geometry.index?.count ?? o.geometry.attributes.position.count) / 3;
        }
      });
      const info = await fetch(url(name) + '.json').then((r) => (r.ok ? r.json() : null)).catch(() => null);
      // the app's model.glb: built by the scripts, or a generated mesh promoted from a snapshot
      if (name === 'current') tag('l').textContent = `Current · ${info?.source ? label(info.source.replace(/^snapshots\/|\.glb$/g, '')) : 'Scripts'}`;
      const mb = info?.glb?.bytes ? ` · ${(info.glb.bytes / 1e6).toFixed(2)} MB` : '';
      const iou = info?.silhouette_iou ? ` · side IoU ${info.silhouette_iou.side}` : '';
      tag('s').textContent = `${car} · ${Math.round(tris).toLocaleString()} tris${mb}${iou}`;
    } catch {
      tag('s').textContent = `missing: ${url(name)}.glb / .fbx`;
    }
  }),
);

const meshes = () => panes.flatMap((p) => {
  const out: THREE.Mesh[] = [];
  p.root.traverse((o) => o instanceof THREE.Mesh && out.push(o));
  return out;
});
const originals = new Map<THREE.Mesh, THREE.Material | THREE.Material[]>();
meshes().forEach((m) => originals.set(m, m.material));
const clay = new THREE.MeshStandardMaterial({ color: '#c8c8c8', roughness: 0.6, metalness: 0 });

let textured = true;
let wire = false;
let spin = false;
const apply = () =>
  meshes().forEach((m) => {
    m.material = textured ? originals.get(m)! : clay;
    (Array.isArray(m.material) ? m.material : [m.material]).forEach((mat) => ((mat as THREE.MeshStandardMaterial).wireframe = wire));
  });
const toggle = (id: string, f: () => boolean) => {
  const b = document.getElementById(id)!;
  b.addEventListener('click', () => b.classList.toggle('on', f()));
};
toggle('t-tex', () => ((textured = !textured), apply(), textured));
toggle('t-wire', () => ((wire = !wire), apply(), wire));
toggle('t-spin', () => (spin = !spin));
if (q.get('clay')) document.getElementById('t-tex')!.click(); // ?clay=1 starts untextured

document.querySelectorAll<HTMLButtonElement>('[data-view]').forEach((b) =>
  b.addEventListener('click', () => {
    const [az, el] = b.dataset.view!.split(',').map(Number);
    const d = camera.position.distanceTo(controls.target);
    camera.position.set(
      controls.target.x + d * Math.sin(az) * Math.cos(el),
      controls.target.y + d * Math.sin(el),
      controls.target.z + d * Math.cos(az) * Math.cos(el),
    );
    controls.update();
  }),
);

function resize() {
  for (const p of panes) {
    const { clientWidth: w, clientHeight: h } = p.el;
    p.renderer.setSize(w, h, false);
    camera.aspect = w / h;
  }
  camera.updateProjectionMatrix();
}
addEventListener('resize', resize);
resize();

let frames = 0;
const clock = new THREE.Clock();
panes[0].renderer.setAnimationLoop(() => {
  const dt = clock.getDelta();
  if (spin) for (const p of panes) p.root.rotation.y += dt * 0.6;
  controls.update();
  for (const p of panes) p.renderer.render(p.scene, camera);
  if (++frames === 3) (window as any).__ready = true;
});
