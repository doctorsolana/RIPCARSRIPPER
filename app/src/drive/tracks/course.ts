import type * as THREE from 'three';
import type { TrackFrame, TrackLook } from '../types';
import type { Geo } from './geo.ts';
import type { FrameAt, Span } from './kit.ts';
import type { Path } from './path.ts';
import type { SupportHook } from './supports.ts';

/** What a course's props hook gets: the props' geometry (G: drawn into the props' chunks, after the supports and
 *  before the tyre walls and hay bales), the frame table and its tags, the world-shadow hints to add to (posts: plan
 *  points under what stands on the meadow) and the start grid (Course.grid). */
export interface PropsContext {
  G: Geo;
  frameAt: FrameAt;
  frames: TrackFrame[];
  tags: Span[];
  posts: [number, number][];
  grid: { s: number; d: number }[];
}

/** A course: everything that makes one lap different from another. One file per course in tracks/ exports one of
 *  these; tracks/index.ts lists them (COURSES). The shared builder (tracks/build.ts) turns it into a Track. */
export interface Course<Id extends string = string> {
  /** ?track=<id>, the bests' key (main.ts), track.object.userData.course. */
  id: Id;
  /** The track switch's label and the results card's "Try <name>"; `blurb` is the switch option's tooltip. */
  name: string;
  blurb: string;
  /** Its dot in the top bar's track switch and its "Try" button on the results card. */
  color: string;
  /** The lap, laid with tracks/path.ts pieces; A and B are its two free straights (Path.freeStraight), which the
   *  closure solve sizes so the lap closes exactly. Called twice per build (at 0, 0 and at the solved lengths). */
  layout(A: number, B: number): Path;
  /** s of the start line (in the gate). */
  start: number;
  /** Plastic wider than the 8 u channel: settle keeps a banked deck's real edge off the meadow, the channel puts rings
   *  and blue connectors across the whole width, and the audio ticks over every connector (track.look.wide). */
  wide: boolean;
  /** The paint on its scaffolds and loop poles (tracks/geo.ts palette: METAL galvanised, BLUE the toy's). */
  metal: THREE.Color;
  /** world-outdoor.ts's style for the meadow round it (STYLES; track.look.world). */
  world: TrackLook['world'];
  /** A hoop over its big jump's flight: the camera's side-on jump shot holds back as it passes (track.look.hoop). */
  hoop: boolean;
  /** Its start grid (userData.grid), pole first: s along the lap, d across (+ right). None: one car in the gate. */
  grid?: () => { s: number; d: number }[];
  /** Its own support kinds (Path.support(kind)) by name, beside the built-in ones (tracks/supports.ts). */
  supports?: Record<string, SupportHook>;
  /** Its set dressing: the start gate, arches, hoops ... (tracks/props.ts has the stock pieces). */
  props(ctx: PropsContext): void;
  /** Medal pace: the autopilot's average speed (u/s) over 3 laps (3 x the lap's length / its 3-lap total in node
   *  laps.ts 'auto'; npm run stats prints the rows), per car - keyed as PROFILES in vehicles/arcade.ts
   *  (profileKey: the car's toy number, else a word of its id), '*' the stock car's, for a car without a profile; medals at x1.03 / 1.10 / 1.20 of laps x
   *  length / pace (main.ts). A car missing here takes the default course's number: the same pace, so its par time
   *  scales with the lap's length. Remeasure the row whenever the layout changes. */
  pars: Record<string, number>;
}
