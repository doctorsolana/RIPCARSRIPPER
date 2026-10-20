import { isAddress, shortWallet } from '../auth/address';
import { loadSession, onSession, type Session } from '../auth/session';
import { CARS, carFile, type CarEntry } from '../catalog';
import { isDev, onDev } from '../dev';
import type { GarageListing } from '../drive/net/protocol';
import { STARTER_CAR } from '../drive/net/protocol';
import { serverHttp, serverUrl } from '../drive/net/prefs';
import { carImg } from '../home/tracks';
import { EXT, mountNav, RIPCARS_URL, WALLET } from '../nav';
import { fetchGarage, lastGarage, raceableCars } from '../owned';
import { STATS, type CarStats } from './stats';
import type { Viewer } from './viewer';

// /garage.html[?car=<id>]: your cars. On top the car you picked, big, in 3D (garage/viewer.ts: drag to turn round it) -
// or, for a Rip Car the game has no model of yet, its RIPCARS photo - with its name, year, toy number and rarity, its
// stats (measured in the sim: stats.ts, npm run stats) and what you can do with it: Drive and Race online for a car
// your wallet may race (your Rip Cars the game has, and the starter), Test drive for any other. Under it the rail:
// your Rip Cars (signed in: the wallet's garage, one card per car with how many you hold) and every car the game has.
// It opens on the link's car, else your first - from the garage the wallet had last time (owned.ts keeps it) at once,
// or once it's in (a first visit waits a moment) - else the featured one, and never swaps the car on show by itself.
// Knobs: ?car=<id>, ?garage=<wallet> (dev mode: any wallet's garage), ?server=ws://host:port.

type GarageCar = GarageListing['cars'][number];
/** A card on the rail: a car the game has (`model`), or a Rip Car it hasn't (photo only); `count` of them held. */
interface Card { key: string; model: string | null; name: string; sub: string; image: string | null; rarity: string | null; toy: string | null; count: number }

const q = new URLSearchParams(location.search);
const SERVER = serverUrl(q), HTTP = serverHttp(SERVER), serverQ = q.get('server');
const FEATURED = 'skyline-hck01';
const WAIT = 2500; // ms a wallet's first visit waits for its garage before opening on the featured car
const RARITY: Record<string, string> = {
  common: '#a3a8b8', uncommon: '#1fdc85', rare: '#3d8bff', epic: '#b45cff', legendary: '#ffc531', chase: '#ff3d6e',
};
const STAT_ROWS: { key: keyof CarStats['bars']; label: string; value?: (s: CarStats) => string; plain?: boolean }[] = [
  { key: 'top', label: 'Top speed', value: (s) => `${s.topKmh}<small>km/h</small>` },
  { key: 'accel', label: '0-100 km/h', value: (s) => `${s.zero100.toFixed(2)}<small>s</small>` },
  { key: 'brake', label: 'Braking', value: (s) => `${s.brakeM.toFixed(1)}<small>m</small>` },
  { key: 'handling', label: 'Handling' },
  { key: 'drift', label: 'Drift' },
  { key: 'offroad', label: 'Off-road' },
  { key: 'weight', label: 'Weight', plain: true },
];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const withServer = (href: string) => (serverQ ? `${href}${href.includes('?') ? '&' : '?'}server=${encodeURIComponent(serverQ)}` : href);

// ---- state
let session: Session | null = loadSession();
const cars: CarEntry[] = CARS.filter((c) => c.modelled && STATS[c.id]);
let garage: GarageListing | null = null, garageErr = 0, garageFor: string | null = null, garageSet = false;
let raceable = new Set<string>([STARTER_CAR]);
let tab: 'mine' | 'all' = 'all', tabPicked = false;
let sel: Card | null = null;
let viewer: Viewer | null = null;
const toys = new Map<string, string>(); // car id -> toy number (its meta.json)

