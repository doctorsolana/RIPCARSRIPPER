import * as THREE from 'three';
import type { CarSpec, DriveInput, Track, Vehicle } from '../types';
import { create, SNAP_LENGTH } from '../vehicles/arcade.ts';
import { dequantizeNet, NET_FAR, NET_FIN, NET_IN, NET_LAPS, NET_LEN, readCarDelta, type Reader } from './codec.ts';
import { ContactSolver } from './contact.ts';
import { dequantize, type QInput } from './protocol.ts';

// The drive page's predicted world (online): every car of the race simulated in this client's own timeline - its
// step counter runs ahead of the server's (net/online.ts) - with the same code and in the same order as the server
// (server/sim.ts): each car's step, then car-to-car contact (net/contact.ts). Your car runs on your inputs; every
// other car on the last input the server said its player is on, from the state the last snapshot gave (the sim is
// deterministic, so that's exact until they change input). When a snapshot for tick k arrives, the world is rewound
// to k - your car to its exact state there (the server's, when your prediction missed; else your own, which the server
// confirmed by its hash), the others to the snapshot's - and replayed to now: a crash shows the moment it happens on
// your screen, against cars drawn where they are now, and is put right as the truth comes in. The page keeps what's
// on screen smooth (the visual error of each correction decays: online.ts).

const H = 1 / 120;

export interface WorldCar {
  id: number; // the player's
  car: string;
  slot: number; // grid slot: the server's order (contact is resolved pair by pair in it)
  own: boolean;
  veh: Vehicle | null; // (a remote car's arrives once its spec has loaded)
  /** In the race: stepped and colliding. */
  active: boolean;
  /** Its input: the last the server said (a remote car's), or this step's (yours). */
  input: QInput;
  /** A remote car's last snapshot: quantized (the delta's base), dequantized, its tick; and its race. */
  q: Int32Array;
  net: Float64Array;
  netK: number;
  has: boolean;
  finish: number;
  laps: number;
  far: boolean;
  // drawing: the pose before the last step (interpolation) and the visual error left by corrections (decays)
  prevP: THREE.Vector3;
  prevQ: THREE.Quaternion;
  off: THREE.Vector3;
  qOff: THREE.Quaternion;
  pb: THREE.Vector3; // (scratch: the pose before a rewind)
  qb: THREE.Quaternion;
  /** A remote car whose prediction put it back on the track (a miss the server may not have seen): it waits where it
   *  was for the next snapshot (no contact meanwhile) - a respawn is the server's to say. */
  held: boolean;
  save: Float64Array | null;
}

