// The drive page's overlay: lap and times (top left), speed (bottom right), the gate prompt, toasts
// (PERFECT!, BOOST, BEST LAP, the hidden tier's rainbow MAX DRIFT!; outlined, so they read on the sky and the grass), split
// deltas, a big WRONG WAY sign, a dip to black on respawn, the results card,
// and an FPS readout with ?fps=1. Self-contained styles; text only changes when its value does.

export interface RaceResult {
  total: number;
  laps: number[];
  bestLap: number;
  newBestLap: boolean;
  newBestTotal: boolean;
  medal: 'gold' | 'silver' | 'bronze' | null;
}

export interface Hud {
  setCar(name: string, color: string): void;
  /** The start prompt (before the drop). */
  gate(show: boolean, touch: boolean): void;
  setLap(lap: number, laps: number): void;
  /** Call every frame (refreshes at 20 Hz; `now` forces it); DOM only changes when the shown text does. */
  setTimes(lapTime: number, total: number, best: number | null, now?: boolean): void;
  setSpeed(kmh: number): void;
  /** Delta against the best lap at a split (negative = ahead). */
  split(delta: number): void;
  /** A word that pops up mid-screen (outlined: readable on sky and grass). kind 'max': the hidden drift tier's - bigger,
   *  rainbow, a wobbly pop (the colour is ignored). */
  toast(text: string, color?: string, kind?: 'max'): void;
  /** The WRONG WAY sign (shown while on; only touches the DOM when it changes). */
  wrongWay(on: boolean): void;
  results(r: RaceResult, onAgain: () => void, onRip: () => void): void;
  hideResults(): void;
  /** A quick dip to black (respawn). */
  flash(): void;
  fps(dt: number): void;
  /** Sound toggle (bottom left). */
  onMute(cb: (muted: boolean) => void): void;
  error(html: string): void;
}

