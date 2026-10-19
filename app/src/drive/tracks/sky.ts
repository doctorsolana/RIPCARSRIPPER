import * as THREE from 'three';
import type { Course, PropsContext } from './course.ts';
import { BLUE, BLUE2, Geo, ORANGE, basis, beam, box, column, mr } from './geo.ts';
import { BASE, DEG, KIT, LIP, col, newFrame, v3, type FrameAt, type Range, type Span } from './kit.ts';
import { CLOSE, FLARE, GROW, Path, easeRun, rampRise, solve } from './path.ts';
import { checkpoint, gateWide, launchArchWide } from './props.ts';
import type { LaneJump } from './split.ts';
import type { Support } from './supports.ts';

// Track 2, the Sky Tower (?track=sky), built like every course (tracks/path.ts) and wide for racing in a pack (16-24
// u, four cars abreast; SKY) but for the classic 9 u channel where the squeeze is the point: the gate deck on a blue
// lattice tower 42 u up with a start grid, a 40 deg plunge in the narrow channel into its loop, a stadium with chained
// boosters, a 30 deg banked 180, a double jump, a 70 deg wall ride ridden UP onto from the meadow (one narrow booster
// pad in the middle of its approach), a rounded crest off it, esses and a chicane on the road, three rhythm humps on
// the straight east (SKY_BUMPS: hopped at speed, rolled over slowly), the climb - chained pads into a pull-up past
// vertical, over the top upside down and a half roll out into a banked right-hander that tightens into a drift corner,
// onto a narrow deck 41 u up (CLIMB, Path.immelmann) - the sky bridge, which splits into two lanes round an island, each
// lane its own jump (BRIDGE, Path.split) - the sky jump's in-run - the dive: off the deck's end a 270 deg descending right-hander that comes
// round UNDER the deck (an over/under) and plunges to a pad at its foot - and the jump itself (3+ s of air through a
// hoop: SKYJ), and a 2.5-turn spiral round the tower back up to the gate. Its own props: the Sky Tower (support
// 'spire'), the wide gate and its grid, the arch and the hoop over the sky jump, checkpoint arches.

/** Track 2, the Sky Tower (u, deg). Wide for racing in a pack - most of the lap is 16-24 u (four cars abreast) - with
 *  the classic channel kept where the squeeze is the point: the plunge off the tower and its loop (`narrow`), and the
 *  chicane on the road (12). */
export const SKY = {
  gateY: 42, gateLen: 40, start: 24, deck: 22, // the gate deck on the tower top: height, length, start line, width
  spiralR: 26, spiralW: 16, spiralBank: 20, spiralY: 3, spiralPads: 4, // the spiral round the tower (2.5 turns)
  plunge: 40, narrow: 9, loopR: 14, // the plunge off the tower and the loop at its foot, in the classic channel
  wide: 22, // the stadium decks and the roads
  bank180: 30, r180: 56, // the banked 180 at the end of the stadium
  // The wall ride: a 180 at wallR banked wallBank, wallW across, ridden up onto: over its entry (wallEase u) the inner
  // edge rises wallLift and the centre the bank's w / 2 sin(bank) more; the exit comes down that and wallDrop. One
  // booster pad, wallPad u wide, in the middle of its approach: line up for it, or ride the wall slower.
  wallBank: 70, wallR: 46, wallW: 24, wallEase: 60, wallLift: 3, wallDrop: 3, wallPad: 5,
  floorY: KIT.floorY,
};

/** Track 2's bumps (u): rounded humps in the plastic, `at` u into their straight. The rhythm section - `n` humps on the
 *  wide straight east before the climb's SE corner - and a single crest on the straight off the wall ride. A car at
 *  race speed (~40+ u/s) hops from crest to crest, ~0.4-0.7 s in the air each; slower, it rolls over them. */
export const SKY_BUMPS = {
  wall: { at: 10, n: 1, wave: 32, amp: 1.6 },
  east: { at: 4, n: 2, wave: 46, amp: 2.0 }, // (founder: fewer, bigger, softer - two long rollers, ~0.5 s of air at speed)
};

