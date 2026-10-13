import * as THREE from 'three';

// Fixed-step game loop: the simulation always advances in H = 1/120 s steps (frame-rate independent,
// deterministic), rendering interpolates between the last two steps with alpha = leftover / H.
// Game time always runs at real time: no slow-mo, no hit-stop (the sim must stay in lockstep for multiplayer) -
// impacts get their drama from the camera, sound, particles and haptics instead. setTimeScale is a test hook only:
// ?fast=N runs N steps per real step, and 0 holds a frame for a screenshot. Render runs every frame with the real
// frame time either way.

export const H = 1 / 120;
const MAX_STEPS = 8; // per frame; behind by more than that, drop the backlog (runs slow instead of spiralling)

export interface Loop {
  /** Tests only: the sim's speed against real time (?fast=N; 0 holds it for a screenshot). */
  setTimeScale(x: number): void;
  stop(): void;
}

export function startLoop(o: { step(h: number): void; render(alpha: number, dt: number): void; maxSteps?: number }): Loop {
  const timer = new THREE.Timer();
  timer.connect(document); // a hidden tab yields dt = 0, not one huge step
  const maxSteps = o.maxSteps ?? MAX_STEPS; // tests running the sim faster than real time raise it
  let acc = 0, scale = 1, raf = 0, running = true;

  const frame = (t: number) => {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    timer.update(t);
    const dt = Math.min(timer.getDelta(), 0.1);
    acc += dt * scale;
    let n = 0;
    while (acc >= H && n < maxSteps) {
      o.step(H);
      acc -= H;
      n++;
    }
    if (acc >= H) acc %= H;
    o.render(acc / H, dt);
  };
  raf = requestAnimationFrame(frame);

  return {
    setTimeScale(x: number) {
      scale = Math.max(0, x);
    },
    stop() {
      running = false;
      cancelAnimationFrame(raf);
      timer.dispose();
    },
  };
}
