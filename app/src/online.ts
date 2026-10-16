import { mountNav } from './nav';
import type { RoomListing } from './drive/net/protocol';
import {
  cleanName, cleanRoom, DEFAULT_CAR, randomName, roomHref, saveCar, savedCar, savedName, saveName, serverHttp, serverUrl,
} from './drive/net/prefs';

// /online.html: the way into multiplayer (the top bar's "Race online"). Your name and car (remembered), the open rooms
// on the game server (GET /rooms, every 2 s) with a Join on each, and Create room (a name, the track, laps, bots).
// Join and Create open the drive page in the room (?online=1&room=...: net/online.ts), where the room's own lobby is.
// When the server isn't there it says so, with the command that starts it (a local demo: `npm run server`).
// Knobs: ?car=<id> (from the top bar's links), ?server=ws://host:port.

interface NavCar { id: string; make: string; model: string; year: number | null; modelled: boolean }

const CSS = `
:root { --bg: #0d0e12; --panel: #16171d; --panel2: #1d1f27; --text: #eef0f3; --muted: #8b90a0; --line: #2a2c35; --accent: #ff3d6e;
  --ok: #3ddc84; --warn: #ffb020; }
* { box-sizing: border-box; }
html, body { margin: 0; min-height: 100%; background: var(--bg); color: var(--text); font: 500 14px/1.45 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; }
body { background: radial-gradient(90% 60% at 50% 0%, #181a22 0%, var(--bg) 70%) fixed; }
#app { max-width: 820px; margin: 0 auto; padding: calc(48px + 40px) max(16px, env(safe-area-inset-right)) 64px max(16px, env(safe-area-inset-left)); }
h1 { font: 400 56px/1 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin: 0; }
.lead { color: var(--muted); font-size: 15px; margin: 12px 0 0; max-width: 560px; }
.eyebrow { font: 700 11px/1 Inter, system-ui, sans-serif; letter-spacing: 0.3em; text-transform: uppercase; color: var(--muted); }
.you { display: grid; grid-template-columns: 1fr 1.3fr; gap: 12px; margin-top: 28px; padding: 16px; background: var(--panel);
  border: 1px solid var(--line); border-radius: 16px; }
label { display: grid; gap: 7px; }
label > span { font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.24em; text-transform: uppercase; color: var(--muted); }
input, select { width: 100%; min-width: 0; font: 600 15px/1 Inter, system-ui, sans-serif; color: var(--text); background: var(--panel2);
  border: 1px solid var(--line); border-radius: 10px; padding: 11px 12px; }
select { appearance: none; background-image: linear-gradient(45deg, transparent 50%, var(--muted) 50%), linear-gradient(135deg, var(--muted) 50%, transparent 50%);
  background-position: calc(100% - 17px) 52%, calc(100% - 12px) 52%; background-size: 5px 5px; background-repeat: no-repeat; padding-right: 30px; }
select option { color: #111; }
input:focus, select:focus { outline: none; border-color: var(--accent); }
.head { display: flex; align-items: center; justify-content: space-between; gap: 12px; margin: 36px 0 12px; }
h2 { font: 400 26px/1 Anton, Impact, sans-serif; letter-spacing: 0.03em; margin: 0; display: flex; align-items: baseline; gap: 10px; }
h2 small { font: 600 13px/1 Inter, system-ui, sans-serif; color: var(--muted); letter-spacing: 0; }
button { font: inherit; cursor: pointer; }
.btn { display: inline-flex; align-items: center; justify-content: center; gap: 8px; padding: 13px 20px; border-radius: 999px; border: 0;
  font: 700 12px/1 Inter, system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; color: #0b0b0d; background: #fff;
  text-decoration: none; white-space: nowrap; }
.btn:hover { background: #e4e6ea; }
.btn.primary { color: #fff; background: var(--accent); box-shadow: 0 6px 24px rgba(255, 61, 110, 0.3); }
.btn.primary:hover { background: #ff5582; }
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
.panel { padding: 28px 24px; text-align: center; background: var(--panel); border: 1px dashed #3a3d48; border-radius: 16px; color: var(--muted); }
.panel b { display: block; color: var(--text); font: 400 24px/1.1 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin-bottom: 8px; }
.panel p { margin: 6px auto 0; max-width: 460px; }
.panel .btn { margin-top: 18px; }
.panel.down { border-style: solid; border-color: rgba(255, 176, 32, 0.35); }
.panel.down b { color: var(--warn); }
code { font: 600 14px/1 ui-monospace, SFMono-Regular, Menlo, monospace; color: var(--text); background: #0a0b0e; border: 1px solid var(--line);
  padding: 8px 12px; border-radius: 8px; display: inline-block; margin-top: 12px; user-select: all; }
.how { margin-top: 36px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; }
.how div { padding: 14px 16px; border-radius: 14px; border: 1px solid var(--line); color: var(--muted); font-size: 13px; }
.how b { display: block; color: var(--text); font-size: 13px; margin-bottom: 4px; }
.how i { font-style: normal; font: 400 20px/1 Anton, Impact, sans-serif; color: var(--accent); margin-right: 8px; }

dialog { width: min(calc(100vw - 32px), 480px); padding: 0; border: 1px solid #33353f; border-radius: 20px; background: #14151b; color: var(--text);
  box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); }
dialog::backdrop { background: rgba(5, 6, 8, 0.7); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
dialog form { display: grid; gap: 18px; padding: 22px; }
dialog h3 { font: 400 32px/1 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin: 0; }
label > span.field-hint, .field-hint { font: 500 12px/1.4 Inter, system-ui, sans-serif; letter-spacing: 0; text-transform: none; color: var(--muted); }
label > span.field-hint.err { color: var(--warn); }
.field-hint a { color: var(--text); }
.tracks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.opt { position: relative; display: grid; gap: 4px; text-align: left; padding: 12px 12px 12px 14px; border-radius: 12px; color: var(--text);
  background: var(--panel2); border: 1px solid var(--line); }
.opt b { display: flex; align-items: center; gap: 8px; font-size: 14px; }
.opt small { color: var(--muted); font-size: 12px; line-height: 1.35; }
.opt[aria-checked="true"] { border-color: var(--c, var(--accent)); background: color-mix(in srgb, var(--c, var(--accent)) 14%, var(--panel2)); }
.seg { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: var(--panel2); border: 1px solid var(--line); }
.seg button { flex: 1; padding: 9px 6px; border: 0; border-radius: 9px; background: none; color: var(--muted); font-weight: 700; }
.seg button[aria-checked="true"] { background: rgba(255, 255, 255, 0.14); color: #fff; }
.row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.actions { display: flex; gap: 10px; justify-content: flex-end; margin-top: 4px; }
.actions .btn { flex: 1; }

@media (max-width: 640px) {
  #app { padding-top: calc(48px + 24px); }
  h1 { font-size: 44px; }
  .lead { font-size: 14px; }
  .you { grid-template-columns: 1fr; margin-top: 20px; }
  .head { margin-top: 28px; }
  .head .btn { padding: 12px 16px; }
  .room { grid-template-columns: 1fr auto; gap: 12px; padding: 14px; }
  .r-who { grid-column: 1 / -1; grid-row: 2; }
  .r-go { grid-column: 2; grid-row: 1; }
  .how { grid-template-columns: 1fr; }
  .row2 { grid-template-columns: 1fr; }
  dialog form { padding: 18px; gap: 16px; }
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
    <div class="eyebrow">Multiplayer</div>
    <h1>Race online</h1>
    <p class="lead">Race other players live, on the same track. Join a room below, or create one and send your friends the invite link.</p>
    <section class="you" aria-label="You">
      <label><span>Your name</span><input id="name" maxlength="20" autocomplete="nickname" placeholder="Your name"></label>
      <label><span>Your car</span><select id="car"></select></label>
    </section>
    <div class="head"><h2>Open rooms <small id="count"></small></h2><button type="button" class="btn primary" id="create">${PLUS}Create room</button></div>
    <div id="list" aria-live="polite"><div class="panel"><p>Looking for rooms…</p></div></div>
    <section class="how" aria-label="How it works">
      <div><b><i>1</i>Join or create</b>Pick an open room, or make your own and choose the track.</div>
      <div><b><i>2</i>Invite</b>In the room, copy the invite link and send it. Up to 10 players.</div>
      <div><b><i>3</i>Ready up</b>When everyone presses Ready, the countdown starts.</div>
    </section>
    <dialog id="dlg" aria-labelledby="dlg-t"></dialog>`;
  const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
  const nameIn = $<HTMLInputElement>('name'), carSel = $<HTMLSelectElement>('car'), list = $('list'), count = $('count');
  const createBtn = $<HTMLButtonElement>('create'), dlg = $<HTMLDialogElement>('dlg');

  // ---- you: name and car (remembered)
  nameIn.value = savedName();
  nameIn.addEventListener('change', () => {
    nameIn.value = cleanName(nameIn.value);
    saveName(nameIn.value);
  });
  const myName = () => {
    let n = cleanName(nameIn.value);
    if (!n) n = nameIn.value = randomName();
    saveName(n);
    return n;
  };
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
    if (!data) {
      count.textContent = '';
      list.innerHTML = `<div class="panel down"><b>Can't reach the game server</b>
        <p>Online races run on a separate server, and it isn't answering at <span style="color:var(--text)">${esc(serverHttp(SERVER))}</span>.</p>
        <p>Running it locally? Start it from the <span style="color:var(--text)">app</span> folder:</p>
        <code>npm run server</code><p style="margin-top:14px">This page checks again every few seconds.</p></div>`;
      return;
    }
    const rooms = data.rooms;
    count.textContent = rooms.length ? String(rooms.length) : '';
    if (!rooms.length) {
      list.innerHTML = `<div class="panel"><b>No open rooms yet</b><p>Create one, then copy its invite link and send it to a friend.
        Or open this page in a second tab to try it out on your own.</p><button type="button" class="btn primary" data-create>${PLUS}Create room</button></div>`;
      return;
    }
    list.innerHTML = rooms.map((r) => {
      const [label, busy] = STATE[r.phase] ?? ['', false];
      const full = r.players.length >= r.max;
      const chips = r.players.map((p) => `<span class="chip${p.bot ? ' bot' : ''}">${esc(p.name)}${p.host ? ' ★' : ''}<small>${esc(p.carName)}</small></span>`).join('');
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
    const t = e.target as HTMLElement;
    if (t.closest('[data-create]')) return openCreate();
    const j = t.closest<HTMLElement>('[data-join]');
    if (j) join(j.dataset.join!);
  });
  function join(name: string) {
    const r = data?.rooms.find((x) => x.name === name);
    if (!r) return;
    location.href = roomHref(r.name, r.track, r.laps, { name: myName(), car: myCar(), server: serverQ });
  }
  refresh();
  setInterval(refresh, 2000);

  // ---- create a room
  createBtn.addEventListener('click', () => openCreate());
  function openCreate() {
    if (!data) return;
    const courses = data.courses;
    let track = courses.find((c) => c.id === 'sky')?.id ?? courses[0].id, laps = 3, bots = 0;
    const base = cleanRoom(cleanName(nameIn.value)) || 'room';
    let room = `${base}-${10 + Math.floor(Math.random() * 90)}`;
    dlg.innerHTML = `<form method="dialog">
      <h3 id="dlg-t">Create a room</h3>
      <label><span>Room name</span><input id="c-name" maxlength="32" value="${esc(room)}" autocomplete="off" spellcheck="false">
        <span class="field-hint" id="c-hint">Players see this name in the list.</span></label>
      <div><label style="margin-bottom:7px"><span>Track</span></label><div class="tracks" role="radiogroup" aria-label="Track">
        ${courses.map((c) => `<button type="button" class="opt" role="radio" data-track="${c.id}" style="--c:${c.color}"><b><i class="dot"></i>${esc(c.name)}</b><small>${esc(c.blurb)}</small></button>`).join('')}
      </div></div>
      <div class="row2">
        <div><label style="margin-bottom:7px"><span>Laps</span></label><div class="seg" role="radiogroup" aria-label="Laps">
          ${[1, 2, 3, 5].map((n) => `<button type="button" role="radio" data-laps="${n}">${n}</button>`).join('')}</div></div>
        <div><label style="margin-bottom:7px"><span>Fill with bots</span></label><div class="seg" role="radiogroup" aria-label="Bots">
          ${[0, 2, 4, 6].map((n) => `<button type="button" role="radio" data-bots="${n}">${n ? n : 'Off'}</button>`).join('')}</div></div>
      </div>
      <span class="field-hint" style="margin-top:-8px">Bots are computer drivers. Friends can still join.</span>
      <div class="actions"><button type="button" class="btn ghost" value="cancel" id="c-cancel">Cancel</button><button type="submit" class="btn primary" id="c-go">Create room</button></div>
    </form>`;
    const nameC = dlg.querySelector<HTMLInputElement>('#c-name')!, hint = dlg.querySelector<HTMLElement>('#c-hint')!;
    const go = dlg.querySelector<HTMLButtonElement>('#c-go')!;
    const sync = () => {
      for (const b of dlg.querySelectorAll<HTMLElement>('[data-track]')) b.setAttribute('aria-checked', String(b.dataset.track === track));
      for (const b of dlg.querySelectorAll<HTMLElement>('[data-laps]')) b.setAttribute('aria-checked', String(Number(b.dataset.laps) === laps));
      for (const b of dlg.querySelectorAll<HTMLElement>('[data-bots]')) b.setAttribute('aria-checked', String(Number(b.dataset.bots) === bots));
      room = cleanRoom(nameC.value);
      const taken = data?.rooms.find((r) => r.name === room);
      go.disabled = !room || !!taken;
      if (!room) hint.textContent = 'Give it a name: letters, numbers and dashes.', hint.className = 'field-hint err';
      else if (taken) {
        hint.innerHTML = `A room called <b>${esc(room)}</b> is already open. Pick another name, or <a href="#" id="c-join">join it</a>.`;
        hint.className = 'field-hint err';
        hint.querySelector('#c-join')!.addEventListener('click', (e) => (e.preventDefault(), join(room)));
      } else hint.textContent = 'Players see this name in the list.', hint.className = 'field-hint';
    };
    nameC.addEventListener('input', () => {
      const c = cleanRoom(nameC.value);
      if (c !== nameC.value) {
        const at = nameC.selectionStart ?? c.length;
        nameC.value = c;
        nameC.setSelectionRange(Math.min(at, c.length), Math.min(at, c.length));
      }
      sync();
    });
    dlg.onclick = (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-track],[data-laps],[data-bots]');
      if (t?.dataset.track) track = t.dataset.track;
      else if (t?.dataset.laps) laps = Number(t.dataset.laps);
      else if (t?.dataset.bots) bots = Number(t.dataset.bots);
      if (t) sync();
      if (e.target === dlg) dlg.close(); // a click on the backdrop
    };
    dlg.querySelector('#c-cancel')!.addEventListener('click', () => dlg.close());
    dlg.querySelector('form')!.addEventListener('submit', (e) => {
      e.preventDefault();
      sync();
      if (go.disabled) return;
      location.href = roomHref(room, track, laps, { name: myName(), car: myCar(), bots, server: serverQ });
    });
    sync();
    dlg.showModal();
    nameC.focus();
    nameC.select();
  }
  Object.assign(window as any, { __lobby: { get data() { return data; }, get down() { return down; } } });
}

main();
