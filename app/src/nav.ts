// The top bar shared by the reveal, the inspector, the drive page and the online lobby: RIPCARS, the pages (Race online
// is the way into multiplayer: online.html, the room browser), and on the reveal and the drive page a car picker plus
// "random pack" (the drive page adds its track switch; in an online room the picker swaps the car in place: onCar).
// Self-contained (its own styles), so it drops into any page.
interface NavCar { id: string; make: string; model: string; year: number | null; modelled: boolean }

/** A segmented switch of links in the bar, before the car picker (the drive page's tracks); the current option is lit
 *  and inert. Where the bar has no room for it in its row (under 1200 px: in the row it would squeeze the page links
 *  onto two lines, which happens below ~1150), it hangs below the bar's right end as a tab, out of the row: the bar
 *  stays one 48 px row laid out exactly as on the other pages, and nothing under it moves. */
export interface NavSwitch {
  label: string; // what it picks (for screen readers)
  options: { name: string; href: string; on: boolean; title?: string; color?: string }[]; // color: the option's dot
}

export interface Nav {
  el: HTMLElement;
  /** Show this car as the current one (the picker, and the links that carry it across pages). */
  setCar(id: string): void;
}

const CSS = `
#nav { position: fixed; top: 0; left: 0; right: 0; z-index: 20; height: 48px; display: flex; align-items: center; gap: 14px;
  padding: 0 max(16px, env(safe-area-inset-left)); background: rgba(10, 11, 15, 0.72); backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid rgba(255, 255, 255, 0.07);
  font: 500 13px/1 Inter, system-ui, sans-serif; color: #eef0f3; }
#nav .brand { font: 400 22px/1 Anton, Impact, sans-serif; letter-spacing: 0.04em; color: #fff; text-decoration: none; }
#nav .brand small { font: 700 9px/1 Inter, system-ui, sans-serif; letter-spacing: 0.18em; text-transform: uppercase;
  color: rgba(238, 240, 243, 0.5); margin-left: 6px; vertical-align: 4px; }
#nav .links { display: flex; gap: 4px; }
#nav .links a { color: rgba(238, 240, 243, 0.7); text-decoration: none; padding: 8px 10px; border-radius: 8px; }
#nav .links a:hover { color: #fff; background: rgba(255, 255, 255, 0.06); }
#nav .links a.on { color: #fff; box-shadow: inset 0 -2px 0 #ff3d6e; border-radius: 0; }
#nav .links a.race { display: inline-flex; align-items: center; gap: 7px; color: #fff; }
#nav .links a.race::before { content: ''; width: 6px; height: 6px; border-radius: 50%; background: #ff3d6e; box-shadow: 0 0 8px #ff3d6e; }
#nav .spacer { flex: 1; }
#nav .narrow { display: none; }
#nav select, #nav button { font: inherit; color: #eef0f3; background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px; padding: 7px 10px; cursor: pointer; max-width: 46vw; min-width: 0; }
#nav button { display: inline-flex; align-items: center; gap: 6px; flex: none; }
#nav select option { color: #111; }
#nav button:hover, #nav select:hover { border-color: #ff3d6e; }
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
@media (max-width: 560px) {
  #nav { gap: 6px; }
  #nav .brand { font-size: 18px; }
  #nav .brand small, #nav .wide { display: none; }
  #nav .narrow { display: inline; }
  #nav .links { gap: 0; }
  #nav .links a { padding: 8px 6px; }
  #nav .links a.race { gap: 5px; }
  #nav select { max-width: 24vw; }
}
/* a phone's bar with the car picker has no room for every page: Inspect (a review tool) steps out for it */
@media (max-width: 440px) { #nav.picker .links a[data-page="inspect"] { display: none; } }
`;

/** `onCar`: the car picker and Random car call this instead of reloading the page with ?car= (an online room swaps
 *  the car in place); it also puts the picker on a page that has none. */
export async function mountNav(page: 'rip' | 'inspect' | 'drive' | 'online', opts: { switch?: NavSwitch; onCar?: (id: string) => void } = {}): Promise<Nav> {
  // embedded (the inspector's Reveal tab shows the reveal in a frame): the outer page has the bar
  if (window.top !== window.self) return { el: document.createElement('header'), setCar() {} };
  document.body.classList.add('nav-on');
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('header');
  el.id = 'nav';
  el.innerHTML = `
    <a class="brand" href="/">RIPCARS<small>prototype</small></a>
    <nav class="links">
      <a href="/" data-page="rip">Rip<span class="wide"> a pack</span></a>
      <a href="/inspect.html" data-page="inspect">Inspect<span class="wide"> cars</span></a>
      <a href="/drive.html" data-page="drive">Drive</a>
      <a href="/online.html" data-page="online" class="race" title="Race other players: join a room or make one"><span class="wide">Race online</span><span class="narrow">Online</span></a>
    </nav>
    <span class="spacer"></span>`;
  el.querySelector(`[data-page="${page}"]`)!.classList.add('on');
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
    el.append(select, random);
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
        rip.href = `/?car=${id}`;
        const track = page === 'drive' ? new URLSearchParams(location.search).get('track') : null;
        drive.href = `/drive.html?car=${id}${track ? `&track=${encodeURIComponent(track)}` : ''}`;
      }
      inspect.href = `/inspect.html?car=${id}`;
      if (modelled.some((c) => c.id === id)) online.href = `/online.html?car=${id}`;
    },
  };
}
