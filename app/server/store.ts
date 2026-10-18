import { mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

// The game server's store: built-in node:sqlite, one file in DATA_DIR (env; default server/data/, git-ignored).
//  - laps: every lap a signed-in player completes in an online race (never a bot's) - wallet, car, track (and its lap
//    length: a re-laid track starts a new board), the lap time in sim steps exactly as the race reports it, the lap's
//    number, the room, its race number and the race's log (replay.ts re-simulates it), the server's time, how many cars
//    raced, and whether the car touched another car during the lap (`contact`) or in the 3 s before it began (`pre`: a
//    push over the line carries into the lap). `auto`: the page said its autopilot drove (?auto=1). The weekly
//    leaderboard counts only clean laps: no contact either way, not the autopilot's - so no push from another car or a
//    bot can make a record.
//  - toys: each Rip Car's toy number (the NFT's 'Toy #', looked up once per mint - it never changes; garage.ts).
// Laps are queued and written outside the race's step (one transaction a turn of the event loop).

export const DATA_DIR = resolve(process.env.DATA_DIR || new URL('./data/', import.meta.url).pathname);
mkdirSync(DATA_DIR, { recursive: true });
export const DB_PATH = join(DATA_DIR, 'store.sqlite');
const db = new DatabaseSync(DB_PATH);
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  CREATE TABLE IF NOT EXISTS laps (
    id INTEGER PRIMARY KEY,
    wallet TEXT NOT NULL,
    car TEXT NOT NULL,
    track TEXT NOT NULL,
    len INTEGER NOT NULL,      -- the track's lap length (u, rounded): a re-laid track is another board
    steps INTEGER NOT NULL,    -- the lap time in sim steps (1/120 s), as the race reports it
    lap INTEGER NOT NULL,      -- the lap's number in its race (1 = the standing start)
    room TEXT NOT NULL,
    race INTEGER NOT NULL,     -- the room's race number
    log TEXT NOT NULL,         -- the race's input log (server/logs/...): replay.ts re-simulates it
    at INTEGER NOT NULL,       -- server time, unix ms
    cars INTEGER NOT NULL,     -- cars in the race (bots included): 1 = a time trial
    contact INTEGER NOT NULL,  -- 1: touched another car during the lap
    pre INTEGER NOT NULL,      -- 1: touched another car in the 3 s before the lap began
    auto INTEGER NOT NULL      -- 1: the page's autopilot drove (?auto=1)
  );
  CREATE INDEX IF NOT EXISTS laps_board ON laps (track, len, at);
  CREATE TABLE IF NOT EXISTS toys (mint TEXT PRIMARY KEY, toy TEXT NOT NULL, at INTEGER NOT NULL);
`);

export interface Lap {
  wallet: string; car: string; track: string; len: number; steps: number; lap: number; room: string; race: number; log: string;
  at: number; cars: number; contact: boolean; pre: boolean; auto: boolean;
}

const insert = db.prepare(`INSERT INTO laps (wallet, car, track, len, steps, lap, room, race, log, at, cars, contact, pre, auto)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
const queue: Lap[] = [];
let flushing = false;
/** Write the queued laps now (one transaction). */
export function flushLaps() {
  flushing = false;
  if (!queue.length) return;
  const rows = queue.splice(0);
  try {
    db.exec('BEGIN');
    for (const l of rows) {
      insert.run(l.wallet, l.car, l.track, l.len, l.steps, l.lap, l.room, l.race, l.log, l.at, l.cars, l.contact ? 1 : 0, l.pre ? 1 : 0, l.auto ? 1 : 0);
    }
    db.exec('COMMIT');
  } catch (e) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // (nothing open)
    }
    console.error('store: laps not written', e, rows);
  }
}
/** Record a lap (queued: written once the race's step is over). */
export function recordLap(l: Lap) {
  queue.push(l);
  if (!flushing) {
    flushing = true;
    setImmediate(flushLaps);
  }
}

const DAY = 86_400_000;
/** The ISO week `now` is in: from Monday 00:00 UTC to the next (ms). */
export function weekOf(now = Date.now()) {
  const d = new Date(now);
  const start = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) - ((d.getUTCDay() + 6) % 7) * DAY;
  return { start, end: start + 7 * DAY };
}

export interface BoardRow { rank: number; wallet: string; car: string; steps: number; at: number; room: string; race: number; lap: number }
// a wallet's best clean lap this week on a track (its first, on a tie), one row per wallet
const BEST = `SELECT id, wallet, car, steps, at, room, race, lap FROM (
    SELECT id, wallet, car, steps, at, room, race, lap, ROW_NUMBER() OVER (PARTITION BY wallet ORDER BY steps, at, id) AS rn
    FROM laps WHERE track = ? AND len = ? AND at >= ? AND at < ? AND contact = 0 AND pre = 0 AND auto = 0
  ) WHERE rn = 1`;
const topQ = db.prepare(`${BEST} ORDER BY steps, at, id LIMIT ?`);
const countQ = db.prepare(`SELECT COUNT(DISTINCT wallet) AS n FROM laps WHERE track = ? AND len = ? AND at >= ? AND at < ? AND contact = 0 AND pre = 0 AND auto = 0`);
const youQ = db.prepare(`WITH best AS (${BEST})
  SELECT b.*, 1 + (SELECT COUNT(*) FROM best o WHERE o.steps < b.steps OR (o.steps = b.steps AND (o.at < b.at OR (o.at = b.at AND o.id < b.id)))) AS rank
  FROM best b WHERE b.wallet = ?`);

type Raw = { id: number; wallet: string; car: string; steps: number; at: number; room: string; race: number; lap: number; rank?: number };
const row = (r: Raw, rank: number): BoardRow => ({ rank, wallet: r.wallet, car: r.car, steps: r.steps, at: r.at, room: r.room, race: r.race, lap: r.lap });

/** One track's board for the week `now` is in: the top `n` (each wallet's best clean lap), how many wallets are on it,
 *  and `wallet`'s best and rank (null: none this week). */
export function board(track: string, len: number, wallet: string | null, now = Date.now(), n = 10) {
  const w = weekOf(now);
  const top = (topQ.all(track, len, w.start, w.end, n) as Raw[]).map((r, i) => row(r, i + 1));
  const drivers = Number((countQ.get(track, len, w.start, w.end) as { n: number }).n);
  const y = wallet ? (youQ.get(track, len, w.start, w.end, wallet) as Raw | undefined) : undefined;
  return { top, drivers, you: y ? row(y, Number(y.rank)) : null, weekStart: w.start, weekEnd: w.end };
}

// ---- toy numbers by mint
const toyGet = db.prepare('SELECT toy FROM toys WHERE mint = ?');
const toyPut = db.prepare('INSERT OR REPLACE INTO toys (mint, toy, at) VALUES (?, ?, ?)');
export const toyOf = (mint: string) => (toyGet.get(mint) as { toy: string } | undefined)?.toy ?? null;
export const saveToy = (mint: string, toy: string) => void toyPut.run(mint, toy, Date.now());

/** Tests: every lap row as stored (0 / 1 for the flags), oldest first. */
export const allLaps = () => db.prepare('SELECT * FROM laps ORDER BY id').all() as Record<string, string | number>[];
