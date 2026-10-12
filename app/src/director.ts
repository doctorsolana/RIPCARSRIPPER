import gsap from 'gsap';
import * as THREE from 'three';
import { type CarData, type CarRig, WORLD_LENGTH, setLevel, setOpacity } from './car';
import type { Tier } from './rarity';
import type { Stage } from './stage';

const DEG = Math.PI / 180;
const FINAL_FOV = 2 * DEG; // near-orthographic, so the model's near side and silhouette both land on the photo

export interface Dom {
  flash: HTMLElement;
  tear: HTMLElement;
  steps: HTMLElement[];
  era: HTMLElement;
  year: HTMLElement;
  make: HTMLElement;
  makeName: HTMLElement;
  badge: HTMLElement;
  model: HTMLElement;
  modelName: HTMLElement;
  panel: HTMLElement;
}

function letters(el: HTMLElement, text: string) {
  el.innerHTML = '';
  return [...text].map((ch) => {
    const s = document.createElement('span');
    s.className = 'ch';
    s.textContent = ch === ' ' ? ' ' : ch;
    el.appendChild(s);
    return s;
  });
}

function odometer(el: HTMLElement, value: string) {
  el.innerHTML = '';
  const strips: { strip: HTMLElement; target: number }[] = [];
  for (const ch of value) {
    const cell = document.createElement('span');
    cell.className = 'odo';
    if (/\d/.test(ch)) {
      const strip = document.createElement('span');
      strip.className = 'odo-strip';
      for (let r = 0; r < 3; r++) for (let d = 0; d < 10; d++) strip.appendChild(Object.assign(document.createElement('span'), { textContent: String(d) }));
      cell.appendChild(strip);
      strips.push({ strip, target: 20 + Number(ch) });
    } else cell.textContent = ch;
    el.appendChild(cell);
  }
  return strips;
}

