import { shortWallet } from './auth/address';
import { clearSession, loadSession, onSession, type Session } from './auth/session';
import { WORDMARK } from './brand';
import { isDev, onDev, setDev } from './dev';

// The top bar shared by every page: the wordmark (home: the landing), Drive, Race online (the way into multiplayer:
// online.html, the room browser), Rip a pack (app.ripcars.io, where the Rip Cars come from: a new tab), and in dev mode
// (dev.ts) the tools - Reveal (the pack-rip prototype, rip.html) and Inspect - with a DEV badge by the logo. On the
// reveal and the drive page a car picker plus "random" (the drive page adds its track switch; in an online room the
// picker swaps the car in place: onCar), and at the right end the wallet chip: "Connect wallet" signed out (the wallet
// picker: auth/wallets.ts, loaded only then), the wallet's icon and short address signed in, with a menu - copy the
// address, dev mode, disconnect. Your wallet is your name in online races (auth/session.ts). Self-contained (its own
// styles), so it drops into any page.
interface NavCar { id: string; make: string; model: string; year: number | null; modelled: boolean }

/** A segmented switch of links in the bar, before the car picker (the drive page's tracks); the current option is lit
 *  and inert. Where the bar has no room for it in its row (under 1200 px: in the row it would squeeze the car picker to
 *  nothing), it hangs below the bar's right end as a tab, out of the row: the bar stays one 48 px row laid out exactly
 *  as on the other pages, and nothing under it moves. */
export interface NavSwitch {
  label: string; // what it picks (for screen readers)
  options: { name: string; href: string; on: boolean; title?: string; color?: string }[]; // color: the option's dot
}

export interface Nav {
  el: HTMLElement;
  /** Show this car as the current one (the picker, and the links that carry it across pages). */
  setCar(id: string): void;
}

/** Where the Rip Cars come from (the top bar's Rip a pack, the landing's). */
export const RIPCARS_URL = 'https://app.ripcars.io/';