const CSS = `
#hud { position: fixed; inset: 0; z-index: 10; pointer-events: none; color: #fff; user-select: none; -webkit-user-select: none;
  font: 600 14px/1.2 Inter, system-ui, sans-serif; text-shadow: 0 1px 2px rgba(0, 0, 0, 0.5), 0 1px 10px rgba(0, 0, 0, 0.45); --car: #ff3d6e; }
#hud .tl { position: absolute; left: max(16px, env(safe-area-inset-left)); top: calc(max(16px, env(safe-area-inset-top)) + 4px); }
body.nav-on #hud .tl { top: calc(max(0px, env(safe-area-inset-top)) + 62px); }
#hud .lap { font: 400 36px/1 Anton, Impact, sans-serif; letter-spacing: 0.03em; }
#hud .lap small { font-size: 20px; opacity: 0.6; }
#hud .lap i { font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.3em; font-style: normal; opacity: 0.7; margin-right: 8px; vertical-align: 8px; }
#hud .times { margin-top: 6px; font-variant-numeric: tabular-nums; display: grid; grid-template-columns: auto auto; gap: 2px 10px; }
#hud .times span { font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; opacity: 0.6; align-self: center; }
#hud .times b { font-size: 17px; }
#hud .spd { position: absolute; right: max(16px, env(safe-area-inset-right)); bottom: max(14px, env(safe-area-inset-bottom)); text-align: right; }
#hud .spd b { display: block; font: 400 64px/0.9 Anton, Impact, sans-serif; font-variant-numeric: tabular-nums; }
#hud .spd span { font-size: 10px; letter-spacing: 0.32em; opacity: 0.7; }
#hud .car { position: absolute; left: max(16px, env(safe-area-inset-left)); bottom: max(16px, env(safe-area-inset-bottom));
  font-size: 11px; letter-spacing: 0.22em; text-transform: uppercase; opacity: 0.75; display: flex; align-items: center; gap: 10px; }
#hud .car::before { content: ''; width: 8px; height: 8px; border-radius: 50%; background: var(--car); box-shadow: 0 0 10px var(--car); }
#hud .mute { pointer-events: auto; cursor: pointer; border: 0; background: rgba(255, 255, 255, 0.1); color: #fff; width: 30px; height: 30px;
  border-radius: 50%; display: grid; place-items: center; padding: 0; }
#hud .mute svg { width: 15px; height: 15px; }
#hud .mute .x { display: none; }
#hud .mute.off .x { display: inline; }
#hud .mute.off .w { display: none; }
/* every toast has a dark outline (eight hard shadows) and a drop under it: any colour reads on the sky, the clouds and
   the grass */
#hud .toast { position: absolute; left: 0; right: 0; top: 24%; text-align: center; font: 400 clamp(34px, 7vw, 68px)/1 Anton, Impact, sans-serif;
  letter-spacing: 0.04em; opacity: 0; transform: scale(0.7); transition: opacity 0.18s, transform 0.3s cubic-bezier(0.2, 1.7, 0.4, 1);
  --ol: rgba(9, 13, 28, 0.9); --o: max(1.5px, 0.035em); --d: max(1px, 0.025em);
  --outline: var(--o) 0 0 var(--ol), calc(-1 * var(--o)) 0 0 var(--ol), 0 var(--o) 0 var(--ol), 0 calc(-1 * var(--o)) 0 var(--ol),
    var(--d) var(--d) 0 var(--ol), calc(-1 * var(--d)) var(--d) 0 var(--ol), var(--d) calc(-1 * var(--d)) 0 var(--ol),
    calc(-1 * var(--d)) calc(-1 * var(--d)) 0 var(--ol);
  text-shadow: var(--outline), 0 0.07em 0 rgba(9, 13, 28, 0.5), 0 0.1em 0.35em rgba(0, 0, 0, 0.35); }
#hud .toast.on { opacity: 1; transform: scale(1); }
/* the hidden drift tier (MAX DRIFT!, its boost): bigger, rainbow running through it, a wobbly pop. The outline is a
   copy of the text behind it (a text-shadow would paint over text clipped from its background) */
#hud .toast.max { font-size: clamp(40px, 8.6vw, 86px); text-shadow: none; }
#hud .toast.max::before { content: attr(data-t); position: absolute; left: 0; right: 0; top: 0; color: transparent;
  text-shadow: var(--outline), 0 0.07em 0 rgba(9, 13, 28, 0.55), 0 0 0.45em rgba(255, 255, 255, 0.45); }
#hud .toast.max span { position: relative; color: transparent; -webkit-background-clip: text; background-clip: text;
  background-image: linear-gradient(100deg, #ff4f7b, #ffb02e, #ffef5c, #4be38a, #3fc8ff, #8f7bff, #ff5ce1, #ff4f7b);
  background-size: 200% 100%; animation: hud-rainbow 0.9s linear infinite; }
#hud .toast.max.on { animation: hud-max 0.6s cubic-bezier(0.2, 1.5, 0.4, 1) both; }
@keyframes hud-rainbow { to { background-position: -200% 0; } }
@keyframes hud-max { 0% { transform: scale(0.35) rotate(-9deg); } 50% { transform: scale(1.16) rotate(3deg); } 75% { transform: scale(0.97) rotate(-1deg); }
  100% { transform: scale(1) rotate(0deg); } }
#hud .split { position: absolute; left: 0; right: 0; top: calc(24% + clamp(44px, 9vw, 84px)); text-align: center;
  font: 700 22px/1 Inter, system-ui, sans-serif; font-variant-numeric: tabular-nums; opacity: 0; transition: opacity 0.2s; }
#hud .split.on { opacity: 1; }
#hud .split.ahead { color: #3ddc84; }
#hud .split.behind { color: #ff5a5a; }
#hud .wrong { position: absolute; left: 0; right: 0; top: 34%; display: flex; justify-content: center; padding: 0 16px; opacity: 0;
  visibility: hidden; transform: translateY(-50%) scale(0.8); transition: opacity 0.18s, visibility 0.18s, transform 0.3s cubic-bezier(0.2, 1.7, 0.4, 1); }
#hud .wrong.on { opacity: 1; visibility: visible; transform: translateY(-50%) scale(1); }
#hud .wrong div { display: flex; align-items: center; gap: 0.28em; padding: 0.14em 0.5em 0.14em 0.34em; border-radius: 0.22em;
  background: rgba(220, 32, 40, 0.9); border: 2px solid rgba(255, 255, 255, 0.9); box-shadow: 0 6px 30px rgba(220, 32, 40, 0.5);
  font: 400 clamp(36px, 7.5vw, 68px)/1.05 Anton, Impact, sans-serif; letter-spacing: 0.05em; white-space: nowrap; text-shadow: none; }
#hud .wrong.on div { animation: hud-pulse 0.8s ease-in-out infinite; }
#hud .wrong svg { width: 0.8em; height: 0.8em; flex: none; }
#hud .gate { position: absolute; left: 0; right: 0; top: 21%; display: none; justify-items: center; text-align: center; padding: 0 16px; }
#hud .gate.on { display: grid; }
#hud .gate b { display: block; font: 400 clamp(40px, 9vw, 84px)/1 Anton, Impact, sans-serif; letter-spacing: 0.04em; animation: hud-pulse 1.1s ease-in-out infinite; }
#hud .gate p { margin: 14px 0 0; font-size: 11px; letter-spacing: 0.24em; text-transform: uppercase; opacity: 0.8; line-height: 1.9; }
@keyframes hud-pulse { 50% { transform: scale(1.06); } }
#hud .fade { position: absolute; inset: 0; background: #000; opacity: 0; transition: opacity 0.3s ease-out; }
#hud .fade.on { opacity: 0.85; transition: none; }
#hud .card { position: absolute; left: 50%; top: 50%; width: min(calc(100vw - 32px), 360px); transform: translate(-50%, -46%); opacity: 0;
  visibility: hidden; transition: opacity 0.3s, transform 0.45s cubic-bezier(0.2, 1.4, 0.4, 1), visibility 0.3s; padding: 22px 22px 18px;
  border-radius: 20px; background: rgba(14, 14, 18, 0.84); -webkit-backdrop-filter: blur(16px); backdrop-filter: blur(16px);
  border: 1px solid rgba(255, 255, 255, 0.1); text-align: center; text-shadow: none; pointer-events: auto; }
#hud .card.on { opacity: 1; visibility: visible; transform: translate(-50%, -50%); }
#hud .card .medal { font: 700 11px/1 Inter, system-ui, sans-serif; letter-spacing: 0.3em; text-transform: uppercase; color: var(--m, #9fb3c8); }
#hud .card .total { font: 400 54px/1.05 Anton, Impact, sans-serif; font-variant-numeric: tabular-nums; margin-top: 8px; }
#hud .card .nb { display: inline-block; margin-top: 6px; padding: 5px 10px; border-radius: 999px; font-size: 10px; letter-spacing: 0.24em;
  text-transform: uppercase; background: color-mix(in srgb, var(--car) 35%, transparent); border: 1px solid var(--car); }
#hud .card ol { list-style: none; margin: 14px 0 0; padding: 0; display: grid; gap: 4px; font-variant-numeric: tabular-nums; }
#hud .card li { display: flex; justify-content: space-between; font-size: 14px; padding: 6px 4px; border-bottom: 1px solid rgba(255, 255, 255, 0.07); }
#hud .card li span { opacity: 0.6; font-size: 11px; letter-spacing: 0.2em; text-transform: uppercase; }
#hud .card li.best b { color: var(--car); }
#hud .card .btns { display: flex; gap: 10px; margin-top: 18px; }
#hud .card button, #hud .card a { flex: 1; padding: 13px 10px; border-radius: 999px; border: 0; cursor: pointer; text-decoration: none;
  font: 700 12px/1 Inter, system-ui, sans-serif; letter-spacing: 0.2em; text-transform: uppercase; }
#hud .card button { color: #0b0b0d; background: #fff; }
#hud .card a { color: #fff; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.18); }
#hud .card .hint { margin-top: 10px; font-size: 10px; letter-spacing: 0.2em; text-transform: uppercase; opacity: 0.45; }
#hud .err { position: absolute; inset: 0; display: grid; place-items: center; text-align: center; padding: 0 16px; pointer-events: auto;
  font: 600 15px/1.5 Inter, system-ui, sans-serif; color: rgba(244, 245, 247, 0.7); }
#hud .err a { color: #fff; }
#hud .fpsr { position: absolute; right: max(16px, env(safe-area-inset-right)); top: 62px; font: 600 11px/1 ui-monospace, monospace; opacity: 0.8; }
@media (max-width: 560px) {
  #hud .lap { font-size: 30px; }
  #hud .spd b { font-size: 52px; }
}
`;

