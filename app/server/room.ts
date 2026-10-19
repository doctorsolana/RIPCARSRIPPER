import { createWriteStream, mkdirSync, type WriteStream } from 'node:fs';
import {
  MSG_SNAP, NET_FAR, NET_FIN, NET_IN, NET_LAPS, NET_LEN, quantizeNet, readInputs, Reader, writeCarDelta, writeFull, Writer,
} from '../src/drive/net/codec.ts';
import {
  COUNTDOWN, H, JITTER_STEPS, LOG_VERSION, MAX_AHEAD, MAX_PLAYERS, Q, SNAP_EVERY, STEER_SLEW, hashSnap, noViolations,
  type Phase, type PlayerInfo, type ResultRow, type S2C, type Violations,
} from '../src/drive/net/protocol.ts';
import { CORE_LENGTH, SNAP_LENGTH } from '../src/drive/vehicles/arcade.ts';
import { RaceSim, carName, loadSpec, type SimCar } from './sim.ts';
import { DATA_DIR, recordLap } from './store.ts';

// A room (by name): its players, the race flow - lobby (join with a car, take a grid slot, Ready) ->
// countdown (everyone ready: the gate drops for all at the same step) -> race (laps, finish order) -> results ->
// lobby - the input buffers and their plausibility checks, the 60 Hz binary snapshots (net/codec.ts: every other car's
// net state as the change since the last one, your own car's full state only when your prediction's hash missed),
// and the race's input log. Nothing allocated per step beyond the messages themselves. Every lap a signed-in player
// completes in a race goes to the store (store.ts: the weekly leaderboard), with whether the car touched another car
// during it or in the 3 s before it (sim.ts) - the log's lap lines carry the same flags, so a replay checks them. A
// solo room is a time trial: one wallet, no bots, not listed (index.ts).

const RING = 1024; // steps of inputs kept per player
const LOG_CHUNK = 16 * 1024; // chars of race log gathered before a write
const FULL_EVERY = Number(process.env.FULL_EVERY ?? 3) * SNAP_EVERY; // steps: a client mispredicting all the time (in a pack) is corrected 20 times a s
const FINISH_WAIT = 30 / H; // steps: after the first car finishes, the rest have this long
const RESULTS_TIME = 8 / H; // steps the results stay up before the next lobby
const RATE = 126; // new input steps per s a client may send (real time and a little: 5%) ...
const BURST = 60; // ... in bursts of up to this many (a stalled tab catching up)
// the race logs: server/logs/, or DATA_DIR/logs/ when DATA_DIR is set (a host's volume: they survive deploys)
const LOG_DIR = process.env.DATA_DIR ? `${DATA_DIR}/logs/` : new URL('./logs/', import.meta.url).pathname;
const BOT_CARS = ['chevy-impala-jkb99', 'roxy-porsche-hrv96', 'porsche-964-gdf88', 'pontiac-firebird-htf40', 'civic-type-r-hcy12',
  'mustang-cobra-r-hgk61', 'porsche-911-gt3-rs', 'beach-bomb-too-k3370', 'skyline-fyg14'];

export interface Player {
  id: number;
  /** The wallet the player signed in with (server/auth.ts; null: a bot). One car per wallet on the whole server
   *  (index.ts). Whether the wallet may race `car` is mayDrive's to say, at the join and at every car change. */
  wallet: string | null;
  name: string; // shown to everyone: the wallet's short form (shortWallet), or "Bot n" - set here, never by a client
  car: string;
  /** The page said its autopilot drives (?auto=1): its laps are stored but never make the leaderboard. */
  auto: boolean;
  send: ((m: S2C) => void) | null; // JSON; null: a bot
  sendBin: ((b: Uint8Array) => void) | null; // binary (a snapshot)
  ready: boolean;
  slot: number; // -1: waiting for the next race
  ping: number;
  viol: Violations;
  ring: Int32Array; // quantized inputs by step % RING
  ringK: Float64Array; // ... the step each slot holds
  newest: number; // the newest step accepted ...
  seen: number; // ... and received at all (late ones too: how early the client's inputs arrive, even when it's behind)
  tokens: number;
  tokenAt: number; // tick the bucket was last filled
  hashes: Map<number, number>; // predicted-state hashes the client reported, by step
  sim: SimCar | null;
  bytesOut: number;
  bytesIn: number;
  /** Which of each car's snapshots this client has (CarNet.ver): the next one is the change from it (or the car whole). */
  has: WeakMap<SimCar, number>;
  lastR: [number, number, number]; // ... and of its own race (laps, lap start, finish)
  lastRace: number;
  snaps: number; // snapshots sent ...
  fulls: number; // ... with the full state of its own car (a misprediction to correct) ...
  fullK: number; // ... the last one's tick (at most every other snapshot: FULL_EVERY) ...
  fullRef: Float64Array; // ... and its state (the next one is sent as the change from it)
}