/** The double jump: two kickers back to back (lip, gap, landing as JUMP, bigger), 18 u wide. */
export const DOUBLE = { lip: 12, lipLen: 8, gap: 26, land: -12, hold: 10, out: 16, between: 14, width: 18, catch: 24, y: 4.5 };

/** The sky jump and its in-run, solved against the arcade model (g = 24). The in-run: the deck the climb (CLIMB) ends
 *  on, 41 u up on the east side, runs on north past the jump's line; off its far end the dive turns right and down - a
 *  270 deg descending right-hander (diveR, banked diveBank, at `sweep` deg) that comes back round heading west and dives
 *  UNDER the deck (the over/under: ~16 u of headroom, the deck's stilts stand clear of it), then plunges at `dive` deg
 *  to `bottom` - the speed builds down it - a booster pad on the straight at its foot (`run`), and a short steep kicker
 *  (`lip` deg) to a lip only `lipY` up (~51.5 u/s there: `speed`). Then a gap of gapX (horizontal) to the landing hill's edge
 *  gapY ABOVE the lip - it jumps up and over onto the hill, like the meadow's big jump - and the hill, a long ski slope:
 *  it eases `edge` -> `steep` over `hill` u, holds, eases to the runway's pitch, and flares onto the meadow. Every run
 *  from 0.85 to 1.15 x `speed` lands on the slope lined up (PERFECT): the slow ones early, near its top, the fast ones
 *  ~100 u further down; 1.2-1.25 x come down on the flare (ok); slower than 0.85 x falls short into the gap and is put
 *  back at the top of the in-run. ~3.3 s of air at the design speed, the apex ~28 u over the lip; the hoop stands over
 *  it (scratch jsearch.mjs, window.ts). */
export const SKYJ = {
  cornerR: 46, // the SE corner on the way to the climb (CLIMB)
  // the dive: the 270 deg right-hander - its yaw rate, bank and `sweep` pitch ease in over diveIn and its yaw rate and
  // bank out over diveIn - a lineUp straight (still at `sweep`: it passes under the deck here), the plunge (eased in over
  // `tip`, held at `dive` deg, eased level over footLen) to `bottom`; then the straight there and its pad (padAt u in:
  // the pad's boost lasts up the ramp). Radius and line-up: the keyboard bots' scratch sweep (dive/sweep2.sh)
  diveR: 56, diveBank: 20, diveIn: 40, sweep: -3, lineUp: 35, tip: 30, dive: -11, footLen: 30,
  bottom: 10, run: 26, padAt: 16,
  lip: 46, lipY: 24, sag: 30, // the launch ramp
  gapX: 66, gapY: 5, // the landing hill's edge from the lip (horizontal, vertical)
  edge: -6, hill: 40, steep: -24, // the hill: its edge's pitch, easing to `steep` over `hill` u ...
  runway: -12, ease: 28, runLen: 30, flare: 30, // ... then to the runway's pitch, and the flare to the meadow
  width: 20, catch: 48, speed: 51.5, // the in-run's and lip's width, the landing's; the design lip speed (u/s)
};

/** The climb to the sky jump's deck, up the wall and over (Path.immelmann; tag 'climb'), 20 u wide: `east` u of plastic
 *  past the road and the SE corner, `pre` u, `pads` chained booster pads (24 u apart) and a `lead` straight; the pull-up
 *  (clothoids totalling e1 into and out of r1) to `over` deg, past vertical; a straight `wall` there; over the top at r2,
 *  easing over e3 to rTop as it comes upside down 48 u up; the half roll over `roll` u (the line diving at first - the
 *  curve that keeps the car pressed on while it's upside down and on its side - and levelling as it comes upright,
 *  `dive` / `pull`: Path.immelmann) into a right-hander of turnR banked `bank`, which sweeps on round to the north onto
 *  the deck (41 u up) and eases out over `out`. Up the wall it's the speed brought to it that carries the car (the tyres
 *  push less the steeper it gets: arcade.ts): over the pads a car reaches ~66 u/s, ~41 at the top; under ~56 at the
 *  pull-up it can't stay on round the top, falls off and is put back before the pads (scratch climbspeed.ts, hold.ts). */