const carOf = (id: string | null | undefined) => cars.find((c) => c.id === id);
const garageWallet = () => {
  const g = q.get('garage');
  return isDev() && isAddress(g) ? g : session?.wallet ?? null;
};
function allCards(): Card[] {
  return cars.map((c) => ({ key: c.id, model: c.id, name: c.model, sub: [c.make, c.year].filter(Boolean).join(' · '), image: null, rarity: c.rarity, toy: null, count: 0 }));
}
/** The wallet's Rip Cars, one card per car (drivable first, then the rest - the list's own order: rarest first). */
function mineCards(): Card[] {
  const by = new Map<string, Card>();
  for (const c of garage?.cars ?? []) {
    const model = c.model && carOf(c.model)?.modelled ? c.model : null;
    const key = model ?? `toy:${c.toy ?? c.name}`;
    const had = by.get(key);
    if (had) {
      had.count++;
      continue;
    }
    const e = carOf(model);
    by.set(key, {
      key, model, name: e ? e.model : c.name, sub: e ? [e.make, e.year].filter(Boolean).join(' · ') : c.assortment ?? '', image: c.image,
      rarity: c.rarity ?? e?.rarity ?? null, toy: c.toy, count: 1,
    });
  }
  return [...by.values()].sort((a, b) => Number(!a.model) - Number(!b.model));
}
const list = () => (tab === 'mine' ? mineCards() : allCards());
/** The tab to open on: your Rip Cars (signed in; while they load too), unless you have none or the link's car isn't one. */
function openTab(): 'mine' | 'all' {
  if (!garageFor) return 'all';
  if (!garage) return 'mine';
  const mine = mineCards(), want = q.get('car');
  return mine.length && (!want || mine.some((c) => c.model === want)) ? 'mine' : 'all';
}
/** The car to open on: the link's (?car=), else your first (a car the game has first), else the featured one. */
function firstCard(): Card {
  const want = q.get('car'), all = allCards(), cards = list();
  return (want ? cards.find((c) => c.model === want) ?? all.find((c) => c.model === want) : undefined) ?? (tab === 'mine' ? cards[0] : undefined)
    ?? all.find((c) => c.model === FEATURED) ?? all[0];
}

// ---- the stage: the car in 3D (or its photo)
const stage = $('stage'), still = $<HTMLImageElement>('still'), canvas = $<HTMLCanvasElement>('c3d'), photo = $('photo');
let showing = '';
async function show(card: Card) {
  const id = card.model;
  $('make').textContent = id ? carOf(id)?.make ?? '' : '';
  photo.hidden = !!id;
  stage.classList.toggle('photo-on', !id);
  if (!id) {
    showing = '';
    viewer?.clear();
    stage.classList.remove('live3d');
    still.removeAttribute('src');
    const img = photo.querySelector('img')!;
    if (card.image) img.src = card.image;
    else img.removeAttribute('src');
    img.alt = card.name;
    return;
  }
  if (id === showing) return;
  showing = id;
  // the car's still at once (the landing's render), the 3D car over it once it's in
  const pic = carImg(id);
  stage.classList.remove('live3d');
  if (pic) {
    still.srcset = `${pic.small} 640w, ${pic.big} 1440w`;
    still.src = pic.big;
  } else still.removeAttribute('src');
  still.alt = card.name;
  if (!viewer) {
    const { createViewer } = await import('./viewer');
    viewer ??= createViewer(canvas);
    Object.assign(window as object, { __viewer: viewer });
  }
  if (showing !== id) return;
  if (await viewer.show(id)) stage.classList.add('live3d');
}