let nextId = 1;
export const newPlayerId = () => nextId++;

// per-step scratch shared by every room (rooms step one after another)
const inBuf = new Int32Array(4 * 256), hashBuf = new Float64Array(2 * 64), netX = new Float64Array(NET_LEN), full = new Float64Array(SNAP_LENGTH);
const W = new Writer(), WC = new Writer(), ZERO = new Int32Array(NET_LEN);
/** A car's snapshots: its quantized net state now and at the last snapshot (version ver), and the change between them
 *  encoded once for every client (and the car whole from 0, for a client new to it: made when one needs it). */
interface CarNet { q: Int32Array; prev: Int32Array; ver: number; delta: Uint8Array; dn: number; whole: Uint8Array; wn: number }
const carNet = new WeakMap<SimCar, CarNet>();
function encodeInto(cn: CarNet, base: Int32Array, which: 'delta' | 'whole') {
  const w = WC.reset();
  writeCarDelta(w, cn.q, base, true);
  if (cn[which].length < w.pos) cn[which] = new Uint8Array(w.pos * 2);
  cn[which].set(w.view());
  if (which === 'delta') cn.dn = w.pos;
  else cn.wn = w.pos;
}

export class Room {
  /** The server is shutting down (index.ts, SIGTERM): no new race counts down. */
  static draining = false;
  readonly name: string;
  readonly sim: RaceSim;
  readonly players: Player[] = [];
  private byId = new Map<number, Player>();
  phase: Phase = 'lobby';
  min = 1;
  /** A time trial: its first wallet alone (no bots, no one else joins), not in the room list. */
  solo = false;
  race = 0; // race number (the snapshots carry it: the client ignores a state from another race)
  private phaseAt = 0; // tick the phase began
  private firstFinish = -1;
  private log: WriteStream | null = null;
  private logged = new Int32Array(0); // the last logged input of each car (4 ints per car, the race's car order)
  private logRow: number[] = [];
  logPath = '';
  /** Bench / tests: race with bots alone (no human needed to start or to keep the race going) ... */
  botsOnly = false;
  /** ... and players that don't report their prediction's hash (count it as matching: no full states). */
  assumeMatch = false;
  stepTime = { n: 0, sum: 0, max: 0 }; // microseconds per step (the room's sim, contact, laps, snapshots): since start ...
  stepWin = { n: 0, sum: 0, max: 0 }; // ... and since the last log line
  sendUs = 0; // (time spent handing snapshots to the sockets)
  simUs = 0; // (... in the sim: cars, contact, laps)
  private inputOf = (c: SimCar, out: [number, number, number, number]) => {
    const p = this.byId.get(c.key);
    if (!p) return false;
    const i = this.curK % RING;
    if (p.ringK[i] !== this.curK) return false;
    out[0] = p.ring[i * 4], out[1] = p.ring[i * 4 + 1], out[2] = p.ring[i * 4 + 2], out[3] = p.ring[i * 4 + 3];
    return true;
  };
  private curK = 0;
  private onLap = (c: SimCar, what: 'lap' | 'finish') => {
    const k = this.curK, time = c.lap.lapTimes[c.lap.lapTimes.length - 1];
    this.broadcast({ t: 'lap', id: c.key, lap: c.lap.laps, time });
    // (c, pc: the car touched another during the lap / in the 3 s before it began - replay.ts checks them)
    this.writeLog({ k, lap: this.sim.cars.indexOf(c), n: c.lap.laps, time, what, c: c.lapTouch ? 1 : 0, pc: c.preTouch ? 1 : 0 });
    if (what === 'finish' && this.firstFinish < 0) this.firstFinish = k;
    // a signed-in player's lap, while the race (and its log) runs: to the store
    const p = this.byId.get(c.key);
    if (p?.wallet && p.send && this.phase === 'race' && this.log) {
      recordLap({
        wallet: p.wallet, car: c.car, track: this.course, len: Math.round(this.sim.track.length), steps: time, lap: c.lap.laps, room: this.name,
        race: this.race, log: this.logPath, at: Date.now(), cars: this.sim.cars.length, contact: c.lapTouch, pre: c.preTouch, auto: p.auto,
      });
    }
  };

