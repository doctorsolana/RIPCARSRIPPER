import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { SolanaSignInInput } from '@solana/wallet-standard-features';
import { parseSignInMessage, verifySignIn } from '@solana/wallet-standard-util';
import { isAddress } from '../src/auth/address.ts';

// Wallet sign-in: Sign In With Solana, verified here - the game server is the only backend - and the session tokens a
// join must carry (index.ts). The wallet address IS the player: no names to pick.
//
//   POST /auth/challenge  -> { input }: the whole sign-in request, made here - domain and uri from the page's origin (only
//                            ALLOWED_ORIGINS), a statement, version 1, chain mainnet, a random single-use nonce, issued
//                            now, expiring in 10 min - and remembered by its nonce (in memory: expiring, capped, and
//                            rate-limited per IP).
//   POST /auth/verify     {nonce, output: {account: {address, publicKey}, signedMessage, signature}} (bytes as base64)
//                         -> { token, wallet, exp }: the input from OUR record of the nonce (never the client's), burned
//                            on the first try, good or bad; the address must be the public key's (base58), and the
//                            signed message the one the request describes (verifySignIn), signed by that key.
//   GET /auth/session     (Authorization: Bearer <token>) -> { wallet, exp }, or { wallet: null } for a token it doesn't
//                         take (not a 401: that's an answer, not an error - a browser would log it): the lobby checks a
//                         remembered sign-in with it.
//
// A token is HMAC-SHA256 over {wallet, iat, exp} with AUTH_SECRET, good for 24 h, checked without any state (verifySession).
// Another proof of a wallet (a Privy login, say) would end in the same issueSession(). CORS on /auth only for the allowed
// origins; a browser's WebSocket from any other origin is refused (originOk, in index.ts).
//
// env: AUTH_SECRET (unset: a random secret per process, with a warning - every sign-in ends when the server restarts),
// ALLOWED_ORIGINS (comma list; default the dev server's http://localhost:5199 and http://127.0.0.1:5199), TRUST_PROXY=1
// (behind a reverse proxy: the client's IP is the last X-Forwarded-For hop, for the rate limits), AUTH_CHALLENGE_TTL
// (seconds a sign-in request lasts, default 600: tests).

export const ALLOWED = (process.env.ALLOWED_ORIGINS ?? 'http://localhost:5199,http://127.0.0.1:5199')
  .split(',').map((s) => s.trim().replace(/\/+$/, '').toLowerCase()).filter(Boolean);
const SECRET = process.env.AUTH_SECRET ? Buffer.from(process.env.AUTH_SECRET, 'utf8') : randomBytes(32);
const CHALLENGE_TTL = (Number(process.env.AUTH_CHALLENGE_TTL) || 600) * 1000; // ms
const SESSION_TTL = 24 * 3600; // s
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const STATEMENT = 'Sign in to race on racecars. Free, no transaction: it only proves this wallet is yours.';
const MAX_PENDING = 10_000; // sign-in requests remembered at once (all IPs)
const RATE = { challenge: [150, 150 / 60], verify: [150, 150 / 60] } as const; // per IP: a burst, then per second (150 a minute: a venue's
// wifi or a carrier's NAT puts dozens of people behind one IP)

if (!process.env.AUTH_SECRET) {
  console.warn('auth: AUTH_SECRET is not set - using a random secret for this process, so every sign-in ends when the server restarts. Set AUTH_SECRET (32+ random characters) in production.');
} else if (process.env.AUTH_SECRET.length < 32) console.warn('auth: AUTH_SECRET is short - use 32+ random characters.');
console.log(`auth: sign-in allowed from ${ALLOWED.join(', ')}`);

/** A browser's Origin header is on the list (none: not a browser - allowed, it still needs a valid token to join). */
export const originOk = (origin: string | undefined) => origin === undefined || ALLOWED.includes(origin.toLowerCase());

// ---- session tokens: base64url(JSON {w, iat, exp}) . base64url(HMAC-SHA256(AUTH_SECRET, that))
const mac = (body: string) => createHmac('sha256', SECRET).update(body).digest('base64url');

/** A session for a wallet whose ownership was just proven (here: a SIWS signature). */
export function issueSession(wallet: string, now = Math.floor(Date.now() / 1000)) {
  const exp = now + SESSION_TTL;
  const body = Buffer.from(JSON.stringify({ w: wallet, iat: now, exp })).toString('base64url');
  return { token: `${body}.${mac(body)}`, exp };
}

