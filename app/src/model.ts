import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { type CarData, type CarRig, type CarUniforms, Frame, carMaterial, constAttrs, setLevel } from './car';
import { splitGlass } from './glass';

// ---- a car modelled by asset-generation/ripcars from its reference sheet -------------------------
// model.glb  body + wheel pivots (local +z out of the car), model frame: nose +x, up +y, right side +z,
//            ground y = 0, length 4
// model.json dimensions, wheels, QA
// alignment.json  the pose that lands the model on the pack photo (orthographic, photo px):
//            u = tx + scale * (R S p).x,  v = ty - scale * (R S p).y,  S = diag(stretch, 1, 1)

export interface Alignment {
  scale: number;
  tx: number;
  ty: number;
  quaternion: [number, number, number, number];
  stretch?: number;
  iou: number;
}

export interface ModelInfo {
  dimensions: { length: number; height: number; width: number };
}

export interface Model {
  gltf: THREE.Group;
  info: ModelInfo;
  alignment: Alignment;
}

export async function loadModel(car: CarData): Promise<Model | null> {
  const get = (f: string) => fetch(car.base + f).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  const [info, alignment] = await Promise.all([get('model.json'), get('alignment.json')]);
  if (!info || !alignment) return null;
  const gltf = await new GLTFLoader().loadAsync(car.base + 'model.glb');
  return { gltf: gltf.scene, info, alignment };
}

export function buildModelRig(car: CarData, model: Model): CarRig {
  const { alignment: a, info } = model;
  const photo = car.extract.photo;
  // World = the photo plane with its origin where the model origin lands; 1 world unit = 1 model unit.
  const frame = new Frame(1 / a.scale, a.tx, a.ty);
  const photoQuat = new THREE.Quaternion(...a.quaternion);
  // model space -> photo uv (flipY texture: v up), through the landing pose
  const toPhoto = new THREE.Matrix4()
    .set(a.scale / photo.w, 0, 0, a.tx / photo.w, 0, a.scale / photo.h, 0, 1 - a.ty / photo.h, 0, 0, 0, 0, 0, 0, 0, 1)
    .multiply(new THREE.Matrix4().makeRotationFromQuaternion(photoQuat))
    .multiply(new THREE.Matrix4().makeScale(a.stretch ?? 1, 1, 1));

  const uniforms: CarUniforms = {
    uReveal: { value: 1 },
    uUnlit: { value: 0 },
    uRim: { value: 0 },
    uRimColor: { value: new THREE.Color('#ffffff') },
    uTex: { value: 1 },
  };
  const materials: THREE.Material[] = [];
  const scene = model.gltf;
  scene.updateMatrixWorld(true);
  const toModel = new THREE.Matrix4().copy(scene.matrixWorld).invert();

  // Each wheel pivot gets a spin group; left pivots are turned 180 deg about y, so they spin the other way.
  const wheels: THREE.Group[] = [];
  for (const pivot of scene.children.filter((o) => o.name.startsWith('wheel_')).slice()) {
    const spin = new THREE.Group();
    spin.userData.spinSign = pivot.name.endsWith('left') ? -1 : 1;
    for (const c of pivot.children.slice()) spin.add(c);
    pivot.add(spin);
    wheels.push(spin);
  }
  scene.updateMatrixWorld(true);

  const meshes: THREE.Mesh[] = [];
  scene.traverse((o) => o instanceof THREE.Mesh && meshes.push(o));
  for (const o of meshes) {
    const src = o.material as THREE.MeshStandardMaterial;
    const isTyre = o.name.endsWith('_tyre');
    const isBody = o.name === 'body' || o.parent === scene;
    const rest = new THREE.Matrix4().multiplyMatrices(toModel, o.matrixWorld); // object -> model space
    const make = () => carMaterial(uniforms, {
      map: src.map ?? null,
      color: isTyre ? '#141416' : '#ffffff',
      paint: '#808080',
      glass: '#101418',
      // the sheet already has the toy's reflections painted in: keep the 3D ones light, or dark
      // paint turns milky
      metalness: isTyre ? 0 : isBody ? 0.12 : 0.4,
      roughness: isTyre ? 0.85 : isBody ? 0.5 : 0.4,
      clearcoat: isBody ? 0.3 : 0,
      clearcoatRoughness: 0.12,
      photo: { map: car.photoTex, matrix: new THREE.Matrix4().multiplyMatrices(toPhoto, rest) },
      materialMap: isBody ? src.roughnessMap : null, // paint vs glass
    });
    constAttrs(o.geometry, 1);
    o.material = make();
    materials.push(o.material as THREE.Material);
    if (isBody) {
      const glass = splitGlass(o, make); // see-through windows into a dark cabin
      if (glass) materials.push(glass.material as THREE.Material);
    }
  }

  const level = new THREE.Group();
  level.add(scene);
  const root = new THREE.Group();
  root.add(level);
  const body = (scene.getObjectByName('body') as THREE.Mesh) ?? (scene.children.find((c) => c instanceof THREE.Mesh) as THREE.Mesh);
  body.morphTargetInfluences = [0]; // no morph targets: the generic-coupe morph is the procedural path's
  const rig: CarRig = {
    root,
    photoQuat,
    photoStretch: a.stretch ?? 1,
    level,
    body,
    wing: new THREE.Group(),
    wheels,
    uniforms,
    materials,
    frame,
    pitch: 0,
    levelAngle: 0,
    levelLift: 0,
    halfWidth: info.dimensions.width / 2,
    height: info.dimensions.height,
    method: 'hero',
  };
  setLevel(rig, 0);
  return rig;
}