  constructor(name: string, course: string, laps: number) {
    this.name = name;
    this.sim = new RaceSim(course, laps);
  }
  get course() {
    return this.sim.course;
  }
  get laps() {
    return this.sim.laps;
  }
  get humans() {
    return this.players.filter((p) => p.send);
  }

  get max() {
    return this.solo ? 1 : MAX_PLAYERS;
  }
  async join(p: Pick<Player, 'id' | 'wallet' | 'name' | 'car' | 'send' | 'sendBin' | 'ready' | 'ping'> & { auto?: boolean }, tick: number): Promise<Player | null> {
    if (this.players.length >= this.max) return null;
    const pl: Player = {
      ...p, auto: !!p.auto, slot: -1, viol: noViolations(), ring: new Int32Array(RING * 4), ringK: new Float64Array(RING).fill(-1), newest: -1, seen: -1,
      tokens: BURST, tokenAt: tick, hashes: new Map(), sim: null, bytesOut: 0, bytesIn: 0, has: new WeakMap(), lastR: [-1, -1, -2], lastRace: -1,
      snaps: 0, fulls: 0, fullK: -1e9, fullRef: new Float64Array(CORE_LENGTH),
    };
    this.players.push(pl);
    this.byId.set(pl.id, pl);
    if (this.phase === 'lobby') await this.seat(pl);
    this.broadcastRoom();
    return pl;
  }
  async addBots(n: number, tick: number) {
    for (let i = 0; i < n && this.players.length < this.max && !this.solo; i++) {
      const bots = this.players.filter((p) => !p.send).length;
      await this.join({ id: newPlayerId(), wallet: null, name: `Bot ${bots + 1}`, car: BOT_CARS[bots % BOT_CARS.length], send: null, sendBin: null, ready: true, ping: 0 }, tick);
    }
  }
  /** The lowest free grid slot, and a car on it. */
  private async seat(p: Player) {
    const taken = new Set(this.players.map((q) => q.slot));
    let s = 0;
    while (taken.has(s)) s++;
    p.slot = s;
    p.sim = await this.sim.addCar(p.id, p.car, s, !p.send);
    if (!this.players.includes(p)) (this.sim.remove(p.id)), (p.sim = null); // left during the load
  }
  leave(p: Player, tick: number) {
    const i = this.players.indexOf(p);
    if (i < 0) return;
    this.players.splice(i, 1);
    this.byId.delete(p.id);
    if (p.sim) {
      if (this.phase === 'race' || this.phase === 'results') {
        p.sim.out = true; // (kept in the race's car list, which the log indexes; no longer stepped)
        if (p.send) this.leftViol.set(p.wallet ?? p.name, { ...p.viol });
        this.writeLog({ k: tick, out: this.sim.cars.indexOf(p.sim) });
      } else this.sim.remove(p.id);
    }
    if (!this.humans.length) this.endLog(tick, 'empty');
    this.broadcastRoom();
  }
  setReady(p: Player, on: boolean) {
    p.ready = on;
    this.broadcastRoom();
  }
  /** Another car: in the lobby its car on the grid is swapped at once (and the player isn't ready any more, so no
   *  countdown starts under the swap); during a race or its results, back in the lobby (toLobby). */
  setCar(p: Player, car: string) {
    if (p.car === car) return;
    p.car = car;
    p.ready = false;
    this.swaps = this.swaps.then(() => this.reseat(p));
    this.broadcastRoom();
  }
  private swaps: Promise<void> = Promise.resolve();
  private async reseat(p: Player) {
    if (this.phase !== 'lobby' || !p.sim || p.sim.car === p.car || p.slot < 0) return;
    this.sim.remove(p.id);
    p.sim = await this.sim.addCar(p.id, p.car, p.slot, !p.send);
    if (!this.players.includes(p)) this.sim.remove(p.id); // left during the load
    this.broadcastRoom();
  }
  /** The host: the room's first human. */
  get host() {
    return this.humans[0]?.id ?? -1;
  }

