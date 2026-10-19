import { readdirSync, readFileSync } from 'node:fs';
import type { GarageListing } from '../src/drive/net/protocol.ts';
import { CARS_DIR, carName, loadSpec } from './sim.ts';
import { saveToy, toyOf } from './store.ts';

// GET /garage?wallet=<address>: a wallet's Rip Cars, from RIPCARS's public API - fetched here, as it has no toy number
// in its list and no CORS for other sites. my-cars (cached 60 s per wallet) gives each car's mint, name, rarity, photo
// and value; each mint's toy number comes from its asset record (once: kept in the store for good, three lookups at a
// time). A toy number the game has a car for (asset-generation/assets/cars/<id>/meta.json "toy" - the reference
// manifest's product_code, the NFT's 'Toy #' attribute) maps to that car: drivable. The cars are Metaplex Core assets of
// the Rip Cars collection (DiRqf7eyipQ7nPKtjWzFUZRyWT3M63GC75qyMDHe9Z81); racing doesn't check ownership yet
// (room.ts mayDrive). RIPCARS_API (env) points at another API base (tests). With HELIUS_RPC_URL set (a DAS-capable RPC;
// keep it in server/.env, never in the repo or the page) the garage comes from the chain instead: loadOnChain below.

const API = (process.env.RIPCARS_API || 'https://app.ripcars.io/api/gacha').replace(/\/+$/, '');
const TTL = 60_000; // ms a wallet's garage is kept
const STALE = 10 * 60_000; // ... and served anyway, marked stale, while RIPCARS doesn't answer
const WAIT = 6000; // ms a request waits for toy numbers still being looked up (then answers partial: ask again)
const LOOKUPS = 3; // asset lookups at once (all wallets)
const MAX_WALLETS = 2000; // garages kept in memory

/** A car: RIPCARS's fields, its toy number (null: not known yet, or RIPCARS has none) and the game's car with that toy
 *  number (`model`: drivable). */
type GarageCar = GarageListing['cars'][number];
type Garage = GarageListing;

const str = (v: unknown, max = 160) => (typeof v === 'string' && v ? v.slice(0, max) : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const https = (v: unknown) => (typeof v === 'string' && v.length < 600 && /^https:\/\/[^\s"'<>\\]+$/.test(v) ? v : null);
const isMint = (v: unknown): v is string => typeof v === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(v);

async function getJson(url: string): Promise<unknown> {
  const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { accept: 'application/json' } });
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.json();
}

// ---- toy number -> the game's car (each car folder's meta.json "toy"; re-read once a minute)
let toyCars = new Map<string, string>(), toyCarsAt = 0;
export function carsByToy() {
  if (Date.now() - toyCarsAt < 60_000) return toyCars;
  const m = new Map<string, string>();
  for (const id of readdirSync(CARS_DIR)) {
    try {
      const meta = JSON.parse(readFileSync(`${CARS_DIR}${id}/meta.json`, 'utf8')) as { toy?: unknown };
      if (typeof meta.toy === 'string' && meta.toy && loadSpec(id)) m.set(meta.toy.toUpperCase(), id);
    } catch {
      // not a car folder, or no meta
    }
  }
  toyCars = m;
  toyCarsAt = Date.now();
  return m;
}

// ---- toy numbers by mint: the store, else RIPCARS's asset record (LOOKUPS at a time; a miss is retried later)
const miss = new Map<string, number>(); // mint -> when to try again
const lookups = new Map<string, Promise<string | null>>();
let active = 0;
const queue: (() => void)[] = [];
async function limited<T>(f: () => Promise<T>): Promise<T> {
  while (active >= LOOKUPS) await new Promise<void>((r) => queue.push(r));
  active++;
  try {
    return await f();
  } finally {
    active--;
    queue.shift()?.();
  }
}
function toyNumber(mint: string): string | null | Promise<string | null> {
  const known = toyOf(mint);
  if (known) return known;
  if ((miss.get(mint) ?? 0) > Date.now()) return null;
  let p = lookups.get(mint);
  if (!p) {
    p = limited(async () => {
      try {
        const a = (await getJson(`${API}/assets/${encodeURIComponent(mint)}`)) as { toyNumber?: unknown } | null;
        const toy = typeof a?.toyNumber === 'string' && /^[A-Za-z0-9-]{1,24}$/.test(a.toyNumber) ? a.toyNumber.toUpperCase() : null;
        if (toy) saveToy(mint, toy);
        else miss.set(mint, Date.now() + 3600_000); // (RIPCARS has none for it: ask again in an hour)
        return toy;
      } catch {
        miss.set(mint, Date.now() + 60_000);
        return null;
      }
    }).finally(() => lookups.delete(mint));
    lookups.set(mint, p);
  }
  return p;
}

// ---- a wallet's garage
const garages = new Map<string, Garage>();
const loading = new Map<string, Promise<Garage>>();
const RARITY = ['legendary', 'epic', 'rare', 'uncommon', 'common'];
const rank = (r: string | null) => {
  const i = RARITY.indexOf((r ?? '').toLowerCase());
  return i < 0 ? RARITY.length : i;
};

// ---- on chain (HELIUS_RPC_URL set): the wallet's Rip Cars straight from a DAS search - ownership and each car's 'Toy #'
// attribute in one call (pages of 1000), no toy lookups. RIPCARS's my-cars, if it answers within 3 s, only adds what
// the chain doesn't have (rarity, value, its smaller photo).
const RPC = process.env.HELIUS_RPC_URL?.trim() || '';
const COLLECTION = 'DiRqf7eyipQ7nPKtjWzFUZRyWT3M63GC75qyMDHe9Z81';
interface DasAsset {
  id?: unknown;
  burnt?: unknown;
  content?: { metadata?: { name?: unknown; attributes?: { trait_type?: unknown; value?: unknown }[] }; links?: { image?: unknown } };
}
async function dasAssets(wallet: string): Promise<DasAsset[]> {
  const all: DasAsset[] = [];
  for (let page = 1; page <= 5; page++) {
    const r = await fetch(RPC, {
      method: 'POST', signal: AbortSignal.timeout(8000), headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'searchAssets', params: { ownerAddress: wallet, grouping: ['collection', COLLECTION], page, limit: 1000 } }),
    });
    if (!r.ok) throw new Error(`DAS: HTTP ${r.status}`); // (never the URL: it is the key)
    const j = (await r.json()) as { result?: { items?: DasAsset[] }; error?: { message?: string } };
    if (!j.result) throw new Error(`DAS: ${j.error?.message ?? 'no result'}`);
    const items = j.result.items ?? [];
    all.push(...items);
    if (items.length < 1000) break;
  }
  return all;
}
async function loadOnChain(wallet: string): Promise<Garage> {
  const [assets, extra] = await Promise.all([
    dasAssets(wallet),
    getJson(`${API}/my-cars?wallet=${encodeURIComponent(wallet)}`).then((l) => (Array.isArray(l) ? l : []), () => []),
  ]);
  const info = new Map<string, Record<string, unknown>>();
  for (const c of extra as Record<string, unknown>[]) if (c && isMint(c.id)) info.set(c.id as string, c);
  const byToy = carsByToy();
  const cars: GarageCar[] = assets.filter((a) => isMint(a.id) && !a.burnt).slice(0, 2000).map((a) => {
    const mint = a.id as string, md = a.content?.metadata, c = info.get(mint) ?? {};
    const attr = (k: string) => md?.attributes?.find((x) => x?.trait_type === k)?.value;
    const t = attr('Toy #');
    const toy = typeof t === 'string' && /^[A-Za-z0-9-]{1,24}$/.test(t) ? t.toUpperCase() : null;
    if (toy && !toyOf(mint)) saveToy(mint, toy);
    const model = toy ? byToy.get(toy) ?? null : null;
    return {
      mint, name: str(md?.name) ?? str(c.name) ?? 'Rip Car', rarity: str(c.rarity, 40), image: https(c.image) ?? https(a.content?.links?.image),
      fmv: num(c.fmv), mintedAt: str(c.mintedAt, 40), collectorRarity: str(c.collectorRarity, 40), assortment: str(c.assortment, 60) ?? str(attr('Assortment'), 60),
      toy, model, modelName: model ? carName(model) : null,
    };
  });
  cars.sort((a, b) => Number(!a.model) - Number(!b.model) || rank(a.rarity) - rank(b.rarity) || (b.fmv ?? 0) - (a.fmv ?? 0) || String(b.mintedAt).localeCompare(String(a.mintedAt)));
  return { wallet, cars, partial: false, at: Date.now() };
}

