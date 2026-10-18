// Dev mode: the top bar adds the tools - the pack-rip reveal (rip.html) and the inspector - with a DEV badge by the logo,
// and the landing takes ?garage=<wallet> (any wallet's garage). Switched in the wallet chip's menu (signed in), in the
// wallet picker's footer (signed out), or with ?dev=1 / ?dev=0 on any URL. Kept in localStorage (no storage: this page
// only); every tab follows. The pages themselves open by URL either way (scripts need them).

const KEY = 'ripcars.dev';
const EVENT = 'ripcars:dev';
let mem = false;

function read(): boolean {
  try {
    return localStorage.getItem(KEY) === '1';
  } catch {
    return mem;
  }
}

/** Dev mode is on. */
export const isDev = () => read();

export function setDev(on: boolean) {
  mem = on;
  try {
    if (on) localStorage.setItem(KEY, '1');
    else localStorage.removeItem(KEY);
  } catch {
    // no storage: this page keeps it (mem)
  }
  dispatchEvent(new Event(EVENT));
}

/** Calls back with the flag whenever it changes, on this page or in another tab. Returns the unsubscribe. */
export function onDev(cb: (on: boolean) => void): () => void {
  const local = () => cb(read());
  const other = (e: StorageEvent) => (e.key === KEY || e.key === null ? cb(read()) : undefined);
  addEventListener(EVENT, local);
  addEventListener('storage', other);
  return () => {
    removeEventListener(EVENT, local);
    removeEventListener('storage', other);
  };
}

// ?dev=1 / ?dev=0 on any page that loads this
{
  const v = new URLSearchParams(location.search).get('dev');
  if (v === '1' || v === '0') {
    mem = v === '1';
    try {
      if (mem) localStorage.setItem(KEY, '1');
      else localStorage.removeItem(KEY);
    } catch {
      // no storage
    }
  }
}
