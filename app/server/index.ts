import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { WebSocketServer, type WebSocket } from 'ws';
import { isAddress, shortWallet } from '../src/auth/address.ts';
import { H, MAX_PLAYERS, PORT, STARTER_CAR, type C2S, type Leaderboard, type RoomListing, type S2C } from '../src/drive/net/protocol.ts';
import { COURSES, courseOf, isCourse } from '../src/drive/tracks/index.ts';
import { ALLOWED, handleAuth, ipOf, originOk, verifySession } from './auth.ts';
import { buildId } from './build-id.ts';
import { garageCached, garageOf } from './garage.ts';
import { mayDrive, newPlayerId, NOT_YOURS, Room, type Player } from './room.ts';
import { carName, trackOf } from './sim.ts';
import { board, DB_PATH, flushLaps, lapsWritten } from './store.ts';

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
// (POST /reset-stats zeroes them). Locked with STATS_KEY (env: ?key= or Authorization: Bearer <key>); without one they're
// open in dev and off (404) in production (NODE_ENV=production, or ALLOWED_ORIGINS without a localhost). Logs a line per
// room every 5 s. GET /rooms: the open rooms and the courses, for the lobby browser (online.html; RoomListing) - a time
// trial (a solo room) isn't listed. GET /leaderboard[?wallet=]: this week's best clean laps per track (store.ts;
// Leaderboard). GET /garage?wallet=: the wallet's Rip Cars (garage.ts). GET /version: the sim build id; GET /health:
// 200 while the server runs. Public GETs, open to any site (CORS *).
// The sim build id (build-id.ts): a join from a page with another is refused ('version': the page says a new version is
// out). SIGTERM (a deploy): no new joins or races, the players are told, and the server exits once no race is on (or
// after DRAIN_S); a second SIGTERM, or SIGINT, exits now.

const port = Number(process.env.PORT) || PORT;
const host = process.env.HOST || undefined; // (unset: every interface, IPv4 and IPv6)
const BUILD = buildId();
const BUILD_ID = BUILD.id;
console.log(`sim build ${BUILD_ID} (${BUILD.files.length} files)`);
const PROD = process.env.NODE_ENV === 'production' || !ALLOWED.some((o) => /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:|$)/.test(o));
const STATS_KEY = process.env.STATS_KEY ? Buffer.from(process.env.STATS_KEY, 'utf8') : null;
if (STATS_KEY && STATS_KEY.length < 16) console.warn('stats: STATS_KEY is short - use 16+ random characters.');
console.log(`stats: ${STATS_KEY ? 'locked with STATS_KEY' : PROD ? 'off (production, no STATS_KEY)' : 'open (dev, no STATS_KEY)'}`);
const DRAIN_S = Number(process.env.DRAIN_S) || 180; // s a SIGTERM waits for the races on to end
// abuse caps (one shared vCPU steps every room; env to tune): rooms open at once (time trials too), rooms with bots,
// sockets per IP (a venue's NAT: generous), seconds a socket may sit without joining, messages a connection may send a
// second (the page sends ~65)
const MAX_ROOMS = Number(process.env.MAX_ROOMS) || 16, MAX_BOT_ROOMS = Number(process.env.MAX_BOT_ROOMS) || 4;
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP) || 80;
const JOIN_WITHIN_S = Number(process.env.JOIN_WITHIN_S) || 20, MAX_MSGS_PER_S = Number(process.env.MAX_MSGS_PER_S) || 400;
const socketsByIp = new Map<string, number>();
const botRooms = new WeakSet<Room>(); // rooms made with bots (marked before the bots' cars load)
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
/** GET /garage's per-IP limit (each miss costs requests to RIPCARS or the chain): a burst of 100, then 100 a minute (a
 *  venue's NAT). A garage in the cache isn't counted; the server's own car checks (room.ts mayDrive) never are. */
