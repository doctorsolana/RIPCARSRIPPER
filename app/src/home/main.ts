import { isAddress, shortWallet } from '../auth/address';
import { checkSession, loadSession, onSession, type Session } from '../auth/session';
import { WORDMARK } from '../brand';
import { openCreateRoom } from '../create-room';
import { isDev, onDev } from '../dev';
import type { GarageListing, Leaderboard, RoomListing } from '../drive/net/protocol';
import { roomHref, serverHttp, serverUrl } from '../drive/net/prefs';
import { EXT, mountNav, RIPCARS_URL, WALLET } from '../nav';
import { carImg, TRACK_IMG, TRACKS } from './tracks';
import type { Turntable } from './turntable';

// The landing (index.html): the game's hub. The hero is your car - the signed-in wallet's best drivable Rip Car, else
// the featured one - big, as a still (first paint, no three.js) that a 3D turntable replaces once the page has loaded
// (home/turntable.ts), with Race online and Drive. Then this week (a card per track: its still, Time trial / Race /
// Drive, the board - each wallet's best lap without car-to-car contact, the top 10 and yours), the open rooms (live,
// Join, Create room), and the garage (the wallet's Rip Cars from RIPCARS - the ones the game has a model of drivable -
// or, signed out, the cars you can drive). Every piece works on its own: no game server, no RIPCARS - one line each.
// Knobs: ?server=ws://host:port (another game server), ?garage=<wallet> (dev mode: any wallet's garage and best car).

const q = new URLSearchParams(location.search);
const SERVER = serverUrl(q), HTTP = serverHttp(SERVER), serverQ = q.get('server');
const FEATURED = 'skyline-hck01';
const BOARD = 10, GARAGE_ROWS = 12;
const RARITY: Record<string, string> = { common: '#98989c', uncommon: '#1fdc85', rare: '#2e7bff', epic: '#b45cff', legendary: '#ffc531' };

interface CarEntry { id: string; make: string; model: string; year: number | null; modelled: boolean }
type GarageCar = GarageListing['cars'][number];

const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
/** A lap in sim steps (1/120 s), as the race counts it: m:ss.sss. */
const lapTime = (steps: number) => {
  const t = steps / 120, m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
};
/** Monday 00:00 UTC after `now`: when the week's boards start over (ms). */
const weekEnd = (now: number) => {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) + (7 - ((d.getUTCDay() + 6) % 7)) * 86_400_000;
};
const resetsIn = (ms: number) => {
  const m = Math.max(1, Math.round(ms / 60_000)), d = Math.floor(m / 1440), h = Math.floor((m % 1440) / 60), mm = m % 60;
  return `Resets in ${d ? `${d}d ${h}h` : h ? `${h}h ${mm}m` : `${mm}m`}`;
};
async function getJson<T>(url: string): Promise<{ ok: true; data: T } | { ok: false; status: number }> {
  if (url.startsWith('/') && !url.startsWith('/cars/')) return { ok: false, status: 0 }; // (no game server set)
  try {
    const r = await fetch(url, { cache: 'no-store', signal: AbortSignal.timeout(12_000) });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, data: (await r.json()) as T };
  } catch {
    return { ok: false, status: 0 }; // (not answering)
  }
}
/** A signed-in wallet - or the picker for one (false: closed without signing in). */
async function signedIn() {
  if (loadSession()) return true;
  const { connectWallet } = await import('../auth/wallets');
  return !!(await connectWallet());
}

// ---- state
let session: Session | null = loadSession();
let cars: CarEntry[] = [];
let board: Leaderboard | null = null, boardDown = false;
let rooms: RoomListing | null = null, roomsDown = false;
let garage: GarageListing | null = null, garageErr: 0 | 502 | 1 = 0, garageFor: string | null = null, garageAll = false;
let hero = FEATURED, heroOwned: GarageCar | null = null;
let tt: Turntable | null = null;

const drivable = (id: string | null | undefined): id is string => !!id && cars.some((c) => c.id === id && c.modelled);
const carOf = (id: string) => cars.find((c) => c.id === id);
const carTitle = (id: string) => {
  const c = carOf(id);
  return c ? `${c.make} ${c.model}` : id;
};
/** The garage on show: dev mode's ?garage=<wallet>, else the signed-in wallet's. */
const garageWallet = () => {
  const g = q.get('garage');
  return isDev() && isAddress(g) ? g : session?.wallet ?? null;
};
const driveHref = (car: string, track?: string) => `/drive.html?car=${encodeURIComponent(car)}${track && track !== 'meadow' ? `&track=${encodeURIComponent(track)}` : ''}`;
const withServer = (href: string) => (serverQ ? `${href}${href.includes('?') ? '&' : '?'}server=${encodeURIComponent(serverQ)}` : href);

