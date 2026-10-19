import { isAddress } from './address';

// The wallet sign-in this browser holds, shared by every page and tab (localStorage): the game server's session token -
// all racing needs - the wallet's address (your name in races), when the token expires, and the wallet's name and icon
// for the top bar. A valid one survives reloads without signing again; Disconnect clears it; an expired one reads as
// none, and so does one the server turns down (checkSession: it restarted with a new secret, say). Storage can be
// missing (private mode): then the sign-in lasts as long as the page. Nothing here loads a wallet (auth/wallets.ts
// does, when you connect), so every page can show the top bar's wallet chip for free.

export interface Session {
  token: string;
  wallet: string; // the address
  exp: number; // the token's expiry (unix seconds)
  name: string; // the wallet that signed (Phantom, Solflare, ...) ...
  icon: string; // ... and its icon (a data: URI, as the Wallet Standard has it; '' if it had none we'd show)
}

const KEY = 'ripcars.session';
const EVENT = 'ripcars:session';
const MARGIN = 60; // s: a token this close to its expiry counts as expired (it could lapse on the way to the server)
let mem: Session | null = null; // (no storage: the page's own copy)

/** A wallet's icon, if it's an image data URI (the only kind the Wallet Standard allows): anything else shows none. */
export const safeIcon = (s: unknown) => (typeof s === 'string' && s.length < 200_000 && /^data:image\/(svg\+xml|webp|png|gif);base64,[A-Za-z0-9+/]+=*$/.test(s) ? s : '');

function valid(o: unknown): Session | null {
  const s = o as Partial<Session> | null;
  if (!s || typeof s.token !== 'string' || !isAddress(s.wallet) || typeof s.exp !== 'number') return null;
  if (s.exp - MARGIN <= Date.now() / 1000) return null;
  return { token: s.token, wallet: s.wallet, exp: s.exp, name: typeof s.name === 'string' ? s.name.slice(0, 40) : '', icon: safeIcon(s.icon) };
}

/** The sign-in, or null (none, expired or unreadable: those are cleared). */
export function loadSession(): Session | null {
  let raw: string | null;
  try {
    raw = localStorage.getItem(KEY);
  } catch {
    return (mem = valid(mem));
  }
  if (!raw) return null;
  let s: Session | null = null;
  try {
    s = valid(JSON.parse(raw));
  } catch {
    // unreadable: cleared below
  }
  if (!s) clearSession();
  return s;
}

export function saveSession(s: Session) {
  mem = s;
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch {
    // no storage: this page keeps it (mem)
  }
  dispatchEvent(new Event(EVENT));
}

export function clearSession() {
  const had = mem !== null || stored();
  mem = null;
  try {
    localStorage.removeItem(KEY);
  } catch {
    // no storage
  }
  if (had) dispatchEvent(new Event(EVENT));
}
function stored() {
  try {
    return localStorage.getItem(KEY) !== null;
  } catch {
    return false;
  }
}

/** Calls back with the sign-in whenever it changes - on this page or in another tab. Returns the unsubscribe. */
export function onSession(cb: (s: Session | null) => void): () => void {
  const local = () => cb(loadSession());
  const other = (e: StorageEvent) => e.key === KEY || e.key === null ? cb(loadSession()) : undefined;
  addEventListener(EVENT, local);
  addEventListener('storage', other);
  return () => {
    removeEventListener(EVENT, local);
    removeEventListener('storage', other);
  };
}

/** Asks the game server (its HTTP base) whether it still takes the remembered token (GET /auth/session): 'bad' clears
 *  it (signed out); 'unknown' when the server can't be reached (kept: racing will tell). */
export async function checkSession(http: string): Promise<'ok' | 'bad' | 'none' | 'unknown'> {
  const s = loadSession();
  if (!s) return 'none';
  if (!http) return 'unknown'; // (no game server here)
  try {
    const r = await fetch(`${http}/auth/session`, { headers: { authorization: `Bearer ${s.token}` }, cache: 'no-store' });
    const j = r.ok ? ((await r.json()) as { wallet?: string | null }) : null;
    if (j?.wallet === s.wallet) return 'ok';
    if (j) {
      if (loadSession()?.token === s.token) clearSession(); // (unless a new sign-in replaced it meanwhile)
      return 'bad';
    }
  } catch {
    // no server
  }
  return 'unknown';
}