// ---- the panel: who it is, what you can do with it, its stats
function bar(v: number, plain = false) {
  return `<span class="g-bar${plain ? ' plain' : ''}"><i style="width:${(v * 100).toFixed(1)}%"></i></span>`;
}
async function renderInfo() {
  const el = $('info'), card = sel;
  if (!card) return void (el.innerHTML = '');
  const e = carOf(card.model);
  const id = card.model;
  const rk = (card.rarity ?? '').toLowerCase(), rc = RARITY[rk];
  let toy = card.toy ?? (id ? toys.get(id) : null) ?? null;
  const held = id ? garage?.cars.filter((c) => c.model === id).length ?? 0 : card.count; // (in the garage on show)
  const head = () => {
    const bits = [e ? e.make : '', e?.year ? String(e.year) : '', toy ?? ''].filter(Boolean).map(esc).join('<i>·</i>');
    return `<p class="g-eyebrow">${rc ? `<span class="g-rar" style="--rc:${rc}">${esc(card.rarity!)}</span>` : ''}${held > 1 || (held && garageFor === session?.wallet) ? `<span class="g-own">${held > 1 ? `×${held}` : 'Yours'}</span>` : ''}<span>${bits}</span></p>
      <h1>${esc(e ? e.model : card.name)}</h1>`;
  };
  if (!id) {
    el.innerHTML = `${head()}<p class="g-line">Not in the game yet</p>`;
    return;
  }
  const s = STATS[id];
  const ok = raceable.has(id) || isDev(); // (dev mode: any car, online too)
  const go = ok
    ? `<a class="btn primary big" href="/drive.html?car=${id}">Drive</a><a class="btn big" href="${withServer(`/online.html?car=${id}`)}">Race online</a>`
    : `<a class="btn primary big" href="/drive.html?car=${id}">Test drive</a>`;
  const rows = s ? STAT_ROWS.map((r) => `<li><span class="k">${r.label}</span>${bar(s.bars[r.key], r.plain)}<b>${r.value ? r.value(s) : ''}</b></li>`).join('') : '';
  el.innerHTML = `${head()}<div class="g-go">${go}</div>${ok ? '' : `<p class="g-line"><a href="${RIPCARS_URL}" target="_blank" rel="noopener">Rip a pack${EXT}</a> to race this</p>`}
    ${rows ? `<ul class="g-stats">${rows}</ul>` : ''}`;
  if (!toy) {
    // the toy number: the car's meta.json (once per car)
    const m = await fetch(carFile(id, 'meta.json')).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    if (typeof m?.toy === 'string') toys.set(id, (toy = m.toy as string));
    if (toy && sel === card) el.querySelector('.g-eyebrow')!.outerHTML = head().split('</p>')[0] + '</p>';
  }
}

