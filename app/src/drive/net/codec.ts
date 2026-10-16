import type { QInput } from './protocol.ts';

// Online play's binary messages (the hot ones: 60 Hz snapshots down, inputs up; the rest stays JSON, protocol.ts).
// Byte 0 is the type. Integers are LEB128 varints (zig-zag for signed ones) except a few fixed fields.
//
// A car travels as its net state (arcade.ts netState: NET_LEN numbers - track position, heading, slip, speed, yaw,
// the hit's knock, the input it's on, the surface under it, its drift, boost, timers, its flight in the air, its race),
// each number quantized to its own unit (NET_SCALE) and sent as the change from the last snapshot this client got
// (the WebSocket is TCP: nothing is lost or reordered, so the last one is always there) - only the fields that changed,
// grouped by eight with a bit per changed group and a bit per changed field in it. A car on the ground cruising sends
// ~15-25 bytes; one that changed nothing, 3. Every client has had the same last snapshot of a car, so its change is
// encoded once per snapshot and the same bytes go to all (room.ts); a client new to the car gets it whole (from 0).
//
//   snapshot  u8 1 | k u32 | race u16 | flags u8 (1: b, 2: r, 4: m, 8: your state at k was right) | zz(a - k) | [b: zz(b)]
//             | [r: laps, zz(lapStart - k), zz(finish)] | n u8 | n x (id, cflags u8 (1: start afresh), car delta)
//             | [m: your car's exact state (writeFull: its CORE_LENGTH numbers, as the change from the last one sent)]
//   inputs    u8 2 | k u32 | n u8 | first input (steer i16, throttle | brake << 10 | drift << 20 in 3 bytes) | then for
//             each next step a byte of which changed (1 steer, 2 throttle, 4 brake, 8 drift's value) + zz deltas
//             | nh u8 | nh x (step - k u8, hash u32)

export const MSG_SNAP = 1, MSG_INPUT = 2;
export const NET_LEN = 72;
/** Indices in the net state the caller fills: the input (steer, throttle, brake, drift as QInput) and the race. */
export const NET_IN = 8, NET_LAPS = 68, NET_FAR = 69, NET_FIN = 70;

/** Units per field (quantized = round(x * scale)): arcade.ts netState's order, eight to a group. */
export const NET_SCALE = new Float64Array([
  // 0 motion: s, d, psi, beta, v, omega, kick, knock
  4096, 1024, 16384, 16384, 256, 2048, 2048, 256,
  // 1 input (already integers), steerVis, body feel (accBase x y z)
  1, 1, 1, 1, 1024, 16, 16, 16,
  // 2 surface under it (grip, drift grip, turn, top speed, drag, bumps, looseness), lane
  4096, 4096, 4096, 4096, 4096, 4096, 4096, 1,
  // 3 the safe spot (s - safeS, v - safeV), its lane, respawn timer, stuck, wrong way, ghost, flags
  16, 64, 1, 1024, 256, 256, 1024, 1,
  // 4 drift: drifting, dir, charge, tier, pressT, slide, looseT, straightT
  1, 1, 1024, 1, 1024, 4096, 1024, 1024,
  // 5 slid, spun, settleT, boost, magic, turbo, stack, wheel spin (in the air)
  1, 1, 1024, 1024, 1024, 1024, 1, 16,
  // 6 hits: stunT, spinT, hayT, slipLim, wallAgo, wallSide, sag, groundT
  1024, 1024, 1024, 16384, 1024, 1, 256, 1024,
  // 7 flight: airTime, airP x y z, airV x y z, airYawRate
  1024, 1024, 1024, 1024, 256, 256, 256, 2048,
  // 8 flight: airQ x y z w; race: laps, far side, finish step; the yaw other cars' hits kicked in lately
  16384, 16384, 16384, 16384, 1, 1, 1, 2048,
]);
if (NET_SCALE.length !== NET_LEN) throw new Error('codec: NET_SCALE');
const GROUPS = NET_LEN / 8;

export function quantizeNet(x: ArrayLike<number>, q: Int32Array) {
  for (let i = 0; i < NET_LEN; i++) q[i] = Math.round(x[i] * NET_SCALE[i]);
}
export function dequantizeNet(q: ArrayLike<number>, x: Float64Array) {
  for (let i = 0; i < NET_LEN; i++) x[i] = q[i] / NET_SCALE[i];
}