export const fmtTime = (t: number) => {
  const m = Math.floor(t / 60), s = t - m * 60;
  return `${m}:${s < 10 ? '0' : ''}${s.toFixed(2)}`;
};

const MEDAL_COLOR = { gold: '#ffb020', silver: '#c9d4e6', bronze: '#d08a4f' } as const;

export function createHud(root: HTMLElement): Hud {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  root.innerHTML = `
    <div class="tl">
      <div class="lap"><i>LAP</i><span class="ln">1</span><small>/<span class="lt">3</span></small></div>
      <div class="times"><span>Lap</span><b class="tlap">0:00.00</b><span>Total</span><b class="ttot">0:00.00</b><span>Best</span><b class="tbest">-</b></div>
    </div>
    <div class="spd"><b>0</b><span>KM/H</span></div>
    <div class="car"><span class="cn"></span><button class="mute" aria-label="Sound on/off" title="Sound (M)">
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M2.5 6v4h2.5l3.5 3V3L5 6z" fill="currentColor" stroke="none"/><path class="w" d="M11 5.5a3.5 3.5 0 0 1 0 5M12.8 3.6a6 6 0 0 1 0 8.8"/>
        <path class="x" d="M11 6l4 4M15 6l-4 4"/></svg></button></div>
    <div class="toast"></div>
    <div class="split"></div>
    <div class="wrong" role="alert"><div><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round"
      stroke-linejoin="round" aria-hidden="true"><path d="M7 21V10a5.5 5.5 0 0 1 11 0v7.5"/><path d="M14 14l4 4 4-4"/></svg>Wrong way</div></div>
    <div class="gate"><div><b></b><p></p></div></div>
    <div class="card"></div>
    <div class="fade"></div>`;
  const $ = <T extends HTMLElement = HTMLElement>(sel: string) => root.querySelector(sel) as T;
  const lapN = $('.ln'), lapT = $('.lt'), tLap = $('.tlap'), tTot = $('.ttot'), tBest = $('.tbest'), spd = $('.spd b');
  const toastEl = $('.toast'), splitEl = $('.split'), gateEl = $('.gate'), card = $('.card'), fade = $('.fade'), mute = $('.mute');
  const wrongEl = $('.wrong');
  let toastTimer = 0, splitTimer = 0, lastSpeed = -1, lastTimesAt = 0, wrongOn = false;
  let fpsEl: HTMLElement | null = null, fpsAcc = 0, fpsN = 0;
  const set = (el: HTMLElement, text: string) => {
    if (el.textContent !== text) el.textContent = text;
  };
  let muted = false;
  const muteCbs: ((m: boolean) => void)[] = [];
  const toggleMute = () => {
    muted = !muted;
    mute.classList.toggle('off', muted);
    muteCbs.forEach((cb) => cb(muted));
  };
  mute.addEventListener('click', (e) => {
    e.stopPropagation();
    toggleMute();
    mute.blur();
  });
  mute.addEventListener('pointerdown', (e) => e.stopPropagation());
  card.addEventListener('pointerdown', (e) => e.stopPropagation()); // taps on the results card don't steer
  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM' && !e.repeat && !(e.target instanceof HTMLInputElement)) toggleMute();
  });

  return {
    setCar(name, color) {
      set($('.cn'), name);
      root.style.setProperty('--car', color);
    },
    gate(show, touch) {
      gateEl.classList.toggle('on', show);
      if (show) {
        set($('.gate b'), touch ? 'Tap to drop' : 'Press any key');
        $('.gate p').innerHTML = touch
          ? 'Drag to steer · it drives itself<br>Hold full lock or add a finger to drift'
          : 'W / ↑ gas · A D / ← → steer · Space drift<br>Drift to charge a boost · R restart';
      }
    },
    setLap(lap, laps) {
      set(lapN, String(lap));
      set(lapT, String(laps));
    },
    setTimes(lapTime, total, best, force) {
      const now = performance.now();
      if (now - lastTimesAt < 50 && !force) return; // 20 Hz is plenty for a clock
      lastTimesAt = now;
      set(tLap, fmtTime(lapTime));
      set(tTot, fmtTime(total));
      set(tBest, best == null ? '-' : fmtTime(best));
    },
    setSpeed(kmh) {
      const k = Math.round(kmh);
      if (k !== lastSpeed) {
        lastSpeed = k;
        spd.textContent = String(k);
      }
    },
    split(delta) {
      set(splitEl, `${delta < 0 ? '−' : '+'}${Math.abs(delta).toFixed(2)}`);
      splitEl.className = `split on ${delta < 0 ? 'ahead' : 'behind'}`;
      clearTimeout(splitTimer);
      splitTimer = window.setTimeout(() => splitEl.classList.remove('on'), 1800);
    },
    toast(text, color = '#fff', kind) {
      const max = kind === 'max';
      if (max) {
        // the rainbow is the span's background clipped to its text; the outline, a copy of the text behind it
        toastEl.textContent = '';
        const s = document.createElement('span');
        s.textContent = text;
        toastEl.append(s);
        toastEl.dataset.t = text;
      } else if (toastEl.firstElementChild || toastEl.textContent !== text) toastEl.textContent = text;
      toastEl.classList.toggle('max', max);
      toastEl.style.color = color;
      toastEl.classList.remove('on');
      void toastEl.offsetWidth; // restart the pop
      toastEl.classList.add('on');
      clearTimeout(toastTimer);
      toastTimer = window.setTimeout(() => toastEl.classList.remove('on'), max ? 1500 : 1100);
    },
    wrongWay(on) {
      if (on === wrongOn) return;
      wrongOn = on;
      wrongEl.classList.toggle('on', on);
    },
    results(r, onAgain, onRip) {
      const best = r.laps.indexOf(r.bestLap);
      card.style.setProperty('--m', r.medal ? MEDAL_COLOR[r.medal] : '#9fb3c8');
      card.innerHTML = `
        <div class="medal">${r.medal ? `${r.medal} medal` : 'Finished'}</div>
        <div class="total">${fmtTime(r.total)}</div>
        ${r.newBestTotal ? '<div class="nb">New personal best</div>' : r.newBestLap ? '<div class="nb">New best lap</div>' : ''}
        <ol>${r.laps.map((t, i) => `<li class="${i === best ? 'best' : ''}"><span>Lap ${i + 1}</span><b>${fmtTime(t)}</b></li>`).join('')}</ol>
        <div class="btns"><button type="button">Again</button><a href="#">Rip a pack</a></div>
        <div class="hint">R or Enter to go again</div>`;
      const again = card.querySelector('button')!, rip = card.querySelector('a')!;
      again.addEventListener('click', (e) => {
        e.stopPropagation();
        again.blur();
        onAgain();
      });
      rip.addEventListener('click', (e) => {
        e.preventDefault();
        onRip();
      });
      card.classList.add('on');
    },
    hideResults() {
      card.classList.remove('on');
    },
    flash() {
      fade.classList.add('on');
      requestAnimationFrame(() => requestAnimationFrame(() => fade.classList.remove('on')));
    },
    fps(dt) {
      if (!fpsEl) {
        fpsEl = document.createElement('div');
        fpsEl.className = 'fpsr';
        root.append(fpsEl);
      }
      fpsAcc += dt;
      fpsN++;
      if (fpsAcc >= 0.5) {
        fpsEl.textContent = `${Math.round(fpsN / fpsAcc)} fps · ${((fpsAcc / fpsN) * 1000).toFixed(1)} ms`;
        fpsAcc = fpsN = 0;
      }
    },
    onMute(cb) {
      muteCbs.push(cb);
    },
    error(html) {
      root.innerHTML = `<div class="err"><p>${html}</p></div>`;
    },
  };
}
