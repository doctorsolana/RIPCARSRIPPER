// The top bar shared by the reveal, the inspector and the drive page: RIPCARS, the pages, and on the reveal
// and the drive page a car picker plus "random pack". Self-contained (its own styles), so it drops into any page.
interface NavCar { id: string; make: string; model: string; year: number | null; modelled: boolean }

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
#nav .spacer { flex: 1; }
#nav select, #nav button { font: inherit; color: #eef0f3; background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 8px; padding: 7px 10px; cursor: pointer; max-width: 46vw; min-width: 0; }
#nav button { display: inline-flex; align-items: center; gap: 6px; flex: none; }
#nav select option { color: #111; }
#nav button:hover, #nav select:hover { border-color: #ff3d6e; }
@media (max-width: 560px) {
  #nav { gap: 6px; }
  #nav .brand { font-size: 18px; }
  #nav .brand small, #nav .wide { display: none; }
  #nav .links a { padding: 8px 6px; }
  #nav select { max-width: 34vw; }
}
`;

export async function mountNav(page: 'rip' | 'inspect' | 'drive'): Promise<Nav> {
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
    </nav>
    <span class="spacer"></span>`;
  el.querySelector(`[data-page="${page}"]`)!.classList.add('on');
  document.body.prepend(el);

  const { cars } = (await fetch('/cars/index.json').then((r) => r.json()).catch(() => ({ cars: [] }))) as { cars: NavCar[] };
  const modelled = cars.filter((c) => c.modelled);
  const rip = el.querySelector<HTMLAnchorElement>('[data-page="rip"]')!;
  const inspect = el.querySelector<HTMLAnchorElement>('[data-page="inspect"]')!;
  const drive = el.querySelector<HTMLAnchorElement>('[data-page="drive"]')!;
  let select: HTMLSelectElement | null = null;

  if ((page === 'rip' || page === 'drive') && modelled.length) {
    // pick a car, or rip a random one; both reload the page with ?car=
    select = document.createElement('select');
    select.title = page === 'drive' ? 'Which car to drive' : 'Which car to reveal';
    select.innerHTML = modelled.map((c) => `<option value="${c.id}">${c.make} ${c.model}${c.year ? ` · ${c.year}` : ''}</option>`).join('');
    select.addEventListener('change', () => go(select!.value));
    const random = document.createElement('button');
    random.innerHTML = `<svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><rect x="1.5" y="1.5" width="13" height="13" rx="3" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="5.2" cy="5.2" r="1.2" fill="currentColor"/><circle cx="8" cy="8" r="1.2" fill="currentColor"/><circle cx="10.8" cy="10.8" r="1.2" fill="currentColor"/></svg><span class="wide">${page === 'drive' ? 'Random car' : 'Random pack'}</span>`;
    random.setAttribute('aria-label', page === 'drive' ? 'Drive a random car' : 'Rip a random car');
    random.title = page === 'drive' ? 'Drive a random car' : 'Rip a random car';
    random.addEventListener('click', () => {
      const others = modelled.filter((c) => c.id !== select!.value);
      go((others.length ? others : modelled)[Math.floor(Math.random() * (others.length || modelled.length))].id);
    });
    el.append(select, random);
  }

  function go(id: string) {
    const q = new URLSearchParams(location.search);
    q.set('car', id);
    location.search = q.toString();
  }

  return {
    el,
    setCar(id: string) {
      if (select && [...select.options].some((o) => o.value === id)) select.value = id;
      // the links carry the car across: inspect what you just ripped, rip what you're inspecting, drive it
      if (modelled.some((c) => c.id === id)) {
        rip.href = `/?car=${id}`;
        drive.href = `/drive.html?car=${id}`;
      }
      inspect.href = `/inspect.html?car=${id}`;
    },
  };
}
