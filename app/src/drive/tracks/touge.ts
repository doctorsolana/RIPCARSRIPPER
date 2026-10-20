import type { Course, PropsContext } from './course.ts';
import { METAL, type Geo } from './geo.ts';
import { DEG, KIT, type FrameAt, type Range } from './kit.ts';
import { Path, easeRun, solve } from './path.ts';
import { mountain, type MountainRange } from './mountain.ts';
import { gateWide } from './props.ts';
import { riviera } from './riviera.ts';
import type { Support } from './supports.ts';
import type { TrackFrame } from '../types';

// Track 3, the Touge (?track=touge): the drift course - a Riviera mountain road, built like every course
// (tracks/path.ts) on a landform of its own (tracks/mountain.ts) above the sea, all asphalt and mostly the narrow road
// (14 u): wide only along the seafront (22: the start, and the run to the first bend) and through the village's braid.
// From the line east along the seafront and round the bay, left up the east flank - a full climbing turn over itself
// (the stone bridge), the cypress avenue and its esses, the cliffside gallery - into the tunnel: a climbing half turn
// in the dark, two pads on the in-run, and out of the mountainside off the lip. The jump flies over the last two legs
// of the switchbacks below and comes down on the landing ramp further on; right, over the stone bridge across the
// gorge, and right again up into the village - two lanes round a block of houses, the piazza's fountain, two lanes
// round the next - linked bends on up the west flank, the ridge's east along the top, and the switchbacks: five
// hairpins down the south face, a short run between each, the last two legs on under the jump's flight; then down
// the gorge, under the village's bridge, to the sea. The dressing is tracks/riviera.ts.

/** Track 3's numbers (u, deg). Every bend sits in the drift band (scratch hold.ts: a slide held round a long bend on
 *  asphalt settles near 40-42 u/s whatever it came in at, downhill or not, at 24-25 deg of slip at R 25-30, 21 at R 35,
 *  19 at R 40 and only 13 at R 60 - and banking takes slip away: at 20 deg of bank an R 50 bend can't hold one). So
 *  R 30-44, banked 4 deg at most. The pieces from the lip round to the gorge are placed by construction: climb.run
 *  sets the switchbacks' north-south (the third leg 20 u past the lip), ridge.run their east-west (the hairpin over
 *  the second leg 56 u west of the flight), pass.ext the last hairpin (30 u east of it) and pass.foot the gorge road's
 *  line (under the middle of the village's bridge) - solved off line, so the flight always crosses the last two legs
 *  and the gorge always runs under the bridge, whatever the free straights come to. */
export const TOUGE = {
  gateLen: 40, start: 24, wide: 22, narrow: 14,
  bay: { R: 70, deg: 16 }, // the seafront's curve round the bay
  flank: { R: 34, hR: 32, y: 31, avenue: 20, gallery: 40, helix: 26, degs: [-40, 80, -80, 40] }, // left off the seafront, a full climbing turn (over itself), the avenue, the gallery
  tunnel: { R: 44, y: 40.5, run: 44, pads: 2, h: 9 }, // the tunnel: a climbing half turn inside the mountain, the in-run south
  jump: { lip: 12, sag: 24, gapX: 108, gapY: -25.5, edge: -26, hill: 10, steep: -22, runway: -8, ease: 12, runLen: 14, flare: 16, catch: 24, floor: 7, out: 16 },
  village: { R: 50, deg: 30, half: 7, lane: 10, len: 84, plaza: 40, fountain: 4, pad: 20, y: 7, turn: 40, east: 50, span: 50, west: 10, turn2: 34, pitch: 4, north: 16 }, // the bridge, the braid
  climb: { R: 34, degs: [35, -70, 35], run: 30.1 }, // north on out of the village: linked bends
  ridge: { R: 34, y: 37, degs: [-50, 100, -50], run: 26.7 }, // east along the top
  pass: { R: 30, leg: 30, n: 4, top: 35, drop: 6.5, ext: 98.9, foot: 56.3, bottom: 1 }, // the switchbacks down the south face
  conn: { R: 34 }, // off the last leg, down the gorge to the sea (B)
  link: 10,
  floorY: KIT.floorY,
};