async function load(wallet: string): Promise<Garage> {
  if (RPC) return loadOnChain(wallet);
  const list = await getJson(`${API}/my-cars?wallet=${encodeURIComponent(wallet)}`);
  if (!Array.isArray(list)) throw new Error('my-cars: not a list');
  const raw = list.filter((c) => c && typeof c === 'object' && isMint((c as { id?: unknown }).id)).slice(0, 2000) as Record<string, unknown>[];
  const toys = raw.map((c) => toyNumber(c.id as string));
  const pending = toys.filter((t): t is Promise<string | null> => t instanceof Promise);
  let partial = false;
  if (pending.length) {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'late'>((r) => (timer = setTimeout(() => r('late'), WAIT)));
    partial = (await Promise.race([Promise.all(pending), late])) === 'late';
    clearTimeout(timer);
  }
  const byToy = carsByToy();
  const cars: GarageCar[] = await Promise.all(raw.map(async (c, i) => {
    const t = toys[i];
    const toy = t instanceof Promise ? (partial ? (toyOf(c.id as string)) : await t) : t;
    const model = toy ? byToy.get(toy) ?? null : null;
    return {
      mint: c.id as string, name: str(c.name) ?? 'Rip Car', rarity: str(c.rarity, 40), image: https(c.image), fmv: num(c.fmv), mintedAt: str(c.mintedAt, 40),
      collectorRarity: str(c.collectorRarity, 40), assortment: str(c.assortment, 60), toy, model, modelName: model ? carName(model) : null,
    };
  }));
  // drivable first, then the rarest, the most valuable, the newest
  cars.sort((a, b) => Number(!a.model) - Number(!b.model) || rank(a.rarity) - rank(b.rarity) || (b.fmv ?? 0) - (a.fmv ?? 0) || String(b.mintedAt).localeCompare(String(a.mintedAt)));
  return { wallet, cars, partial, at: Date.now() };
}

/** The wallet's garage: kept TTL (a partial one only a few seconds), the same request shared by everyone asking at once;
 *  RIPCARS not answering -> the last one if it's recent (stale), else the error. */
export async function garageOf(wallet: string): Promise<Garage> {
  const had = garages.get(wallet);
  if (had && Date.now() - had.at < (had.partial ? 3000 : TTL)) return had;
  let p = loading.get(wallet);
  if (!p) {
    p = load(wallet).then((g) => {
      garages.delete(wallet);
      garages.set(wallet, g);
      if (garages.size > MAX_WALLETS) garages.delete(garages.keys().next().value!);
      return g;
    }).finally(() => loading.delete(wallet));
    loading.set(wallet, p);
  }
  try {
    return await p;
  } catch (e) {
    if (had && Date.now() - had.at < STALE) return { ...had, stale: true };
    throw e;
  }
}
