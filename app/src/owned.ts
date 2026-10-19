import { loadSession } from './auth/session';
import { STARTER_CAR, type GarageListing } from './drive/net/protocol';
import { serverHttp, serverUrl } from './drive/net/prefs';

// The cars this browser's wallet may race online - time trials, rooms, the leaderboard: its Rip Cars the game has a
// model of (GET /garage on the game server: the same list the server checks, room.ts mayDrive) plus the starter
// (STARTER_CAR), everyone's. Signed out: the starter. The server not answering: what the wallet's garage said last time
// (kept per wallet in localStorage), else the starter. A test drive (the drive page offline) takes any car.

const KEY = 'ripcars.owned.';
const asked = new Map<string, Promise<Set<string>>>();

function remembered(wallet: string): string[] {
  try {
    const a = JSON.parse(localStorage.getItem(KEY + wallet) ?? '[]');
    return Array.isArray(a) ? a.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/** The cars `wallet` (default: the signed-in one) may race, the starter first. Asked once per page per wallet. */
export function raceableCars(wallet: string | null = loadSession()?.wallet ?? null): Promise<Set<string>> {
  if (!wallet) return Promise.resolve(new Set([STARTER_CAR]));
  let p = asked.get(wallet);
  if (!p) {
    p = (async () => {
      const http = serverHttp(serverUrl());
      let models = remembered(wallet);
      if (http) {
        try {
          const r = await fetch(`${http}/garage?wallet=${wallet}`, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
          if (r.ok) {
            const g = (await r.json()) as GarageListing;
            models = [...new Set(g.cars.map((c) => c.model).filter((m): m is string => !!m))];
            try {
              localStorage.setItem(KEY + wallet, JSON.stringify(models));
            } catch {
              // no storage
            }
          }
        } catch {
          // offline: what it said last time
        }
      }
      return new Set([STARTER_CAR, ...models]);
    })();
    asked.set(wallet, p);
  }
  return p;
}