/** The Touge lap. A and B are the free straights that close it: the seafront, east, and the run down the gorge to the
 *  sea, south. Everything from the tunnel's mouth round to the last leg is fixed, so the jump's flight always crosses the
 *  last two legs where it should. */
function layoutTouge(A: number, B: number) {
  const K = TOUGE, Ba = K.bay, Fk = K.flank, Tu = K.tunnel, J = K.jump, V = K.village, Ri = K.ridge, Ps = K.pass;
  const P = new Path(K.floorY, { surface: 'asphalt', edge: 'rail', width: K.wide, shoulder: 0 });
  const yawDeg = () => P.pose.yaw / DEG;
  const chain = (R: number, degs: number[], toY?: number) => {
    const y0 = P.pose.y, n = degs.length;
    degs.forEach((d, i) => P.arc(R, d, { ease: 14, ...(toY !== undefined ? { toY: y0 + ((toY - y0) * (i + 1)) / n } : {}) }));
  };
  // ---- The seafront, east: the line and its grid, the curve round the bay
  P.seg(K.gateLen).tag('gate', 0);
  P.tags.push({ tag: 'finish', s0: K.start - 1, s1: K.start + 1 });
  P.freeStraight(A);
  P.arc(Ba.R, -Ba.deg, { ease: 16 }).arc(Ba.R, Ba.deg, { ease: 16 });
  P.support('seafront', 0);
  // ---- Up the east flank: left off the seafront (the road narrows), a full climbing turn (over itself on a stone
  // bridge), the avenue of cypresses, linked bends, the cliffside gallery, up to the tunnel
  P.widen(K.narrow, 30);
  P.seg(K.link);
  P.arc(Fk.R, -90, { ease: 14 });
  P.seg(12);
  const hx = 2 * Math.PI * Fk.hR;
  P.arc(Fk.hR, -360, { bank: 4, ease: 16, toY: Fk.helix });
  P.support('bridge', P.s - hx * 0.25); // (its last quarter, over its first)
  const av0 = P.s;
  P.seg(Fk.avenue);
  chain(Fk.R, Fk.degs, Fk.y - 2);
  P.slopeTo(Fk.y, 5, 16);
  P.support('avenue', av0); // (its cypresses line the bends on up to the gallery too)
  const ga0 = P.s;
  P.seg(Fk.gallery);
  P.support('gallery', ga0);
  // ---- The tunnel: a climbing half turn to the left inside the mountain, the in-run south (its pads)
  const t0 = P.s;
  P.arc(Tu.R, -180, { ease: 16, toY: Tu.y });
  const in0 = P.s;
  for (let k = 0; k < Tu.pads; k++) P.tags.push({ tag: 'booster', s0: P.s + 6 + 18 * k, s1: P.s + 14 + 18 * k });
  P.seg(Tu.run);
  P.support('tunnel', t0);
  // ---- The jump: out of the mountainside over the two legs below, onto the landing ramp further down
  const k0 = P.s, lipTh = J.lip * DEG;
  P.seg(J.sag, { pitch: lipTh }).tag('kicker', k0);
  const lip = P.s, p0 = J.edge * DEG;
  P.tags.push({ tag: 'inrun', s0: in0, s1: lip });
  const unit = (c: number) => { const a = easeRun(lipTh, c, 1), b = easeRun(c, p0, 1); return { x: a.x + b.x, y: a.y + b.y }; };
  const crest = solve((c) => { const u = unit(c); return u.y / u.x; }, J.gapY / J.gapX, -lipTh - 0.6, lipTh);
  const half = J.gapX / unit(crest).x;
  P.seg(half, { pitch: crest }).seg(half, { pitch: p0 });
  P.tags.push({ tag: 'gap', s0: lip, s1: P.s, floor: J.floor });
  P.key(P.s - 16, {}).key(P.s, { width: J.catch });
  const p1 = J.steep * DEG, rw = J.runway * DEG;
  P.seg(J.hill, { pitch: p1 });
  const steep = (V.y - P.pose.y - easeRun(p1, rw, J.ease).y - Math.sin(rw) * J.runLen - easeRun(rw, 0, J.flare).y) / Math.sin(p1);
  P.seg(Math.max(0, steep)).seg(J.ease, { pitch: rw }).seg(J.runLen);
  P.widen(K.narrow, J.flare + 10);
  P.seg(J.flare, { pitch: 0 }).tag('bigjump', lip);
  P.seg(J.out);
  // ---- Right, west over the stone bridge across the gorge, then right again, north up into the village: the braid -
  // two lanes round a block of houses (a kink to the left: the left lane its inside, the right its outside, with a
  // pad), the piazza and its fountain, two lanes round the next block (the kink to the right, the pad on the left)
  P.arc(V.turn, 90, { ease: 14 });
  P.seg(V.east);
  const br0 = P.s;
  P.seg(V.span);
  P.support('bridge', br0);
  const vi0 = P.s;
  P.seg(V.west);
  P.arc(V.turn2, 90, { ease: 14 });
  const W = 2 * (V.half + V.lane);
  P.widen(W, 20);
  P.seg(20, { pitch: V.pitch * DEG });
  const isle = (len: number, half: number, nose: number, lay: () => void, pad: -1 | 1 | 0) => {
    const s0 = P.s, tail = len - nose;
    P.splits.push({ s0, s1: s0 + len, nose, tail, half, slope: 0.6, lane: W / 2 - half, lanes: [[], []] });
    if (pad) P.tags.push({ tag: 'booster', s0: s0 + V.pad, s1: s0 + V.pad + 8, lane: pad, d0: pad < 0 ? -W / 2 + 1.5 : half + 1.5, d1: pad < 0 ? -half - 1.5 : W / 2 - 1.5 });
    lay();
    P.support(pad ? 'isle' : 'plaza', s0); // (the dressing's: tracks/riviera.ts)
  };
  const bend = (deg: number) => () => { const rest = V.len - (Math.abs(deg) * DEG * V.R + 16); P.seg(rest / 2).arc(V.R, deg, { ease: 16 }).seg(rest / 2); };
  isle(V.len, V.half, 16, bend(-V.deg), 1);
  isle(V.plaza, V.fountain, 8, () => P.seg(V.plaza), 0);
  isle(V.len, V.half, 16, bend(V.deg), -1);
  P.widen(K.narrow, 20);
  P.seg(V.north);
  P.support('village', vi0);
  // ---- On up the west flank: linked bends
  chain(K.climb.R, K.climb.degs);
  P.seg(K.climb.run);
  // ---- East along the top: right, linked bends, then right and right again onto the first leg
  P.arc(Ri.R, 90, { ease: 14, toY: Ri.y - 6 });
  chain(Ri.R, Ri.degs, Ri.y);
  P.seg(Ri.run);
  P.arc(Ps.R, 90, { ease: 12 }).arc(Ps.R, 90, { ease: 12, toY: Ps.top });
  // ---- The switchbacks down the south face: hairpins left, right, left, right with a short run between; the last two
  // legs run on east past the others (round the bottom right hairpin), under the jump's flight, and the last on west
  for (let k = 0; k < Ps.n; k++) {
    const y = Ps.top - Ps.drop * k, ext = k === Ps.n - 1 ? Ps.ext : 0;
    P.slopeTo(y - Ps.drop * 0.45, 6, (Ps.leg + ext) / 2);
    P.arc(Ps.R, k % 2 ? 180 : -180, { bank: 4, ease: 12, toY: y - Ps.drop });
  }
  P.slopeTo(Ps.bottom + 2, 8, 12);
  P.seg(Ps.foot);
  // ---- Off the last leg: left, down the gorge (under the village's bridge) to the sea (B), and left onto the seafront
  P.arc(K.conn.R, -90, { ease: 14 });
  P.slopeTo(K.floorY, 6, 12);
  P.widen(K.wide, 40);
  P.freeStraight(B);
  const close = ((((-yawDeg()) % 360) + 540) % 360) - 180;
  if (Math.abs(close) > 1) P.arc(K.conn.R, close, { ease: 14 });
  P.seg(20);
  P.support('seafront', P.s - 20);
  P.support('cut', 0); // (the whole lap is cut into the course's own landform: no embankments - tracks/mountain.ts)
  return P;
}

