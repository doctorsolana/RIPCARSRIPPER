import { STEER_OUT } from '../input.ts';
import type { DriveInput } from '../types';

// Online play (local multiplayer demo): what the drive page (net/online.ts) and the server (app/server/) say to each
// other over a WebSocket. The server is the authority: it runs the same sim (vehicles/arcade.ts on tracks/, car-to-car
// contact in net/contact.ts) for every car at 120 Hz, from the players' INPUTS only. The hot messages are binary
// (net/codec.ts): 60 Hz snapshots down, inputs up; the rest is JSON (below).
//
//   client -> server   join, ready, name, car, leave, pings (JSON); inputs (binary: each tagged with its sim step, the
//                      unacknowledged ones re-sent, and the hashes of the client's predicted states)
//   server -> client   welcome, the room (players, phase, the start step), laps, results, pongs (JSON); snapshots
//                      (binary: every other car's state for the client to predict it, your car's when it mispredicted)
//
// Inputs travel quantized (ints: steer -1000..1000, throttle and brake 0..1000, drift 0/1), and the client drives its
// own car on exactly the quantized numbers the server will use, so its prediction matches the server's bit for bit
// unless something only the server knows happened (another car, an input that arrived late).
// Step numbers are the server's: tick k is the state after k steps; the input for step k takes tick k to k + 1.

export const PORT = 8790;
export const H = 1 / 120; // the sim's fixed step (loop.ts)
export const SNAP_EVERY = 2; // a snapshot every 2 steps: 60 Hz
export const Q = 1000; // input quantization
/** The fastest the steering may move per step (quantized): the game's own - keys, pad and touch all slew through
 *  input.ts's STEER_OUT (12/s) - so a client can't steer faster than a player can. */
export const STEER_SLEW = Math.round(STEER_OUT * H * Q); // 100
export const JITTER_STEPS = 2; // the server's input buffer: a client aims for its inputs to arrive this many steps early
export const MAX_AHEAD = 240; // steps: an input further ahead of the server than this is from the future (rejected)
export const RESEND = 12; // a client re-sends its last inputs (up to this many steps) until the server has them
export const COUNTDOWN = 3; // s from everyone ready to the gate drop
export const LOG_VERSION = 3; // 3: the tamer car-to-car contact (solid toy cars, rails holding a pressed car; 2's and 1's logs re-simulate only on their code)

/** A quantized input: [steer, throttle, brake, drift]. */
export type QInput = [number, number, number, number];
export const IDLE_Q: QInput = [0, 0, 0, 0];

const clampI = (x: number, a: number, b: number) => (x < a ? a : x > b ? b : x);

/** Quantize what the input module (or the autopilot) asks for, slewing the steer no faster than STEER_SLEW from the
 *  last step's (`prev`) - what an honest client sends, and what the server applies. `raw`: skip the slew (tests: a
 *  client that breaks the rules, to see the server's checks count it). */
export function quantize(inp: DriveInput, prev: QInput, raw = false): QInput {
  let st = Math.round(clampI(inp.steer, -1, 1) * Q);
  if (!raw) st = clampI(st, prev[0] - STEER_SLEW, prev[0] + STEER_SLEW);
  return [st, Math.round(clampI(inp.throttle, 0, 1) * Q), Math.round(clampI(inp.brake, 0, 1) * Q), inp.drift ? 1 : 0];
}
/** quantize() into `out` (nothing allocated: the server's bots, every step). */
export function quantizeInto(inp: DriveInput, prev: QInput, out: QInput, raw = false): QInput {
  let st = Math.round(clampI(inp.steer, -1, 1) * Q);
  if (!raw) st = clampI(st, prev[0] - STEER_SLEW, prev[0] + STEER_SLEW);
  out[0] = st, out[1] = Math.round(clampI(inp.throttle, 0, 1) * Q), out[2] = Math.round(clampI(inp.brake, 0, 1) * Q), out[3] = inp.drift ? 1 : 0;
  return out;
}
export function dequantize(q: QInput, out: DriveInput): DriveInput {
  out.steer = q[0] / Q;
  out.throttle = q[1] / Q;
  out.brake = q[2] / Q;
  out.drift = q[3] !== 0;
  return out;
}