  // ---- inputs (binary, net/codec.ts): the plausibility checks. Each step's input is checked once, as it first arrives.
  onInputs(p: Player, data: Uint8Array, tick: number) {
    const v = p.viol;
    const m = readInputs(new Reader(data), inBuf, hashBuf);
    if (!m || m.n > 64) {
      v.format++;
      return;
    }
    // refill the rate bucket: RATE steps per s of real (server) time
    p.tokens = Math.min(BURST, p.tokens + (tick - p.tokenAt) * H * RATE);
    p.tokenAt = tick;
    const last = m.k + m.n - 1;
    if (last <= tick + MAX_AHEAD && last > p.seen) p.seen = last;
    for (let j = 0; j < m.n; j++) {
      const k: number = m.k + j, o = j * 4;
      if (k <= p.newest && p.ringK[k % RING] === k) continue; // already have it (a re-send)
      if (k < tick) {
        if (k > p.newest - RING) v.late++;
        continue;
      }
      if (k > tick + MAX_AHEAD) {
        v.future++;
        continue;
      }
      if (p.tokens < 1) {
        v.rate++;
        continue;
      }
      p.tokens--;
      let st = inBuf[o], th = inBuf[o + 1], br = inBuf[o + 2], dr = inBuf[o + 3];
      if (st < -Q || st > Q || th < 0 || th > Q || br < 0 || br > Q || (dr !== 0 && dr !== 1)) {
        v.range++;
        st = Math.max(-Q, Math.min(Q, st));
        th = Math.max(0, Math.min(Q, th));
        br = Math.max(0, Math.min(Q, br));
        dr = dr ? 1 : 0;
      }
      // the steering can't move faster than the game's own key / pad smoothing (against the step before, if we have it)
      const pk = (k - 1) % RING;
      if (k > 0 && p.ringK[pk] === k - 1) {
        const prev = p.ring[pk * 4];
        if (Math.abs(st - prev) > STEER_SLEW) {
          v.slew++;
          st = prev + Math.sign(st - prev) * STEER_SLEW;
        }
      }
      const r = (k % RING) * 4;
      p.ring[r] = st, p.ring[r + 1] = th, p.ring[r + 2] = br, p.ring[r + 3] = dr;
      p.ringK[k % RING] = k;
      if (k > p.newest) p.newest = k;
    }
    if (p.hashes.size < 256) for (let j = 0; j < Math.min(m.nh, 32); j++) if (hashBuf[j * 2] >= tick) p.hashes.set(hashBuf[j * 2], hashBuf[j * 2 + 1] >>> 0);
  }