/** The support ranges as the builder hands them to the hooks (the mountain is drawn from them, in props). */
let ranges: MountainRange[] = [], rangesOf: TrackFrame[] | null = null;
const note = (sp: Range<Support>, frames: TrackFrame[]) => {
  if (rangesOf !== frames) (ranges = []), (rangesOf = frames);
  ranges.push({ kind: sp.kind, s0: sp.s0, s1: sp.s1 });
};

/** The Touge's props: the wide gate and its grid, the mountain (tracks/mountain.ts) and the Riviera over it - the
 *  village, the bridges' arches, the gallery, the avenue, the seafront, villas (tracks/riviera.ts). */
function props({ G, frameAt, frames, tags, grid }: PropsContext) {
  gateWide(G, frameAt, TOUGE.start, grid);
  if (rangesOf !== frames) return;
  const land = mountain(G, frameAt, frames, ranges, tags.filter((g) => g.tag === 'gap'), { tunnelH: TOUGE.tunnel.h, seed: 31 });
  const V = TOUGE.village;
  const isles = ranges.filter((r) => r.kind === 'isle' || r.kind === 'plaza').map((r) => {
    const fountain = r.kind === 'plaza', nose = fountain ? 8 : 16;
    return { s0: r.s0, s1: r.s1, nose, tail: r.s1 - r.s0 - nose, half: fountain ? V.fountain : V.half };
  });
  riviera(G, frameAt, frames, land, ranges, isles, 47);
}