/** The wallet a token was issued to, or null: not ours (forged or tampered with), malformed or expired. */
export function verifySession(token: unknown): { wallet: string; exp: number } | null {
  if (typeof token !== 'string' || token.length > 600) return null;
  const dot = token.indexOf('.');
  if (dot < 1 || token.indexOf('.', dot + 1) >= 0) return null;
  const body = token.slice(0, dot), got = Buffer.from(token.slice(dot + 1)), want = Buffer.from(mac(body));
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  let p: { w?: unknown; iat?: unknown; exp?: unknown };
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
  const now = Date.now() / 1000;
  if (!p || !isAddress(p.w) || typeof p.iat !== 'number' || typeof p.exp !== 'number') return null;
  if (p.exp <= now || p.iat > now + 60 || p.exp - p.iat > SESSION_TTL) return null;
  return { wallet: p.w, exp: p.exp };
}

// ---- base58 (the address of a public key)
const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
export function base58(bytes: Uint8Array): string {
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  let s = '';
  while (n > 0n) {
    s = B58[Number(n % 58n)] + s;
    n /= 58n;
  }
  for (let i = 0; i < bytes.length && bytes[i] === 0; i++) s = '1' + s;
  return s;
}

// ---- sign-in requests (by nonce) and the per-IP rate limits
interface Pending { input: SolanaSignInInput; origin: string; exp: number }
const pending = new Map<string, Pending>();
const buckets = { challenge: new Map<string, { tokens: number; at: number }>(), verify: new Map<string, { tokens: number; at: number }>() };
function allow(kind: keyof typeof buckets, ip: string) {
  const [burst, perS] = RATE[kind], now = Date.now() / 1000, m = buckets[kind];
  const b = m.get(ip) ?? { tokens: burst, at: now };
  b.tokens = Math.min(burst, b.tokens + (now - b.at) * perS);
  b.at = now;
  m.set(ip, b);
  if (b.tokens < 1) return false;
  b.tokens--;
  return true;
}
setInterval(() => {
  const now = Date.now();
  for (const [k, p] of pending) if (p.exp <= now) pending.delete(k);
  for (const [kind, m] of Object.entries(buckets)) {
    const [burst, perS] = RATE[kind as keyof typeof buckets];
    for (const [ip, b] of m) if (b.tokens + (now / 1000 - b.at) * perS >= burst) m.delete(ip); // full again: forget it
  }
}, 60_000).unref();

/** The client's IP (behind a proxy with TRUST_PROXY=1: the last X-Forwarded-For hop), for the rate limits. */
export function ipOf(req: IncomingMessage) {
  if (TRUST_PROXY) {
    const hops = String(req.headers['x-forwarded-for'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
    if (hops.length) return hops[hops.length - 1]; // (what the proxy in front saw: the earlier hops are the client's say)
  }
  return req.socket.remoteAddress ?? '?';
}

class HttpError extends Error {
  status: number;
  constructor(status: number, msg: string) {
    super(msg);
    this.status = status;
  }
}
function readJson(req: IncomingMessage, max = 8192): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > max) {
        reject(new HttpError(413, 'Too large'));
        req.destroy();
      } else chunks.push(c);
    });
    req.on('end', () => {
      try {
        const o = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
        resolve(o && typeof o === 'object' ? o : {});
      } catch {
        reject(new HttpError(400, 'Not JSON'));
      }
    });
    req.on('error', reject);
  });
}
/** Base64 that decodes to `min`..`max` bytes, strictly (no stray characters), else null. */
function bytes(s: unknown, min: number, max = min): Uint8Array | null {
  if (typeof s !== 'string' || s.length > 4 * Math.ceil(max / 3) || !/^[A-Za-z0-9+/]*={0,2}$/.test(s)) return null;
  const b = Buffer.from(s, 'base64');
  return b.length >= min && b.length <= max ? new Uint8Array(b) : null;
}

function challenge(origin: string) {
  if (pending.size >= MAX_PENDING) {
    const now = Date.now();
    for (const [k, p] of pending) if (p.exp <= now) pending.delete(k);
    if (pending.size >= MAX_PENDING) throw new HttpError(503, 'Too many sign-ins at once. Try again in a minute.');
  }
  const now = Date.now();
  const input: SolanaSignInInput = {
    domain: new URL(origin).host, statement: STATEMENT, uri: origin, version: '1', chainId: 'mainnet',
    nonce: randomBytes(16).toString('hex'), issuedAt: new Date(now).toISOString(), expirationTime: new Date(now + CHALLENGE_TTL).toISOString(),
  };
  pending.set(input.nonce!, { input, origin, exp: now + CHALLENGE_TTL });
  return { input };
}