const CSS = `
#nav { position: fixed; top: 0; left: 0; right: 0; z-index: 20; height: 48px; display: flex; align-items: center; gap: 14px;
  padding: 0 max(16px, env(safe-area-inset-left)); background: rgba(10, 11, 15, 0.72); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  font: 500 13px/1 Inter, system-ui, sans-serif; color: #eef0f3; }
#nav .brand { --wm: 13px; display: inline-flex; flex: none; align-items: center; gap: 10px; align-self: stretch; color: #fff; text-decoration: none; white-space: nowrap; }
#nav .brand .rc-wm { --lamp-off: rgba(255, 255, 255, 0.2); display: block; height: var(--wm); width: calc(var(--wm) * 8.81); flex: none; }
#nav .brand .dv { display: none; padding: 3px 5px 2px; border-radius: 4px; font: 800 9px/1 Inter, system-ui, sans-serif; letter-spacing: 0.14em;
  color: #0b0b0d; background: #ffb020; }
#nav.dev .brand .dv { display: inline-block; }
#nav .links { display: flex; flex: none; gap: 4px; }
#nav .links a { display: inline-flex; align-items: center; color: rgba(238, 240, 243, 0.7); text-decoration: none; padding: 8px 10px; border-radius: 8px; white-space: nowrap; }
#nav .links a:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
#nav .links a.on { color: #fff; box-shadow: inset 0 -2px 0 #3dff8b; border-radius: 0; }
#nav .links a.race { gap: 7px; color: #fff; }
#nav .links a.race::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #3dff8b; box-shadow: 0 0 8px rgba(61, 255, 139, 0.7); }
#nav .links a.ext svg { width: 9px; height: 9px; margin-left: 5px; opacity: 0.55; flex: none; }
#nav .links a.dev { display: none; color: rgba(255, 192, 77, 0.8); }
#nav .links a.dev:hover { color: #ffc04d; }
#nav .links a.dev.on { color: #ffc04d; box-shadow: inset 0 -2px 0 #ffb020; }
#nav.dev .links a.dev { display: inline-flex; }
#nav .spacer { flex: 1; }
#nav a:focus-visible, #nav button:focus-visible, #nav select:focus-visible { outline: 2px solid #3dff8b; outline-offset: 2px; }
#nav .narrow { display: none; }
#nav select, #nav button { font: inherit; color: #eef0f3; background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px; padding: 7px 10px; cursor: pointer; max-width: 46vw; min-width: 0; }
#nav button { display: inline-flex; align-items: center; gap: 6px; flex: none; }
#nav select option { color: #111; }
#nav button:hover, #nav select:hover { border-color: rgba(61, 255, 139, 0.6); }
#nav .seg { display: flex; flex: none; gap: 2px; padding: 2px; border-radius: 9px; background: rgba(255, 255, 255, 0.07);
  border: 1px solid rgba(255, 255, 255, 0.12); }
#nav .seg a { display: flex; align-items: center; gap: 7px; padding: 8px 11px; border-radius: 6px; color: rgba(238, 240, 243, 0.7);
  text-decoration: none; white-space: nowrap; }
#nav .seg a::before { content: ''; flex: none; width: 6px; height: 6px; border-radius: 50%; background: var(--dot, currentColor); opacity: 0.6; }
#nav .seg a:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
#nav .seg a.on { color: #fff; background: rgba(255, 255, 255, 0.15); cursor: default; }
#nav .seg a.on::before { opacity: 1; box-shadow: 0 0 8px var(--dot, currentColor); }
@media (max-width: 1199px) {
  #nav .seg { position: absolute; top: 100%; right: max(16px, env(safe-area-inset-right)); padding: 0 3px 3px; border-top: 0;
    border-radius: 0 0 11px 11px; background: rgba(10, 11, 15, 0.72); border-color: rgba(255, 255, 255, 0.07);
    backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); }
  #nav .seg a { padding: 7px 10px; font-size: 12px; }
}
/* the wallet chip and its menu */
#nav .wal { position: relative; flex: none; }
#nav .wal .w-chip { position: relative; max-width: none; font-variant-numeric: tabular-nums; }
#nav .wal:not(.in) .w-chip { border-color: rgba(61, 255, 139, 0.45); }
#nav .w-chip img, #nav .w-chip svg { width: 16px; height: 16px; border-radius: 4px; flex: none; }
#nav .w-chip .w-dot { display: none; position: absolute; right: 3px; top: 3px; width: 7px; height: 7px; border-radius: 50%; background: #3dff8b;
  box-shadow: 0 0 0 2px #14151b; }
#nav .w-menu { position: absolute; top: calc(100% + 8px); right: 0; min-width: 250px; display: grid; gap: 2px; padding: 6px; border-radius: 14px;
  background: #14151b; border: 1px solid #33353f; box-shadow: 0 18px 50px rgba(0, 0, 0, 0.55); }
#nav .w-menu[hidden] { display: none; }
#nav .w-who { display: flex; align-items: center; gap: 10px; padding: 8px 10px 12px; margin-bottom: 4px; border-bottom: 1px solid #2a2c35; }
#nav .w-who img, #nav .w-who svg { width: 30px; height: 30px; border-radius: 8px; flex: none; }
#nav .w-who svg { padding: 6px; background: rgba(255, 255, 255, 0.07); }
#nav .w-who b { display: block; font: 600 15px/1.2 Inter, system-ui, sans-serif; font-variant-numeric: tabular-nums; }
#nav .w-who small { display: block; margin-top: 4px; font-size: 11.5px; line-height: 1.3; color: rgba(238, 240, 243, 0.55); }
#nav .w-menu button { width: 100%; max-width: none; justify-content: flex-start; gap: 10px; padding: 10px; border: 0; border-radius: 9px; background: none; }
#nav .w-menu button:hover { background: rgba(255, 255, 255, 0.07); border: 0; }
#nav .w-menu button svg { width: 15px; height: 15px; flex: none; opacity: 0.8; }
#nav .w-menu button .sw { margin-left: auto; }
#nav .w-menu hr { margin: 4px 6px; border: 0; border-top: 1px solid #2a2c35; }
/* a small on/off switch (the dev mode row) */
.rc-sw { position: relative; flex: none; width: 28px; height: 16px; border-radius: 8px; background: rgba(255, 255, 255, 0.16); transition: background 0.15s; }
.rc-sw::after { content: ''; position: absolute; left: 2px; top: 2px; width: 12px; height: 12px; border-radius: 50%; background: #fff; transition: transform 0.15s; }
[aria-checked="true"] > .rc-sw { background: #ffb020; }
[aria-checked="true"] > .rc-sw::after { transform: translateX(12px); }
/* narrower, the bar never wraps or spills: the page links keep one line and the car picker gives way (it shrinks), then
   in steps - the picker's neighbours go to icons (Random car, the wallet chip: its menu has the address; signed in, a
   green dot on the wallet's icon), the page links go short, then the phone layout */
@media (max-width: 1099px) {
  #nav.picker > button .wide, #nav.picker .w-t { display: none; }
  #nav.picker .wal.in .w-dot { display: block; }
}
@media (max-width: 900px) {
  #nav .wide { display: none; }
  #nav .narrow { display: inline; }
}
@media (max-width: 640px) {
  #nav { gap: 6px; }
  #nav .brand { --wm: 11px; gap: 7px; }
  #nav .links { gap: 0; }
  #nav .links a { padding: 8px 6px; }
  #nav .links a.race { gap: 5px; }
  #nav .links a.ext svg { margin-left: 3px; }
  #nav select { max-width: 24vw; }
  #nav .w-t { display: none; }
  #nav .wal.in .w-dot { display: block; }
}
/* a phone's bar with the car picker has no room for every link: the dev tools step out for it, and Rip a pack (the
   bar's links stay on every other page) */
@media (max-width: 440px) { #nav.picker .links a.ext { display: none; } }
/* dev mode: the tools need room - Rip a pack steps out first, then on a phone the tools (they open by URL, and the
   landing's foot links them) */
@media (max-width: 900px) { #nav.dev .links a.ext { display: none; } }
@media (max-width: 640px) { #nav.dev .links a.dev { display: none; } }
@media (max-width: 374px) { #nav.picker .brand .dv { display: none; } }
@media (max-width: 359px) { #nav select { max-width: 19vw; } #nav .brand { --wm: 10px; } #nav.picker { gap: 4px; } #nav.picker .brand { --wm: 8.5px; gap: 5px; } }
`;
/** A wallet glyph (16 x 16, currentColor): the chip signed out, and the lobby's Connect wallet. */
export const WALLET = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M13 5.5V4a1.5 1.5 0 0 0-1.5-1.5h-8A1.5 1.5 0 0 0 2 4v8a1.5 1.5 0 0 0 1.5 1.5h9A1.5 1.5 0 0 0 14 12V7a1.5 1.5 0 0 0-1.5-1.5H2.5"/><circle cx="11" cy="9.5" r="1" fill="currentColor" stroke="none"/></svg>';
/** An arrow out (external links: Rip a pack). */
export const EXT = '<svg viewBox="0 0 10 10" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 1.5h5.5V7M8.5 1.5L1.5 8.5"/></svg>';
const COPY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M10.5 3.5v-.5A1 1 0 0 0 9.5 2h-6A1 1 0 0 0 2.5 3v6a1 1 0 0 0 1 1h.5"/></svg>';
const EXIT = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6.5 13.5h-3a1 1 0 0 1-1-1v-9a1 1 0 0 1 1-1h3M10.5 11l3-3-3-3M13.5 8H6"/></svg>';
const CODE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5.5 4.5L2 8l3.5 3.5M10.5 4.5L14 8l-3.5 3.5"/></svg>';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);