/** A growable byte buffer (reused: nothing allocated once it's big enough). */
export class Writer {
  buf = new Uint8Array(4096);
  dv = new DataView(this.buf.buffer);
  pos = 0;
  reset() {
    this.pos = 0;
    return this;
  }
  private room(n: number) {
    if (this.pos + n <= this.buf.length) return;
    const b = new Uint8Array(Math.max(this.buf.length * 2, this.pos + n));
    b.set(this.buf);
    this.buf = b;
    this.dv = new DataView(b.buffer);
  }
  u8(x: number) {
    this.room(1);
    this.buf[this.pos++] = x;
  }
  u16(x: number) {
    this.room(2);
    this.dv.setUint16(this.pos, x, true);
    this.pos += 2;
  }
  i16(x: number) {
    this.room(2);
    this.dv.setInt16(this.pos, x, true);
    this.pos += 2;
  }
  u32(x: number) {
    this.room(4);
    this.dv.setUint32(this.pos, x >>> 0, true);
    this.pos += 4;
  }
  f64(x: number) {
    this.room(8);
    this.dv.setFloat64(this.pos, x, true);
    this.pos += 8;
  }
  /** Unsigned LEB128 (any safe integer). */
  uv(x: number) {
    this.room(8);
    while (x >= 128) {
      this.buf[this.pos++] = (x % 128) | 128;
      x = Math.floor(x / 128);
    }
    this.buf[this.pos++] = x;
  }
  /** Signed, zig-zag. */
  zv(x: number) {
    this.uv(x >= 0 ? x * 2 : -x * 2 - 1);
  }
  /** Bytes as they are (an encoding made once, sent to many). */
  bytes(b: Uint8Array, n = b.length) {
    this.room(n);
    this.buf.set(n === b.length ? b : b.subarray(0, n), this.pos);
    this.pos += n;
  }
  /** What's been written (a view: copy it before the next reset if it must outlive it). */
  view() {
    return this.buf.subarray(0, this.pos);
  }
}

export class Reader {
  buf: Uint8Array;
  dv: DataView;
  pos = 0;
  constructor(b: Uint8Array) {
    this.buf = b;
    this.dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  }
  get left() {
    return this.buf.length - this.pos;
  }
  u8() {
    if (this.pos >= this.buf.length) throw new RangeError('codec: short');
    return this.buf[this.pos++];
  }
  u16() {
    const x = this.dv.getUint16(this.pos, true);
    this.pos += 2;
    return x;
  }
  i16() {
    const x = this.dv.getInt16(this.pos, true);
    this.pos += 2;
    return x;
  }
  u32() {
    const x = this.dv.getUint32(this.pos, true);
    this.pos += 4;
    return x;
  }
  f64() {
    const x = this.dv.getFloat64(this.pos, true);
    this.pos += 8;
    return x;
  }
  uv() {
    let x = 0, m = 1;
    for (let i = 0; i < 8; i++) {
      const b = this.u8();
      x += (b & 127) * m;
      if (b < 128) return x;
      m *= 128;
    }
    throw new RangeError('codec: varint');
  }
  zv() {
    const u = this.uv();
    return u % 2 ? -(u + 1) / 2 : u / 2;
  }
}

/** A car's quantized net state as the change from `base` (which becomes `q`, unless `keep`). */
export function writeCarDelta(w: Writer, q: Int32Array, base: Int32Array, keep = false) {
  let gm = 0;
  for (let g = 0; g < GROUPS; g++) for (let i = g * 8; i < g * 8 + 8; i++) if (q[i] !== base[i]) (gm |= 1 << g), (i = g * 8 + 8);
  w.uv(gm);
  for (let g = 0; g < GROUPS; g++) {
    if (!(gm & (1 << g))) continue;
    let fm = 0;
    for (let j = 0; j < 8; j++) if (q[g * 8 + j] !== base[g * 8 + j]) fm |= 1 << j;
    w.u8(fm);
    for (let j = 0; j < 8; j++) if (fm & (1 << j)) w.zv(q[g * 8 + j] - base[g * 8 + j]);
  }
  if (!keep) base.set(q);
}
/** Back: applies the change to `base` (the last state of that car this client got). */
export function readCarDelta(r: Reader, base: Int32Array) {
  const gm = r.uv();
  for (let g = 0; g < GROUPS; g++) {
    if (!(gm & (1 << g))) continue;
    const fm = r.u8();
    for (let j = 0; j < 8; j++) if (fm & (1 << j)) base[g * 8 + j] += r.zv();
  }
}

/** Your car's state, exact (the simulation's own numbers: arcade.ts snapshot()[0..CORE_LENGTH), its outputs follow
 *  from them), as the change from the last one sent (`ref`, which becomes `a`): a bit per number that changed, then
 *  each one's bits XOR the old one's, its zero bytes at either end left out (a byte says how many). Unchanged flags and
 *  timers cost nothing; a number that moved a little, ~6 bytes. */
