import type { Course, PropsContext } from './course.ts';
import { METAL } from './geo.ts';
import { DEG, KIT } from './kit.ts';
import { CLOSE, FLARE, GROW, Path, easeRun, rampRise, solve } from './path.ts';
import { gate, launchArch } from './props.ts';

// The meadow (the default course): a twisty lap of country roads through the meadow - asphalt with mown grass verges, a
// loose dirt stretch - with the orange Hot Wheels plastic kept for the set pieces: the raised start gate and its drop,
// the kicker and gap jump on scaffolding, the BIG jump - a booster, a steep launch ramp on a tall scaffold tower, ~2.35
// s of air over the road below, a long landing ramp - then a booster into the loop and a banked climb on stone pillars
// back up to the gate. About 70 pieces (tracks/path.ts); two free straights close the lap.

/** The meadow's numbers: the kit's (tracks/kit.ts), and its raised gate: height, length, the start line's s. */
export const MEADOW = { ...KIT, gateY: 14, gateLen: 22, start: 8 } as const;

// The jump, tuned against the arcade model (g = 24): the lip, a gap with no surface (the virtual surface's crest is all
// in the air), then the landing slope. 0.70 s of air at 42 u/s; from 34 to 54 u/s the car lands within ~14 deg of the
// slope, and even 24 u/s clears the gap (2D search, scratch jump.mjs).
export const JUMP = { lip: 8, lipLen: 6, gap: 14, land: -8, landHold: 6, landOut: 14 };

// The big jump, solved against the arcade model (g = 24; its launcher pulls a car on the launch ramp to the one speed
// whose arc lands best lined up with the landing ramp, and its nose follows the flight path until it levels to the ramp).
// A 30 deg lip 20 u up; a gap of 46 u (horizontal) to the landing deck's edge 4 u above the lip, its virtual surface a
// low crest; then the landing ramp: the deck eases over (to -4 deg over 34 u, to -32 deg over the next 20) and holds
// -32 deg for 12 u - a straight run comes down on that hold lined up with it (51 u/s, ~2.35 s of air, ~105 u across,
// 2-4 deg into the ramp wherever in its step it left the lip: PERFECT) - then sags to an -8 deg runway that catches the
// fast flights and flares onto the meadow. Every flight from 0.85 to 1.15 x that speed lands on the ramp: the slow ones
// on the deck (~22 deg into it), the fast ones on the runway (~32 deg); all ~22 u over the road below. Profile from a 2D
// search with the vehicle's ballistics, launcher and air attitude (scratch round3/track/search8.mjs).
export const BIG = {
  lip: 30, lipY: 20, sag: 28, // deg, u: the launch ramp's pitch at the lip and the lip's height; it eases up over `sag` u
  gapX: 46, gapY: 4, // u: the landing deck's edge, horizontally and vertically from the lip
  deck: [[34, -4], [20, -32], [12, -32], [14, -8]] as [number, number][], // [u, deg] pitch eases over the landing ramp ...
  runway: -8, flare: 14, // ... then the runway (solved to reach the meadow) and its flare to flat
  width: 16, // u: the landing ramp is a catch tray this wide, narrowing to the road's over its runway
  cross: 24, // u past the lip (horizontal): where the road below passes under the flight
};

const CATCH = 12; // u: the jump's landing tray starts this wide