/** The wallet chip at the bar's right end, kept in step with the sign-in (this tab's and the other tabs'). */
function mountWallet(el: HTMLElement) {
  const box = document.createElement('div');
  box.className = 'wal';
  el.append(box);
  let s: Session | null = null;
  const render = (now: Session | null) => {
    s = now;
    box.classList.toggle('in', !!s);
    if (!s) {
      box.innerHTML = `<button type="button" class="w-chip" aria-label="Connect wallet" title="Connect a Solana wallet">${WALLET}<span class="w-t">Connect wallet</span></button>`;
      return;
    }
    const icon = s.icon ? `<img src="${s.icon}" alt="">` : WALLET;
    box.innerHTML = `<button type="button" class="w-chip" aria-haspopup="menu" aria-expanded="false" aria-label="Wallet ${s.wallet}" title="${s.wallet}">${icon}<span class="w-t">${shortWallet(s.wallet)}</span><i class="w-dot"></i></button>
      <div class="w-menu" role="menu" hidden>
        <div class="w-who">${icon}<div><b>${shortWallet(s.wallet)}</b>${s.name ? `<small>${esc(s.name)}</small>` : ''}</div></div>
        <button type="button" role="menuitem" data-act="copy">${COPY}<span>Copy address</span></button>
        <button type="button" role="menuitemcheckbox" aria-checked="${isDev()}" data-act="dev">${CODE}<span>Dev mode</span><i class="rc-sw sw"></i></button>
        <hr>
        <button type="button" role="menuitem" data-act="out">${EXIT}<span>Disconnect</span></button>
      </div>`;
  };
  const menu = (open: boolean) => {
    const m = box.querySelector<HTMLElement>('.w-menu');
    if (!m) return;
    m.hidden = !open;
    box.querySelector('.w-chip')!.setAttribute('aria-expanded', String(open));
  };
  box.addEventListener('click', async (e) => {
    const t = e.target as HTMLElement;
    if (t.closest('.w-chip')) {
      if (!s) return void (await import('./auth/wallets')).connectWallet();
      return menu(!!box.querySelector<HTMLElement>('.w-menu')!.hidden);
    }
    const act = t.closest<HTMLElement>('[data-act]')?.dataset.act;
    if (act === 'copy' && s) {
      const label = t.closest('button')!.querySelector('span')!;
      label.textContent = (await copy(s.wallet)) ? 'Copied' : 'Copy failed';
      setTimeout(() => label.isConnected && ((label.textContent = 'Copy address'), menu(false)), 1200);
    } else if (act === 'dev') {
      setDev(!isDev()); // (the bar and the row follow: onDev)
    } else if (act === 'out' && s) {
      const name = s.name;
      clearSession();
      void import('./auth/wallets').then((m) => m.disconnectWallet(name)); // (the wallet forgets this site too, if it can)
    }
  });
  addEventListener('pointerdown', (e) => !box.contains(e.target as Node) && menu(false));
  addEventListener('keydown', (e) => e.key === 'Escape' && menu(false));
  onSession(render);
  onDev((on) => box.querySelector('[data-act="dev"]')?.setAttribute('aria-checked', String(on)));
  render(loadSession());
}
async function copy(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // no clipboard API (plain http on a LAN address): the old way
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    let ok = false;
    try {
      ok = document.execCommand('copy');
    } catch {
      ok = false;
    }
    ta.remove();
    return ok;
  }
}