const garageBuckets = new Map<string, { tokens: number; at: number }>();
function garageAllowed(ip: string) {
  const now = Date.now() / 1000, b = garageBuckets.get(ip) ?? { tokens: 100, at: now };
  b.tokens = Math.min(100, b.tokens + (now - b.at) * (100 / 60));
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

/** The leaderboard's answers, kept a few seconds and until the next lap is written: the board's queries are sync SQLite
 *  on the thread that steps the races, so a burst of page loads mustn't run them each time. */
const boardCache = new Map<string, { at: number; v: number; body: Leaderboard }>();
function cachedBoard(wallet: string | null): Leaderboard {
  const key = wallet ?? '', now = Date.now(), hit = boardCache.get(key);
  if (hit && hit.v === lapsWritten && now - hit.at < 5000) return hit.body;
  const body = leaderboard(wallet);
  if (boardCache.size > 1000) boardCache.clear();
  boardCache.set(key, { at: now, v: lapsWritten, body });
  return body;
}

/** /stats and /reset-stats: with STATS_KEY, the key (?key= or a Bearer header, compared in constant time); without one,
 *  open in dev and off in production. */
function statsAllowed(req: IncomingMessage, url: URL) {
  if (!STATS_KEY) return !PROD;
  const a = req.headers.authorization ?? '';
  const got = Buffer.from(a.startsWith('Bearer ') ? a.slice(7) : (url.searchParams.get('key') ?? ''), 'utf8');
  return got.length === STATS_KEY.length && timingSafeEqual(got, STATS_KEY);
}

const http = createServer(async (req, res) => {
  if (await handleAuth(req, res)) return;
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (url.pathname === '/health') return sendJson(res, 200, { ok: true, version: BUILD_ID, draining });
  if (url.pathname === '/version') return sendJson(res, 200, { version: BUILD_ID });
  if (url.pathname === '/leaderboard' && req.method === 'GET') {
    const w = url.searchParams.get('wallet');
    if (w !== null && w !== '' && !isAddress(w)) return sendJson(res, 400, { error: 'Not a wallet address' });
    try {
      return sendJson(res, 200, cachedBoard(w || null));
    } catch (e) {
      console.error('leaderboard:', e);
      return sendJson(res, 500, { error: 'Server error' });
    }
  }
  if (url.pathname === '/garage' && req.method === 'GET') {
    const w = url.searchParams.get('wallet') ?? '';
    if (!isAddress(w)) return sendJson(res, 400, { error: 'Not a wallet address' });
    if (!garageCached(w) && !garageAllowed(ipOf(req))) return sendJson(res, 429, { error: 'Too many requests. Try again in a minute.' });
    try {
      return sendJson(res, 200, await garageOf(w));
    } catch (e) {
      console.warn(`garage ${w}: ${(e as Error).message}`);
      return sendJson(res, 502, { error: "Can't reach RIPCARS right now" });
    }
  }
  if (url.pathname === '/rooms') {
    const body: RoomListing = {
      rooms: [...rooms.values()].filter((r) => !r.solo).map((r) => {
        const c = courseOf(isCourse(r.course) ? r.course : 'meadow');
        return {
          name: r.name, track: r.course, trackName: c.name, color: c.color, laps: r.laps, phase: r.phase, max: MAX_PLAYERS,
          players: r.info().map((p) => ({ name: p.name, wallet: p.wallet, car: p.car, carName: p.carName, bot: p.bot, ready: p.ready, host: p.id === r.host })),
        };
      }),
      courses: COURSES.map((c) => ({ id: c.id, name: c.name, color: c.color, blurb: c.blurb })),
      version: BUILD_ID,
    };
    return sendJson(res, 200, body);
  }
  if ((url.pathname === '/stats' || url.pathname === '/reset-stats') && !statsAllowed(req, url)) {
    res.writeHead(404, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return void res.end('Not found\n');
  }
  if (url.pathname === '/stats' && req.method === 'GET') {
    const up = nowMs() / 1000;
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(JSON.stringify({
      version: BUILD_ID, draining, tick, uptime: up, behind: stats.behind, stepUs: stats.step.json(), lateUs: stats.late.json(), gcUs: stats.gc.json(),
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
  if (url.pathname === '/reset-stats') {
    if (req.method !== 'POST') {
      res.writeHead(405, { allow: 'POST', 'content-type': 'text/plain' });
      return void res.end('POST only\n');
    }
    for (const r of rooms.values()) (r.stepTime = { n: 0, sum: 0, max: 0 }), (r.sendUs = r.simUs = 0);
    stats.step.reset(), stats.late.reset(), stats.gc.reset(), (stats.behind = 0);
    res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
    return void res.end('ok');
  }
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('RIPCARS drive server: connect a WebSocket (drive.html?online=1)\n');
});
// a browser's WebSocket only from the allowed origins (a client that isn't a browser sends none: it still needs a token)
const wss = new WebSocketServer({
  server: http, maxPayload: 16 * 1024, perMessageDeflate: false, // (ws's default, said: no compression of 20-200 B messages)
  verifyClient: (info: { origin?: string }, cb: (ok: boolean, code?: number, msg?: string) => void) => (originOk(info.origin || undefined) ? cb(true) : cb(false, 403, 'Origin not allowed')),
});

/** Every open connection's way to tell its player the server is restarting (the drain, below). */
const conns = new Set<{ restarting: (final: boolean) => void }>();
let draining = false;

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
  console.log(`[room ${r.name}] - ${p.name} (#${p.id})${p.send ? `: ${p.viol.late} late inputs, ${p.snaps} snapshots (${p.fulls} with a correction)` : ''}`);
  r.leave(p, tick);
  closeIfEmpty(r);
}

wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
  const ip = ipOf(req), open = (socketsByIp.get(ip) ?? 0) + 1;
  socketsByIp.set(ip, open);
  ws.on('close', () => {
    const n = (socketsByIp.get(ip) ?? 1) - 1;
    if (n > 0) socketsByIp.set(ip, n);
    else socketsByIp.delete(ip);
  });
  if (open > MAX_SOCKETS_PER_IP) return void ws.close(1013, 'too many connections');
  const idle = setTimeout(() => !me && ws.close(4003, 'join timeout'), JOIN_WITHIN_S * 1000);
  ws.on('close', () => clearTimeout(idle));
  let msgs = 0, msgWin = Date.now();
  let room: Room | null = null, me: Player | null = null, joining = false, wallet: string | null = null, gone = false;
  let entering: Room | null = null; // the room this connection's player is being added to (its car loading)
  let carAsks = 0; // car changes asked for (only the latest one's check counts)
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
    /** The server is restarting: say so (final: it's going now - the connection closes). */
    restarting(final: boolean) {
      if (final) {
        send({ t: 'error', code: 'restart', msg: 'The game server is restarting for an update' });
        ws.close(1012, 'restarting');
      } else if (me) send({ t: 'notice', code: 'restart', msg: 'The game server restarts after this race' });
    },
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
    const now = Date.now();
    if (now - msgWin >= 1000) (msgWin = now), (msgs = 0);
    if (++msgs > MAX_MSGS_PER_S) return void ws.close(1008, 'flood');
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
      if (m.v !== BUILD_ID) {
        send({ t: 'error', code: 'version', msg: 'A new version is out' });
        return void ws.close(4002, 'version');
      }
      if (draining) {
        send({ t: 'error', code: 'restart', msg: 'The game server is restarting for an update' });
        return void ws.close(1012, 'restarting');
      }
      const auth = verifySession(m.token);
      if (!auth) return send({ t: 'error', code: 'auth', msg: 'Sign in with your wallet to race' });
      joining = true;
      const rn = String(m.room ?? '').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
      // a car the wallet doesn't hold races as the starter (and the page is told: below)
      const asked = String(m.car).slice(0, 64), car = (await mayDrive(auth.wallet, asked)) ? asked : STARTER_CAR;
      if (gone) return;
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
      const wantBots = solo ? 0 : Math.min(9, Math.max(0, Math.round(Number(m.bots)) || 0));
      if (!r && (rooms.size >= MAX_ROOMS || (wantBots && [...rooms.values()].filter((x) => botRooms.has(x)).length >= MAX_BOT_ROOMS))) {
        joining = false;
        if (byWallet.get(wallet) === conn) byWallet.delete(wallet);
        wallet = null;
        return send({ t: 'error', code: 'full', msg: 'The server is busy right now: join an open room, or try again in a few minutes' });
      }
      if (!r) {
        r = new Room(rn, String(m.track), laps);
        r.solo = solo;
        r.min = solo ? 1 : Math.min(10, Math.max(1, Math.round(Number(m.min)) || 1));
        rooms.set(rn, r);
        console.log(`[room ${rn}] created: ${r.course}, ${laps} laps, ${solo ? 'time trial' : `waits for ${r.min}`}`);
        if (wantBots) {
          botRooms.add(r);
          await r.addBots(wantBots, tick);
        }
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
      if (car !== asked) send({ t: 'car', car, msg: NOT_YOURS });
      r.broadcastRoom();
      return;
    }
    if (!room || !me) return;
    if (m.t === 'auto') me.auto = true; // (the console's autopilot: one way, never back)
    else if (m.t === 'ready') room.setReady(me, !!m.on);
    else if (m.t === 'car') {
      // only a car the wallet holds (or the starter); refused, the player keeps the car it has (the page is told)
      const want = String(m.car).slice(0, 64), seq = ++carAsks, p = me, r = room;
      const ok = await mayDrive(p.wallet, want);
      if (seq !== carAsks || me !== p || room !== r) return; // (a later pick, or left, meanwhile)
      if (ok) r.setCar(p, want);
      else send({ t: 'car', car: p.car, msg: NOT_YOURS });
    } else if (m.t === 'leave') ws.close();
  });
  conns.add(conn);
  ws.on('close', () => {
    conns.delete(conn);
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

// the event loop's blocks (anything that holds it - a GC, a sync call - delays every step and snapshot behind it)
const loopDelay = monitorEventLoopDelay({ resolution: 5 });
loopDelay.enable();
let lastBytes = new Map<number, number>(), lastLate = new Map<number, number>();
setInterval(() => {
  for (const r of rooms.values()) {
    const st = r.stepWin;
    const ps = r.players.map((p) => {
      const kbs = ((p.bytesOut - (lastBytes.get(p.id) ?? 0)) / 5 / 1024).toFixed(1);
      const late = p.viol.late - (lastLate.get(p.id) ?? 0); // inputs that came after their step ran (the last one repeated)
      return p.send ? `${p.name}${p.ready ? '*' : ''} ${p.ping}ms ${kbs}KB/s${late ? ` ${late} late` : ''}` : p.name;
    });
    console.log(`[room ${r.name}] ${r.course} ${r.phase} race ${r.race} | ${r.players.length} cars: ${ps.join(', ')} | step ${st.n ? (st.sum / st.n).toFixed(0) : '-'} us avg, ${st.max.toFixed(0)} max`);
    st.n = st.sum = st.max = 0;
  }
  lastBytes = new Map([...rooms.values()].flatMap((r) => r.players.map((p) => [p.id, p.bytesOut] as [number, number])));
  lastLate = new Map([...rooms.values()].flatMap((r) => r.players.map((p) => [p.id, p.viol.late] as [number, number])));
  const blockMs = loopDelay.max / 1e6;
  loopDelay.reset();
  if (rooms.size) console.log(`server: steps late p50 ${(stats.late.q(0.5) / 1000).toFixed(2)} ms, p99 ${(stats.late.q(0.99) / 1000).toFixed(2)}, max ${(stats.late.max / 1000).toFixed(1)}; gc ${stats.gc.n} pauses, max ${(stats.gc.max / 1000).toFixed(1)} ms; loop blocked max ${blockMs.toFixed(1)} ms (5 s)`);
  if (stats.behind) console.log(`server: fell behind by ${stats.behind} steps (dropped)`), (stats.behind = 0);
}, 5000);

http.listen(port, host, () => console.log(`RIPCARS drive server on ws://${host ?? 'localhost'}:${port} (stats: http://localhost:${port}/stats; store ${DB_PATH})`));

// ---- shutting down. SIGTERM (a deploy, fly's stop): no new joins, no new races (Room.draining), every player told; out
// once no race is counting down or running, or after DRAIN_S. A second SIGTERM, or SIGINT (Ctrl+C): out now.
const racing = () => [...rooms.values()].filter((r) => r.phase === 'countdown' || r.phase === 'race');
function exitNow(why: string) {
  console.log(`server: exiting (${why})`);
  for (const c of conns) c.restarting(true);
  for (const r of rooms.values()) r.close(tick);
  flushLaps();
  http.close();
  setTimeout(() => process.exit(0), 300).unref(); // (the closes go out first)
}
function drain() {
  if (draining) return exitNow('second signal');
  draining = Room.draining = true;
  const n = racing().length;
  console.log(`server: SIGTERM - draining: no new joins or races; ${n ? `waiting for ${n} race(s) to end (up to ${DRAIN_S} s)` : 'no race on'}`);
  for (const c of conns) c.restarting(false);
  const until = Date.now() + DRAIN_S * 1000;
  const check = () => {
    if (!racing().length) return exitNow('no race on');
    if (Date.now() >= until) return exitNow(`${DRAIN_S} s up`);
    setTimeout(check, 500);
  };
  check();
}
process.on('SIGTERM', drain);
process.on('SIGINT', () => exitNow('SIGINT'));
