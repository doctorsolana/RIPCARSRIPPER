import * as THREE from 'three';
import type { Track, TrackFrame, TrackTag } from '../types';
import { channelGeometry, boosterGeometry, PAD_W } from './channel.ts';
import type { Course } from './course.ts';
import { framesOf } from './frames.ts';
import { Geo, PROP_CHUNKS, basis, chunked, mr, runs } from './geo.ts';
import { LIP, STRIP, hardOf, newFrame, v3, type Span } from './kit.ts';
import { barriers } from './props.ts';
import { GROUND, roadGeometry, roadMaterial } from './road.ts';
import { islandNoses, laneFrames, makeSplit } from './split.ts';
import { supports, stilts, type Stack } from './supports.ts';

// A course definition (tracks/course.ts) -> a Track: the frame table (tracks/frames.ts), the queries along it
// (frameAt / nearest / tagAt), and the meshes, 11 draw calls at most: the plastic channel (with its blue connectors),
// the booster pads, the road (asphalt, dirt, mown verges, embankments and curbs under one shader) and the props
// (supports, the course's gate and set pieces, tyre walls and hay bales: flat-shaded vertex colours, like the meadow's
// scenery) in 8 area chunks, so the camera only draws the ones in view.

/** Builds a course's track. `nearest()` returns a shared object (valid until the next call) whose `offset` is LOCAL to the
 *  frame: x along t, y along up (height above the surface), z along right (lateral, + right). */
