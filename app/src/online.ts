import { shortWallet } from './auth/address';
import { checkSession, loadSession, onSession, type Session } from './auth/session';
import { openCreateRoom } from './create-room';
import { isDev } from './dev';
import { mountNav, WALLET } from './nav';
import type { RoomListing } from './drive/net/protocol';
import { DEFAULT_CAR, roomHref, saveCar, savedCar, serverHttp, serverUrl } from './drive/net/prefs';

// /online.html: the way into multiplayer (the top bar's "Race online"). Who you race as - your wallet (signed in: its
// short address; signed out: Connect wallet) - and your car (remembered), the open rooms on the game server (GET /rooms,
// every 2 s) with a Join on each - all of them, or one track's (the switch; ?track=<id> from the landing's Race) - and
// Create room (create-room.ts: a name, the track, laps, bots). Join and Create need a signed-in wallet: signed out they
// open the wallet picker first (auth/wallets.ts), then go on to the room - the drive page in it (?online=1&room=...:
// net/online.ts), where the room's own lobby is. A remembered sign-in the server no longer takes (it restarted with a
// new secret, say) is dropped on load. When the server isn't there it says so (in dev mode with the command that starts
// it). Knobs: ?car=<id> (from the top bar's links), ?track=<id>, ?server=ws://host:port.

interface NavCar { id: string; make: string; model: string; year: number | null; modelled: boolean }

