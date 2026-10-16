import type { CarSpec, Track, VehicleState, WheelSpec } from '../types';

// Online play's race rules, shared by the server (app/server/sim.ts, which is the authority) and the drive page: the
// start grid, lap counting (main.ts's single-player rule), race progress for the standings (car-to-car contact is
// net/contact.ts).
// All deterministic: no clocks, no randomness, a fixed order.

/** Start grid slots (s along the lap, d across: + right), pole first: the course's own (the Sky Tower's 8) and, past
 *  them or on a course without one (the meadow's two-wide gate), rows 7 u apart behind the line, as many abreast as the
 *  track's width takes (2 on the meadow's channel, at most 4). */
export function gridSlots(track: Track, n: number): { s: number; d: number }[] {
  const own = ((track.object.userData as { grid?: { s: number; d: number }[] }).grid ?? []).slice(0, n);
  const out = own.map((g) => ({ s: g.s, d: g.d }));
  let back = own.length ? track.start - Math.min(...own.map((g) => g.s)) + 7 : 3;
  while (out.length < n) {
    const s = track.start - back, w = track.frameAt(s).width;
    const across = Math.max(1, Math.min(4, Math.floor(w / 4)));
    const gap = w / across;
    for (let j = 0; j < across && out.length < n; j++) out.push({ s, d: (j - (across - 1) / 2) * gap });
    back += 7;
  }
  const L = track.length;
  return out.map((g) => ({ s: ((g.s % L) + L) % L, d: g.d }));
}

/** The car spec the drive page's rig.ts builds from a car's model.json and meta.json (the server reads the same files:
 *  both sides must drive the same car). */
export function carSpecOf(id: string, info: { dimensions?: { length?: number; width?: number; height?: number }; wheels?: WheelSpec[] } | null,
  meta: Record<string, unknown> | null): CarSpec {
  const dims = info?.dimensions ?? {};
  return {
    id,
    length: dims.length ?? 4,
    width: dims.width ?? 1.5,
    height: dims.height ?? 1.2,
    wheels: (info?.wheels ?? []).map((w) => ({ name: w.name, centre: [w.centre[0], w.centre[1], w.centre[2]], r: w.r })),
    meta: meta ?? {},
  };
}

/** One car's race: main.ts's lap rule - a lap counts when the car crosses the line forward having been round the far
 *  side since the last one (no lap for starting behind the line, or for backing over it). Times in steps. */
export interface LapState { far: boolean; laps: number; lapStart: number; lapTimes: number[]; finish: number }
export const newLap = (go: number): LapState => ({ far: false, laps: 0, lapStart: go, lapTimes: [], finish: -1 });

/** After step k (the car's state is tick k + 1): 'lap' or 'finish' when it completes one. */
export function lapStep(l: LapState, st: VehicleState, track: Track, k: number, laps: number): 'lap' | 'finish' | null {
  const L = track.length, r = (((st.trackS - track.start) % L) + L) % L;
  if (r > L * 0.5 && r < L * 0.9) l.far = true;
  if (!(st.lapDelta > 0 && l.far)) return null;
  l.far = false;
  l.lapTimes.push(k + 1 - l.lapStart);
  l.lapStart = k + 1;
  l.laps++;
  if (l.laps >= laps && l.finish < 0) {
    l.finish = k + 1;
    return 'finish';
  }
  return 'lap';
}

/** How far along the race a car is (u): laps done x the lap, plus the way round this one (behind the line before the
 *  first crossing counts as negative). */
export function progressOf(l: LapState, st: VehicleState, track: Track) {
  const L = track.length;
  let r = (((st.trackS - track.start) % L) + L) % L;
  if (!l.far && r > L * 0.75) r -= L;
  return l.laps * L + r;
}

// Car-to-car contact: net/contact.ts (the server runs it after every step; the page predicts it).
export { ContactSolver, newContactStats, type ContactStats } from './contact.ts';
