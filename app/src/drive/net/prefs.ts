import { PORT, STARTER_CAR } from './protocol';

// What the online pages share: the player's car (remembered in localStorage), where the game server is, and the link
// into a room (the drive page with ?online=1 - what the lobby browser's Join / Create and the invite link open). Who you
// are is your wallet's sign-in (auth/session.ts), not a setting.

const CAR_KEY = 'ripcars.online.car';
export const DEFAULT_CAR = STARTER_CAR; // (online, the car everyone may race)

function get(key: string) {
  try {
    return localStorage.getItem(key) ?? '';
  } catch {
    return ''; // no storage (private mode): nothing remembered
  }
}
function put(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    // no storage
  }
}
export const savedCar = () => get(CAR_KEY);
export const saveCar = (id: string) => put(CAR_KEY, id);
/** A room's name as the server keeps it: a-z 0-9 _ - and 32 long. */
export const cleanRoom = (s: string) => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);

/** The game server's WebSocket: ?server=ws://host:port, else the build's VITE_GAME_SERVER (the hosted site:
 *  wss://play.racecars.fun, say), else this host on PORT (the local demo) - but never a plain ws:// one from an https
 *  page (a browser blocks it as mixed content): there, with no server set, it's '' - none, the online parts say offline.
 *  Its HTTP side serves GET /rooms, /leaderboard, /garage and /auth. */
export function serverUrl(q = new URLSearchParams(location.search)) {
  const set = q.get('server') ?? (import.meta.env.VITE_GAME_SERVER as string | undefined);
  if (set) return set;
  return location.protocol === 'https:' ? '' : `ws://${location.hostname || 'localhost'}:${PORT}`;
}
/** Its HTTP side ('' for none). */
export const serverHttp = (ws: string) => ws.replace(/^ws/, 'http');

/** The drive page in a room (the invite link is the same, `absolute`: the friend brings their own wallet and car).
 *  `solo`: a time trial - a room of your own (no bots, no one else). `dev`: the link turns dev mode on (no wallet needed). */
export function roomHref(room: string, track: string, laps: number, o: { car?: string; bots?: number; server?: string | null; absolute?: boolean; solo?: boolean; dev?: boolean } = {}) {
  const p = new URLSearchParams({ online: '1', room, track, laps: String(laps) });
  if (o.solo) p.set('solo', '1');
  if (o.dev) p.set('dev', '1');
  if (o.car) p.set('car', o.car);
  if (o.bots) p.set('bots', String(o.bots));
  if (o.server) p.set('server', o.server);
  return `${o.absolute ? location.origin : ''}/drive.html?${p}`;
}