export const touge: Course<'touge'> = {
  id: 'touge', name: 'Touge', blurb: 'Hairpins, a tunnel jump and the sea',
  color: '#9d6bff', // its dot in the track switch and its Try button: violet
  layout: layoutTouge,
  start: TOUGE.start,
  wide: false, // (no plastic)
  metal: METAL,
  world: 'touge', hoop: false, // world-outdoor's Riviera: the sea, the hills inland, the golden afternoon
  // its start grid: four abreast in three rows behind the line (s along the lap, d across: + right), pole first
  grid: () => [3, 10, 17].flatMap((back) => [-1.5, -0.5, 0.5, 1.5].map((k) => ({ s: TOUGE.start - back, d: k * 5.2 }))),
  // (the mountain and the Riviera are drawn in props, from these ranges; the bridges' arches with them)
  supports: Object.fromEntries(['bridge', 'cut', 'tunnel', 'village', 'isle', 'plaza', 'gallery', 'avenue', 'seafront'].map((k) => [k, (_G: Geo, _f: FrameAt, sp: Range<Support>, o: { frames: TrackFrame[] }) => note(sp, o.frames)])),
  props,
  // medal pace (u/s) per car: see Course.pars
  pars: { roxy: 44.77, gt3: 44.65, fyg14: 44.17, jhw90: 44.16, skyline: 44.33, splittin: 43.89, '964': 43.25, mustang: 43.14, jaguar: 43.29, civic: 42.79, firebird: 41.9, silvia: 41.93, volvo: 41.67, impala: 41.38, beach: 40.6, '*': 43.03 },
};