// ---- the rail
function renderTabs() {
  const w = garageFor, n = garage?.cars.length ?? 0;
  const dev = w && w !== session?.wallet;
  const tabs = w
    ? `<button type="button" role="tab" data-tab="mine" aria-selected="${tab === 'mine'}">${dev ? esc(shortWallet(w)) : 'Your Rip Cars'}<small>${garage ? n : ''}</small></button>`
    : '';
  $('tabs').innerHTML = `${tabs}<button type="button" role="tab" data-tab="all" aria-selected="${tab === 'all'}">All cars<small>${cars.length}</small></button>`;
  $('act').innerHTML = !w
    ? `<button type="button" class="btn sm" data-connect>${WALLET}Connect wallet</button>`
    : tab === 'mine' && !garage
      ? `<span class="g-note">${garageErr === 502 ? "Can't reach RIPCARS" : garageErr ? 'Game server offline' : 'Loading'}</span>`
      : tab === 'mine' && !n
        ? `<a class="btn primary sm" href="${RIPCARS_URL}" target="_blank" rel="noopener">Rip a pack${EXT}</a>`
        : '';
}
function renderStrip() {
  const strip = $('strip'), cards = list();
  strip.innerHTML = cards.map((c) => {
    const pic = c.model ? carImg(c.model) : null;
    const img = pic ? `<img src="${pic.small}" alt="" loading="lazy" decoding="async">` : c.image ? `<img class="ph" src="${esc(c.image)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '';
    const rc = RARITY[(c.rarity ?? '').toLowerCase()];
    const sub = c.model ? c.sub : 'Not in the game yet';
    return `<button type="button" role="option" class="g-card${c.model ? '' : ' off'}" data-key="${esc(c.key)}" aria-selected="${sel?.key === c.key}"${rc ? ` style="--rc:${rc}"` : ''}>
      <span class="pic">${img}</span>${c.count > 1 ? `<span class="n">×${c.count}</span>` : ''}
      <span class="nm">${esc(c.name)}</span><span class="sub">${esc(sub)}</span></button>`;
  }).join('');
}
function select(card: Card, scroll = true) {
  sel = card;
  void show(card);
  void renderInfo();
  for (const b of $('strip').querySelectorAll<HTMLElement>('.g-card')) {
    const on = b.dataset.key === card.key;
    b.setAttribute('aria-selected', String(on));
    if (on && scroll) b.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'smooth' });
  }
  if (card.model) {
    const p = new URLSearchParams(location.search);
    p.set('car', card.model);
    history.replaceState(null, '', `${location.pathname}?${p}`);
    nav?.setCar(card.model);
  }
}
$('strip').addEventListener('click', (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('.g-card');
  const card = b && list().find((c) => c.key === b.dataset.key);
  if (card) select(card);
});
// a mouse wheel scrolls the strip sideways
$('strip').addEventListener('wheel', (e) => {
  const s = $('strip');
  if (Math.abs(e.deltaY) > Math.abs(e.deltaX) && s.scrollWidth > s.clientWidth) {
    s.scrollLeft += e.deltaY;
    e.preventDefault();
  }
}, { passive: false });
$('tabs').addEventListener('click', (e) => {
  const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as 'mine' | 'all' | undefined;
  if (!t || t === tab) return;
  tab = t;
  tabPicked = true;
  renderTabs();
  renderStrip();
  // the car on show stays if it's in this list too, else the list's first
  const cards = list();
  select(cards.find((c) => c.model && c.model === sel?.model) ?? cards[0] ?? sel!, true);
});
$('act').addEventListener('click', async (e) => {
  if (!(e.target as HTMLElement).closest('[data-connect]')) return;
  const { connectWallet } = await import('../auth/wallets');
  await connectWallet();
});
// left / right: the next car on the rail
addEventListener('keydown', (e) => {
  if ((e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') || e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
  const cards = list(), i = cards.findIndex((c) => c.key === sel?.key);
  const next = cards[(i + (e.key === 'ArrowRight' ? 1 : -1) + cards.length) % cards.length];
  if (next) select(next);
});

// ---- the wallet's garage
/** The rail as the garage on show has it now; the car on show stays (as your copy of it, if you hold one: its rarity,
 *  how many), or - none yet - the first one. */
function railChanged() {
  if (!tabPicked) tab = openTab();
  renderTabs();
  renderStrip();
  if (!sel) {
    if (!garageFor || garage || q.get('car')) select(firstCard(), false);
    return;
  }
  sel = list().find((c) => c.key === sel!.key || (c.model && c.model === sel!.model)) ?? sel;
  void renderInfo();
}
let tries = 0;
async function loadGarage(again = false) {
  const w = garageWallet();
  if (!again) tries = 0;
  if (!garageSet || w !== garageFor) {
    // another wallet (or the first look): what its garage held last time, at once
    garageSet = true;
    garage = w ? lastGarage(w) : null;
    garageErr = 0;
    garageFor = w;
    tabPicked = false;
    railChanged();
  }
  if (!w) return;
  const a = await fetchGarage(w, HTTP);
  if (garageFor !== w) return;
  if (a.ok) {
    garage = a.garage;
    garageErr = 0;
    if (garage.partial && ++tries < 4) setTimeout(() => garageFor === w && void loadGarage(true), 2500);
  } else if (!garage) garageErr = a.status === 502 ? 502 : 1;
  railChanged();
  if (!sel) select(firstCard(), false); // (it didn't answer: the featured car)
}
async function loadRaceable() {
  raceable = await raceableCars(session?.wallet ?? null);
  void renderInfo();
}

// ---- go
let nav: Awaited<ReturnType<typeof mountNav>> | null = null;
async function main() {
  void mountNav('garage').then((n) => {
    nav = n;
    if (sel?.model) n.setCar(sel.model);
  });
  void loadGarage(); // (opens on a car at once - the link's, signed out, or the wallet's garage from last time - or once it's in)
  if (!sel) setTimeout(() => !sel && select(firstCard(), false), WAIT);
  void loadRaceable();
  onSession((s) => {
    const was = session?.wallet ?? null;
    session = s;
    if ((s?.wallet ?? null) === was) return;
    void loadGarage();
    void loadRaceable();
  });
  onDev(() => void loadGarage());
  Object.assign(window as object, { __garage: { get sel() { return sel; }, get garage() { return garage; }, get tab() { return tab; }, get raceable() { return raceable; } } });
}
void main();