export const CLIMB = {
  east: 100, pre: 20, pads: 3, w: 20, lead: 16,
  r1: 18, e1: 16, over: 95, wall: 9, r2: 12, e2: 8, rTop: 34, e3: 10, roll: 34, dive: 1, pull: 0.5, turnR: 28, bank: 30, out: 16,
};

/** The sky bridge (founder: smaller, a more aggressive curve to drift, then two smaller tracks side by side - a choice,
 *  and fun in a pack). Out of the climb's half roll the right-hander (CLIMB.turnR, banked CLIMB.bank) tightens to `r`
 *  over `tighten` u and eases out over `out`, narrowing from the roll's 20 u to `w` over `narrow` u: a drift corner (in
 *  grip ~38 u/s; drifted it holds too, a little slower through, out faster with its mini-turbo). Onto the deck `w` wide
 *  (the free straight A), then the split (Path.split, tracks/split.ts): the deck flares over `flare` u to two lanes
 *  `lane` wide either side of an island `half` u each side of the centre line - a gap you see the meadow through - whose
 *  point is `nose` u in, opening at `slope`; it closes again `tailRoom` u before the split's end (`len`), and the deck
 *  narrows on to the dive's width over `rejoin`. From `catch0` to `catch1` u in both lanes widen outward by `catch`
 *  (catch trays over the landings: a crooked take-off still comes down on its lane). Each lane has its own jump - the
 *  left one early and steeper (26 deg, ~1.55-1.7 s of air), the right one later and flatter (24 deg, ~1.45-1.6 s), a
 *  bit over the double jump's and far from the sky jump's - kicker, gap and landing hill solved so a straight run at race
 *  speed lands PERFECT (scratch jd.ts); the two lanes lap within ~0.05 s of each other. */
export const BRIDGE = {
  r: 18, tighten: 14, out: 14, w: 11, narrow: 30,
  flare: 16, half: 2, lane: 9.5, slope: 0.25, nose: 24, len: 158, tailRoom: 4, rejoin: 12, catch: 5, catch0: 56, catch1: 144,
  left: { at: 44, lip: 26, lipLen: 10, gap: 22, land: -14, out: 12 } as LaneJump | null,
  right: { at: 64, lip: 24, lipLen: 10, gap: 26, land: -14, out: 12 } as LaneJump | null,
};

/** Track 2: the Sky Tower lap. A and B are the free straights that close it (the deck at the top of the climb, the
 *  runout west from the sky jump's landing to the spiral). */
