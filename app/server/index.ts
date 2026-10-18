import { createServer } from 'node:http';
import { PerformanceObserver } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAddress, shortWallet } from '../src/auth/address.ts';
import { H, MAX_PLAYERS, PORT, type C2S, type Leaderboard, type RoomListing, type S2C } from '../src/drive/net/protocol.ts';
import { COURSES, courseOf, isCourse } from '../src/drive/tracks/index.ts';
import { handleAuth, ipOf, originOk, verifySession } from './auth.ts';
import { garageOf } from './garage.ts';
import { mayDrive, newPlayerId, Room, type Player } from './room.ts';
import { carName, trackOf } from './sim.ts';
import { board, DB_PATH } from './store.ts';

// RIPCARS drive: the local multiplayer demo's server. `npm run server` -> ws://localhost:8790 (PORT to change it).
// Server-authoritative: it runs the drive page's own sim (vehicles/arcade.ts, tracks/, car-to-car contact in
// net/contact.ts) for every car at 120 Hz from the players' inputs, and sends 60 Hz binary snapshots back (room.ts;
// the protocol in src/drive/net/protocol.ts and codec.ts). Rooms are made by name on the first join. Every race's
// applied inputs go to server/logs/<room>/*.jsonl (replay.ts re-runs one).
// Players are wallets: a join carries the session token of a wallet sign-in (auth.ts: POST /auth/challenge, /auth/verify)
// and is refused without a valid one; the player's name is the wallet's short form, set here. One connection per wallet
// on the whole server: a new join from a wallet closes its older connection (that car leaves, as on a disconnect), so a
// wallet never drives two cars. A browser's WebSocket from an origin not on ALLOWED_ORIGINS is refused.
// The clock: each step is due at its own moment of real time (hrtime), the timer set for the next one; a late wake
// runs the steps it owes at once (never drifting), and more than half a second behind drops the backlog.
// GET http://localhost:8790/stats: rooms, players, step time, how late the steps ran, GC pauses and bandwidth as JSON
// (/reset-stats zeroes them). Logs a line per room every 5 s. GET /rooms: the open rooms and the courses, for the lobby
// browser (online.html; RoomListing) - a time trial (a solo room) isn't listed. GET /leaderboard[?wallet=]: this week's
// best clean laps per track (store.ts; Leaderboard). GET /garage?wallet=: the wallet's Rip Cars (garage.ts). Public
// GETs, open to any site (CORS *), like /rooms.

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

/** A public GET's JSON answer (any site may read it: CORS *). */
function sendJson(res: import('node:http').ServerResponse, status: number, body: unknown, cache = 'no-store') {
  res.writeHead(status, { 'content-type': 'application/json', 'access-control-allow-origin': '*', 'cache-control': cache });
  res.end(JSON.stringify(body));
}
/** GET /garage's per-IP limit (each miss costs requests to RIPCARS): a burst of 20, then 20 a minute. */
const garageBuckets = new Map<string, { tokens: number; at: number }>();
function garageAllowed(ip: string) {
  const now = Date.now() / 1000, b = garageBuckets.get(ip) ?? { tokens: 20, at: now };
  b.tokens = Math.min(20, b.tokens + (now - b.at) * (20 / 60));
  b.at = now;
  garageBuckets.set(ip, b);
  if (garageBuckets.size > 10_000) garageBuckets.delete(garageBuckets.keys().next().value!);
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}
/** GET /leaderboard[?wallet=]: this week's board for every course (the top 10 by each wallet's best clean lap), and the
 *  wallet's own best and rank on each. */
function leaderboard(wallet: string | null): Leaderboard {
  const now = Date.now();
  let week = { weekStart: 0, weekEnd: 0 };
  const tracks = COURSES.map((c) => {
    const len = Math.round(trackOf(c.id).length);
    const b = board(c.id, len, wallet, now);
    week = { weekStart: b.weekStart, weekEnd: b.weekEnd };
    const out = (r: (typeof b.top)[number]) => ({ rank: r.rank, wallet: r.wallet, name: shortWallet(r.wallet), car: r.car, carName: carName(r.car), steps: r.steps, time: r.steps * H, at: r.at });
    return { id: c.id, name: c.name, color: c.color, length: len, drivers: b.drivers, top: b.top.map(out), you: b.you ? out(b.you) : null };
  });
  return { ...week, now, tracks };
}

