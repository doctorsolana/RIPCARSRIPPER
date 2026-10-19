import { loadSession } from './auth/session';
import type { RoomListing } from './drive/net/protocol';
import { cleanRoom } from './drive/net/prefs';
import { TRACK_IMG } from './home/tracks';

// Create a room: the dialog the lobby browser (online.html) and the landing share - a name (filled in: the wallet's
// first four characters and a number; a name that's already open is refused, with a link to join it), the track, laps
// (1, 2, 3, 5) and bots (off, 2, 4, 6). `go` opens the room; the caller makes sure there's a signed-in wallet first.

export interface CreateRoom {
  courses: RoomListing['courses'];
  /** A room by this name is open now. */
  taken(name: string): boolean;
  /** The track picked to start with (default: the Sky Tower). */
  track?: string;
  go(room: string, track: string, laps: number, bots: number): void;
  join(room: string): void;
}

const CSS = `
dialog.mkroom { width: min(calc(100vw - 32px), 480px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid #33353f; border-radius: 20px;
  background: #14151b; color: #eef0f3; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); font: 500 14px/1.45 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; overscroll-behavior: contain; }
dialog.mkroom::backdrop { background: rgba(5, 6, 8, 0.7); backdrop-filter: blur(4px); -webkit-backdrop-filter: blur(4px); }
.mkroom * { box-sizing: border-box; }
.mkroom form { display: grid; gap: 18px; padding: 22px; }
.mkroom h3 { font: 400 32px/1 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin: 0; }
.mkroom .f { display: grid; gap: 7px; min-width: 0; }
.mkroom .f > span { font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.24em; text-transform: uppercase; color: #8b90a0; }
.mkroom input { width: 100%; min-width: 0; font: 600 15px/1 Inter, system-ui, sans-serif; color: #eef0f3; background: #1d1f27;
  border: 1px solid #2a2c35; border-radius: 10px; padding: 11px 12px; }
.mkroom input:focus { outline: none; border-color: #3dff8b; }
.mkroom .hint { min-height: 1em; font: 500 12px/1.4 Inter, system-ui, sans-serif; color: #ffb020; }
.mkroom .hint:empty { display: none; }
.mkroom .hint a { color: #eef0f3; }
.mkroom .tracks { display: grid; grid-template-columns: 1fr 1fr; gap: 8px; }
.mkroom .opt { position: relative; display: flex; align-items: flex-end; aspect-ratio: 16 / 9; padding: 10px 12px; overflow: hidden; border-radius: 12px;
  color: #fff; background: #1d1f27 center / cover no-repeat; border: 2px solid transparent; cursor: pointer; text-align: left;
  font: 400 19px/1 Anton, Impact, sans-serif; letter-spacing: 0.03em; box-shadow: inset 0 -50px 40px -20px rgba(0, 0, 0, 0.75); }
.mkroom .opt i { width: 8px; height: 8px; margin: 0 8px 4px 0; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); flex: none; }
.mkroom .opt[aria-checked="false"] { filter: saturate(0.5) brightness(0.7); }
.mkroom .opt[aria-checked="true"] { border-color: var(--c); }
.mkroom .seg { display: flex; gap: 4px; padding: 3px; border-radius: 12px; background: #1d1f27; border: 1px solid #2a2c35; }
.mkroom .seg button { flex: 1; padding: 9px 6px; border: 0; border-radius: 9px; background: none; color: #8b90a0; font: 700 14px/1 Inter, system-ui, sans-serif; cursor: pointer; }
.mkroom .seg button[aria-checked="true"] { background: rgba(255, 255, 255, 0.14); color: #fff; }
.mkroom .row2 { display: grid; grid-template-columns: 1fr 1fr; gap: 14px; }
.mkroom .actions { display: flex; gap: 10px; margin-top: 4px; }
.mkroom .actions button { flex: 1; display: inline-flex; align-items: center; justify-content: center; padding: 14px 18px; border-radius: 999px; border: 0;
  font: 700 12px/1 Inter, system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; cursor: pointer; }
.mkroom .actions .no { color: #eef0f3; background: rgba(255, 255, 255, 0.06); border: 1px solid rgba(255, 255, 255, 0.16); }
.mkroom .actions .no:hover { background: rgba(255, 255, 255, 0.1); }
.mkroom .actions .go { color: #0b0c10; background: #3dff8b; box-shadow: 0 6px 24px rgba(61, 255, 139, 0.2); }
.mkroom .actions .go:hover { background: #24e676; }
.mkroom .actions .go:active { background: #1cc965; }
.mkroom .actions .go:disabled { opacity: 0.4; cursor: default; box-shadow: none; }
@media (max-width: 560px) { .mkroom form { padding: 18px; gap: 16px; } .mkroom .row2 { grid-template-columns: 1fr; } }
`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