  // ---- the race flow and the sim, once per step (tick k -> k + 1)
  step(k: number) {
    const t0 = performance.now();
    if (this.phase === 'lobby') {
      let n = 0, all = true;
      for (const p of this.players) if ((this.botsOnly || p.send) && p.slot >= 0) (n++), (all &&= p.ready);
      if (n >= Math.max(1, this.min) && all && !Room.draining) this.countdown(k);
    } else if (this.phase === 'countdown' && k >= this.sim.go) {
      this.setPhase('race', k);
    }
    if ((this.phase === 'race' || this.phase === 'results') && k >= this.sim.go) {
      this.curK = k;
      const t1 = performance.now();
      this.sim.step(k, this.inputOf, this.onLap);
      this.simUs += (performance.now() - t1) * 1000;
      // the log: each car's applied input, when it changes
      const cars = this.sim.cars, row = this.logRow;
      if (this.logged.length < cars.length * 4) {
        const l = new Int32Array(cars.length * 4).fill(-9999);
        l.set(this.logged);
        this.logged = l;
      }
      row.length = 0;
      for (let i = 0; i < cars.length; i++) {
        const c = cars[i], q = c.last, o = i * 4, l = this.logged;
        if (c.out || (l[o] === q[0] && l[o + 1] === q[1] && l[o + 2] === q[2] && l[o + 3] === q[3])) continue;
        row.push(i, q[0], q[1], q[2], q[3]);
        l[o] = q[0], l[o + 1] = q[1], l[o + 2] = q[2], l[o + 3] = q[3];
      }
      if (row.length && this.log) this.logBuf += `{"k":${k},"in":[${row.join(',')}]}\n`;
      if (this.logBuf.length > LOG_CHUNK) this.flushLog();
      if (this.phase === 'race') {
        let racing = 0, done = true, someone = false;
        for (const c of cars) if (!c.out) (racing++), (done &&= c.lap.finish >= 0);
        for (const p of this.players) if ((p.send || this.botsOnly) && p.sim && !p.sim.out) someone = true;
        if (!racing || !someone) this.toLobby(k + 1);
        else if (done || (this.firstFinish >= 0 && k + 1 - this.firstFinish >= FINISH_WAIT)) this.finish(k + 1);
      }
    }
    // the results stay up RESULTS_TIME, or until every human has asked for the next race (Race again, then Ready)
    if (this.phase === 'results') {
      let all = true;
      for (const p of this.players) if (p.send && !p.ready) all = false;
      if (k + 1 - this.phaseAt >= RESULTS_TIME || all) this.toLobby(k + 1);
    }
    if ((k + 1) % SNAP_EVERY === 0) this.snapshot(k + 1);
    const us = (performance.now() - t0) * 1000, a = this.stepTime, b = this.stepWin;
    a.n++, a.sum += us, b.n++, b.sum += us;
    if (us > a.max) a.max = us;
    if (us > b.max) b.max = us;
  }

  private setPhase(ph: Phase, k: number) {
    this.phase = ph;
    this.phaseAt = k;
    this.broadcastRoom();
  }
  private countdown(k: number) {
    this.race++;
    this.firstFinish = -1;
    // everyone races un-readied: Ready again (from the results card on) asks for the next race
    for (const p of this.players) if (p.send) p.ready = false;
    const go = k + Math.round(COUNTDOWN / H);
    this.sim.start(go);
    this.logged = new Int32Array(this.sim.cars.length * 4).fill(-9999);
    this.openLog(k);
    this.setPhase('countdown', k);
  }
  private finish(k: number) {
    const rows = this.results();
    this.endLog(k, 'finished', rows);
    this.broadcast({ t: 'results', race: this.race, rows });
    this.setPhase('results', k);
  }
  results(): ResultRow[] {
    const names = new Map(this.players.map((p) => [p.id, p.name]));
    return this.sim.results((c) => names.get(c.key) ?? `#${c.key}`);
  }
  private async toLobbyAsync(k: number) {
    // the cars of players who left go; those waiting get a slot; everyone back on the grid, not ready (bots are)
    for (const c of [...this.sim.cars]) if (c.out) this.sim.remove(c.key);
    this.sim.go = -1;
    for (const c of this.sim.cars) this.sim.place(c);
    for (const p of this.players) if (p.slot < 0) await this.seat(p);
    for (const p of this.players) if (p.sim && p.sim.car !== p.car) await this.reseat(p); // a car picked between races
    this.endLog(k, 'aborted');
    this.setPhase('lobby', k);
  }
  private toLobby(k: number) {
    this.phase = 'lobby'; // (at once: the seats are async)
    void this.toLobbyAsync(k);
  }