function verify(body: Record<string, unknown>, origin: string) {
  const nonce = typeof body.nonce === 'string' ? body.nonce : '';
  const rec = pending.get(nonce);
  if (rec) pending.delete(nonce); // single use: the first try burns it, good or bad
  if (!rec || rec.exp <= Date.now()) throw new HttpError(401, 'That sign-in request expired or was already used. Try again.');
  if (rec.origin !== origin) throw new HttpError(401, 'That sign-in request was made for another site.');
  const out = (body.output ?? {}) as { account?: { address?: unknown; publicKey?: unknown }; signedMessage?: unknown; signature?: unknown };
  const publicKey = bytes(out.account?.publicKey, 32), signature = bytes(out.signature, 64), signedMessage = bytes(out.signedMessage, 1, 2048);
  if (!publicKey || !signature || !signedMessage) throw new HttpError(400, 'That sign-in is malformed.');
  const wallet = base58(publicKey);
  // (verifySignIn checks the signature against the key, but not that the address in the message - or the one the wallet
  // reports - is that key's: a signature by one key claiming another's address must not pass)
  if (out.account?.address !== wallet) throw new HttpError(401, "The wallet's address isn't its key's.");
  if (parseSignInMessage(signedMessage)?.address !== wallet) throw new HttpError(401, 'The signed message names another address.');
  let ok = false;
  try {
    ok = verifySignIn(rec.input, { account: { address: wallet, publicKey, chains: [], features: [] }, signedMessage, signature });
  } catch {
    ok = false;
  }
  if (!ok) throw new HttpError(401, "The signature doesn't match this sign-in request.");
  const s = issueSession(wallet);
  console.log(`auth: signed in ${wallet} (${origin})`);
  return { token: s.token, wallet, exp: s.exp };
}

function json(res: ServerResponse, status: number, body: unknown, origin?: string) {
  const h: Record<string, string> = { 'content-type': 'application/json', 'cache-control': 'no-store' };
  if (origin) Object.assign(h, { 'access-control-allow-origin': origin, vary: 'Origin' });
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

/** The /auth/ routes. Returns false for any other URL (index.ts serves those). */
export async function handleAuth(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const path = (req.url ?? '').split('?')[0];
  if (!path.startsWith('/auth/')) return false;
  const hdr = req.headers.origin;
  if (hdr !== undefined && !originOk(hdr)) {
    json(res, 403, { error: 'This site may not sign in here.' }); // (no CORS headers: the browser hides even this)
    return true;
  }
  // the page this is for: the browser's Origin, or - not a browser - the first allowed origin
  const origin = hdr ?? ALLOWED[0];
  const cors = hdr; // CORS headers only for a browser on the list
  if (!origin) {
    json(res, 403, { error: 'No site may sign in here (ALLOWED_ORIGINS is empty).' });
    return true;
  }
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': hdr ?? '*', vary: 'Origin', 'access-control-allow-methods': 'GET, POST',
      'access-control-allow-headers': 'content-type, authorization', 'access-control-max-age': '600',
    });
    res.end();
    return true;
  }
  const ip = ipOf(req);
  try {
    if (path === '/auth/challenge' && req.method === 'POST') {
      if (!allow('challenge', ip)) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
      await readJson(req, 1024);
      json(res, 200, challenge(origin), cors);
    } else if (path === '/auth/verify' && req.method === 'POST') {
      if (!allow('verify', ip)) throw new HttpError(429, 'Too many sign-in attempts. Wait a minute and try again.');
      json(res, 200, verify(await readJson(req), origin), cors);
    } else if (path === '/auth/session' && req.method === 'GET') {
      const a = req.headers.authorization ?? '';
      json(res, 200, verifySession(a.startsWith('Bearer ') ? a.slice(7) : '') ?? { wallet: null }, cors);
    } else throw new HttpError(404, 'No such route');
  } catch (e) {
    const status = e instanceof HttpError ? e.status : 500;
    if (status === 500) console.error('auth:', e);
    if (!res.headersSent) json(res, status, { error: e instanceof HttpError ? e.message : 'Server error' }, cors);
  }
  return true;
}
