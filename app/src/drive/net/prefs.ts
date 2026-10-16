import { PORT } from './protocol';

// What the online pages share: the player's name and car (remembered in localStorage), where the game server is, and
// the link into a room (the drive page with ?online=1 - what the lobby browser's Join / Create and the invite link open).

const NAME_KEY = 'ripcars.drive.name', CAR_KEY = 'ripcars.online.car';
export const DEFAULT_CAR = 'skyline-hck01';

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
export const savedName = () => get(NAME_KEY);
export const saveName = (n: string) => put(NAME_KEY, n);
export const savedCar = () => get(CAR_KEY);
export const saveCar = (id: string) => put(CAR_KEY, id);
export const randomName = () => `Driver ${100 + Math.floor(Math.random() * 900)}`;
/** As the server keeps them: letters, digits, space, _ . - and 20 long. */
export const cleanName = (s: string) => s.replace(/[^\p{L}\p{N} _.-]/gu, '').slice(0, 20).trim();
/** A room's name as the server keeps it: a-z 0-9 _ - and 32 long. */
export const cleanRoom = (s: string) => s.toLowerCase().replace(/\s+/g, '-').replace(/[^a-z0-9_-]/g, '').slice(0, 32);

/** The game server's WebSocket (?server=ws://host:port, else this host on PORT) and its HTTP side (GET /rooms). */
export function serverUrl(q = new URLSearchParams(location.search)) {
  return q.get('server') ?? `ws://${location.hostname || 'localhost'}:${PORT}`;
}
export const serverHttp = (ws: string) => ws.replace(/^ws/, 'http');

/** The drive page in a room. `invite`: the link to share (no name or car: the friend brings their own). */
export function roomHref(room: string, track: string, laps: number, o: { name?: string; car?: string; bots?: number; server?: string | null; absolute?: boolean } = {}) {
  const p = new URLSearchParams({ online: '1', room, track, laps: String(laps) });
  if (o.car) p.set('car', o.car);
  if (o.name) p.set('name', o.name);
  if (o.bots) p.set('bots', String(o.bots));
  if (o.server) p.set('server', o.server);
  return `${o.absolute ? location.origin : ''}/drive.html?${p}`;
}