/** The lap. A and B are the free straights that close it (the braking zone into the SE corner, the run-up to the big jump). */
function layout(A: number, B: number) {
  const T = MEADOW, J = JUMP;
  const P = new Path(T.gateY);
  let s0 = 0;
  // ---- The start gate on its wooden tower, then the drop to the meadow: a long crest, so a flying lap stays down.
  P.seg(T.gateLen).tag('gate', 0).support('tower', 0);
  P.tags.push({ tag: 'finish', s0: T.start - 1, s1: T.start + 1 });
  s0 = P.s;
  P.slopeTo(T.floorY, 20, 60, 18).tag('drop', s0).support('trestle', s0);
  // ---- Asphalt: off the plastic into flowing esses over a rise, then the fast sweeper between tyre walls (NE).
  P.toRoad('asphalt', 10).seg(FLARE + GROW + 6);
  P.arc(55, -35, { toY: 2.4, ease: 14 }).arc(52, 70, { ease: 14 }).arc(55, -35, { toY: T.floorY, ease: 14 });
  P.seg(GROW + 6).wall();
  P.arc(64, 90, { bank: 5, ease: 16 });
  P.seg(4).open(5).seg(GROW + 10);
  // East side, heading south: the chicane, esses, a fast kink over a rise, the braking zone into the SE corner.
  P.arc(18, -40).arc(18, 40).seg(4);
  P.verge(8).seg(GROW);
  P.arc(45, 50, { bank: 3, ease: 12 }).arc(45, -50, { bank: 3, ease: 12 }).seg(20);
  P.arc(75, -24, { toY: 2.2, ease: 14 }).arc(75, 24, { toY: T.floorY, ease: 14 });
  P.freeStraight(A);
  P.verge(6).seg(GROW + 4);
  P.arc(24, 90, { bank: 3, ease: 10 });
  P.verge(8).seg(GROW + 4);
  // ---- Dirt, heading west: humps, a bale-lined S, drifty corners, then the SW corner.
  P.surfaceTo('dirt').seg(16);
  s0 = P.s;
  P.arc(40, -40, { ease: 12 }).seg(GROW + 2).wall();
  P.arc(30, 80, { ease: 12 }).arc(32, -80, { ease: 12 }).open(8);
  P.arc(40, 40, { ease: 12 }).seg(20);
  P.arc(28, 56, { ease: 12 }).seg(10);
  P.bumps(0.55, 36, s0);
  P.seg(GROW + 4);
  // ---- Plastic: a booster up onto the scaffolding, the kicker, the gap, the landing and down to the asphalt.
  P.toPlastic();
  s0 = P.s;
  P.seg(FLARE + 6).booster(20, 4);
  // A banked S climbing onto the scaffolding (one pitch through both turns), a long crest, then the run-up to the lip.
  const sLen = 2 * (24 * DEG * 60 + 12), th = solve((t) => rampRise(t, 18) + Math.sin(t) * sLen + rampRise(t, 26), 6.5 - P.pose.y, 0, 0.3);
  P.seg(18, { pitch: th }).arc(60, -24, { bank: 7, ease: 12 }).arc(60, 24, { bank: 7, ease: 12 }).seg(26, { pitch: 0 }).seg(14);
  let k0 = P.s;
  P.seg(J.lipLen, { pitch: J.lip * DEG }).tag('kicker', k0);
  k0 = P.s;
  P.seg(J.gap, { pitch: J.land * DEG }).tag('gap', k0);
  // The landing is a catch tray: 12 u wide where a car comes down (a crooked take-off still lands), narrowing to the
  // channel as the slope eases out.
  P.key(P.s, {}).key(P.s, { width: CATCH }).key(P.s + J.landHold + J.landOut, { width: T.width });
  P.seg(J.landHold).seg(J.landOut, { pitch: 0 }).seg(8);
  P.slopeTo(T.floorY, 7, 20, 16).support('scaffold', s0);
  P.seg(6).toRoad('asphalt', 0).seg(FLARE + 10);
  // ---- Asphalt: the NW corner flat out between tyre walls, esses over a rise, the run (B) to the big jump.
  P.arc(34, 124, { bank: 3, ease: 12 });
  P.seg(4).open(8);
  P.arc(45, -40, { bank: 3, ease: 12, toY: 1.8 }).arc(45, 40, { bank: 3, ease: 12, toY: T.floorY });
  P.freeStraight(B);
  // ---- Plastic: THE BIG JUMP, east. The launch ramp up its scaffold tower to the lip, a booster where it starts to
  // climb (so a car leaves the lip within ~3% of the jump's speed even without the vehicle's pull to it), the gap over
  // the road below, the long landing ramp down to the meadow.
  P.toPlastic();
  P.seg(FLARE + 18);
  s0 = P.s;
  const lipTh = BIG.lip * DEG, ramp = (BIG.lipY - P.pose.y - easeRun(0, lipTh, BIG.sag).y) / Math.sin(lipTh);
  P.tags.push({ tag: 'booster', s0: s0 + 8, s1: s0 + 16 });
  P.seg(BIG.sag, { pitch: lipTh }).seg(ramp).tag('kicker', s0);
  const lip = P.s, Lx = P.pose.x, Lz = P.pose.z, Lyaw = P.pose.yaw;
  // The gap's virtual surface: a low crest (two equal eases, lip pitch -> c -> flat) ending on the landing deck's edge.
  const unit = (c: number) => { const a = easeRun(lipTh, c, 1), b = easeRun(c, 0, 1); return { x: a.x + b.x, y: a.y + b.y }; };
  const crest = solve((c) => { const u = unit(c); return u.y / u.x; }, BIG.gapY / BIG.gapX, -lipTh, lipTh);
  const half = BIG.gapX / unit(crest).x;
  P.seg(half, { pitch: crest }).seg(half, { pitch: 0 }).tag('gap', lip);
  // The landing ramp: a catch tray BIG.width wide, narrowing to the road over the runway.
  const h0 = P.s;
  P.key(h0, {}).key(h0, { width: BIG.width });
  for (const [len, deg] of BIG.deck) P.seg(len, { pitch: deg * DEG });
  const rw = BIG.runway * DEG, runway = (T.floorY - P.pose.y - easeRun(rw, 0, BIG.flare).y) / Math.sin(rw);
  P.key(P.s, {}).key(P.s + runway, { width: T.road });
  P.seg(runway).seg(BIG.flare, { pitch: 0 }).tag('bigjump', lip).support('rig', s0);
  // ---- Asphalt: round under the jump. Right, right again and back west beside it, then 60 deg right and across under
  // the flight (the straight back is whatever puts that crossing BIG.cross past the lip), left toward the loop.
  const turnR = { bank: 3, ease: 12 }, X = 60, tX = new Path(0).arc(26, X, turnR).pose; // how far that turn carries on
  P.seg(4).toRoad('asphalt', 6).seg(FLARE + 2);
  P.arc(24, 90, turnR).seg(6);
  P.verge(8);
  P.arc(24, 90, turnR);
  const ca = Math.cos(Lyaw), sa = Math.sin(Lyaw);
  const along = (P.pose.x - Lx) * ca + (P.pose.z - Lz) * sa, south = -(P.pose.x - Lx) * sa + (P.pose.z - Lz) * ca;
  P.seg(along - tX.x - (south - tX.z) / Math.tan(X * DEG) - BIG.cross).arc(26, X, turnR);
  P.seg((south - tX.z) / Math.sin(X * DEG) + 14).arc(30, -X, turnR);
  P.seg(CLOSE(8) + 4);
  // ---- Plastic: the booster into the loop, then the banked climb on stone pillars round to the gate.
  P.toPlastic();
  P.seg(FLARE + 4).booster(28, 6);
  const l0 = P.s;
  P.loop(8.5, 9.5).tag('loop', l0).support('loop', l0);
  P.seg(14);
  s0 = P.s;
  const turn = 360 * Math.ceil(P.pose.yaw / DEG / 360 - 1e-9) - P.pose.yaw / DEG; // whatever closes the heading
  P.arc(38, turn, { bank: 16, ease: 14, toY: T.gateY, pin: 26, pout: 34 }).tag('helix', s0).support('pillar', s0);
  return P;
}

/** The meadow's props: the start gate, the arch over the big jump's lip. */
function props({ G: PG, frameAt, tags }: PropsContext) {
  gate(PG, frameAt, MEADOW.start);
  for (const g of tags) if (g.tag === 'bigjump') launchArch(PG, frameAt, g.s0 - 3);
}

export const meadow: Course<'meadow'> = {
  id: 'meadow', name: 'Meadow', blurb: 'Country roads, a dirt stretch, the big jump and the loop',
  color: '#6fd35a', // its dot in the track switch and its Try button: the grass
  layout,
  start: MEADOW.start,
  wide: false, // the plain 8 u channel (its plastic is never banked wide)
  metal: METAL, // galvanised scaffolds
  world: 'meadow', hoop: false,
  props,
  // medal pace (u/s) per car: see Course.pars
  pars: { skyline: 44.05, impala: 42.03, roxy: 43.38, gt3: 43.34, '964': 42.78, firebird: 42.73, beach: 41.26, civic: 42.64, mustang: 43.18, '*': 42.1 },
};