function layoutSky(A: number, B: number) {
  const K = SKY, J2 = SKYJ, D2 = DOUBLE, C = CLIMB;
  const P = new Path(K.gateY, { width: K.spiralW });
  let s0 = 0;
  // ---- The gate deck on the tower top: four abreast, two rows behind the line (track.object.userData.grid)
  P.widen(K.deck, 10);
  P.seg(K.gateLen).tag('gate', 0).support('spire', 0);
  P.tags.push({ tag: 'finish', s0: K.start - 1, s1: K.start + 1 });
  // ---- The plunge: 40 deg off the tower in the classic narrow channel (the pack squeezes in single file), a booster on
  // the way down, straight into the loop
  s0 = P.s;
  P.widen(K.narrow, 24);
  const th = K.plunge * DEG, rIn = 60, rOut = 30; // (a long crest: the chase camera stays over it)
  const hold = (P.pose.y - K.floorY - rampRise(th, rIn) - rampRise(th, rOut)) / Math.sin(th);
  P.seg(rIn, { pitch: -th });
  P.tags.push({ tag: 'booster', s0: P.s + hold * 0.35, s1: P.s + hold * 0.35 + 8 });
  P.seg(hold);
  P.seg(rOut, { pitch: 0 }).tag('drop', s0).support('pylons', s0);
  P.seg(10);
  const l0 = P.s;
  P.loop(K.loopR, K.narrow + 3).tag('loop', l0).support('loop', l0);
  P.seg(10);
  // ---- Speed: the stadium on the meadow, chained boosters, up onto stilts and the banked 180
  P.widen(K.wide, 30);
  P.seg(40);
  for (let i = 0; i < 3; i++) P.booster(24, 8);
  s0 = P.s;
  P.slopeTo(6, 5, 24);
  P.arc(K.r180, 180, { bank: K.bank180, ease: 30 });
  P.seg(10);
  // ---- The double jump, westward on stilts
  P.slopeTo(D2.y, 3, 20);
  P.widen(D2.width, 16);
  P.seg(18);
  // each landing is a catch tray wider than the lips (a crooked or off-centre take-off still lands), narrowing again
  // before the next lip; it widens over the end of the gap (nothing there to drive on or hit), so the walls never jump
  // out between two frames - a car reversing up the tray to its edge isn't snapped sideways
  const tray = () => P.key(P.s - D2.hold - D2.out - 6, {}).key(P.s - D2.hold - D2.out, { width: D2.catch });
  P.kicker(D2);
  tray().widen(D2.width, D2.between);
  P.seg(D2.between).kicker(D2);
  tray().widen(K.wide, 20);
  P.seg(20).support('stilts', s0);
  // ---- The wall ride, on the meadow: one narrow booster pad in the middle of the approach, then the 180 ridden up
  // onto the wall and back down off it
  P.slopeTo(K.floorY, 3, 12); // (the second landing runs out a little below the deck it left)
  s0 = P.s;
  P.widen(K.wallW, 24);
  P.seg(24);
  P.tags.push({ tag: 'booster', s0: P.s, s1: P.s + 8, d0: -K.wallPad / 2, d1: K.wallPad / 2 });
  P.seg(26);
  P.wallArc(K.wallR, -180, { bank: K.wallBank, ease: K.wallEase, w: K.wallW, lift: K.wallLift, drop: K.wallDrop });
  P.support('stilts', s0);
  P.widen(K.wide, 20);
  const BW = SKY_BUMPS.wall;
  P.humpsAt(P.s + BW.at, BW.n, BW.wave, BW.amp); // (SKY_BUMPS)
  P.seg(50);
  // ---- Technical, on the road: esses between grass verges, a chicane between tyre walls, eastward
  P.seg(6).toRoad('asphalt', 5, 16).seg(FLARE + GROW);
  P.arc(30, -50, { ease: 12 }).arc(30, 100, { ease: 12 }).arc(30, -50, { ease: 12 }).seg(16);
  P.wall().widen(12, 10);
  P.seg(10);
  P.arc(18, 45, { ease: 10 }).arc(18, -45, { ease: 10 });
  P.seg(4).open(6);
  P.seg(GROW).widen(K.wide, 16);
  P.seg(16);
  // ---- The climb to the sky jump (CLIMB): back onto the plastic, east on the meadow and round the SE corner, north
  // over a row of chained pads, then up the wall - a pull-up past vertical, over the top upside down (heading back
  // south, above the pads) and a half roll out of it into a banked right-hander - that sweeps on round to the north,
  // onto the deck 41 u up (A). Its rig: a lattice tower behind the wall and one beside the roll (supports 'climb')
  P.seg(CLOSE(6) + 4).toPlastic(J2.width);
  s0 = P.s;
  P.seg(FLARE);
  const BE = SKY_BUMPS.east;
  P.humpsAt(P.s + BE.at, BE.n, BE.wave, BE.amp).seg(C.east); // (SKY_BUMPS)
  P.arc(J2.cornerR, -90, { bank: 6, ease: 16 });
  P.seg(C.pre);
  for (let i = 0; i < C.pads; i++) P.booster(24, 8);
  P.widen(C.w, C.lead);
  P.seg(C.lead).support('stilts', s0);
  const c0 = P.s;
  P.immelmann(C).tag('climb', c0);
  // ... the rest of the right-hander to the north, tightening from turnR to the bridge's r (a drift corner) and
  // narrowing to the bridge's width, the bank and turn easing out together
  const BR = BRIDGE, left = 3 * Math.PI / 2 - (P.pose.yaw - 2 * Math.PI * Math.floor(P.pose.yaw / (2 * Math.PI)));
  const kT = 1 / C.turnR, kB = 1 / BR.r, bendHold = (left - (BR.tighten * (kT + kB)) / 2 - (BR.out * kB) / 2) / kB;
  P.widen(BR.w, BR.narrow);
  P.seg(BR.tighten, { k: kB }).seg(bendHold).seg(BR.out, { k: 0, bank: 0 }).support('climb', c0);
  s0 = P.s;
  P.seg(6);
  P.freeStraight(A);
  // ... the split: two lanes, each its own jump, round an island, and back to one deck before the dive
  P.widen(2 * (BR.half + BR.lane), BR.flare);
  // (both lanes widen outward into catch trays over the jumps' landings - a crooked take-off still comes down on the
  // lane - and narrow back gently before the island closes)
  const sp0 = P.s, W = 2 * (BR.half + BR.lane);
  P.key(sp0 + BR.catch0, {}).key(sp0 + BR.catch0 + 16, { width: W + 2 * BR.catch }).key(sp0 + BR.catch1, {});
  P.key(sp0 + BR.len + BR.rejoin, { width: J2.width }); // (the rejoin: narrowing all the way down to the dive's width)
  P.split(BR.len, { nose: BR.nose, tail: BR.len - BR.tailRoom, half: BR.half, slope: BR.slope, lane: BR.lane, lanes: [BR.left, BR.right] });
  P.seg(BR.rejoin);
  // ... then the dive (all of it tag 'inrun': flat out, crests hold, a miss is put back at its top): off the deck's far
  // end to the right and down - a 270 deg descending right-hander - that comes back heading west UNDER the deck (the
  // over/under), lines up and plunges to the foot of the launch ramp
  const in0 = P.s, kD = 1 / J2.diveR, th1 = J2.sweep * DEG, th2 = J2.dive * DEG;
  P.seg(J2.diveIn, { k: kD, bank: J2.diveBank * DEG, pitch: th1 }).seg((1.5 * Math.PI) / kD - J2.diveIn).seg(J2.diveIn, { k: 0, bank: 0 });
  P.seg(J2.lineUp);
  const dive = (J2.bottom - P.pose.y - easeRun(th1, th2, J2.tip).y - easeRun(th2, 0, J2.footLen).y) / Math.sin(th2);
  P.seg(J2.tip, { pitch: th2 }).seg(dive).seg(J2.footLen, { pitch: 0 });
  P.booster(J2.run, J2.padAt).support('stilts', s0);
  // ---- The sky jump, westward toward the tower: the launch ramp, the gap (the hoop over its apex), the landing hill
  s0 = P.s;
  const lipTh = J2.lip * DEG;
  const ramp = (J2.lipY - P.pose.y - easeRun(0, lipTh, J2.sag).y) / Math.sin(lipTh);
  P.seg(J2.sag, { pitch: lipTh }).seg(ramp).tag('kicker', s0);
  const lip = P.s, p0 = J2.edge * DEG;
  P.tags.push({ tag: 'inrun', s0: in0, s1: lip });
  // the gap's virtual surface: two equal eases, lip pitch -> c -> the hill's edge pitch, ending on its edge
  const unit = (c: number) => { const a = easeRun(lipTh, c, 1), b = easeRun(c, p0, 1); return { x: a.x + b.x, y: a.y + b.y }; };
  const crest = solve((c) => { const u = unit(c); return u.y / u.x; }, J2.gapY / J2.gapX, -lipTh, lipTh);
  const half = J2.gapX / unit(crest).x;
  P.seg(half, { pitch: crest }).seg(half, { pitch: p0 }).tag('gap', lip);
  P.key(P.s - 16, {}).key(P.s, { width: J2.catch }); // the landing is a catch tray, wider than the lip (widening over the gap's end)
  const p1 = J2.steep * DEG, rw = J2.runway * DEG;
  P.seg(J2.hill, { pitch: p1 });
  const steep = (K.floorY - P.pose.y - easeRun(p1, rw, J2.ease).y - Math.sin(rw) * J2.runLen - easeRun(rw, 0, J2.flare).y) / Math.sin(p1);
  P.seg(steep).seg(J2.ease, { pitch: rw }).seg(J2.runLen);
  P.widen(K.spiralW, J2.flare + 20);
  P.seg(J2.flare, { pitch: 0 }).tag('bigjump', lip).support('rig', s0);
  // ---- The runout west to the tower (B), and the spiral: up round the tower to the gate, counter-clockwise, a booster
  // about every half turn
  P.freeStraight(B);
  P.slopeTo(K.spiralY, 4, 16);
  s0 = P.s;
  const yaw = P.pose.yaw / DEG, turn = -(yaw - 360 * Math.floor(yaw / 360 + 1e-9)) - 720; // whatever closes the heading
  const pin = 20, len = Math.abs(turn) * DEG * K.spiralR + 14;
  for (let i = 0; i < K.spiralPads; i++) P.tags.push({ tag: 'booster', s0: s0 + pin + len * (0.12 + 0.22 * i), s1: s0 + pin + len * (0.12 + 0.22 * i) + 8 });
  P.arc(K.spiralR, turn, { bank: K.spiralBank, ease: 14, toY: K.gateY, pin, pout: 0 }).tag('helix', s0).support('spire', s0);
  return P;
}