export function openCreateRoom(o: CreateRoom) {
  if (!document.getElementById('mkroom-css')) {
    const st = document.createElement('style');
    st.id = 'mkroom-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const courses = o.courses;
  let track = courses.find((c) => c.id === o.track)?.id ?? courses.find((c) => c.id === 'sky')?.id ?? courses[0].id, laps = 3, bots = 0;
  const base = cleanRoom(loadSession()?.wallet.slice(0, 4) ?? '') || 'race';
  let room = `${base}-${10 + Math.floor(Math.random() * 90)}`;
  const dlg = document.createElement('dialog');
  dlg.className = 'mkroom';
  dlg.id = 'dlg';
  dlg.setAttribute('aria-labelledby', 'dlg-t');
  dlg.innerHTML = `<form method="dialog">
      <h3 id="dlg-t">Create a room</h3>
      <label class="f"><span>Name</span><input id="c-name" maxlength="32" value="${esc(room)}" autocomplete="off" spellcheck="false"><i class="hint" id="c-hint"></i></label>
      <div class="f"><span>Track</span><div class="tracks" role="radiogroup" aria-label="Track">
        ${courses.map((c) => `<button type="button" class="opt" role="radio" data-track="${esc(c.id)}" style="--c:${esc(c.color)}${TRACK_IMG[c.id] ? `;background-image:url(${TRACK_IMG[c.id].small})` : ''}" title="${esc(c.blurb)}"><i></i>${esc(c.name)}</button>`).join('')}
      </div></div>
      <div class="row2">
        <div class="f"><span>Laps</span><div class="seg" role="radiogroup" aria-label="Laps">
          ${[1, 2, 3, 5].map((n) => `<button type="button" role="radio" data-laps="${n}">${n}</button>`).join('')}</div></div>
        <div class="f"><span>Bots</span><div class="seg" role="radiogroup" aria-label="Bots">
          ${[0, 2, 4, 6].map((n) => `<button type="button" role="radio" data-bots="${n}">${n ? n : 'Off'}</button>`).join('')}</div></div>
      </div>
      <div class="actions"><button type="button" class="no" id="c-cancel">Cancel</button><button type="submit" class="go" id="c-go">Create room</button></div>
    </form>`;
  document.body.append(dlg);
  const nameIn = dlg.querySelector<HTMLInputElement>('#c-name')!, hint = dlg.querySelector<HTMLElement>('#c-hint')!;
  const goBtn = dlg.querySelector<HTMLButtonElement>('#c-go')!;
  const sync = () => {
    for (const b of dlg.querySelectorAll<HTMLElement>('[data-track]')) b.setAttribute('aria-checked', String(b.dataset.track === track));
    for (const b of dlg.querySelectorAll<HTMLElement>('[data-laps]')) b.setAttribute('aria-checked', String(Number(b.dataset.laps) === laps));
    for (const b of dlg.querySelectorAll<HTMLElement>('[data-bots]')) b.setAttribute('aria-checked', String(Number(b.dataset.bots) === bots));
    room = cleanRoom(nameIn.value);
    const taken = !!room && o.taken(room);
    goBtn.disabled = !room || taken;
    if (!room) hint.textContent = 'Letters, numbers and dashes';
    else if (taken) {
      hint.innerHTML = `<b>${esc(room)}</b> is already open. <a href="#" id="c-join">Join it</a>`;
      hint.querySelector('#c-join')!.addEventListener('click', (e) => (e.preventDefault(), dlg.close(), o.join(room)));
    } else hint.textContent = '';
  };
  nameIn.addEventListener('input', () => {
    const c = cleanRoom(nameIn.value);
    if (c !== nameIn.value) {
      const at = nameIn.selectionStart ?? c.length;
      nameIn.value = c;
      nameIn.setSelectionRange(Math.min(at, c.length), Math.min(at, c.length));
    }
    sync();
  });
  dlg.addEventListener('click', (e) => {
    const t = (e.target as HTMLElement).closest<HTMLElement>('[data-track],[data-laps],[data-bots]');
    if (t?.dataset.track) track = t.dataset.track;
    else if (t?.dataset.laps) laps = Number(t.dataset.laps);
    else if (t?.dataset.bots) bots = Number(t.dataset.bots);
    if (t) sync();
    if (e.target === dlg) dlg.close(); // a click on the backdrop
  });
  dlg.querySelector('#c-cancel')!.addEventListener('click', () => dlg.close());
  dlg.querySelector('form')!.addEventListener('submit', (e) => {
    e.preventDefault();
    sync();
    if (goBtn.disabled) return;
    o.go(room, track, laps, bots);
  });
  dlg.addEventListener('close', () => dlg.remove());
  sync();
  dlg.showModal();
  nameIn.focus();
  nameIn.select();
}
