import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

// /views.html?car=<id>[&lit=1] - each sheet view next to the model rendered with that view's camera.
// Model frame: nose +x, up +y, right side +z. Sheet crops come from asset-generation (review/<view>.jpg).
const q = new URLSearchParams(location.search);
const car = q.get('car') ?? 'skyline-hck01';
const base = `/cars/${car}/`;
document.getElementById('title')!.textContent = `Sheet vs model · ${car}${q.get('m') ? ' · ' + q.get('m') : ''}`;
const litBox = document.getElementById('lit') as HTMLInputElement;
litBox.checked = q.get('lit') === '1';
litBox.addEventListener('change', () => {
  q.set('lit', litBox.checked ? '1' : '0');
  location.search = q.toString();
});

// camera direction (from the car towards the camera) and up vector per sheet view
const VIEWS: Record<string, { dir: THREE.Vector3; up: THREE.Vector3; label: string }> = {
  side: { dir: new THREE.Vector3(0, 0, 1), up: new THREE.Vector3(0, 1, 0), label: 'Right side' },
  left: { dir: new THREE.Vector3(0, 0, -1), up: new THREE.Vector3(0, 1, 0), label: 'Left side' },
  top: { dir: new THREE.Vector3(0, 1, 0), up: new THREE.Vector3(0, 0, -1), label: 'Top (nose right)' },
  front: { dir: new THREE.Vector3(1, 0, 0), up: new THREE.Vector3(0, 1, 0), label: 'Front' },
  rear: { dir: new THREE.Vector3(-1, 0, 0), up: new THREE.Vector3(0, 1, 0), label: 'Rear' },
};

// ?m=<snapshot> compares a snapshot (e.g. tripo-multiview-rebake) instead of the current model
const gltf = await new GLTFLoader().loadAsync(base + (q.get('m') ? `snapshots/${q.get('m')}.glb` : 'model.glb'));
const scene = new THREE.Scene();
scene.background = new THREE.Color('#ffffff');
scene.add(gltf.scene);
const lit = litBox.checked;
const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
renderer.toneMapping = lit ? THREE.AgXToneMapping : THREE.NoToneMapping;
if (lit) {
  scene.environment = new THREE.PMREMGenerator(renderer).fromScene(new RoomEnvironment(), 0.04).texture;
  const key = new THREE.DirectionalLight('#ffffff', 1.3);
  key.position.set(4, 8, 6);
  scene.add(key, new THREE.HemisphereLight('#ffffff', '#444', 0.6));
} else {
  // raw texture: exactly what was baked from the sheet, no lighting
  gltf.scene.traverse((o) => {
    if (o instanceof THREE.Mesh) {
      const m = o.material as THREE.MeshStandardMaterial;
      o.material = new THREE.MeshBasicMaterial({ map: m.map, color: m.map ? 0xffffff : m.color });
    }
  });
}
const box = new THREE.Box3().setFromObject(gltf.scene);
const rows = document.getElementById('rows')!;

for (const [name, v] of Object.entries(VIEWS)) {
  const ref = new Image();
  ref.src = `${base}review/${name}.jpg`;
  const ok = await ref.decode().then(() => true).catch(() => false);
  if (!ok) continue;
  // frame the model's own extent in this view's plane
  const cam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 100);
  const centre = box.getCenter(new THREE.Vector3());
  cam.up.copy(v.up);
  cam.position.copy(centre).addScaledVector(v.dir, 20);
  cam.lookAt(centre);
  cam.updateMatrixWorld();
  const corners = [0, 1, 2, 3, 4, 5, 6, 7].map((i) =>
    new THREE.Vector3(i & 1 ? box.max.x : box.min.x, i & 2 ? box.max.y : box.min.y, i & 4 ? box.max.z : box.min.z)
      .applyMatrix4(cam.matrixWorldInverse),
  );
  const xs = corners.map((c) => c.x), ys = corners.map((c) => c.y);
  Object.assign(cam, { left: Math.min(...xs), right: Math.max(...xs), top: Math.max(...ys), bottom: Math.min(...ys) });
  cam.updateProjectionMatrix();
  // same height as the reference crop, width from the model's own aspect
  const h = ref.naturalHeight;
  const w = Math.round((h * (cam.right - cam.left)) / (cam.top - cam.bottom));
  renderer.setSize(w, h, false);
  renderer.render(scene, cam);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  canvas.getContext('2d')!.drawImage(renderer.domElement, 0, 0);

  const row = document.createElement('section');
  row.className = 'row';
  row.innerHTML = `<h2>${v.label}</h2><div class="pair"><figure></figure><figure></figure></div>`;
  const [f1, f2] = row.querySelectorAll('figure');
  f1.append(ref, Object.assign(document.createElement('figcaption'), { textContent: 'ChatGPT sheet' }));
  f2.append(canvas, Object.assign(document.createElement('figcaption'), { textContent: lit ? 'Model (lit)' : 'Model (raw texture)' }));
  rows.append(row);
}
(window as any).__ready = true;