  // ---- snapshots (60 Hz, binary): every other car's net state (the change since the last one this client got), and
  // the client's own car's full state when its prediction missed
  private snapshot(k: number) {
    const racing = (this.phase === 'race' || this.phase === 'results') && k > this.sim.go;
    // each car's quantized net state, once (with the input it's on: the newest its player has sent), and its change
    // since the last snapshot, encoded once for everyone
    for (const c of this.sim.cars) {
      if (c.out) continue;
      let cn = carNet.get(c);
      if (!cn) carNet.set(c, (cn = { q: new Int32Array(NET_LEN), prev: new Int32Array(NET_LEN), ver: 0, delta: new Uint8Array(64), dn: 0, whole: new Uint8Array(128), wn: -1 }));
      c.veh.netState!(netX);
      const p = this.byId.get(c.key);
      const i = p && p.newest >= k ? p.newest % RING : -1;
      if (p && i >= 0 && p.ringK[i] === p.newest) for (let j = 0; j < 4; j++) netX[NET_IN + j] = p.ring[i * 4 + j];
      else for (let j = 0; j < 4; j++) netX[NET_IN + j] = c.last[j];
      netX[NET_LAPS] = c.lap.laps;
      netX[NET_FAR] = c.lap.far ? 1 : 0;
      netX[NET_FIN] = c.lap.finish;
      quantizeNet(netX, cn.q);
      encodeInto(cn, cn.prev, 'delta');
      cn.wn = -1;
    }
    for (const p of this.players) {
      if (!p.sendBin) continue;
      const w = W.reset();
      w.u8(MSG_SNAP);
      w.u32(k);
      w.u16(this.race & 0xffff);
      // your race (when it changed) and your full state (when your prediction's hash missed)
      const own = p.sim && !p.sim.out ? p.sim : null;
      let r = false, m = false, ok = false;
      if (own && (own.lap.laps !== p.lastR[0] || own.lap.lapStart !== p.lastR[1] || own.lap.finish !== p.lastR[2] || p.lastRace !== this.race)) r = true;
      if (own && racing) {
        // (a client mispredicting all the time - in a pack - is corrected at most every FULL_EVERY steps; in between
        // it's told only whether its state was right)
        const theirs = p.hashes.get(k);
        if (theirs !== undefined || !this.assumeMatch) {
          own.veh.snapshotInto!(full);
          if (theirs !== undefined && theirs === hashSnap(full)) ok = true;
          else m = k - p.fullK >= FULL_EVERY;
        }
      }
      const hasB = p.seen >= 0;
      w.u8((hasB ? 1 : 0) | (r ? 2 : 0) | (m ? 4 : 0) | (ok ? 8 : 0));
      w.zv(p.newest - k);
      if (hasB) w.zv(Math.max(-1e6, p.seen - k));
      if (r && own) {
        w.uv(own.lap.laps);
        w.zv(own.lap.lapStart - k);
        w.zv(own.lap.finish);
        p.lastR[0] = own.lap.laps, p.lastR[1] = own.lap.lapStart, p.lastR[2] = own.lap.finish;
        p.lastRace = this.race;
      }
      // every other car, as the change from its last snapshot (which this client has), or whole
      let n = 0;
      for (const c of this.sim.cars) if (!c.out && c !== own) n++;
      w.u8(n);
      for (const c of this.sim.cars) {
        if (c.out || c === own) continue;
        const cn = carNet.get(c)!;
        w.uv(c.key);
        if (p.has.get(c) === cn.ver) {
          w.u8(0);
          w.bytes(cn.delta, cn.dn);
        } else {
          if (cn.wn < 0) encodeInto(cn, ZERO, 'whole');
          w.u8(1);
          w.bytes(cn.whole, cn.wn);
        }
        p.has.set(c, cn.ver + 1);
      }
      if (m) {
        writeFull(w, full.subarray(0, CORE_LENGTH), p.fullRef);
        p.fulls++;
        p.fullK = k;
      }
      if (p.hashes.size) for (const key of p.hashes.keys()) if (key <= k) p.hashes.delete(key);
      p.snaps++;
      const t1 = performance.now();
      p.sendBin(w.view());
      this.sendUs += (performance.now() - t1) * 1000;
    }
    for (const c of this.sim.cars) {
      const cn = c.out ? null : carNet.get(c);
      if (cn) cn.prev.set(cn.q), cn.ver++;
    }
  }