// ---- its props: the Sky Tower, the hoop over the sky jump ----------------------------------------------------------

/** The centre of the spiral (the 'helix' tag): each frame's centre of turn (R to the inside of its horizontal right),
 *  averaged over the middle of the climb. */
function helixCentre(frameAt: FrameAt, h: Span, R: number) {
  const f = newFrame(), c = v3(), r = v3();
  let n = 0;
  const a = h.s0 + (h.s1 - h.s0) * 0.15, b = h.s0 + (h.s1 - h.s0) * 0.85;
  for (let s = a; s <= b; s += 2) {
    frameAt(s, f);
    r.set(f.right.x, 0, f.right.z).normalize().multiplyScalar(Math.sign(f.kappa) * R); // (+ kappa: right is the inside)
    c.add(r.add(f.p));
    n++;
  }
  return c.divideScalar(n).setY(0);
}

/** The Sky Tower: a chunky blue lattice column at the centre of the spiral, up to the gate deck - four corner posts,
 *  a girt every 6 u, an X-brace per face and storey, orange chevron plates under the top - with an arm out to the
 *  spiral's inner edge every ~24 deg of its climb (and a strut under each), and girders out to the gate deck. Under
 *  the deck's far end, a slimmer lattice leg. */
function spire(G: Geo, frameAt: FrameAt, sp: Range<Support>, tags: Span[], posts: [number, number][]) {
  const helix = tags.find((t) => t.tag === 'helix');
  if (!helix) return;
  const C = helixCentre(frameAt, helix, SKY.spiralR), f = newFrame(), a = v3(), b = v3(), UP = v3(0, 1, 0), m = new THREE.Matrix4();
  const HW = 7, top = frameAt(0).p.y - BASE - 0.4; // the column's half-width and height (to just under the deck)
  const onDeck = sp.s0 < 1;
  if (!onDeck) {
    // the column (built once, with the spiral's range), capped with a deck and an orange band
    column(G, C.x, C.z, HW, 0, top + 3, 6, BLUE, BLUE2);
    box(G, m.makeTranslation(C.x, top + 3.3, C.z), [0, 0, 0], [2 * HW + 1.6, 0.6, 2 * HW + 1.6], BLUE2, BLUE, 2);
    box(G, m.makeTranslation(C.x, top + 4.1, C.z), [0, 0, 0], [2 * HW + 1, 1, 2 * HW + 1], ORANGE, BLUE2, 1);
    // chevrons: two rows of orange plates on each face, under the top
    for (let face = 0; face < 4; face++) {
      const ang = (face * Math.PI) / 2, nx = Math.cos(ang), nz = Math.sin(ang);
      for (const y of [top - 4, top - 9]) for (const k of [-1, 1]) {
        m.makeRotationY(-ang).setPosition(C.x + nx * (HW + 0.35), y, C.z + nz * (HW + 0.35));
        box(G, m.multiply(mr.makeRotationX(k * 0.62)), [0, 0, k * 1.6], [0.3, 1.1, 4.2], ORANGE, ORANGE, 2);
      }
    }
    posts.push([C.x, C.z]);
    // arms to the spiral: every ~24 deg of turn
    const step = (24 * DEG) * SKY.spiralR;
    for (let s = helix.s0 + 22; s < helix.s1 - 4; s += step) {
      frameAt(s, f);
      const inner = Math.sign(f.kappa); // the inside of the turn (+1: the right)
      a.copy(f.p).addScaledVector(f.right, inner * (f.width / 2 + LIP)).addScaledVector(f.up, -BASE - 0.3);
      const dx = a.x - C.x, dz = a.z - C.z, k = HW / Math.max(Math.abs(dx), Math.abs(dz));
      b.set(C.x + dx * k, a.y, C.z + dz * k);
      beam(G, b, a, 0.7, 0.7, UP, BLUE);
      beam(G, b.set(C.x + dx * k, Math.max(0.3, a.y - 6), C.z + dz * k), a, 0.45, 0.45, UP, BLUE2);
      box(G, basis(f, m), [0, -BASE - 0.25, 0], [0.6, 0.5, f.width + 2 * LIP + 0.6], BLUE); // a transom under the floor
    }
    return;
  }
  // the gate deck: a girder out from the column's top to each bent under the deck, and a leg under its far end
  for (let s = sp.s0 + 2; s < sp.s1; s += 8) {
    frameAt(s, f);
    box(G, basis(f, m), [0, -BASE - 0.3, 0], [0.7, 0.6, f.width + 2 * LIP + 0.8], BLUE);
    a.copy(f.p).addScaledVector(f.up, -BASE - 0.6);
    const dx = a.x - C.x, dz = a.z - C.z, k = HW / Math.max(Math.abs(dx), Math.abs(dz));
    if (k < 1) {
      b.set(C.x + dx * k, a.y, C.z + dz * k);
      beam(G, b, a, 0.8, 0.9, UP, BLUE);
      beam(G, b.set(C.x + dx * k, a.y - 7, C.z + dz * k), a, 0.5, 0.5, UP, BLUE2);
    }
  }
  frameAt(sp.s1 - 4, f);
  column(G, f.p.x, f.p.z, 3, 0, f.p.y - BASE - 0.6, 6, BLUE, BLUE2, Math.atan2(f.t.z, f.t.x));
  posts.push([f.p.x, f.p.z]);
}