const http = createServer(async (req, res) => {
  if (await handleAuth(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    const w = url.searchParams.get('wallet');
    if (w !== null && w !== '' && !isAddress(w)) return sendJson(res, 400, { error: 'Not a wallet address' });
    try {
      return sendJson(res, 200, leaderboard(w || null));
    } catch (e) {
      console.error('leaderboard:', e);
      return sendJson(res, 500, { error: 'Server error' });
    }
  }
  if (url.pathname === '/garage' && req.method === 'GET') {
    const w = url.searchParams.get('wallet') ?? '';
    if (!isAddress(w)) return sendJson(res, 400, { error: 'Not a wallet address' });
    if (!garageAllowed(ipOf(req))) return sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' });
    try {
      return sendJson(res, 200, await garageOf(w));
    } catch (e) {
      console.warn(`garage ${w}: ${(e as Error).message}`);
      return sendJson(res, 502, { error: "Can't reach RIPCARS right now" });
    }
  }
  if (req.url?.startsWith('/rooms')) {
    const body: RoomListing = {
      rooms: [...rooms.values()].filter((r) => !r.solo).map((r) => {
        const c = courseOf(isCourse(r.course) ? r.course : 'meadow');
        return {
          name: r.name, track: r.course, trackName: c.name, color: c.color, laps: r.laps, phase: r.phase, max: MAX_PLAYERS,
          players: r.info().map((p) => ({ name: p.name, wallet: p.wallet, car: p.car, carName: p.carName, bot: p.bot, ready: p.ready, host: p.id === r.host })),
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
        name: r.name, course: r.course, laps: r.laps, phase: r.phase, race: r.race, log: r.logPath, solo: r.solo,
        stepUs: r.stepTime.n ? { avg: r.stepTime.sum / r.stepTime.n, max: r.stepTime.max, n: r.stepTime.n, simAvg: r.simUs / r.stepTime.n, sendAvg: r.sendUs / r.stepTime.n } : null,
        contact: r.sim.contact,
        players: r.players.map((p) => ({ id: p.id, name: p.name, wallet: p.wallet, car: p.car, bot: !p.send, slot: p.slot, ping: p.ping, viol: p.viol, bytesOut: p.bytesOut, bytesIn: p.bytesIn, snaps: p.snaps, fulls: p.fulls })),
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
// a browser's WebSocket only from the allowed origins (a client that isn't a browser sends none: it still needs a token)
const wss = new WebSocketServer({
  server: http, maxPayload: 16 * 1024,
  verifyClient: (info: { origin?: string }, cb: (ok: boolean, code?: number, msg?: string) => void) => (originOk(info.origin || undefined) ? cb(true) : cb(false, 403, 'Origin not allowed')),
});

/** The connection each wallet races on: a newer join from the wallet replaces it (one car per wallet). */
const byWallet = new Map<string, { replace: () => void }>();

/** A room with no human left closes (bots don't keep it). */
function closeIfEmpty(r: Room) {
  if (r.humans.length || rooms.get(r.name) !== r) return;
  r.close(tick);
  rooms.delete(r.name);
  console.log(`[room ${r.name}] closed`);
}
/** A player out of their room (a disconnect, a replaced connection). */
function leaveRoom(r: Room, p: Player) {
  if (!r.players.includes(p)) return;
  console.log(`[room ${r.name}] - ${p.name} (#${p.id})`);
  r.leave(p, tick);
  closeIfEmpty(r);
}

wss.on('connection', (ws: WebSocket) => {
  let room: Room | null = null, me: Player | null = null, joining = false, wallet: string | null = null, gone = false;
  let entering: Room | null = null; // the room this connection's player is being added to (its car loading)
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
  /** The car leaves (as on a disconnect). */
  const drop = () => {
    if (room && me) leaveRoom(room, me);
    room = me = null;
  };
  const conn = {
    /** The same wallet joined on another connection: this one's car leaves now, and it closes. */
    replace() {
      gone = true;
      send({ t: 'error', code: 'replaced', msg: 'You joined from another tab or device' });
      drop();
      const q = entering?.players.find((x) => x.send === send); // (still joining: its player goes too, now)
      if (entering && q) leaveRoom(entering, q);
      ws.close(4001, 'replaced');
    },
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
      if (me || joining || gone) return;
      // who: the wallet of a valid sign-in, or no join (the page asks to sign in again, then joins on this connection)
      const auth = verifySession(m.token);
      if (!auth) return send({ t: 'error', code: 'auth', msg: 'Sign in with your wallet to race' });
      joining = true;
      const rn = String(m.room ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
      const car = mayDrive(auth.wallet, String(m.car)) ? String(m.car) : 'skyline-hck01';
      const laps = Math.min(9, Math.max(1, Math.round(Number(m.laps)) || 3));
      const solo = m.solo === true; // a time trial: this wallet alone
      const elsewhere = (r: Room) => r.course !== m.track || r.laps !== Math.round(Number(m.laps) || 3);
      const refuse = (r: Room, why: 'track' | 'full' | 'solo') => {
        joining = false;
        closeIfEmpty(r); // (one made just now for a track it can't race)
        if (why === 'track') return send({ t: 'track', track: r.course, laps: r.laps });
        return send({ t: 'error', code: 'full', msg: why === 'solo' ? (r.solo ? "That's someone's time trial" : 'That room name is taken') : 'The room is full' });
      };
      // an open room this join can't go into: say so before touching the wallet's car elsewhere
      let r = rooms.get(rn);
      if (r && r.solo !== solo) return refuse(r, 'solo'); // (a time trial is its own room, and only one)
      if (r && r.solo && !r.players.some((q) => q.wallet === auth.wallet)) return refuse(r, 'solo');
      if (r && elsewhere(r)) return refuse(r, 'track'); // the room races another course: reload on it
      if (r && r.players.length >= r.max && !r.players.some((q) => q.wallet === auth.wallet)) return refuse(r, 'full');
      // one car per wallet: this connection takes over from the wallet's older one, whose car leaves first (if it was
      // its room's last human, that room closes - the room is looked up again below)
      wallet = auth.wallet;
      const prev = byWallet.get(wallet);
      byWallet.set(wallet, conn);
      if (prev && prev !== conn) prev.replace();
      r = rooms.get(rn);
      if (!r) {
        r = new Room(rn, String(m.track), laps);
        r.solo = solo;
        r.min = solo ? 1 : Math.min(10, Math.max(1, Math.round(Number(m.min)) || 1));
        rooms.set(rn, r);
        console.log(`[room ${rn}] created: ${r.course}, ${laps} laps, ${solo ? 'time trial' : `waits for ${r.min}`}`);
        const bots = solo ? 0 : Math.min(9, Math.max(0, Math.round(Number(m.bots)) || 0));
        if (bots) await r.addBots(bots, tick);
      } else if (m.min && !r.solo) r.min = Math.max(r.min, Math.min(10, Math.round(Number(m.min)) || 1));
      if (gone) return closeIfEmpty(r); // (closed, or replaced, while the room was made)
      if (elsewhere(r)) return refuse(r, 'track');
      entering = r;
      const p = await r.join({ id: newPlayerId(), wallet, name: shortWallet(wallet), car, send, sendBin, ready: false, ping: 0, auto: m.auto === true }, tick);
      entering = null;
      if (!p) {
        if (byWallet.get(wallet) === conn) byWallet.delete(wallet);
        wallet = null;
        return refuse(r, 'full');
      }
      if (gone) return leaveRoom(r, p); // (closed or replaced while its car loaded)
      room = r;
      me = p;
      console.log(`[room ${rn}] + ${p.name} (${wallet}, #${p.id}, ${car}) slot ${p.slot}; ${r.players.length} in the room`);
      send({ t: 'welcome', you: p.id, room: rn, track: r.course, laps: r.laps, tick });
      r.broadcastRoom();
      return;
    }
    if (!room || !me) return;
    if (m.t === 'ready') room.setReady(me, !!m.on);
    else if (m.t === 'car') {
      if (mayDrive(me.wallet, String(m.car))) room.setCar(me, String(m.car));
    } else if (m.t === 'leave') ws.close();
  });
  ws.on('close', () => {
    gone = true;
    if (wallet && byWallet.get(wallet) === conn) byWallet.delete(wallet);
    drop();
    const q = entering?.players.find((x) => x.send === send);
    if (entering && q) leaveRoom(entering, q);
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

http.listen(port, () => console.log(`RIPCARS drive server on ws://localhost:${port} (stats: http://localhost:${port}/stats; store ${DB_PATH})`));
