import * as THREE from 'three';
import type { CarSpec, DriveInput, Track, Vehicle } from '../types';
import { CORE_LENGTH, SNAP_LENGTH } from '../vehicles/arcade.ts';
import { MSG_SNAP, readFull, Reader, writeInputs, Writer } from './codec.ts';
import { H, hashSnap, IDLE_Q, JITTER_STEPS, quantize, RESEND, SNAP_EVERY, type Phase, type PlayerInfo, type QInput, type S2C } from './protocol.ts';
import { World, type WorldCar } from './world.ts';

// The drive page's side of online play, without the page (net/online.ts draws it, plays it, shows the room): the
// room as the server tells it, the clock (this client's step counter runs ahead of the server's so its inputs arrive
// JITTER_STEPS early), your inputs (quantized as the server will apply them, sent with the unacknowledged ones and
// the hashes of your predicted states: net/codec.ts), and the predicted world (net/world.ts) - every car stepped in
// your timeline, rewound to each snapshot and replayed to now. A correction keeps what's on screen where it was: the
// difference goes into each car's visual error (WorldCar.off / qOff), which the page lets decay; a respawn-sized one
// snaps. No DOM in here: tests drive it headless.

const RING = 1024;
const SNAP_DIST = 6; // u: a correction bigger than this (a respawn) snaps instead
const MAX_MARGIN = 8; // steps (67 ms): the most lead the clock adds for a jittery link

type Room = Extract<S2C, { t: 'room' }>;