const xb = new DataView(new ArrayBuffer(16));
export function writeFull(w: Writer, a: ArrayLike<number>, ref: Float64Array) {
  const n = a.length;
  w.u8(n);
  for (let i = 0; i < n; i += 8) {
    let m = 0;
    for (let j = 0; j < 8 && i + j < n; j++) if (!Object.is(a[i + j], ref[i + j])) m |= 1 << j;
    w.u8(m);
  }
  for (let i = 0; i < n; i++) {
    if (Object.is(a[i], ref[i])) continue;
    xb.setFloat64(0, a[i]);
    xb.setFloat64(8, ref[i]);
    let lead = 0, trail = 0;
    for (let j = 0; j < 8 && (xb.getUint8(j) ^ xb.getUint8(8 + j)) === 0; j++) lead++;
    for (let j = 7; j > lead && (xb.getUint8(j) ^ xb.getUint8(8 + j)) === 0; j--) trail++;
    w.u8(lead | (trail << 4));
    for (let j = lead; j < 8 - trail; j++) w.u8(xb.getUint8(j) ^ xb.getUint8(8 + j));
    ref[i] = a[i];
  }
}
/** Back: `out` and `ref` (the last one received) become the new state. */
export function readFull(r: Reader, out: Float64Array, ref: Float64Array): number {
  const n = r.u8();
  const pos = r.pos;
  r.pos += Math.ceil(n / 8);
  for (let i = 0; i < n; i++) {
    if ((r.buf[pos + (i >> 3)] >> (i & 7)) & 1) {
      const h = r.u8(), lead = h & 15, trail = h >> 4;
      xb.setFloat64(8, ref[i]);
      for (let j = 0; j < 8; j++) xb.setUint8(j, xb.getUint8(8 + j) ^ (j >= lead && j < 8 - trail ? r.u8() : 0));
      ref[i] = xb.getFloat64(0);
    }
    out[i] = ref[i];
  }
  return n;
}

// ---- inputs (client -> server)
export function writeInputs(w: Writer, k: number, inputs: Int32Array, from: number, n: number, hashes: ArrayLike<number>, nh: number) {
  w.u8(MSG_INPUT);
  w.u32(k);
  w.u8(n);
  let ps = 0, pt = 0, pb = 0;
  for (let j = 0; j < n; j++) {
    const o = (from + j) * 4;
    const st = inputs[o], th = inputs[o + 1], br = inputs[o + 2], dr = inputs[o + 3];
    if (j === 0) {
      w.i16(st);
      const x = (th & 1023) | ((br & 1023) << 10) | ((dr & 1) << 20);
      w.u8(x & 255), w.u8((x >> 8) & 255), w.u8((x >> 16) & 255);
    } else {
      const f = (st !== ps ? 1 : 0) | (th !== pt ? 2 : 0) | (br !== pb ? 4 : 0) | (dr ? 8 : 0);
      w.u8(f);
      if (f & 1) w.zv(st - ps);
      if (f & 2) w.zv(th - pt);
      if (f & 4) w.zv(br - pb);
    }
    ps = st, pt = th, pb = br;
  }
  w.u8(nh);
  for (let j = 0; j < nh; j++) {
    w.u8(hashes[j * 2] - k);
    w.u32(hashes[j * 2 + 1]);
  }
}
/** Reads an input packet into `out` (4 ints per step: steer, throttle, brake, drift) and the hashes [step, hash] into
 *  `hs`; returns the first step and the counts, or null if it's malformed. (No value is trusted: room.ts checks them.) */
export function readInputs(r: Reader, out: Int32Array, hs: Float64Array): { k: number; n: number; nh: number } | null {
  try {
    if (r.u8() !== MSG_INPUT) return null;
    const k = r.u32(), n = r.u8();
    if (n * 4 > out.length) return null;
    let st = 0, th = 0, br = 0, dr = 0;
    for (let j = 0; j < n; j++) {
      if (j === 0) {
        st = r.i16();
        const x = r.u8() | (r.u8() << 8) | (r.u8() << 16);
        th = x & 1023, br = (x >> 10) & 1023, dr = (x >> 20) & 1;
      } else {
        const f = r.u8();
        if (f & 1) st += r.zv();
        if (f & 2) th += r.zv();
        if (f & 4) br += r.zv();
        dr = f & 8 ? 1 : 0;
      }
      out[j * 4] = st, out[j * 4 + 1] = th, out[j * 4 + 2] = br, out[j * 4 + 3] = dr;
    }
    const nh = r.u8();
    if (nh * 2 > hs.length) return null;
    for (let j = 0; j < nh; j++) (hs[j * 2] = k + r.u8()), (hs[j * 2 + 1] = r.u32());
    return { k, n, nh };
  } catch {
    return null;
  }
}

/** (A QInput from 4 ints.) */
export const qOf = (a: ArrayLike<number>, o: number, out: QInput): QInput => ((out[0] = a[o]), (out[1] = a[o + 1]), (out[2] = a[o + 2]), (out[3] = a[o + 3]), out);
