// ?tune=1: a slider per number in the active driving model's TUNING object, live. "Copy" puts the changed
// values on the clipboard as JSON to paste back into the source; "Reset" restores the defaults.

const CSS = `
#tune { position: fixed; z-index: 30; right: 8px; top: 56px; bottom: 8px; width: min(300px, 70vw); overflow-y: auto; padding: 10px 12px;
  background: rgba(10, 11, 15, 0.86); border: 1px solid rgba(255, 255, 255, 0.1); border-radius: 12px; color: #eef0f3;
  font: 500 11px/1.3 Inter, system-ui, sans-serif; touch-action: pan-y; -webkit-backdrop-filter: blur(10px); backdrop-filter: blur(10px); }
#tune.min { bottom: auto; overflow: hidden; }
#tune.min label { display: none; }
#tune header { display: flex; gap: 6px; align-items: center; margin-bottom: 6px; }
#tune header b { flex: 1; letter-spacing: 0.16em; text-transform: uppercase; font-size: 10px; }
#tune button { font: inherit; color: inherit; background: rgba(255, 255, 255, 0.08); border: 1px solid rgba(255, 255, 255, 0.15);
  border-radius: 6px; padding: 3px 7px; cursor: pointer; }
#tune label { display: grid; grid-template-columns: 1fr auto; gap: 0 8px; padding: 3px 0; }
#tune label.changed span { color: #ffb020; }
#tune input { grid-column: 1 / 3; width: 100%; margin: 2px 0 0; }
#tune output { font-variant-numeric: tabular-nums; opacity: 0.85; }
`;

const nice = (x: number) => {
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  return x / p < 2 ? p : x / p < 5 ? 2 * p : 5 * p;
};

export function mountTune(tuning: Record<string, number>, title: string) {
  const defaults = { ...tuning };
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  const el = document.createElement('div');
  el.id = 'tune';
  el.innerHTML = `<header><b>${title} tuning</b><button data-a="copy">Copy</button><button data-a="reset">Reset</button><button data-a="min">–</button></header>`;
  const rows: { key: string; input: HTMLInputElement; out: HTMLOutputElement; label: HTMLLabelElement }[] = [];
  for (const key of Object.keys(tuning)) {
    const d = defaults[key];
    const max = d === 0 ? 1 : Math.abs(d) * 2.5;
    const step = nice(Math.max(Math.abs(d), 0.01) / 100);
    const label = document.createElement('label');
    label.innerHTML = `<span>${key}</span><output></output><input type="range" min="${d < 0 ? -max : 0}" max="${max}" step="${step}">`;
    const input = label.querySelector('input')!, out = label.querySelector('output')!;
    input.value = String(tuning[key]);
    out.textContent = String(tuning[key]);
    input.addEventListener('input', () => {
      tuning[key] = Number(input.value);
      out.textContent = input.value;
      label.classList.toggle('changed', tuning[key] !== defaults[key]);
    });
    rows.push({ key, input, out, label });
    el.append(label);
  }
  // don't let the panel's touches and keys drive the car
  for (const ev of ['pointerdown', 'keydown'] as const) el.addEventListener(ev, (e) => e.stopPropagation());
  el.addEventListener('click', (e) => {
    const a = (e.target as HTMLElement).dataset.a;
    if (a === 'copy') {
      const changed = Object.fromEntries(Object.entries(tuning).filter(([k, v]) => v !== defaults[k]));
      navigator.clipboard?.writeText(JSON.stringify(changed, null, 1)).catch(() => {});
      console.log('tuning changes', changed);
    } else if (a === 'reset') {
      for (const r of rows) {
        tuning[r.key] = defaults[r.key];
        r.input.value = String(defaults[r.key]);
        r.out.textContent = String(defaults[r.key]);
        r.label.classList.remove('changed');
      }
    } else if (a === 'min') el.classList.toggle('min');
  });
  document.body.append(el);
}