/** The hoop over the sky jump: a ring (centre `c`, facing along the flight `dir`, radius R) in red and white segments,
 *  held up by two slim blue masts from the meadow. */
function hoop(G: Geo, c: THREE.Vector3, dir: THREE.Vector3, R: number, posts: [number, number][]) {
  const n = 24, side = v3(-dir.z, 0, dir.x).normalize(), UP = v3(0, 1, 0), a = v3(), b = v3();
  const at = (i: number, o: THREE.Vector3) => { const ang = (i / n) * 2 * Math.PI; return o.copy(c).addScaledVector(side, Math.cos(ang) * R).addScaledVector(UP, Math.sin(ang) * R); };
  const red = col('#e2261c'), white = col('#f6f4ee');
  for (let i = 0; i < n; i++) beam(G, at(i, a), at(i + 1, b), 1.5, 1.1, dir, i % 2 ? white : red);
  for (const sg of [-1, 1]) {
    at(sg > 0 ? n * 0.625 : n * 0.875, a); // the lower quarter of the ring each side
    beam(G, b.set(a.x + side.x * sg * 3, -0.2, a.z + side.z * sg * 3), a, 0.6, 0.6, dir, BLUE);
    posts.push([b.x, b.z]);
  }
}

/** The Sky Tower's props: the wide gate and its grid, the arch and the hoop over the sky jump, checkpoint arches. */
function props({ G: PG, frameAt, frames, tags, posts, grid }: PropsContext) {
  const start = SKY.start, pads = tags.filter((g) => g.tag === 'booster');
  gateWide(PG, frameAt, start, grid);
  for (const g of tags) if (g.tag === 'bigjump') {
    launchArchWide(PG, frameAt, g.s0 - 3);
    // the hoop over the apex of the flight at the design speed
    const lf = frameAt(g.s0), th = Math.asin(lf.t.y), V = SKYJ.speed, ta = (V * Math.sin(th)) / 24;
    const dir = v3(lf.t.x, 0, lf.t.z).normalize();
    const c = v3().copy(lf.p).addScaledVector(dir, V * Math.cos(th) * ta).add(v3(0, (V * Math.sin(th) * ta) / 2 + 0.7, 0));
    hoop(PG, c, dir, 11.5, posts);
  }
  // checkpoint arches: the stadium after the loop, the road's start, the top of the sky jump's in-run
  const loop = tags.find((t) => t.tag === 'loop'), lip = tags.find((t) => t.tag === 'bigjump');
  if (loop) checkpoint(PG, frameAt, loop.s1 + 26);
  const road = frames.find((g, i) => i > 0 && g.surface === 'asphalt' && frames[i - 1].surface === 'plastic');
  if (road) checkpoint(PG, frameAt, road.s + 24);
  const run = tags.find((t) => t.tag === 'inrun');
  if (run) checkpoint(PG, frameAt, run.s0 + 3); // (the drop-in: over the deck at the top of the in-run)
  else if (lip) {
    let first = lip.s0;
    for (const g of pads) if (g.s0 < lip.s0 && lip.s0 - g.s0 < 100) first = Math.min(first, g.s0);
    checkpoint(PG, frameAt, first - 10);
  }
}

