import { createServer } from 'node:http';
import { PerformanceObserver } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import { H, MAX_PLAYERS, PORT, type C2S, type RoomListing, type S2C } from '../src/drive/net/protocol.ts';
import { COURSES, courseOf, isCourse } from '../src/drive/tracks/index.ts';
import { newPlayerId, Room, validCar, type Player } from './room.ts';
import { trackOf } from './sim.ts';

// RIPCARS drive: the local multiplayer demo's server. `npm run server` -> ws://localhost:8790 (PORT to change it).
// Server-authoritative: it runs the drive page's own sim (vehicles/arcade.ts, tracks/, car-to-car contact in
// net/contact.ts) for every car at 120 Hz from the players' inputs, and sends 60 Hz binary snapshots back (room.ts;
// the protocol in src/drive/net/protocol.ts and codec.ts). Rooms are made by name on the first join. Every race's
// applied inputs go to server/logs/<room>/*.jsonl (replay.ts re-runs one).
// The clock: each step is due at its own moment of real time (hrtime), the timer set for the next one; a late wake
// runs the steps it owes at once (never drifting), and more than half a second behind drops the backlog.
// GET http://localhost:8790/stats: rooms, players, step time, how late the steps ran, GC pauses and bandwidth as JSON
// (/reset-stats zeroes them). Logs a line per room every 5 s. GET /rooms: the open rooms and the courses, for the lobby
// browser (online.html; RoomListing).

const port = Number(process.env.PORT) || PORT;
const rooms = new Map<string, Room>();
for (const c of COURSES) trackOf(c.id); // (built once now: building one on a room's first join stalls every room)
const t0 = process.hrtime.bigint();
const nowMs = () => Number(process.hrtime.bigint() - t0) / 1e6;
let tick = 0; // global step counter: every room steps on it

/** A histogram in fixed buckets (us), for the step time and the steps' lateness. */
class Hist {
  edges: number[];
  counts: number[];
  n = 0;
  sum = 0;
  max = 0;
  constructor(edges: number[]) {
    this.edges = edges;
    this.counts = new Array(edges.length + 1).fill(0);
  }
  add(x: number) {
    let i = 0;
    while (i < this.edges.length && x > this.edges[i]) i++;
    this.counts[i]++;
    this.n++;
    this.sum += x;
    if (x > this.max) this.max = x;
  }
  q(p: number) {
    let c = 0;
    for (let i = 0; i < this.counts.length; i++) if ((c += this.counts[i]) >= p * this.n) return i < this.edges.length ? this.edges[i] : this.max;
    return this.max;
  }
  json() {
    const b: Record<string, number> = {};
    this.counts.forEach((c, i) => c && (b[i < this.edges.length ? `<=${this.edges[i]}` : `>${this.edges.at(-1)}`] = c));
    return { n: this.n, avg: this.n ? this.sum / this.n : 0, p50: this.q(0.5), p99: this.q(0.99), p999: this.q(0.999), max: this.max, buckets: b };
  }
  reset() {
    this.counts.fill(0);
    this.n = this.sum = this.max = 0;
  }
}
const EDGES = [25, 50, 100, 200, 400, 800, 1600, 3200, 6400, 12800, 25600];
const stats = {
  step: new Hist(EDGES), // us per tick, every room
  late: new Hist([-500, -250, 0, 250, 500, 1000, 2000, 4000, 8000, 16000, 32000]), // us after its moment that a step ran (< 0: before)
  gc: new Hist([250, 500, 1000, 2000, 4000, 8000, 16000, 32000]), // us per GC pause
  behind: 0,
};
new PerformanceObserver((list) => {
  for (const e of list.getEntries()) stats.gc.add(e.duration * 1000);
}).observe({ entryTypes: ['gc'] });

const cleanName = (s: unknown) => String(s ?? '').replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 20).trim();