// ---- hero
const heroBox = $('h-car'), heroImg = $<HTMLImageElement>('h-img'), canvas3d = $<HTMLCanvasElement>('h-3d');
function renderHero() {
  const c = carOf(hero);
  const owned = heroOwned;
  if (c) {
    const rarity = owned?.rarity ?? null;
    const mine = owned && garageFor === session?.wallet; // (dev mode's ?garage= shows someone else's)
    const chip = [mine ? 'Yours' : '', owned ? rarity : ''].filter(Boolean).join(' · ');
    $('h-eyebrow').innerHTML = `${chip ? `<span class="own" style="--rc:${RARITY[(rarity ?? '').toLowerCase()] ?? '#fff'}">${esc(chip)}</span>` : ''}<span>${esc(c.make)}${c.year ? ` · ${c.year}` : ''}</span>`;
    $('h-name').textContent = c.model;
    $('h-make').textContent = c.make;
  }
  const pic = carImg(hero);
  if (pic && !heroImg.src.endsWith(pic.big)) {
    heroImg.srcset = `${pic.small} 640w, ${pic.big} 1440w`;
    heroImg.src = pic.big;
  }
  heroImg.hidden = !pic;
  heroImg.alt = c ? `${c.make} ${c.model}` : '';
  $<HTMLAnchorElement>('h-race').href = withServer(`/online.html?car=${encodeURIComponent(hero)}`);
  $<HTMLAnchorElement>('h-drive').href = driveHref(hero);
}
async function setHero(id: string, owned: GarageCar | null) {
  if (id === hero && owned?.mint === heroOwned?.mint) return;
  const swap = id !== hero;
  hero = id;
  heroOwned = owned;
  renderHero();
  renderTracks();
  if (swap && tt) {
    heroBox.classList.remove('live3d'); // (the new car's still while its model loads)
    await tt.show(id).catch(() => {});
    if (hero === id) heroBox.classList.add('live3d');
  }
}
/** The hero: the garage's best drivable car (the list comes rarest and most valuable first), else the featured one. */
function pickHero() {
  const best = garage?.cars.find((c) => drivable(c.model)) ?? null;
  void setHero(best ? best.model! : FEATURED, best);
}
function start3d() {
  const c = (navigator as Navigator & { connection?: { saveData?: boolean; effectiveType?: string } }).connection;
  if (tt || c?.saveData || /2g/.test(c?.effectiveType ?? '') || matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  import('./turntable').then(async ({ createTurntable }) => {
    tt = createTurntable(canvas3d, { interactive: true });
    const id = hero;
    await tt.show(id);
    if (hero !== id) await tt.show(hero);
    requestAnimationFrame(() => heroBox.classList.add('live3d'));
    Object.assign(window as object, { __turntable: tt });
  }).catch((e) => console.warn('turntable', e));
}

// ---- live line (the hero): open rooms and who's in them
function renderLive() {
  const el = $('h-live');
  const open = rooms?.rooms ?? [];
  const people = open.reduce((n, r) => n + r.players.filter((p) => !p.bot).length, 0);
  el.hidden = !open.length;
  if (open.length) el.innerHTML = `<span><b>${plural(open.length, 'room')}</b> open · <b>${plural(people, 'player')}</b></span>`;
}

// ---- this week: a card per track (index.html has the two courses' cards, for the first paint; a course it doesn't
// know gets one made here)
const tracksEl = $('tracks');
function renderTracks() {
  const list = TRACKS.map((t) => ({ ...t, ...(board?.tracks.find((b) => b.id === t.id) ?? {}) }));
  for (const b of board?.tracks ?? []) if (!list.some((t) => t.id === b.id)) list.push(b); // (a course this page doesn't know yet)
  const me = session?.wallet;
  const server = !roomsDown || !boardDown; // (one answered: it's there)
  for (const t of list) {
    let card = tracksEl.querySelector<HTMLElement>(`[data-track="${t.id}"]`);
    if (!card) {
      const pic = TRACK_IMG[t.id];
      card = document.createElement('article');
      card.className = 'trk';
      card.dataset.track = t.id;
      card.style.setProperty('--c', t.color);
      card.innerHTML = `<div class="trk-pic">${pic ? `<img src="${pic.big}" srcset="${pic.small} 800w, ${pic.big} 1600w" sizes="(max-width: 980px) 100vw, 50vw" alt="${esc(t.name)}: a car in the air" loading="lazy" decoding="async">` : ''}
          <h3><i></i>${esc(t.name)}</h3></div>
        <div class="trk-go"><button type="button" class="btn primary sm" data-tt="${esc(t.id)}">Time trial</button>
          <a class="btn ghost sm" data-race>Race</a><a class="btn ghost sm" data-drive>Drive</a></div>
        <ol class="board"></ol>`;
      tracksEl.append(card);
    }
    card.querySelector<HTMLButtonElement>('[data-tt]')!.disabled = !server;
    const race = card.querySelector<HTMLAnchorElement>('[data-race]')!;
    race.href = withServer(`/online.html?track=${encodeURIComponent(t.id)}&car=${encodeURIComponent(hero)}`);
    race.setAttribute('aria-disabled', String(!server));
    card.querySelector<HTMLAnchorElement>('[data-drive]')!.href = driveHref(hero, t.id);
    const tb = board?.tracks.find((b) => b.id === t.id);
    let html: string;
    if (!board) html = boardDown ? '<li class="none">Leaderboard offline</li>' : '';
    else if (!tb?.top.length) html = '<li class="none">No laps yet this week</li>';
    else {
      const row = (r: (typeof tb.top)[number]) => `<li class="${r.rank === 1 ? 'first' : ''}${r.wallet === me ? ' me' : ''}"><span class="rk">${r.rank}</span>
        <span class="wl" title="${esc(r.wallet)}">${esc(r.name)}</span><span class="cr">${esc(r.carName)}</span><span class="tm">${lapTime(r.steps)}</span></li>`;
      html = tb.top.map(row).join('');
      if (tb.you && tb.you.rank > BOARD) html += `<li class="gap" aria-hidden="true">···</li>${row(tb.you)}`;
    }
    const ol = card.querySelector('.board')!;
    if (ol.innerHTML !== html) ol.innerHTML = html;
  }
  renderReset();
}
function renderReset() {
  const now = Date.now();
  $('reset').textContent = resetsIn((board && board.weekEnd > now ? board.weekEnd : weekEnd(now)) - now);
}
tracksEl.addEventListener('click', async (e) => {
  const b = (e.target as HTMLElement).closest<HTMLElement>('[data-tt]');
  if (!b) return;
  // a time trial: a room of your own on this track (solo: no bots, no one else), its laps count for the board
  if (!(await signedIn())) return;
  const track = b.dataset.tt!;
  const room = `tt-${track}-${Math.random().toString(36).slice(2, 8)}`;
  location.href = roomHref(room, track, 3, { car: hero, server: serverQ, solo: true });
});

// ---- open rooms (every 3 s)
const STATE: Record<string, [string, boolean]> = { lobby: ['Waiting', false], countdown: ['Starting', true], race: ['Racing', true], results: ['Racing', true] };
function renderRooms() {
  const list = $('r-list'), create = $<HTMLButtonElement>('r-create');
  create.disabled = !rooms;
  $('r-count').textContent = rooms?.rooms.length ? String(rooms.rooms.length) : '';
  let html: string;
  if (!rooms) html = roomsDown ? '<p class="note">Game server offline</p>' : '';
  else if (!rooms.rooms.length) html = '<p class="note">No open rooms</p>';
  else {
    html = `<div class="rooms">${rooms.rooms.slice(0, 6).map((r) => {
      const [label, busy] = STATE[r.phase] ?? ['', false];
      const full = r.players.length >= r.max;
      const humans = r.players.filter((p) => !p.bot), bots = r.players.length - humans.length;
      const who = [...humans.slice(0, 3).map((p) => p.name), humans.length > 3 ? `+${humans.length - 3}` : '', bots ? plural(bots, 'bot') : ''].filter(Boolean).join(', ');
      return `<div class="rm" data-room="${esc(r.name)}"><div class="rm-name" title="${esc(r.name)}">${esc(r.name)}</div>
        <div class="rm-trk" style="--c:${esc(r.color)}"><i></i>${esc(r.trackName)} · ${plural(r.laps, 'lap')}</div>
        <div class="rm-who"><span class="rm-st${busy ? ' busy' : ''}">${label}</span><b>${r.players.length}/${r.max}</b><span class="rm-ppl">${esc(who)}</span></div>
        <button type="button" class="btn sm" data-join="${esc(r.name)}" ${full ? 'disabled' : ''}>${full ? 'Full' : 'Join'}</button></div>`;
    }).join('')}</div>`;
  }
  if (list.innerHTML !== html) list.innerHTML = html;
}
async function pollRooms() {
  const r = await getJson<RoomListing>(`${HTTP}/rooms`);
  rooms = r.ok ? r.data : null;
  roomsDown = !r.ok;
  renderRooms();
  renderLive();
  renderTracks();
}
$('r-list').addEventListener('click', (e) => {
  const j = (e.target as HTMLElement).closest<HTMLElement>('[data-join]');
  if (j) void join(j.dataset.join!);
});
async function join(name: string) {
  const r = rooms?.rooms.find((x) => x.name === name);
  if (!r || !(await signedIn())) return;
  location.href = roomHref(r.name, r.track, r.laps, { car: hero, server: serverQ });
}
$('r-create').addEventListener('click', () => {
  if (!rooms) return;
  openCreateRoom({
    courses: rooms.courses,
    taken: (n) => !!rooms?.rooms.some((r) => r.name === n),
    go: async (room, track, laps, bots) => {
      if (await signedIn()) location.href = roomHref(room, track, laps, { car: hero, bots, server: serverQ });
    },
    join: (n) => void join(n),
  });
});
$<HTMLAnchorElement>('r-all').href = $<HTMLAnchorElement>('r-all2').href = withServer('/online.html');

// ---- this week's boards (with your rank)
async function loadBoard() {
  const w = session?.wallet;
  const r = await getJson<Leaderboard>(`${HTTP}/leaderboard${w ? `?wallet=${w}` : ''}`);
  if (r.ok) (board = r.data), (boardDown = false);
  else boardDown = !board;
  renderTracks();
}

// ---- the garage
let garageTries = 0;
async function loadGarage(again = false) {
  const w = garageWallet();
  if (!again) garageTries = 0;
  if (w !== garageFor) (garage = null), (garageErr = 0), (garageAll = false);
  garageFor = w;
  renderGarage();
  if (!w) return pickHero();
  const r = await getJson<GarageListing>(`${HTTP}/garage?wallet=${w}`);
  if (garageFor !== w) return; // (signed out or in as someone else meanwhile)
  if (r.ok) {
    garage = r.data;
    garageErr = 0;
    if (r.data.partial && ++garageTries < 4) setTimeout(() => garageFor === w && void loadGarage(true), 2500);
  } else if (!garage) garageErr = r.status === 502 ? 502 : 1;
  renderGarage();
  pickHero();
}
function renderGarage() {
  const body = $('g-body'), act = $('g-act'), title = $('garage-h');
  const w = garageFor;
  const dev = w && w !== session?.wallet;
  if (!w) {
    // signed out: the cars the game has, and Connect
    title.innerHTML = 'Garage';
    act.innerHTML = `<button type="button" class="btn sm" data-connect>${WALLET}Connect wallet</button>`;
    const list = cars.filter((c) => c.modelled);
    body.innerHTML = `<div class="cars">${list.map((c) => {
      const pic = carImg(c.id);
      return `<a class="car render go" href="${driveHref(c.id)}"><div class="pic">${pic ? `<img src="${pic.small}" alt="${esc(`${c.make} ${c.model}`)}" loading="lazy" decoding="async">` : ''}</div>
        <div class="nm">${esc(`${c.make} ${c.model}`)}</div><div class="sub">${c.year ?? ''}</div><span class="btn ghost sm">Drive</span></a>`;
    }).join('')}</div>`;
    return;
  }
  const mine = garage?.cars ?? [];
  const n = mine.filter((c) => drivable(c.model)).length;
  title.innerHTML = `${dev ? 'Rip Cars' : 'Your Rip Cars'}${mine.length ? `<small>${mine.length}${n ? ` · ${n} drivable` : ''}</small>` : ''}`;
  act.innerHTML = dev ? `<span class="who" title="${esc(w)}">${esc(shortWallet(w))} · dev</span>` : '';
  if (!garage) {
    body.innerHTML = garageErr === 502 ? "<p class=\"note\">Can't reach RIPCARS right now</p>" : garageErr ? '<p class="note">Game server offline</p>' : '';
    return;
  }
  if (!mine.length) {
    body.innerHTML = `<p class="note">No Rip Cars in this wallet yet<a class="btn primary sm" href="${RIPCARS_URL}" target="_blank" rel="noopener">Rip a pack${EXT}</a></p>`;
    return;
  }
  const shown = garageAll ? mine : mine.slice(0, GARAGE_ROWS);
  body.innerHTML = `<div class="cars">${shown.map((c) => {
    const go = drivable(c.model);
    const rc = RARITY[(c.rarity ?? '').toLowerCase()];
    const sub = [c.rarity, c.collectorRarity].filter(Boolean).join(' · ');
    const inner = `${go ? '<span class="tag">Drivable</span>' : ''}<div class="pic">${c.image ? `<img src="${esc(c.image)}" alt="${esc(c.name)}" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : ''}</div>
      <div class="nm" title="${esc(c.name)}">${esc(c.name)}</div><div class="sub"${rc ? ` style="--rc:${rc}"` : ''}>${esc(sub)}</div>${go ? '<span class="btn ghost sm">Drive</span>' : ''}`;
    return go ? `<a class="car go" href="${driveHref(c.model!)}" title="Drive the ${esc(carTitle(c.model!))}">${inner}</a>` : `<div class="car off">${inner}</div>`;
  }).join('')}</div>${mine.length > shown.length ? `<div class="g-more"><button type="button" class="btn ghost sm" data-all>Show all ${mine.length}</button></div>` : ''}`;
}
$('garage').addEventListener('click', (e) => {
  const t = e.target as HTMLElement;
  if (t.closest('[data-connect]')) void signedIn();
  else if (t.closest('[data-all]')) (garageAll = true), renderGarage();
});

// ---- the foot
function renderFoot() {
  $('foot').innerHTML = `<span class="mark" role="img" aria-label="racecars">${WORDMARK}</span><nav><a href="${RIPCARS_URL}" target="_blank" rel="noopener">Rip a pack${EXT}</a>${isDev() ? '<a class="dev" href="/rip.html">Reveal</a><a class="dev" href="/inspect.html">Inspect</a>' : ''}</nav>`;
}

// ---- go
async function main() {
  void mountNav('home');
  renderHero();
  renderTracks();
  renderFoot();
  renderGarage();
  // the 3D car: on the visitor's first touch, scroll or key - or, on a computer (a fine pointer, 8+ cores), once the page
  // has loaded and gone idle. A phone that's never touched keeps the still (three.js is ~170 kB gzipped plus the car)
  const go3d = () => {
    for (const e of ['pointerdown', 'pointermove', 'scroll', 'keydown', 'touchstart']) removeEventListener(e, go3d);
    start3d();
  };
  for (const e of ['pointerdown', 'pointermove', 'scroll', 'keydown', 'touchstart']) addEventListener(e, go3d, { passive: true });
  if (matchMedia('(pointer: fine)').matches && (navigator.hardwareConcurrency ?? 0) >= 8) {
    addEventListener('load', () => ('requestIdleCallback' in window ? requestIdleCallback(go3d, { timeout: 2500 }) : setTimeout(go3d, 800)));
  }
  const list = await getJson<{ cars: CarEntry[] }>('/cars/index.json');
  cars = list.ok ? list.data.cars : [];
  renderHero();
  void pollRooms();
  void loadBoard();
  void loadGarage();
  void checkSession(HTTP); // (a sign-in this server no longer takes is dropped: onSession follows)
  setInterval(() => !document.hidden && void pollRooms(), 3000);
  setInterval(() => !document.hidden && void loadBoard(), 60_000);
  setInterval(renderReset, 30_000);
  onSession((s) => {
    const was = session?.wallet ?? null;
    session = s;
    if ((s?.wallet ?? null) === was) return;
    void loadBoard();
    void loadGarage();
  });
  onDev(() => {
    renderFoot();
    void loadGarage();
  });
  Object.assign(window as object, {
    __home: { get board() { return board; }, get rooms() { return rooms; }, get garage() { return garage; }, get hero() { return hero; }, get garageErr() { return garageErr; } },
  });
}
void main();