/** `onCar`: the car picker and Random car call this instead of reloading the page with ?car= (an online room swaps
 *  the car in place); it also puts the picker on a page that has none. */
export async function mountNav(page: 'home' | 'rip' | 'inspect' | 'drive' | 'online', opts: { switch?: NavSwitch; onCar?: (id: string) => void } = {}): Promise<Nav> {
  // embedded (the inspector's Reveal tab shows the reveal in a frame): the outer page has the bar
  if (window.top !== window.self) return { el: document.createElement('header'), setCar() {} };
  document.body.classList.add('nav-on');
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('header');
  el.id = 'nav';
  el.innerHTML = `
    <a class="brand" href="/" aria-label="racecars">${WORDMARK}<b class="dv" title="Dev mode is on">DEV</b></a>
    <nav class="links">
      <a href="/drive.html" data-page="drive">Drive</a>
      <a href="/online.html" data-page="online" class="race"><span class="wide">Race online</span><span class="narrow">Online</span></a>
      <a href="${RIPCARS_URL}" class="ext" target="_blank" rel="noopener" data-page="ripcars"><span class="wide">Rip a pack</span><span class="narrow">Rip</span>${EXT}</a>
      <a href="/rip.html" data-page="rip" class="dev">Reveal</a>
      <a href="/inspect.html" data-page="inspect" class="dev">Inspect</a>
    </nav>
    <span class="spacer"></span>`;
  el.querySelector(`[data-page="${page}"]`)?.classList.add('on');
  el.classList.toggle('dev', isDev());
  onDev((on) => el.classList.toggle('dev', on));
  if (opts.switch) {
    // links (a switch reloads the page): the current one has no href, so it's inert. It goes in after the spacer, so
    // the car picker and Random car (appended once the car list is in) land after it
    const seg = document.createElement('nav');
    seg.className = 'seg';
    seg.setAttribute('aria-label', opts.switch.label);
    for (const o of opts.switch.options) {
      const a = document.createElement('a');
      a.textContent = o.name;
      if (o.title) a.title = o.title;
      if (o.color) a.style.setProperty('--dot', o.color);
      if (o.on) {
        a.className = 'on';
        a.setAttribute('aria-current', 'page');
      } else a.href = o.href;
      seg.append(a);
    }
    el.append(seg);
  }
  mountWallet(el);
  document.body.prepend(el);

  const { cars } = (await fetch('/cars/index.json').then((r) => r.json()).catch(() => ({ cars: [] }))) as { cars: NavCar[] };
  const modelled = cars.filter((c) => c.modelled);
  const rip = el.querySelector<HTMLAnchorElement>('[data-page="rip"]')!;
  const inspect = el.querySelector<HTMLAnchorElement>('[data-page="inspect"]')!;
  const drive = el.querySelector<HTMLAnchorElement>('[data-page="drive"]')!;
  const online = el.querySelector<HTMLAnchorElement>('[data-page="online"]')!;
  let select: HTMLSelectElement | null = null;

  if ((page === 'rip' || page === 'drive' || opts.onCar) && modelled.length) {
    // pick a car, or rip a random one; both reload the page with ?car=
    select = document.createElement('select');
    select.title = page !== 'rip' ? 'Which car to drive' : 'Which car to reveal';
    select.innerHTML = modelled.map((c) => `<option value="${c.id}">${c.make} ${c.model}${c.year ? ` · ${c.year}` : ''}</option>`).join('');
    select.addEventListener('change', () => go(select!.value));
    const random = document.createElement('button');
    random.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.2" cy="5.2" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="10.8" cy="10.8" r="1.2" fill="currentColor"/></svg><span class="wide">${page !== 'rip' ? 'Random car' : 'Random pack'}</span>`;
    random.setAttribute('aria-label', page !== 'rip' ? 'Drive a random car' : 'Rip a random car');
    random.title = page !== 'rip' ? 'Drive a random car' : 'Rip a random car';
    random.addEventListener('click', () => {
      const others = modelled.filter((c) => c.id !== select!.value);
      go((others.length ? others : modelled)[Math.floor(Math.random() * (others.length || modelled.length))].id);
    });
    el.querySelector('.wal')!.before(select, random); // (the wallet chip stays at the right end)
    el.classList.add('picker');
  }

  function go(id: string) {
    if (opts.onCar) return opts.onCar(id);
    const q = new URLSearchParams(location.search);
    q.set('car', id);
    location.search = q.toString();
  }

  return {
    el,
    setCar(id: string) {
      if (select && [...select.options].some((o) => o.value === id)) select.value = id;
      // the links carry the car across: inspect what you just ripped, rip what you're inspecting, drive it (from the
      // drive page: on the same track; from anywhere else: the meadow)
      if (modelled.some((c) => c.id === id)) {
        rip.href = `/rip.html?car=${id}`;
        const track = page === 'drive' ? new URLSearchParams(location.search).get('track') : null;
        drive.href = `/drive.html?car=${id}${track ? `&track=${encodeURIComponent(track)}` : ''}`;
      }
      inspect.href = `/inspect.html?car=${id}`;
      if (modelled.some((c) => c.id === id)) online.href = `/online.html?car=${id}`;
    },
  };
}