const CSS = `
:root { --bg: #0d0e12; --panel: #16171d; --panel2: #1d1f27; --text: #eef0f3; --muted: #8b90a0; --line: #2a2c35; --accent: #ff3d6e;
  --ok: #3ddc84; --warn: #ffb020; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 500 14px/1.45 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; }
body { background: radial-gradient(90% 60% at 50% 0%, #181a22 0%, var(--bg) 70%) fixed; }
#app { max-width: 820px; margin: 0 auto; padding: calc(48px + 44px) max(16px, env(safe-area-inset-right)) 64px max(16px, env(safe-area-inset-left)); }
h1 { font: 400 56px/1 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin: 0; }
.you { display: grid; grid-template-columns: 1fr 1.3fr; gap: 12px; margin-top: 24px; padding: 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 16px; align-items: start; }
label, .me { display: grid; gap: 7px; min-width: 0; }
label > span, .me > span { font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); }
.me-v { display: flex; align-items: center; gap: 10px; min-width: 0; min-height: 42px; padding: 0 12px; border-radius: 10px; background: var(--panel2);
  border: 1px solid var(--line); font: 600 15px/1 Inter, system-ui, sans-serif; color: var(--text); }
.me-v img, .me-v svg { width: 22px; height: 22px; border-radius: 6px; flex: none; }
.me-v b { font-weight: 600; font-variant-numeric: tabular-nums; }
.me-v small { margin-left: auto; padding-left: 8px; color: var(--muted); font-size: 12px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
button.me-v { width: 100%; cursor: pointer; color: #fff; background: rgba(255, 61, 110, 0.14); border-color: rgba(255, 61, 110, 0.55); }
button.me-v:hover { background: rgba(255, 61, 110, 0.24); }
button.me-v svg { width: 18px; height: 18px; border-radius: 0; }
input, select { width: 100%; min-width: 0; font: 600 15px/1 Inter, system-ui, sans-serif; color: var(--text); background: var(--panel2);
  border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; }
select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 17px) 52%, calc(100% - 12px) 52%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 30px; }
select option { color: #111; }
input:focus, select:focus { outline: none; border-color: var(--accent); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 36px 0 12px; }
.head > div { display: flex; align-items: center; gap: 14px; min-width: 0; }
h2 { font: 400 26px/1 Anton, Impact, sans-serif; letter-spacing: 0.03em; margin: 0; display: flex; align-items: baseline; gap: 10px; white-space: nowrap; }
h2 small { font: 600 13px/1 Inter, system-ui, sans-serif; color: var(--muted); letter-spacing: 0; }
.filter { display: flex; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(255, 255, 255, 0.05); border: 1px solid var(--line); }
.filter a { display: flex; align-items: center; gap: 7px; padding: 7px 10px; border-radius: 6px; color: var(--muted); text-decoration: none; font-size: 12.5px; white-space: nowrap; }
.filter a:hover { color: var(--text); }
.filter a.on { color: #fff; background: rgba(255, 255, 255, 0.13); }
.filter a i { width: 6px; height: 6px; border-radius: 50%; background: var(--c); }
button { font: inherit; cursor: pointer; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 13px 20px; border-radius: 999px; border: 0;
  font: 700 12px/1 Inter, system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; color: #0b0b0d; background: #fff;
  text-decoration: none; white-space: nowrap; }
.btn:hover { background: #e4e6ea; }
.btn.primary { color: #fff; background: #e0245a; box-shadow: 0 6px 24px rgba(255, 61, 110, 0.3); }
.btn.primary:hover { background: #ea3366; }
.btn.ghost { color: var(--text); background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.16); }
.btn.ghost:hover { background: rgba(255, 255, 255, 0.1); }
.btn:disabled { opacity: 0.4; cursor: default; box-shadow: none; }
.btn svg { width: 14px; height: 14px; }
#list { display: grid; gap: 10px; }
.room { display: grid; grid-template-columns: minmax(150px, 1fr) 1.5fr auto; align-items: center; gap: 18px; padding: 16px 16px 16px 20px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 16px; }
.room:hover { border-color: #3a3d48; }
.r-name { font: 400 24px/1.1 Anton, Impact, sans-serif; letter-spacing: 0.02em; overflow-wrap: anywhere; }
.r-meta { display: flex; align-items: center; gap: 8px; margin-top: 6px; color: var(--muted); font-size: 13px; }
.dot { width: 8px; height: 8px; border-radius: 50%; background: var(--c, #fff); box-shadow: 0 0 8px var(--c, #fff); flex: none; }
.r-state { display: inline-flex; align-items: center; gap: 7px; font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.2em;
  text-transform: uppercase; color: var(--ok); }
.r-state::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
.r-state.busy { color: var(--warn); }
.r-who { display: grid; gap: 6px; min-width: 0; }
.r-players { display: flex; flex-wrap: wrap; gap: 6px; }
.chip { display: inline-flex; align-items: baseline; gap: 6px; max-width: 100%; padding: 5px 9px; border-radius: 8px; background: var(--panel2);
  font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.chip small { color: var(--muted); font-size: 11px; overflow: hidden; text-overflow: ellipsis; }
.chip.bot { opacity: 0.7; }
.r-count { font-size: 12px; color: var(--muted); }
.r-go { display: grid; justify-items: end; gap: 6px; }
.r-go .note { font-size: 11px; color: var(--muted); }
.panel { padding: 22px 20px; background: var(--panel); border: 1px solid var(--line); border-radius: 16px; color: var(--muted);
  display: flex; align-items: center; justify-content: space-between; gap: 14px; flex-wrap: wrap; }
.panel.down { color: var(--warn); border-color: rgba(255, 176, 32, 0.3); }
code { font: 600 13px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); background: #0a0b0e; border: 1px solid var(--line);
  padding: 7px 10px; border-radius: 8px; user-select: all; }

@media (max-width: 640px) {
  #app { padding-top: calc(48px + 28px); }
  h1 { font-size: 44px; }
  .you { grid-template-columns: 1fr; margin-top: 20px; }
  .head { margin-top: 28px; flex-wrap: wrap; }
  .head .btn { padding: 12px 16px; }
  .room { grid-template-columns: 1fr auto; gap: 12px; padding: 14px; }
  .r-who { grid-column: 1 / -1; grid-row: 2; }
  .r-go { grid-column: 2; grid-row: 1; }
}
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const PLUS = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 2.5v11M2.5 8h11" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
const STATE: Record<string, [string, boolean]> = {
  lobby: ['Waiting to start', false], countdown: ['Starting', true], race: ['Racing', true], results: ['Race just ended', true],
};

async function main() {
  const q = new URLSearchParams(location.search);
  const SERVER = serverUrl(q);
  const serverQ = q.get('server');
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const nav = await mountNav('online');

  const app = document.getElementById('app')!;
  app.innerHTML = `
    <h1>Race online</h1>
    <section class="you" aria-label="You">
      <div class="me" id="me"></div>
      <label><span>Your car</span><select id="car"></select></label>
    </section>
    <div class="head"><div><h2>Open rooms <small id="count"></small></h2><nav class="filter" id="filter" aria-label="Track"></nav></div>
      <button type="button" class="btn primary" id="create">${PLUS}Create room</button></div>
    <div id="list" aria-live="polite"></div>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const meBox = $('me'), carSel = $<HTMLSelectElement>('car'), list = $('list'), count = $('count');
  const createBtn = $<HTMLButtonElement>('create'), filterEl = $('filter');
  let only = q.get('track'); // one track's rooms (the landing's Race on a track), or all

  // ---- you: your wallet (signed in or not: the top bar's chip shows it too) and your car (remembered)
  function showMe(s: Session | null) {
    meBox.innerHTML = s
      ? `<span>Racing as</span><div class="me-v" title="${esc(s.wallet)}">${s.icon ? `<img src="${s.icon}" alt="">` : WALLET}<b>${esc(shortWallet(s.wallet))}</b>${s.name ? `<small>${esc(s.name)}</small>` : ''}</div>`
      : `<span>You</span><button type="button" class="me-v" id="connect">${WALLET}Connect wallet</button>`;
  }
  showMe(loadSession());
  onSession(showMe);
  void checkSession(serverHttp(SERVER)); // (a sign-in this server no longer takes is dropped: the chip and this follow)
  meBox.addEventListener('click', (e) => (e.target as HTMLElement).closest('#connect') && void signedIn());
  /** A signed-in wallet - or the picker for one (false: closed without signing in). */
  async function signedIn() {
    if (loadSession()) return true;
    const { connectWallet } = await import('./auth/wallets');
    return !!(await connectWallet());
  }
  const { cars } = (await fetch('/cars/index.json').then((r) => r.json()).catch(() => ({ cars: [] }))) as { cars: NavCar[] };
  const modelled = cars.filter((c) => c.modelled);
  carSel.innerHTML = modelled.map((c) => `<option value="${c.id}">${esc(`${c.make} ${c.model}`)}${c.year ? ` · ${c.year}` : ''}</option>`).join('');
  const want = [q.get('car'), savedCar(), DEFAULT_CAR].find((id) => id && modelled.some((c) => c.id === id));
  if (want) carSel.value = want;
  nav.setCar(carSel.value);
  carSel.addEventListener('change', () => {
    saveCar(carSel.value);
    nav.setCar(carSel.value);
  });
  const myCar = () => {
    saveCar(carSel.value);
    return carSel.value || DEFAULT_CAR;
  };

  // ---- the rooms, every 2 s
  let data: RoomListing | null = null, lastJson = '', down = false;
  async function refresh() {
    try {
      if (!SERVER) throw new Error('no game server'); // (an https page with none set)
      const r = await fetch(`${serverHttp(SERVER)}/rooms`, { cache: 'no-store' });
      const json = await r.text();
      down = false;
      if (json === lastJson) return;
      lastJson = json;
      data = JSON.parse(json) as RoomListing;
    } catch {
      if (down) return;
      down = true;
      data = null;
      lastJson = '';
    }
    render();
  }
  function render() {
    createBtn.disabled = !data;
    renderFilter();
    if (!data) {
      count.textContent = '';
      list.innerHTML = `<div class="panel down"><span>Game server offline</span>${isDev() ? '<code>npm run server</code>' : ''}</div>`;
      return;
    }
    const rooms = data.rooms.filter((r) => !only || r.track === only);
    count.textContent = rooms.length ? String(rooms.length) : '';
    if (!rooms.length) {
      const c = only && data.courses.find((x) => x.id === only);
      list.innerHTML = `<div class="panel"><span>No open rooms${c ? ` on ${esc(c.name)}` : ''}</span></div>`;
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const [label, busy] = STATE[r.phase] ?? ['', false];
      const full = r.players.length >= r.max;
      const chips = r.players.map((p) => `<span class="chip${p.bot ? ' bot' : ''}"${p.wallet ? ` title="${esc(p.wallet)}"` : ''}>${esc(p.name)}${p.host ? ' ★' : ''}<small>${esc(p.carName)}</small></span>`).join('');
      return `<article class="room" data-room="${esc(r.name)}">
        <div><div class="r-name">${esc(r.name)}</div><div class="r-meta"><i class="dot" style="--c:${esc(r.color)}"></i>${esc(r.trackName)} · ${r.laps} ${r.laps === 1 ? 'lap' : 'laps'}</div></div>
        <div class="r-who"><div><span class="r-state${busy ? ' busy' : ''}">${label}</span> <span class="r-count">· ${r.players.length}/${r.max} players</span></div>
          <div class="r-players">${chips}</div></div>
        <div class="r-go"><button type="button" class="btn" data-join="${esc(r.name)}" ${full ? 'disabled' : ''}>${full ? 'Full' : 'Join'}</button>
          ${!full && busy ? '<span class="note">You race in the next one</span>' : ''}</div>
      </article>`;
    }).join('');
  }
  list.addEventListener('click', (e) => {
    const j = (e.target as HTMLElement).closest<HTMLElement>('[data-join]');
    if (j) join(j.dataset.join!);
  });
  /** The track switch: all rooms, or one track's (kept in the URL). */
  function renderFilter() {
    const cs = data?.courses ?? [];
    if (only && cs.length && !cs.some((c) => c.id === only)) only = null;
    const html = cs.length < 2 ? '' : [`<a href="#" data-only="" class="${only ? '' : 'on'}">All</a>`,
      ...cs.map((c) => `<a href="#" data-only="${esc(c.id)}" class="${only === c.id ? 'on' : ''}" style="--c:${esc(c.color)}"><i></i>${esc(c.name)}</a>`)].join('');
    if (filterEl.innerHTML !== html) filterEl.innerHTML = html;
  }
  filterEl.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).closest<HTMLElement>('[data-only]');
    if (!a) return;
    e.preventDefault();
    only = a.dataset.only || null;
    const p = new URLSearchParams(location.search);
    if (only) p.set('track', only);
    else p.delete('track');
    const qs = p.toString();
    history.replaceState(null, '', `${location.pathname}${qs ? `?${qs}` : ''}`);
    render();
  });
  async function join(name: string) {
    const r = data?.rooms.find((x) => x.name === name);
    if (!r || !(await signedIn())) return;
    location.href = roomHref(r.name, r.track, r.laps, { car: myCar(), server: serverQ });
  }
  refresh();
  setInterval(refresh, 2000);

  // ---- create a room (create-room.ts: the landing has the same)
  createBtn.addEventListener('click', () => {
    if (!data) return;
    openCreateRoom({
      courses: data.courses,
      track: only ?? undefined,
      taken: (n) => !!data?.rooms.some((r) => r.name === n),
      go: async (room, track, laps, bots) => {
        if (await signedIn()) location.href = roomHref(room, track, laps, { car: myCar(), bots, server: serverQ });
      },
      join: (n) => void join(n),
    });
  });
  Object.assign(window as any, { __lobby: { get data() { return data; }, get down() { return down; } } });
}

main();
