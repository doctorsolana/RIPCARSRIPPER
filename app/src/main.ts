import * as THREE from 'three';
import './style.css';
import { type RevealMethod, buildCar, loadCar, setLevel, setOpacity } from './car';
import { createDirector, type Dom } from './director';
import { buildModelRig, loadModel } from './model';
import { mountNav } from './nav';
import { tierOf } from './rarity';
import { createStage } from './stage';

// URL knobs: ?car=<id>  ?rarity=<tier>  ?reveal=hero|profile  ?t=<seconds> (seek + pause)
//            ?mode=view&yaw=&az=&el=          static lit turntable view, for reviewing a model
//            ?mode=final&unlit=0|1&card=0..1  the landing pose with the car still visible
const q = new URLSearchParams(location.search);
const num = (k: string, d: number) => (q.has(k) ? Number(q.get(k)) : d);
const mode = q.get('mode');

const $ = (id: string) => document.getElementById(id)!;

async function main() {
  const nav = mountNav('rip');
  const car = await loadCar(q.get('car') ?? 'skyline-hck01');
  nav.then((n) => n.setCar(car.id));
  // A car modelled from its reference sheet gets the full 360 reveal. Without a model (or with
  // ?reveal=profile) the car is built from the pack photo alone and shown near side-on.
  const model = q.get('reveal') === 'profile' && car.params ? null : await loadModel(car);
  if (!model && !car.params) {
    // nothing to reveal yet: the car hasn't been through asset-generation (`ripcars status`)
    $('panel').insertAdjacentHTML('beforebegin', `<p class="missing">No 3D model for ${car.meta.make} ${car.meta.model} yet.</p>`);
    (window as any).__ready = true;
    return;
  }
  const rig = model ? buildModelRig(car, model) : buildCar(car, q.get('reveal') as RevealMethod | null);
  const tier = tierOf(q.get('rarity') ?? car.meta.rarity);
  const canvas = $('c') as HTMLCanvasElement;
  const stage = createStage(canvas, car, rig, { preserve: !!mode || q.has('t') });

  const dom: Dom = {
    flash: $('flash'), tear: $('tear'), steps: [...$('steps').children] as HTMLElement[],
    era: $('b-era'), year: $('year'), make: $('b-make'), makeName: $('make'), badge: $('badge'),
    model: $('b-model'), modelName: $('model'), panel: $('panel'),
  };
  $('p-rarity').textContent = tier.label;
  $('p-name').textContent = `${car.meta.make} ${car.meta.model}`;
  $('p-sub').textContent = [car.meta.year, car.meta.line].filter(Boolean).join(' · ');
  $('p-sub2').textContent = [car.meta.collection, car.meta.series].filter(Boolean).join(' · ');

  const dir = createDirector(stage, rig, car, tier, dom);
  $('replay').addEventListener('click', () => dir.tl.restart());
  // hand-off to the drive page: the same car, its GLB already in the browser cache
  const spin = $('spin') as HTMLAnchorElement;
  spin.href = `/drive.html?car=${encodeURIComponent(car.id)}`;
  spin.hidden = !model;

  const resize = () => stage.resize(innerWidth, innerHeight);
  addEventListener('resize', resize);
  resize();

  if (mode === 'view') {
    dir.tl.seek(dir.carStart - 0.05).pause();
    dir.cam.az = num('az', 0.6);
    dir.cam.el = num('el', 0.15);
    rig.root.rotation.y = num('yaw', 0);
    document.body.classList.add('debug');
  } else if (mode === 'final') {
    dir.tl.seek('end').pause();
    setOpacity(rig, 1);
    setLevel(rig, 0);
    rig.uniforms.uUnlit.value = num('unlit', 0);
    stage.card.material.opacity = num('card', 0.5);
    stage.shine.material.uniforms.uOpacity.value = 0;
    document.body.classList.add('debug');
  } else if (q.has('t')) {
    dir.tl.seek(num('t', 0)).pause();
  } else {
    setTimeout(() => dir.tl.play(0), 350);
  }
  if (mode) dir.applyState = () => {};

  const clock = new THREE.Clock();
  let frames = 0;
  stage.renderer.setAnimationLoop(() => {
    const dt = Math.min(clock.getDelta(), 1 / 20);
    stage.update(dt);
    dir.updateCamera(clock.elapsedTime);
    stage.renderer.render(stage.scene, stage.camera);
    if (++frames === 3) Object.assign(window as any, { __ready: true, __rig: rig }); // for scripts/ checks
  });
}

main();