export class NetClient {
  // ---- the room as the server tells it
  me = -1;
  phase: Phase = 'lobby';
  players: PlayerInfo[] = [];
  grid: { s: number; d: number }[] = [];
  go = -1;
  raceNo = 0;
  mySlot = -1;
  inRace = false;
  /** Your race: laps done, the step your lap began, your finish step (-1). */
  lap: [number, number, number] = [0, 0, -1];
  rtt = 0;
  // ---- the clock: cs is your step (the server's numbering, ahead of it)
  cs: number | null = null;
  hold = 0;
  extra = 0;
  private settleUntil = 0;
  private bHist: { at: number; b: number }[] = [];
  private bSort = new Float64Array(1024);
  /** Extra steps of lead on top of JITTER_STEPS, learnt from late inputs (steerClock). */
  margin = 0;
  private marginAt = 0;
  private lateAt = 0;
  // ---- your inputs and predicted states by step; the states whose hash was sent (exact: the server's when it matches)
  private ring = new Int32Array(RING * 4);
  private ringK = new Float64Array(RING).fill(-1);
  private snaps: Float64Array[] = Array.from({ length: RING }, () => new Float64Array(SNAP_LENGTH));
  private snapK = new Float64Array(RING).fill(-1);
  private hashes = new Uint32Array(RING);
  private sent: Float64Array[] = Array.from({ length: RING / SNAP_EVERY }, () => new Float64Array(SNAP_LENGTH));
  private sentK = new Float64Array(RING / SNAP_EVERY).fill(-1);
  private hashTo = -1; // hashes sent up to this step
  ack = -1;
  lastQ: QInput = [0, 0, 0, 0];
  private qtmp: QInput = [0, 0, 0, 0];
  /** The last input you drove on (the page's audio reads it). */
  input: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };
  // ---- the world
  readonly world: World;
  own: WorldCar | null = null;
  veh: Vehicle;
  private car: string;
  private present = new Set<number>(); // the cars in the last snapshot
  private hitAt = -1e9; // your last car hit's step (a hit found only in a replay plays late, unless one played just now)
  private full = new Float64Array(CORE_LENGTH); // your car's exact state when the server sends it ...
  private fullRef = new Float64Array(CORE_LENGTH); // ... as the change from the last one
  private w = new Writer();
  private inScratch = new Int32Array(4 * 64);
  private hsScratch = new Float64Array(2 * 64);
  private qb = new THREE.Quaternion();
  private dqt = new THREE.Quaternion();
  private dv = new THREE.Vector3();
  private send: (d: string | Uint8Array, droppable: boolean) => void;
  private raw: boolean;
  readonly stats = {
    corr: [] as number[], // your car's visual error a correction left (u), before smoothing
    rcorr: [] as number[], // ... the other cars'
    mis: [] as number[], // your prediction's error at the snapshot's step (u), when the server sent your state
    reconciles: 0, rollbacks: 0, replayed: 0, holds: 0, jumps: 0, snaps: 0, fulls: 0, lateHits: 0, snapped: 0,
    lead: 0, margin: 0, b: [] as number[], snapBytes: 0, extraSteps: 0, holdSteps: 0,
  };

  constructor(o: { track: Track; specOf: (car: string) => Promise<CarSpec>; vehicle: Vehicle; car: string; send: (d: string | Uint8Array, droppable: boolean) => void; raw?: boolean }) {
    this.world = new World(o.track, o.specOf);
    this.veh = o.vehicle;
    this.car = o.car;
    this.send = o.send;
    this.raw = !!o.raw;
  }

  /** The race is on (the clock past the start): the world steps. */
  raceOn() {
    return this.go >= 0 && this.cs !== null && this.cs >= this.go && (this.phase === 'race' || this.phase === 'results' || this.phase === 'countdown');
  }
  /** ... and you're in it. */
  racing() {
    return this.inRace && this.raceOn();
  }

  /** Your car's vehicle (at the start, and after a car swap in the lobby). */
  setVehicle(veh: Vehicle, car: string) {
    this.veh = veh;
    this.car = car;
    if (this.me >= 0) this.own = this.world.setOwn(this.me, car, this.mySlot, veh);
  }

  // ---- the JSON messages the client needs (the page shows the rest)
  onWelcome(m: Extract<S2C, { t: 'welcome' }>) {
    this.me = m.you;
    this.own = this.world.setOwn(this.me, this.car, this.mySlot, this.veh);
    this.cs = m.tick + Math.ceil(this.rtt / 2 / 1000 / H) + JITTER_STEPS + 4;
    this.syncPlayers();
  }
  onPong(m: Extract<S2C, { t: 'P' }>, now: number) {
    this.rtt = now - m.c;
  }
  /** The room: returns 'race' when a new race's countdown began (your car is on the grid), 'lobby' when it's back. */
  onRoom(m: Room): 'race' | 'lobby' | null {
    const was = this.phase, wasRace = this.raceNo;
    this.phase = m.phase;
    this.players = m.players;
    this.grid = m.grid;
    const mine = this.players.find((p) => p.id === this.me);
    let out: 'race' | 'lobby' | null = null;
    if (this.phase === 'countdown' && (was !== 'countdown' || wasRace !== m.race)) {
      this.go = m.go;
      this.raceNo = m.race;
      this.mySlot = mine?.slot ?? -1;
      this.inRace = this.mySlot >= 0;
      this.placeOnGrid();
      out = 'race';
    } else if (this.phase === 'lobby') {
      this.go = -1;
      this.inRace = false;
      this.mySlot = mine?.slot ?? -1;
      this.placeOnGrid();
      out = 'lobby';
    }
    this.syncPlayers();
    return out;
  }
  /** Every other player with a grid slot has a car in the world (in slot order: the server's); yours too. */
  private syncPlayers() {
    if (this.me < 0) return;
    for (const p of this.players) if (p.id !== this.me && p.slot >= 0) this.world.remote(p.id, p.car, p.slot);
    for (const c of [...this.world.cars]) if (!c.own && !this.players.some((p) => p.id === c.id && p.slot >= 0)) this.world.remove(c.id);
    this.own = this.world.setOwn(this.me, this.car, this.mySlot, this.veh);
  }
  /** Your car on your grid slot, at rest. */
  placeOnGrid() {
    const g = this.grid[this.mySlot] ?? { s: this.world.track.start, d: 0 };
    this.veh.reset(g.s, g.d);
    const e = this.veh.state.events as Record<string, unknown>;
    for (const k in e) e[k] = undefined;
    this.lap = [0, this.go, -1];
    if (this.own) {
      this.own.prevP.copy(this.veh.state.position);
      this.own.prevQ.copy(this.veh.state.quaternion);
      this.own.off.set(0, 0, 0);
      this.own.qOff.identity();
    }
  }

  // ---- snapshots (binary). `apply` false: a snapshot the page's simulated network "lost" - read (the next one is a
  // change from it) but not acted on.
  onSnapshot(buf: Uint8Array, apply: boolean, now: number) {
    // a rewind still waiting carries your corrected state (the server's full one): do it now, before this snapshot's
    // cars overwrite the ones it rewinds to (a plain one is just superseded by this newer one)
    if (this.pending?.m) this.settle();
    const r = new Reader(buf);
    if (r.u8() !== MSG_SNAP) return;
    const k = r.u32(), race = r.u16(), flags = r.u8();
    const a = k + r.zv();
    const b = flags & 1 ? r.zv() : null;
    let lapR: [number, number, number] | null = null;
    if (flags & 2) {
      const laps = r.uv(), ls = k + r.zv(), fin = r.zv();
      lapR = [laps, ls, fin];
    }
    const n = r.u8();
    this.present.clear();
    for (let i = 0; i < n; i++) {
      const id = r.uv(), cf = r.u8();
      this.world.readCar(r, id, (cf & 1) !== 0, k);
      this.present.add(id);
    }
    const m = (flags & 4) !== 0, ok = (flags & 8) !== 0;
    if (m) readFull(r, this.full, this.fullRef);
    this.stats.snapBytes += buf.length;
    if (!apply) return;
    this.stats.snaps++;
    if (m) this.stats.fulls++;
    this.ack = Math.max(this.ack, a);
    // behind the server itself (a stall, or a clock set before the server caught up): every input would be late
    // (the steps already owed count: several snapshots read after a stalled frame must not each add the jump)
    const cs = this.cs === null ? null : this.cs + this.extra;
    if (cs !== null && cs <= k + Math.ceil(this.rtt / 2000 / H)) {
      const need = k + Math.ceil(this.rtt / 2000 / H) + JITTER_STEPS + 2 - cs;
      if (this.raceOn()) this.extra += need;
      else this.cs! += need;
      this.stats.jumps++;
      this.bHist.length = 0;
    }
    if (b !== null) {
      // your input for a step the server had already run (it repeated your last one): ask for more lead
      if (b < 0 && this.racing()) this.lateAt = now;
      this.bHist.push({ at: now, b });
      this.stats.b.push(b);
      if (this.stats.b.length > 4000) this.stats.b.splice(0, 2000);
    }
    if (lapR && race === this.raceNo) this.lap = lapR;
    if (this.own) this.own.finish = this.lap[2];
    this.updateActive();
    // the rewind waits for the next step or frame (settle): snapshots that come in a burst - after a stall on the
    // way - cost one rewind and replay, not one each
    if (race === this.raceNo && this.raceOn() && this.cs !== null && k >= this.go && k <= this.cs) this.pending = { k, m, ok };
    else if (!this.raceOn()) {
      // not racing: the others stand where the server says (the grid)
      for (const c of this.world.cars) {
        if (c.own || !c.veh || !c.has) continue;
        c.veh.restoreNet!(c.net);
        c.prevP.copy(c.veh.state.position);
        c.prevQ.copy(c.veh.state.quaternion);
        c.off.set(0, 0, 0);
        c.qOff.identity();
      }
    }
  }

  private pending: { k: number; m: boolean; ok: boolean } | null = null;
  /** The newest snapshot's rewind, if one waits (stepOnce and the page's frame call it). */
  settle() {
    const p = this.pending;
    if (!p) return;
    this.pending = null;
    if (this.cs !== null && p.k <= this.cs && this.raceOn()) this.rewind(p.k, p.m, p.ok);
  }

  /** Who steps: your car when you're racing, every other car in the race once its state and vehicle are here. */
  private updateActive() {
    const on = this.raceOn();
    for (const c of this.world.cars) c.active = c.own ? this.racing() : on && c.has && !!c.veh && this.present.has(c.id);
  }

  /** The world back to the server's tick k and forward to now (your state there: the server's when it sent it - your
   *  prediction missed - else your own the server confirmed); each car's visual error takes up the correction. */
  private rewind(k: number, m: boolean, ok: boolean) {
    const cs = this.cs!, w = this.world, st = this.stats;
    st.rollbacks++;
    for (const c of w.cars) {
      if (!c.active || !c.veh) continue;
      c.pb.copy(c.veh.state.position);
      c.qb.copy(c.veh.state.quaternion);
    }
    // your state at k
    let ownState: Float64Array | null = null;
    const i = k % RING, si = (k / SNAP_EVERY) % this.sentK.length;
    if (m) {
      ownState = this.full;
      st.reconciles++;
      if (this.snapK[i] === k) {
        const mine = this.snaps[i];
        this.dv.set(mine[1] - this.full[1], mine[2] - this.full[2], 0); // (s, d)
        st.mis.push(this.dv.length());
      }
    } else if (ok && this.sentK[si] === k) ownState = this.sent[si]; // (the one the server confirmed: exact)
    else if (this.snapK[i] === k) ownState = this.snaps[i]; // (else your best guess there)
    const own = this.own;
    const ownWas = own?.active ?? false;
    if (own && own.active && !ownState) own.active = false; // (nothing to rewind it to: it carries on as it is)
    // the replay's events are what already played (yours kept as they were; a hit only the replay found plays late)
    const ev = this.veh.state.events, ev0 = { ...ev };
    for (const key in ev) (ev as Record<string, unknown>)[key] = undefined;
    w.rollback(k, cs, ownState, (j) => this.inputAt(j), (j) => {
      if (own?.active) this.keepSnap(j + 1);
      st.replayed++;
    });
    const late = ev.carHit !== undefined && cs - this.hitAt > 24 ? { carHit: ev.carHit, spinOut: ev.spinOut } : null;
    for (const key in ev) (ev as Record<string, unknown>)[key] = undefined;
    Object.assign(ev, ev0);
    if (late) {
      ev.carHit = Math.max(ev.carHit ?? 0, late.carHit!);
      if (late.spinOut) ev.spinOut = true;
      this.hitAt = cs;
      st.lateHits++;
    }
    if (own) own.active = ownWas;
    for (const c of w.cars) {
      if (!c.veh) continue;
      if (!c.own) {
        const e = c.veh.state.events as Record<string, unknown>;
        for (const key in e) e[key] = undefined;
      }
      if (!c.active) continue;
      const p = c.veh.state.position, q = c.veh.state.quaternion;
      const err = c.pb.distanceTo(p);
      if (err > SNAP_DIST) st.snapped++; // (a respawn the prediction didn't see: a jump, not an error to smooth)
      else (c.own ? st.corr : st.rcorr).push(err);
      if (err > SNAP_DIST) {
        c.off.set(0, 0, 0);
        c.qOff.identity();
        c.prevP.copy(p);
        c.prevQ.copy(q);
        continue;
      }
      // keep what's on screen where it was: the render's last pose moves with the correction, the offset carries it
      this.dv.subVectors(p, c.pb);
      c.prevP.add(this.dv);
      c.off.sub(this.dv);
      this.dqt.copy(q).multiply(this.qb.copy(c.qb).invert());
      c.prevQ.premultiply(this.dqt);
      c.qOff.multiply(this.dqt.invert());
    }
    if (st.corr.length > 20000) st.corr.splice(0, 10000);
    if (st.rcorr.length > 40000) st.rcorr.splice(0, 20000);
  }

  private inputAt(k: number): QInput {
    const i = k % RING;
    if (this.ringK[i] !== k) return this.lastQ;
    const q = this.qtmp;
    q[0] = this.ring[i * 4], q[1] = this.ring[i * 4 + 1], q[2] = this.ring[i * 4 + 2], q[3] = this.ring[i * 4 + 3];
    return q;
  }
  private keepSnap(k: number) {
    const i = k % RING;
    this.veh.snapshotInto!(this.snaps[i]);
    this.snapK[i] = k;
    this.hashes[i] = hashSnap(this.snaps[i]);
  }

  /** One step of yours: the input (`read`: the page's - keys, pad, touch or the autopilot; null when not racing),
   *  quantized as the server will apply it, kept, and the world stepped on it. */
  stepOnce(read: (racing: boolean) => DriveInput) {
    this.settle();
    if (this.cs === null) return void read(false);
    if (this.hold > 0) {
      this.hold--;
      this.stats.holds++;
      return;
    }
    const k = this.cs;
    const race = this.racing();
    const raw = read(race);
    const qi = race ? quantize(raw, this.lastQ, this.raw) : IDLE_Q;
    const i = k % RING;
    this.ring[i * 4] = qi[0], this.ring[i * 4 + 1] = qi[1], this.ring[i * 4 + 2] = qi[2], this.ring[i * 4 + 3] = qi[3];
    this.ringK[i] = k;
    this.lastQ = qi;
    if (this.raceOn()) {
      this.updateActive();
      if (race) {
        this.input.steer = qi[0] / 1000, this.input.throttle = qi[1] / 1000, this.input.brake = qi[2] / 1000, this.input.drift = qi[3] !== 0;
      }
      this.world.step(k, qi);
      if (this.veh.state.events.carHit !== undefined) this.hitAt = k;
    }
    this.cs = k + 1;
    if (race) this.keepSnap(this.cs);
  }

  /** Inputs since the server's ack (the last RESEND steps at most), and the hashes of your predicted states at the
   *  snapshot steps not reported yet (each once). */
  flush() {
    const cs = this.cs;
    if (cs === null) return;
    const from = Math.max(this.ack + 1, cs - RESEND);
    if (from >= cs) return;
    const n = cs - from, inp = this.inScratch;
    for (let j = 0; j < n; j++) {
      const q = this.inputAt(from + j);
      inp[j * 4] = q[0], inp[j * 4 + 1] = q[1], inp[j * 4 + 2] = q[2], inp[j * 4 + 3] = q[3];
    }
    let nh = 0;
    const h0 = Math.max(this.hashTo + 1, from + 1);
    for (let k = h0 + ((SNAP_EVERY - (h0 % SNAP_EVERY)) % SNAP_EVERY); k <= cs && nh < 32; k += SNAP_EVERY) {
      const i = k % RING;
      if (this.snapK[i] !== k || k <= this.go) continue;
      this.hsScratch[nh * 2] = k;
      this.hsScratch[nh * 2 + 1] = this.hashes[i];
      const si = (k / SNAP_EVERY) % this.sentK.length;
      this.sent[si].set(this.snaps[i]);
      this.sentK[si] = k;
      nh++;
    }
    this.hashTo = cs;
    const w = this.w.reset();
    writeInputs(w, from, inp, 0, n, this.hsScratch, nh);
    this.send(w.view().slice(), true);
  }

  /** The clock: keep your inputs arriving JITTER_STEPS + margin early. Returns the sim's speed against real time.
   *  How early they arrive is the low end of the last 4 s (its 5th percentile: one stall on the way - a lost packet TCP
   *  re-sends - is a blip to ride out, not a new lag to jump to); the margin grows a step each time an input still
   *  arrives late (up to MAX_MARGIN) and shrinks a step after a calm 10 s. Racing, the clock only ever speeds up or
   *  slows down a little (your car never stops or leaps): a jump only for a lag far off what it is steering to. Not
   *  racing yet, it just moves. */
  steerClock(now: number): number {
    const bh = this.bHist;
    while (bh.length && bh[0].at < now - 4000) bh.shift();
    if (this.lateAt > this.marginAt + 1500 && this.margin < MAX_MARGIN) (this.margin++), (this.marginAt = now);
    else if (this.margin > 0 && now - Math.max(this.lateAt, this.marginAt) > 10000) (this.margin--), (this.marginAt = now);
    if (this.cs === null || bh.length < 6 || now < this.settleUntil) return 1;
    const sc = this.bSort, nb = Math.min(bh.length, sc.length);
    for (let i = 0; i < nb; i++) sc[i] = bh[bh.length - nb + i].b;
    const lo = sc.subarray(0, nb).sort()[Math.floor(nb * 0.05)];
    const target = JITTER_STEPS + this.margin;
    const err = lo - target;
    this.stats.lead = err;
    this.stats.margin = this.margin;
    if (Math.abs(err) > 2 && !this.raceOn() && !(this.go >= 0 && this.cs - err >= this.go)) {
      this.cs -= err; // not driving yet: just move the clock
      this.stats.jumps++;
    } else if (err < -12) {
      this.extra += -err; // far behind (the lag went up for good): catch up now
      this.stats.jumps++;
    } else if (err > 60 && !this.racing()) {
      this.hold += err - 4; // far too early, not driving: wait
      this.stats.jumps++;
    } else {
      // (asymmetric: a late input costs a correction, an early one only a few ms of latency)
      return err < 0 ? 1 + Math.min(0.06, -err * 0.01) : err > 2 ? 1 - Math.min(0.05, (err - 2) * 0.004) : 1;
    }
    bh.length = 0;
    this.settleUntil = now + this.rtt + 300;
    return 1;
  }
}
