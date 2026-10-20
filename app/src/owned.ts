import { loadSession } from './auth/session';
import { STARTER_CAR, type GarageListing } from './drive/net/protocol';
import { serverHttp, serverUrl } from './drive/net/prefs';

// A wallet's garage (GET /garage on the game server: its Rip Cars, and which of them the game has a model of), asked
// once at a time per wallet per page and remembered per wallet in localStorage: the landing and the garage page open on
// the cars it held last time - your car at once, not the featured one first and then yours - while they ask again.
// And the cars this browser's wallet may race online - time trials, rooms, the leaderboard: its Rip Cars the game has a
// model of (the same list the server checks, room.ts mayDrive) plus the starter (STARTER_CAR), everyone's. Signed out:
// the starter. The server not answering: what the wallet's garage said last time, else the starter. A test drive (the
// drive page offline) takes any car.

const KEY = 'ripcars.owned.', GKEY = 'ripcars.garage.';
const KEEP = 30 * 86_400_000; // ms: a garage remembered longer ago than this is forgotten
const asked = new Map<string, Promise<Set<string>>>();
const asking = new Map<string, Promise<GarageAnswer>>();

export type GarageAnswer = { ok: true; garage: GarageListing } | { ok: false; status: number };

function remembered(wallet: string): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY + wallet) ?? '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The wallet's garage as the game server last listed it to this browser, or null. */
export function lastGarage(wallet: string): GarageListing | null {
  try {
    const g = JSON.parse(localStorage.getItem(GKEY + wallet) ?? 'null') as GarageListing | null;
    return g && g.wallet === wallet && Array.isArray(g.cars) && Date.now() - g.at < KEEP ? g : null;
  } catch {
    return null;
  }
}

/** GET /garage for `wallet` (a second ask while one is out joins it). A complete answer is remembered (lastGarage), and
 *  the cars it may race with it. status 0: no game server, or it didn't answer; 502: it couldn't reach RIPCARS. */
export function fetchGarage(wallet: string, http = serverHttp(serverUrl())): Promise<GarageAnswer> {
  let p = asking.get(wallet);
  if (!p) {
    p = (async (): Promise<GarageAnswer> => {
      if (!http) return { ok: false, status: 0 };
      try {
        const r = await fetch(`${http}/garage?wallet=${wallet}`, { cache: 'no-store', signal: AbortSignal.timeout(15_000) });
        if (!r.ok) return { ok: false, status: r.status };
        const garage = (await r.json()) as GarageListing;
        try {
          localStorage.setItem(KEY + wallet, JSON.stringify([...new Set(garage.cars.map((c) => c.model).filter((m): m is string => !!m))]));
          if (!garage.partial) localStorage.setItem(GKEY + wallet, JSON.stringify(garage));
        } catch {
          // no storage
        }
        return { ok: true, garage };
      } catch {
        return { ok: false, status: 0 };
      }
    })().finally(() => asking.delete(wallet));
    asking.set(wallet, p);
  }
  return p;
}

/** The cars `wallet` (default: the signed-in one) may race, the starter first. Asked once per page per wallet. */
export function raceableCars(wallet: string | null = loadSession()?.wallet ?? null): Promise<Set<string>> {
  if (!wallet) return Promise.resolve(new Set([STARTER_CAR]));
  let p = asked.get(wallet);
  if (!p) {
    p = fetchGarage(wallet).then((a) => new Set([STARTER_CAR, ...(a.ok ? a.garage.cars.map((c) => c.model).filter((m): m is string => !!m) : remembered(wallet))]));
    asked.set(wallet, p);
  }
  return p;
}