  info(): PlayerInfo[] {
    return this.players.map((p) => {
      const v = p.viol;
      return { id: p.id, name: p.name, wallet: p.wallet, car: p.car, carName: carName(p.car), ready: p.ready, bot: !p.send, slot: p.slot, ping: p.ping, viol: v.format + v.range + v.slew + v.future + v.rate };
    });
  }
  broadcastRoom() {
    const n = Math.max(8, ...this.players.map((p) => p.slot + 1));
    this.broadcast({
      t: 'room', phase: this.phase, players: this.info(), go: this.sim.go, laps: this.laps, track: this.course, min: this.min, host: this.host,
      grid: this.sim.grid(n), race: this.race,
    });
  }
  broadcast(m: S2C) {
    for (const p of this.players) p.send?.(m);
  }

  // ---- the race's input log: a header (course, laps, the start step, the cars on their slots with their players'
  // wallets), each step's changed inputs, laps, leaves, and the end (results, contact counts and a hash of every car's
  // state) - replay.ts re-simulates it exactly, every collision included.
  private openLog(k: number) {
    this.endLog(k, 'restart');
    this.leftViol.clear();
    const dir = `${LOG_DIR}${this.name.replace(/[^a-z0-9_-]/gi, '_').slice(0, 32) || 'room'}/`;
    mkdirSync(dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.logPath = `${dir}${stamp}-race${this.race}.jsonl`;
    this.log = createWriteStream(this.logPath);
    this.raceContact = { ...this.sim.contact };
    this.writeLog({
      t: 'head', v: LOG_VERSION, room: this.name, course: this.course, laps: this.laps, go: this.sim.go, at: k,
      cars: this.sim.cars.map((c) => {
        const p = this.players.find((q) => q.id === c.key);
        return { id: c.key, name: p?.name ?? '', wallet: p?.wallet ?? null, car: c.car, slot: c.slot, bot: !!c.bot, carName: carName(c.car) };
      }),
    });
  }
  private leftViol = new Map<string, Violations>();
  private raceContact = { pairs: 0, touches: 0, hits: 0, maxDepth: 0, maxVn: 0 };
  /** This race's contact counts (the room's since it opened, less those before the race). */
  raceContacts() {
    const a = this.sim.contact, b = this.raceContact;
    return { pairs: a.pairs - b.pairs, touches: a.touches - b.touches, hits: a.hits - b.hits };
  }
  // (the lines gather here and go to the file in chunks of LOG_CHUNK: one write a second or so, not one per step)
  private logBuf = '';
  private writeLog(o: object) {
    if (this.log) this.logBuf += JSON.stringify(o) + '\n';
  }
  private flushLog() {
    if (this.log && this.logBuf) this.log.write(this.logBuf);
    this.logBuf = '';
  }
  private endLog(k: number, why: string, rows?: ResultRow[]) {
    if (!this.log) return;
    const viol: Record<string, Violations> = {};
    for (const p of this.players) if (p.send) viol[p.wallet ?? p.name] = p.viol;
    for (const [w, v] of this.leftViol) viol[w] ??= v; // (and those who left mid-race: their late inputs too)
    this.leftViol.clear();
    this.writeLog({ t: 'end', k, why, results: rows ?? this.results(), hash: this.sim.hash(), viol, contact: this.raceContacts() });
    this.flushLog();
    this.log.end();
    this.log = null;
  }
  close(k: number) {
    this.endLog(k, 'closed');
  }
}

export const validCar = (id: string) => !!loadSpec(id);
/** Whether a wallet may race this car: any car the game has, for now. Later the car must be one of the wallet's Rip
 *  Cars (an asset of the collection it holds, its 'Toy #' the car's product code): that check goes here - the join and
 *  every car change ask it. */
export const mayDrive = (_wallet: string | null, car: string) => validCar(car);
export { JITTER_STEPS };