const http = createServer((req, res) => {
  if (req.url?.startsWith('/rooms')) {
    const body: RoomListing = {
      rooms: [...rooms.values()].map((r) => {
        const c = courseOf(isCourse(r.course) ? r.course : 'meadow');
        return {
          name: r.name, track: r.course, trackName: c.name, color: c.color, laps: r.laps, phase: r.phase, max: MAX_PLAYERS,
          players: r.info().map((p) => ({ name: p.name, car: p.car, carName: p.carName, bot: p.bot, ready: p.ready, host: p.id === r.host })),
        };
      }),
      courses: COURSES.map((c) => ({ id: c.id, name: c.name, color: c.color, blurb: c.blurb })),
    };
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': 'no-store' });
    res.end(JSON.stringify(body));
    return;
  }
  if (req.url?.startsWith('/stats')) {
    const up = nowMs() / 1000;
    res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' });
    res.end(JSON.stringify({
      tick, uptime: up, behind: stats.behind, stepUs: stats.step.json(), lateUs: stats.late.json(), gcUs: stats.gc.json(),
      heapMB: process.memoryUsage().heapUsed / 2 ** 20,
      rooms: [...rooms.values()].map((r) => ({
        name: r.name, course: r.course, laps: r.laps, phase: r.phase, race: r.race, log: r.logPath,
        stepUs: r.stepTime.n ? { avg: r.stepTime.sum / r.stepTime.n, max: r.stepTime.max, n: r.stepTime.n, simAvg: r.simUs / r.stepTime.n, sendAvg: r.sendUs / r.stepTime.n } : null,
        contact: r.sim.contact,
        players: r.players.map((p) => ({ id: p.id, name: p.name, car: p.car, bot: !p.send, slot: p.slot, ping: p.ping, viol: p.viol, bytesOut: p.bytesOut, bytesIn: p.bytesIn, snaps: p.snaps, fulls: p.fulls })),
      })),
    }));
    return;
  }
  if (req.url?.startsWith('/reset-stats')) {
    for (const r of rooms.values()) (r.stepTime = { n: 0, sum: 0, max: 0 }), (r.sendUs = r.simUs = 0);
    stats.step.reset(), stats.late.reset(), stats.gc.reset(), (stats.behind = 0);
    res.writeHead(200, { 'access-control-allow-origin': '*' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('RIPCARS drive server: connect a WebSocket (drive.html?online=1)\n');
});
const wss = new WebSocketServer({ server: http, maxPayload: 16 * 1024 });

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null, me: Player | null = null, joining = false;
  const send = (m: S2C) => {
    if (ws.readyState !== ws.OPEN) return;
    const s = JSON.stringify(m);
    if (me) me.bytesOut += s.length;
    ws.send(s);
  };
  const sendBin = (b: Uint8Array) => {
    if (ws.readyState !== ws.OPEN) return;
    if (me) me.bytesOut += b.length;
    ws.send(Buffer.from(b), { binary: true }); // (a copy: the encoder's buffer is reused for the next one)
  };
  ws.on('message', async (data, isBinary) => {
    const buf = data as Buffer;
    if (me) me.bytesIn += buf.length ?? 0;
    if (isBinary) {
      if (room && me) room.onInputs(me, new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength), tick);
      return;
    }
    let m: C2S;
    try {
      m = JSON.parse(String(data));
    } catch {
      if (me) me.viol.format++;
      return;
    }
    if (!m || typeof m !== 'object') return;
    if (m.t === 'p') {
      if (me && typeof m.rtt === 'number') me.ping = Math.round(Math.min(9999, Math.max(0, m.rtt)));
      return send({ t: 'P', c: m.c, k: tick });
    }
    if (m.t === 'join') {
      if (me || joining) return;
      joining = true;
      const name = cleanName(m.name) || 'Driver';
      const rn = String(m.room ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
      const car = validCar(String(m.car)) ? String(m.car) : 'skyline-hck01';
      let r = rooms.get(rn);
      if (!r) {
        const laps = Math.min(9, Math.max(1, Math.round(Number(m.laps)) || 3));
        r = new Room(rn, String(m.track), laps);
        r.min = Math.min(10, Math.max(1, Math.round(Number(m.min)) || 1));
        rooms.set(rn, r);
        console.log(`[room ${rn}] created: ${r.course}, ${laps} laps, waits for ${r.min}`);
        const bots = Math.min(9, Math.max(0, Math.round(Number(m.bots)) || 0));
        if (bots) await r.addBots(bots, tick);
      } else if (m.min) r.min = Math.max(r.min, Math.min(10, Math.round(Number(m.min)) || 1));
      if (r.course !== m.track || r.laps !== Math.round(Number(m.laps) || 3)) {
        joining = false;
        return send({ t: 'track', track: r.course, laps: r.laps }); // the room races another course: reload on it
      }
      const p = await r.join({ id: newPlayerId(), name, car, send, sendBin, ready: false, ping: 0 }, tick);
      if (!p) {
        joining = false;
        return send({ t: 'error', msg: 'The room is full' });
      }
      room = r;
      me = p;
      console.log(`[room ${rn}] + ${name} (#${p.id}, ${car}) slot ${p.slot}; ${r.players.length} in the room`);
      send({ t: 'welcome', you: p.id, room: rn, track: r.course, laps: r.laps, tick });
      r.broadcastRoom();
      return;
    }
    if (!room || !me) return;
    if (m.t === 'ready') room.setReady(me, !!m.on);
    else if (m.t === 'name') {
      const name = cleanName(m.name);
      if (name && name !== me.name) room.setName(me, name);
    } else if (m.t === 'car') {
      if (validCar(String(m.car))) room.setCar(me, String(m.car));
    }
    else if (m.t === 'leave') ws.close();
  });
  ws.on('close', () => {
    if (!room || !me) return;
    console.log(`[room ${room.name}] - ${me.name} (#${me.id})`);
    room.leave(me, tick);
    if (!room.humans.length) {
      room.close(tick);
      rooms.delete(room.name);
      console.log(`[room ${room.name}] closed`);
    }
  });
});

// The clock: step k is due at (k + 1) H of real time. Each wake runs the steps owed (every room once per step), then
// sleeps until the next one is due (the timers keep whole milliseconds and wake late rather than early: a step up to
// EARLY ms before its moment runs now rather than a timer's tick late - it's the server's clock, the phase is its own).
const STEP_MS = H * 1000, EARLY = 0.6;
function pump() {
  const now = nowMs();
  const due = Math.floor((now + EARLY) / STEP_MS);
  let n = 0;
  while (tick < due && n < 60) {
    const a = nowMs();
    stats.late.add((a - (tick + 1) * STEP_MS) * 1000);
    for (const r of rooms.values()) r.step(tick);
    stats.step.add((nowMs() - a) * 1000);
    tick++;
    n++;
  }
  if (tick < due) {
    stats.behind += due - tick;
    tick = due; // more than half a second behind: drop it (never spiral)
  }
  setTimeout(pump, Math.max(0, (tick + 1) * STEP_MS - EARLY - nowMs()));
}
pump();

let lastBytes = new Map<number, number>();
setInterval(() => {
  for (const r of rooms.values()) {
    const st = r.stepWin;
    const ps = r.players.map((p) => {
      const kbs = ((p.bytesOut - (lastBytes.get(p.id) ?? 0)) / 5 / 1024).toFixed(1);
      return p.send ? `${p.name}${p.ready ? '*' : ''} ${p.ping}ms ${kbs}KB/s` : p.name;
    });
    console.log(`[room ${r.name}] ${r.course} ${r.phase} race ${r.race} | ${r.players.length} cars: ${ps.join(', ')} | step ${st.n ? (st.sum / st.n).toFixed(0) : '-'} us avg, ${st.max.toFixed(0)} max`);
    st.n = st.sum = st.max = 0;
  }
  lastBytes = new Map([...rooms.values()].flatMap((r) => r.players.map((p) => [p.id, p.bytesOut] as [number, number])));
  if (rooms.size) console.log(`server: steps late p50 ${(stats.late.q(0.5) / 1000).toFixed(2)} ms, p99 ${(stats.late.q(0.99) / 1000).toFixed(2)}, max ${(stats.late.max / 1000).toFixed(1)}; gc ${stats.gc.n} pauses, max ${(stats.gc.max / 1000).toFixed(1)} ms`);
  if (stats.behind) console.log(`server: fell behind by ${stats.behind} steps (dropped)`), (stats.behind = 0);
}, 5000);

http.listen(port, () => console.log(`RIPCARS drive server on ws://localhost:${port} (stats: http://localhost:${port}/stats)`));