export function buildTrack(course: Course): Track {
  const F = framesOf(course);
  const { frames, L, N, ds, tags } = F;
  const wrap = (s: number) => ((s % L) + L) % L;
  const clamp = (x: number, a: number) => (x < -a ? -a : x > a ? a : x);

  function frameAt(s: number, out: TrackFrame = newFrame()): TrackFrame {
    const w = wrap(s), u = w / ds;
    let i = Math.floor(u);
    const a = u - i;
    if (i >= N) i -= N;
    const f0 = frames[i], f1 = frames[i + 1 === N ? 0 : i + 1];
    out.s = w;
    out.p.lerpVectors(f0.p, f1.p, a);
    out.t.lerpVectors(f0.t, f1.t, a).normalize();
    out.up.lerpVectors(f0.up, f1.up, a);
    out.up.addScaledVector(out.t, -out.up.dot(out.t)).normalize();
    out.right.crossVectors(out.t, out.up).normalize();
    out.kappa = f0.kappa + (f1.kappa - f0.kappa) * a;
    out.kappaN = f0.kappaN + (f1.kappaN - f0.kappaN) * a;
    out.width = f0.width + (f1.width - f0.width) * a;
    out.shoulder = f0.shoulder + (f1.shoulder - f0.shoulder) * a;
    out.surface = f0.surface;
    out.edge = f0.edge;
    return out;
  }

  const res = { s: 0, frame: newFrame(), offset: v3() }, dq = v3();
  function nearest(p: THREE.Vector3, hintS: number, window = 25) {
    const c = Math.round(wrap(hintS) / ds), w = Math.min(Math.ceil(window / ds), N >> 1);
    let best = Infinity, bi = 0;
    for (let k = -w; k <= w; k++) {
      const i = (((c + k) % N) + N) % N, q = frames[i].p;
      const dx = p.x - q.x, dy = p.y - q.y, dz = p.z - q.z, d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < best) { best = d2; bi = i; }
    }
    const f = frames[bi];
    frameAt(f.s + clamp(dq.subVectors(p, f.p).dot(f.t), ds), res.frame);
    frameAt(res.frame.s + clamp(dq.subVectors(p, res.frame.p).dot(res.frame.t), ds), res.frame);
    dq.subVectors(p, res.frame.p);
    res.s = res.frame.s;
    res.offset.set(dq.dot(res.frame.t), dq.dot(res.frame.up), dq.dot(res.frame.right));
    return res;
  }

  function tagAt(s: number, lane?: number): TrackTag | null {
    const w = wrap(s);
    let best: TrackTag | null = null, bl = Infinity;
    for (let i = 0; i < tags.length; i++) {
      const g = tags[i];
      if (w >= g.s0 && w < g.s1 && g.s1 - g.s0 < bl && (g.lane === undefined || g.lane === lane)) { best = g.tag; bl = g.s1 - g.s0; }
    }
    return best;
  }

  // A lane split (tracks/split.ts; track 2's sky bridge): two channels either side of an island, in place of the one
  const split = F.splits.length ? makeSplit(F.splits[0], frameAt) : undefined;
  if (F.splits.length > 1) console.warn('track: one split per lap (the rest are ignored)');

  const object = new THREE.Group();
  object.name = 'track';
  let plasticRuns = runs(frames, ds, (f) => f.surface === 'plastic');
  // (a split's stretch from point to point is its lanes' channels, not the track's: the run is cut there, flush)
  if (split) plasticRuns = plasticRuns.flatMap(([a, b]): [number, number][] => (a < split.nose && b > split.tail ? [[a, split.nose], [split.tail, b]] : [[a, b]]));
  const roadRuns = runs(frames, ds, (f) => f.surface !== 'plastic');

  // The orange channel (and its tabs). AgX insets saturated primaries, which turns #ff6b00 salmon under the lights: the
  // plastic skips tone mapping (with a darker albedo to match the scene's exposure) so it stays Hot Wheels orange.
  const gaps = tags.filter((g) => g.tag === 'gap' && g.lane === undefined);
  const lanes = split ? ([-1, 1] as const).map((lane) => ({
    lane, frameAt: laneFrames(frameAt, split, lane), runs: [[split.nose, split.tail]] as [number, number][],
    gaps: tags.filter((g) => g.tag === 'gap' && g.lane === lane), bare: [split.nose, split.tail],
  })) : [];
  const ch = channelGeometry(frameAt, plasticRuns, L, ds, gaps, course.wide, split ? { bare: [split.nose, split.tail], more: lanes, extra: (G) => islandNoses(G, frameAt, split) } : {});
  const trackMat = new THREE.MeshStandardMaterial({ color: new THREE.Color(0.5, 0.5, 0.5), roughness: 0.6, metalness: 0, vertexColors: true, envMapIntensity: 0.25, toneMapped: false });
  const channel = new THREE.Mesh(ch.geo, trackMat);
  channel.name = 'channel';

  // Booster pads with running chevrons (the world advances userData.boosterTime).
  const pads = tags.filter((g) => g.tag === 'booster');
  const time = { value: 0 };
  const padMat = new THREE.MeshBasicMaterial({ vertexColors: true, toneMapped: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 });
  padMat.onBeforeCompile = (sh) => {
    sh.uniforms.uTime = time;
    sh.vertexShader = 'attribute float aPhase;\nvarying float vPhase;\n' + sh.vertexShader.replace('#include <begin_vertex>', '#include <begin_vertex>\nvPhase = aPhase;');
    sh.fragmentShader = 'uniform float uTime;\nvarying float vPhase;\n' + sh.fragmentShader.replace(
      '#include <color_fragment>',
      '#include <color_fragment>\nif (vPhase >= 0.0) diffuseColor.rgb *= 0.35 + 0.95 * pow(0.5 + 0.5 * sin(uTime * 10.0 - vPhase * 2.1), 2.0);',
    );
  };
  // A pad spans the 8 u channel; across wider plastic they lie side by side, a row of them (one more every ~7.4 u). A
  // narrow pad (d0..d1: track 2's before the wall ride) is one plate just that wide, where it lies across the deck.
  const m = new THREE.Matrix4(), f = newFrame(), row = (w: number) => (w <= 10 ? 1 : Math.round(w / 7.4));
  const count = (g: Span) => (g.d0 !== undefined ? 1 : row(frameAt((g.s0 + g.s1) / 2, f).width));
  const nPads = pads.reduce((n, g) => n + count(g), 0);
  const boosters = new THREE.InstancedMesh(boosterGeometry(), padMat, nPads);
  let iPad = 0;
  for (const g of pads) {
    frameAt((g.s0 + g.s1) / 2, f);
    if (g.d0 !== undefined) {
      const d1 = g.d1 ?? g.d0;
      basis(f, m).multiply(mr.makeTranslation(0, 0, (g.d0 + d1) / 2)).multiply(new THREE.Matrix4().makeScale(1, 1, (d1 - g.d0) / PAD_W));
      boosters.setMatrixAt(iPad++, m);
      continue;
    }
    const n = row(f.width);
    for (let k = 0; k < n; k++) {
      basis(f, m);
      if (n > 1) m.multiply(mr.makeTranslation(0, 0, (k - (n - 1) / 2) * (f.width / n)));
      boosters.setMatrixAt(iPad++, m);
    }
  }
  boosters.name = 'boosters';

  // The road: asphalt, dirt, verges, banks and curbs.
  const rd = roadGeometry(frames, frameAt, ds, roadRuns);
  const road = new THREE.Mesh(rd.geo, roadMaterial());
  road.name = 'road';

  // The props: supports, the start gate, the course's set pieces (Course.props), tyre walls and hay bales - in
  // PROP_CHUNKS area chunks, each its own mesh, so the ones off screen are frustum-culled.
  const PG = new Geo();
  const sp = supports(PG, frameAt, F.sup, tags.filter((g) => g.lane === undefined), course.metal, frames, course.start, course.supports, split);
  if (split) {
    // the lanes' own stilts, wherever the track's stand under the split (they stand clear of the island's stretch)
    for (const r of F.sup) {
      if (r.kind !== 'stilts' || r.s1 <= split.nose || r.s0 >= split.tail) continue;
      const s0 = Math.max(r.s0, split.nose), s1 = Math.min(r.s1, split.tail);
      for (const ln of lanes) stilts(PG, ln.frameAt, { kind: 'stilts', s0, s1 }, (s, pad) => ln.gaps.some((g) => s > g.s0 - pad && s < g.s1 + pad), sp.posts, frames);
    }
  }
  const start = course.start;
  const grid = course.grid?.() ?? []; // a start grid (s along the lap, d across: + right), pole first; none: the gate's
  course.props({ G: PG, frameAt, frames, tags, posts: sp.posts, grid });
  const br = barriers(PG, frames, frameAt, ds);
  const props = new THREE.Group(), propMat = new THREE.MeshLambertMaterial({ vertexColors: true, flatShading: true });
  props.name = 'props';
  chunked(PG, PROP_CHUNKS).forEach((g, i) => props.add(Object.assign(new THREE.Mesh(g, propMat), { name: `props-${i}` })));

  // Every surface you can drive on, for a physics engine: the channel and the road mesh in one soup.
  const cp = ch.geo.attributes.position.array as Float32Array, rp = rd.geo.attributes.position.array as Float32Array;
  const ci = ch.geo.index!.array as Uint32Array, ri = rd.geo.index!.array as Uint32Array;
  const positions = new Float32Array(cp.length + rp.length);
  positions.set(cp);
  positions.set(rp, cp.length);
  const indices = new Uint32Array(ci.length + ri.length);
  indices.set(ci);
  for (let i = 0; i < ri.length; i++) indices[ci.length + i] = ri[i] + cp.length / 3;

  // How far each frame's footprint reaches on the ground (half-width from the centre line, u): the surface, the verge,
  // the barrier's strip and the bank down to the meadow (or the channel and its supports). Keep scenery out of it.
  const footprint = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    const g = frames[i];
    footprint[i] = g.surface === 'plastic' ? g.width / 2 + LIP + 1.2 + 0.12 * Math.max(0, g.p.y) : hardOf(g) + STRIP[g.edge] + Math.max(0.8, (g.p.y - GROUND) * 1.8);
  }

  object.add(channel, boosters, road, props);
  const stacks: Stack[] = [];
  object.userData = { stacks, posts: sp.posts, boosterTime: time, footprint, grid, course: course.id, counts: { tabs: ch.tabs, curbs: rd.curbs, tyres: br.tyres, bales: br.bales, pads: nPads } };
  const look = { world: course.world, hoop: course.hoop, wide: course.wide };
  return { length: L, frames, object, collider: { positions, indices }, tags, start, frameAt, nearest, tagAt, look, ...(split ? { split } : {}) };
}