export const sky: Course<'sky'> = {
  id: 'sky', name: 'Sky Tower', blurb: 'A tower drop, huge jumps, a wall ride and the spiral back up',
  color: '#ff6b00', // its dot in the track switch and its Try button: the orange plastic
  layout: layoutSky,
  start: SKY.start,
  wide: true, // its wide decks: settle's clearance by their width, rings and connectors across them (and the audio's ticks)
  metal: BLUE, // its scaffolds: the toy's blue
  world: 'sky', hoop: true, // world-outdoor's stadium style; the camera's sky-jump shot knows the hoop over the flight
  // its start grid: four abreast in two rows behind the line (s along the lap, d across: + right), pole first
  grid: () => [3, 10].flatMap((back) => [-1.5, -0.5, 0.5, 1.5].map((k) => ({ s: SKY.start - back, d: k * 5.5 }))),
  supports: { spire: (G, frameAt, sp, o) => spire(G, frameAt, sp, o.tags, o.posts) },
  props,
  // medal pace (u/s) per car: see Course.pars
  pars: { skyline: 47.30, impala: 45.89, roxy: 47.20, gt3: 47.28, '964': 46.67, firebird: 46.36, beach: 45.11, civic: 46.11, mustang: 46.88, silvia: 46.21, volvo: 45.65, jaguar: 47.17, splittin: 47.02, '*': 46.65 },
};