export class World {
  readonly track: Track;
  readonly solver: ContactSolver;
  readonly cars: WorldCar[] = [];
  private vehs: Vehicle[] = [];
  private skip = new Uint8Array(16);
  private dq: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };
  private specOf: (id: string) => Promise<CarSpec>;
  constructor(track: Track, specOf: (id: string) => Promise<CarSpec>) {
    this.track = track;
    this.solver = new ContactSolver(track);
    this.specOf = specOf;
  }
  get(id: number) {
    for (const c of this.cars) if (c.id === id) return c;
    return null;
  }
  private blank(id: number, car: string, slot: number, own: boolean, veh: Vehicle | null): WorldCar {
    return {
      id, car, slot, own, veh, active: false, input: [0, 0, 0, 0], q: new Int32Array(NET_LEN), net: new Float64Array(NET_LEN), netK: -1, has: false,
      finish: -1, laps: 0, far: false, prevP: new THREE.Vector3(), prevQ: new THREE.Quaternion(), off: new THREE.Vector3(), qOff: new THREE.Quaternion(),
      pb: new THREE.Vector3(), qb: new THREE.Quaternion(), held: false, save: own ? null : new Float64Array(SNAP_LENGTH),
    };
  }
  /** Your car (its vehicle is the page's). */
  setOwn(id: number, car: string, slot: number, veh: Vehicle) {
    let c = this.cars.find((x) => x.own);
    if (!c) this.cars.push((c = this.blank(id, car, slot, true, veh)));
    c.id = id, c.car = car, c.slot = slot, c.veh = veh;
    this.sort();
    return c;
  }
  /** Another player's car (made now, its vehicle once its spec loads; car '' : not known yet). Another car for the
   *  same player: a new one. */
  remote(id: number, car: string, slot: number): WorldCar {
    let c = this.get(id);
    if (c && !c.own && c.car && car && c.car !== car) {
      // (the snapshots' record of this player's car goes on from where it was: keep it)
      const old = c;
      this.remove(id);
      this.cars.push((c = this.blank(id, car, slot, false, null)));
      c.q.set(old.q), c.net.set(old.net), (c.netK = old.netK), (c.has = old.has);
    }
    if (!c) this.cars.push((c = this.blank(id, car, slot, false, null)));
    if (car && !this.loading.has(c)) {
      const nc = c;
      nc.car = car;
      this.loading.add(nc);
      this.specOf(car).then((spec) => create(this.track, spec)).then((v) => {
        if (!this.cars.includes(nc)) return;
        nc.veh = v;
        if (nc.has) v.restoreNet!(nc.net);
      }).catch((e) => console.warn('no car', car, e));
    }
    c.slot = slot;
    this.sort();
    return c;
  }
  private loading = new WeakSet<WorldCar>();
  remove(id: number) {
    const i = this.cars.findIndex((c) => c.id === id && !c.own);
    if (i >= 0) this.cars.splice(i, 1);
  }
  private sort() {
    this.cars.sort((a, b) => a.slot - b.slot || a.id - b.id);
  }

  /** A snapshot's car record (net/codec.ts): its state at tick k, into its car (made if new: slot from the room). */
  readCar(r: Reader, id: number, fresh: boolean, k: number) {
    const c = this.get(id) ?? this.remote(id, '', 999);
    if (fresh) c.q.fill(0);
    readCarDelta(r, c.q);
    dequantizeNet(c.q, c.net);
    c.netK = k;
    c.has = true;
    c.input[0] = c.net[NET_IN], c.input[1] = c.net[NET_IN + 1], c.input[2] = c.net[NET_IN + 2], c.input[3] = c.net[NET_IN + 3];
    c.laps = c.net[NET_LAPS];
    c.far = c.net[NET_FAR] !== 0;
    c.finish = c.net[NET_FIN];
    return c;
  }

  /** One step (k) of every active car - yours on `ownIn` - then car-to-car contact (cars that have finished pass
   *  through: server/sim.ts ghostAt). Each car's pose before it is kept for drawing. */
  step(k: number, ownIn: QInput | null) {
    const vehs = this.vehs;
    let n = 0;
    for (const c of this.cars) {
      if (!c.active || !c.veh || c.held) continue;
      const v = c.veh;
      c.prevP.copy(v.state.position);
      c.prevQ.copy(v.state.quaternion);
      if (c.save) v.snapshotInto!(c.save);
      v.step(H, dequantize(c.own && ownIn ? ownIn : c.input, this.dq));
      if (v.state.events.respawn && c.save) {
        v.restore!(c.save);
        v.state.events.respawn = undefined;
        c.held = true;
        continue;
      }
      if (v.state.events.respawn) c.prevP.copy(v.state.position), c.prevQ.copy(v.state.quaternion); // (no streak across it)
      if (this.skip.length <= n) {
        const s = new Uint8Array(this.skip.length * 2);
        s.set(this.skip);
        this.skip = s;
      }
      this.skip[n] = c.finish >= 0 && c.finish <= k ? 1 : 0;
      vehs[n++] = v;
    }
    vehs.length = n;
    return this.solver.solve(vehs, n, this.skip, H);
  }

  /** Back to tick k: your car to `ownState` (a vehicle snapshot, or just its core; null: as it is), every other active car to its
   *  snapshot (which is at k); then forward to `to` - your inputs from `ownAt`, `after(j)` once step j is done. */
  rollback(k: number, to: number, ownState: ArrayLike<number> | null, ownAt: (j: number) => QInput, after?: (j: number) => void) {
    for (const c of this.cars) {
      c.held = false;
      if (!c.active || !c.veh) continue;
      if (c.own) {
        if (ownState) c.veh.restoreCore!(ownState);
      } else if (c.has) c.veh.restoreNet!(c.net);
    }
    for (let j = k; j < to; j++) {
      this.step(j, ownAt(j));
      after?.(j);
    }
  }
}