/** What the server's plausibility checks count per player (a counted input is clamped or dropped, never trusted). */
export interface Violations {
  format: number; // a malformed packet (dropped)
  range: number; // a value out of range (clamped)
  slew: number; // the steering moved faster than the game's own smoothing allows (clamped)
  future: number; // an input for a step too far ahead of the server (dropped)
  rate: number; // more new steps than real time allows (dropped)
  late: number; // arrived after its step was simulated (not a violation: the network; the last input was repeated)
}
export const noViolations = (): Violations => ({ format: 0, range: 0, slew: 0, future: 0, rate: 0, late: 0 });

/** A 32-bit hash of a vehicle snapshot, each number to HASH_RES: the client reports its predicted state's hash at
 *  snapshot steps; the server sends the full state back only when its own differs - a real misprediction to correct.
 *  (Not the exact bits: the browser's and Node's Math.exp - same V8, other builds - can differ in the last bit, so a
 *  prediction is never bit-exact for long; at a millionth of a unit it is, until something only the server knew.) */
const HASH_RES = 2 ** 20;
const f64 = new Float64Array(1), u32 = new Uint32Array(f64.buffer);
export function hashSnap(a: ArrayLike<number>): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < a.length; i++) {
    f64[0] = Math.round(a[i] * HASH_RES) || 0; // (-0 is 0)
    h = Math.imul(h ^ u32[0], 16777619);
    h = Math.imul(h ^ u32[1], 16777619);
  }
  return h >>> 0;
}

export type Phase = 'lobby' | 'countdown' | 'race' | 'results';

export interface PlayerInfo {
  id: number;
  name: string;
  car: string;
  carName: string; // make and model, for the lobby
  ready: boolean;
  bot: boolean;
  /** Grid slot (0 = pole) while in the race or lining up for it; -1: waiting for the next race. */
  slot: number;
  ping: number; // ms (the client's own report)
  viol: number; // plausibility violations counted (not counting late inputs)
}

export interface ResultRow {
  id: number;
  name: string;
  car: string;
  pos: number; // 1 = winner
  total: number | null; // steps from the drop to the finish (null: did not finish)
  laps: number[]; // steps per lap
  best: number | null;
}

export const MAX_PLAYERS = 10;

/** GET http://<server>/rooms: the open rooms, for the lobby browser (online.html), and the courses a room can race. */
export interface RoomListing {
  rooms: {
    name: string; track: string; trackName: string; color: string; laps: number; phase: Phase; max: number;
    players: { name: string; car: string; carName: string; bot: boolean; ready: boolean; host: boolean }[];
  }[];
  courses: { id: string; name: string; color: string; blurb: string }[];
}

/** Client -> server. */
export type C2S =
  | { t: 'join'; room: string; name: string; car: string; track: string; laps: number; min?: number; bots?: number }
  | { t: 'ready'; on: boolean }
  | { t: 'name'; name: string } // rename (any time)
  | { t: 'car'; car: string } // another car (in the lobby; between races it takes effect back in the lobby)
  | { t: 'p'; c: number; rtt?: number } // ping (c: the client's clock), with its last measured round trip
  | { t: 'leave' };

/** Server -> client. */
export type S2C =
  | { t: 'welcome'; you: number; room: string; track: string; laps: number; tick: number }
  | { t: 'track'; track: string; laps: number } // the room races another track: reload on it
  | { t: 'error'; msg: string }
  | {
      t: 'room'; phase: Phase; players: PlayerInfo[]; go: number; laps: number; track: string; min: number;
      host: number; // the host's id: the room's first human (it passes on in join order when they leave)
      /** grid slots (s, d) by slot index */ grid: { s: number; d: number }[]; race: number;
    }
  | { t: 'lap'; id: number; lap: number; time: number } // a car completed a lap (steps)
  | { t: 'results'; race: number; rows: ResultRow[] }
  | { t: 'P'; c: number; k: number }; // pong: the ping's clock, the server's tick

/** A snapshot, decoded (net/codec.ts; MSG_SNAP): tick k of race `race`. */
export interface Snap {
  k: number;
  race: number;
  a: number; // the newest step of your inputs the server has (an ack: stop re-sending up to it)
  b: number | null; // how early your newest input arrived (its step - k; < 0: late): the clock steers this to JITTER_STEPS
  r: [number, number, number] | null; // your race when it changed: laps done, the step your lap began, finish step (-1)
  n: number; // cars in it (every other car in the race), their ids in ids[0..n), their net states (dequantized) in net
  m: boolean; // your car's full state at k is in full (your prediction's hash didn't match, or there was none)
}