export function createDirector(stage: Stage, rig: CarRig, car: CarData, tier: Tier, dom: Dom) {
  const U = rig.uniforms;
  const L = tier.level;
  // Hero: full turntable — needs a model that holds up from every angle. Profile: never strays far from
  // side-on, starts as a generic coupe and shapes itself into the real car on its way into the pack.
  const profile = rig.method === 'profile';
  const mv = profile
    ? { yaw: [-0.55, -0.3, 0.35, 0], cam: [[0.35, 0.03], [0.24, 0.08], [0.14, 0.1]], spin: -Math.PI * 4 }
    : { yaw: [-1.0, -0.2, 0.75, Math.PI * 2], cam: [[0.95, 0.04], [0.6, 0.13], [0.42, 0.17]], spin: -Math.PI * 6 };
  const morph = { g: profile ? 1 : 0 };
  const rarityColor = new THREE.Color(tier.color);
  const cam = { az: 0.95, el: 0.05, fov0: 30, p: 0, shake: 0 };
  const wheelSpin = { a: 0 };
  const level = { k: 1 };
  const carFade = { o: 1 };
  const orbitTarget = new THREE.Vector3(0, rig.height * 0.42, 0);

  function finalPose(aspect: number) {
    const t = Math.tan(FINAL_FOV / 2);
    const portrait = aspect < 0.9;
    const [availW, availH] = portrait ? [0.9, 0.66] : [0.55, 0.86];
    const [nx, ny] = portrait ? [0, 0.29] : [-0.33, 0];
    const dist = Math.max(stage.cardH / (availH * 2 * t), stage.cardW / (availW * 2 * t * aspect));
    const halfH = dist * t;
    const target = stage.cardCenter.clone().sub(new THREE.Vector3(nx * halfH * aspect, ny * halfH, 0));
    return { target, dist };
  }

  // Orbit pose → dolly-zoom into the straight-on photo pose as cam.p goes 0 → 1.
  function updateCamera(time: number) {
    const c = stage.camera;
    const f0 = cam.fov0 * DEG;
    const hf0 = 2 * Math.atan(Math.tan(f0 / 2) * c.aspect);
    const d0 = (WORLD_LENGTH * 0.6) / Math.sin(Math.min(f0, hf0) / 2);
    const dir0 = new THREE.Vector3(Math.sin(cam.az) * Math.cos(cam.el), Math.sin(cam.el), Math.cos(cam.az) * Math.cos(cam.el));
    const fin = finalPose(c.aspect);
    const p = cam.p;
    const fov = THREE.MathUtils.lerp(f0, FINAL_FOV, p);
    const halfH = THREE.MathUtils.lerp(d0 * Math.tan(f0 / 2), fin.dist * Math.tan(FINAL_FOV / 2), p);
    const dist = halfH / Math.tan(fov / 2);
    const target = orbitTarget.clone().lerp(fin.target, p);
    const dir = dir0.lerp(new THREE.Vector3(0, 0, 1), p).normalize();
    c.fov = fov / DEG;
    c.near = Math.max(0.05, dist - 25);
    c.far = dist + 40;
    c.position.copy(target).addScaledVector(dir, dist);
    c.lookAt(target);
    // Backlights sit beyond the car on the far side from the camera (target stays at the origin).
    const right = new THREE.Vector3().crossVectors(new THREE.Vector3(0, 1, 0), dir).normalize();
    stage.rimL.position.copy(dir).multiplyScalar(-10).addScaledVector(right, -5).setY(3);
    stage.rimR.position.copy(dir).multiplyScalar(-10).addScaledVector(right, 5).setY(1.5);
    if (cam.shake > 0) {
      const s = cam.shake * 0.04 * halfH;
      c.position.x += (Math.sin(time * 61) + Math.sin(time * 37)) * s;
      c.position.y += (Math.sin(time * 47) + Math.sin(time * 29)) * s;
    }
    c.updateProjectionMatrix();
  }

  function applyState() {
    for (const w of rig.wheels) w.rotation.z = wheelSpin.a * (w.userData.spinSign ?? 1);
    rig.body.morphTargetInfluences![0] = morph.g;
    setLevel(rig, level.k);
    setOpacity(rig, carFade.o);
  }

  // ---- text ----
  const yearStrips = odometer(dom.year, String(car.meta.year ?? '—'));
  const makeChars = letters(dom.makeName, car.meta.make.toUpperCase());
  const modelChars = letters(dom.modelName, car.meta.model.toUpperCase());
  dom.badge.textContent = tier.label;
  dom.badge.style.setProperty('--tier', tier.color);
  dom.panel.style.setProperty('--tier', tier.color);
  document.documentElement.style.setProperty('--tier', tier.color);

  const tl = gsap.timeline({ paused: true, onUpdate: applyState });
  const stepOn = (i: number, at: number | string) =>
    tl.fromTo(dom.steps[i], { scale: 1, backgroundColor: 'rgba(255,255,255,0.18)' }, { scale: 1.35, backgroundColor: i === 0 ? '#ffffff' : tier.color, duration: 0.3, ease: 'back.out(3)' }, at);

  // ---- 0 · rip -------------------------------------------------------------------------------
  tl.fromTo(dom.tear, { scaleX: 0, opacity: 1 }, { scaleX: 1, duration: 0.3, ease: 'power3.in' }, 0)
    .fromTo(dom.tear, { opacity: 1 }, { opacity: 0, duration: 0.25, immediateRender: false }, 0.32)
    .fromTo(dom.flash, { opacity: 0, backgroundColor: '#ffffff' }, { opacity: 0.55, duration: 0.06 }, 0.3)
    .to(dom.flash, { opacity: 0, duration: 0.5 }, 0.36);

  // ---- 1 · era: black silhouette, white rim light, year rolls in ------------------------------
  const ERA = 0.45;
  tl.addLabel('era', ERA);
  stepOn(0, ERA);
  tl.fromTo(U.uTex, { value: profile ? 0 : 1 }, { value: profile ? 0 : 1, duration: 0.01 }, 0)
    .fromTo(rig.wing.scale, { y: profile ? 0.001 : 1 }, { y: profile ? 0.001 : 1, duration: 0.01 }, 0)
    .fromTo(morph, { g: profile ? 1 : 0 }, { g: profile ? 1 : 0, duration: 0.01 }, 0)
    .fromTo(U.uReveal, { value: 0 }, { value: 0, duration: 0.01 }, 0)
    .fromTo(U.uRim, { value: 0 }, { value: 1.5, duration: 1.1, ease: 'power2.out' }, ERA)
    .fromTo(U.uRimColor.value, { r: 1, g: 1, b: 1 }, { r: 1, g: 1, b: 1, duration: 0.01 }, 0)
    .fromTo([stage.rimL, stage.rimR], { intensity: 0 }, { intensity: 2.5, duration: 1, ease: 'power2.out' }, ERA)
    .fromTo(rig.root.rotation, { y: mv.yaw[0] }, { y: mv.yaw[1], duration: 2.6, ease: 'sine.inOut' }, ERA)
    .fromTo(cam, { az: mv.cam[0][0], el: mv.cam[0][1] }, { az: mv.cam[1][0], el: mv.cam[1][1], duration: 2.6, ease: 'sine.inOut' }, ERA)
    .fromTo(stage.floor.material, { opacity: 0 }, { opacity: 0.25, duration: 1 }, ERA)
    .fromTo(stage.shadow.material, { opacity: 0 }, { opacity: 0.85, duration: 1 }, ERA)
    .fromTo(dom.era, { autoAlpha: 0, y: 20 }, { autoAlpha: 1, y: 0, duration: 0.4 }, ERA + 0.25);
  yearStrips.forEach(({ strip, target }, i) =>
    tl.fromTo(strip, { yPercent: 0 }, { yPercent: -(target / 30) * 100, duration: 1.3 + i * 0.18, ease: 'power3.out' }, ERA + 0.35),
  );
  tl.to(dom.era, { autoAlpha: 0, y: -16, duration: 0.3 }, ERA + 2.1);

  // ---- 2 · rarity: colour floods in, paint appears, make + tier badge -------------------------
  const RAR = ERA + 2.15;
  const hold = 0.25 * L;
  tl.addLabel('rarity', RAR);
  stepOn(1, RAR);
  tl.fromTo(dom.flash, { opacity: 0, backgroundColor: tier.color }, { opacity: 0.3 + 0.08 * L, duration: 0.07, immediateRender: false }, RAR)
    .to(dom.flash, { opacity: 0, duration: 0.6 }, RAR + 0.07)
    .to(U.uRimColor.value, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b, duration: 0.3 }, RAR)
    .to([stage.rimL.color, stage.rimR.color], { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b, duration: 0.3 }, RAR)
    .fromTo(stage.particles.material, { opacity: 0 }, { opacity: 0.35 + 0.12 * L, duration: 0.8, immediateRender: false }, RAR)
    .fromTo(stage.particles.material.color, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b }, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b, duration: 0.01 }, RAR)
    .fromTo(stage.floor.material.color, { r: 1, g: 1, b: 1 }, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b, duration: 0.5, immediateRender: false }, RAR)
    .fromTo(U.uReveal, { value: 0 }, { value: 1, duration: 1.3, ease: 'power2.inOut', immediateRender: false }, RAR + 0.25)
    .fromTo(stage.scene, { environmentIntensity: 0 }, { environmentIntensity: 0.3, duration: 1.3, ease: 'power2.inOut' }, RAR + 0.25)
    .fromTo(stage.scene.environmentRotation, { y: -1.2 }, { y: 1.6, duration: 2.4 + hold, ease: 'sine.inOut' }, RAR)
    .fromTo(stage.hemi, { intensity: 0 }, { intensity: 0.45, duration: 1 }, RAR + 0.3)
    .fromTo(stage.key, { intensity: 0 }, { intensity: 1.2, duration: 1 }, RAR + 0.3)
    .to(U.uRim, { value: 0.12, duration: 1 }, RAR + 0.5)
    .to(rig.root.rotation, { y: mv.yaw[2], duration: 2.4 + hold, ease: 'sine.inOut' }, RAR)
    .to(cam, { az: mv.cam[2][0], el: mv.cam[2][1], duration: 2.4 + hold, ease: 'sine.inOut' }, RAR)
    .fromTo(dom.make, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, RAR + 0.3)
    .fromTo(makeChars, { autoAlpha: 0, y: 40, filter: 'blur(8px)' }, { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.5, stagger: 0.05, ease: 'power3.out' }, RAR + 0.3);
  const POP = RAR + 1.25 + hold * 0.5;
  tl.fromTo(dom.badge, { autoAlpha: 0, scale: 2.6 }, { autoAlpha: 1, scale: 1, duration: 0.45, ease: 'back.out(2.2)' }, POP)
    .fromTo(stage.ring.scale, { x: 0.5, y: 0.5, z: 0.5 }, { x: 4 + L, y: 4 + L, z: 4 + L, duration: 0.9, ease: 'power2.out' }, POP)
    .fromTo(stage.ring.material, { opacity: 0 }, { opacity: 0.9, duration: 0.05, immediateRender: false }, POP)
    .to(stage.ring.material, { opacity: 0, duration: 0.8 }, POP + 0.1)
    .fromTo(stage.ring.material.color, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b }, { r: rarityColor.r, g: rarityColor.g, b: rarityColor.b, duration: 0.01 }, POP)
    .fromTo(cam, { shake: 0 }, { shake: 0.4 + 0.35 * L, duration: 0.05, immediateRender: false }, POP)
    .to(cam, { shake: 0, duration: 0.5 + 0.1 * L, ease: 'power2.out' }, POP + 0.05)
    .fromTo(stage.sparkSpeed, { value: 1 }, { value: 4 + L, duration: 0.1, immediateRender: false }, POP)
    .to(stage.sparkSpeed, { value: 1, duration: 1 }, POP + 0.1)
    .to(dom.make, { autoAlpha: 0, y: -16, duration: 0.3 }, RAR + 2.3 + hold);

  // ---- 3 · the car: spin into profile, dolly-zoom flat, land on the real photo -----------------
  const CAR = RAR + 2.45 + hold;
  tl.addLabel('car', CAR);
  stepOn(2, CAR);
  tl.to(rig.root.rotation, { y: mv.yaw[3], duration: 2.5, ease: 'power3.inOut' }, CAR)
    .fromTo(wheelSpin, { a: 0 }, { a: mv.spin, duration: 2.5, ease: 'power3.inOut' }, CAR)
    .fromTo(cam, { p: 0 }, { p: 1, duration: 2.7, ease: 'power3.inOut', immediateRender: false }, CAR + 0.1)
    .fromTo(level, { k: 1 }, { k: 0, duration: 0.8, immediateRender: false }, CAR + 1.6)
    .to([stage.floor.material, stage.shadow.material, stage.particles.material], { opacity: 0, duration: 0.8 }, CAR + 1.3)
    .fromTo(dom.model, { autoAlpha: 0 }, { autoAlpha: 1, duration: 0.2 }, CAR + 0.15)
    .fromTo(modelChars, { autoAlpha: 0, y: 40, filter: 'blur(8px)' }, { autoAlpha: 1, y: 0, filter: 'blur(0px)', duration: 0.5, stagger: 0.04, ease: 'power3.out' }, CAR + 0.15)
    .fromTo(stage.card.material, { opacity: 0 }, { opacity: 1, duration: 0.7, ease: 'power1.in', immediateRender: false }, CAR + 2.0)
    .fromTo(U.uUnlit, { value: 0 }, { value: 1, duration: 0.5, immediateRender: false }, CAR + 2.3)
    .fromTo(carFade, { o: 1 }, { o: 0, duration: 0.2, immediateRender: false }, CAR + 3.05)
    .to(dom.model, { autoAlpha: 0, y: -16, duration: 0.3 }, CAR + 1.7) // gone before the card lands under it
    .to([stage.rimL, stage.rimR], { intensity: 0, duration: 0.8 }, CAR + 1.4)
    // Settle into the photo's flat studio light so the lit car already resembles the pack shot.
    .to(stage.key, { intensity: 0.35, duration: 0.8 }, CAR + 1.4)
    .to(stage.hemi, { intensity: 0.3, duration: 0.8 }, CAR + 1.4)
    .to(stage.scene, { environmentIntensity: 0, duration: 0.8 }, CAR + 1.4) // studio light panels glare off the roof once it's edge-on
    .fromTo(stage.shine.material.uniforms.uOpacity, { value: 0 }, { value: 0.9 + 0.1 * L, duration: 0.01, immediateRender: false }, CAR + 3.0)
    .fromTo(stage.shine.material.uniforms.uSweep, { value: -0.3 }, { value: 1.6, duration: 1.0, ease: 'power1.inOut', immediateRender: false }, CAR + 3.0)
    .fromTo(dom.panel, { autoAlpha: 0, y: 24 }, { autoAlpha: 1, y: 0, duration: 0.5, ease: 'power3.out' }, CAR + 3.15);
  if (profile) {
    // Generic coupe → this car: a rim-light pulse while the outline reshapes, then the photo paint lands.
    tl.fromTo(morph, { g: 1 }, { g: 0, duration: 1.5, ease: 'power2.inOut', immediateRender: false }, CAR + 0.35)
      .to(U.uRim, { value: 1.1, duration: 0.25 }, CAR + 0.3)
      .to(U.uRim, { value: 0, duration: 1.3 }, CAR + 0.6)
      .fromTo(U.uTex, { value: 0 }, { value: 1, duration: 1.1, immediateRender: false }, CAR + 0.9)
      .fromTo(rig.wing.scale, { y: 0.001 }, { y: 1, duration: 0.5, ease: 'back.out(2)', immediateRender: false }, CAR + 1.3);
  } else tl.to(U.uRim, { value: 0, duration: 1 }, CAR + 1.2);
  tl.addLabel('end', CAR + 3.7);

  return { tl, cam, updateCamera, applyState, carStart: CAR };
}
