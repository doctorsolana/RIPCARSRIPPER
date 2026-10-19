import type { SolanaSignInFeature, SolanaSignInInput, SolanaSignMessageFeature } from '@solana/wallet-standard-features';
import { createSignInMessageText } from '@solana/wallet-standard-util';
import { getWallets } from '@wallet-standard/app';
import type { Wallet, WalletAccount } from '@wallet-standard/base';
import type { StandardConnectFeature, StandardDisconnectFeature } from '@wallet-standard/features';
import { serverHttp, serverUrl } from '../drive/net/prefs';
import { isDev, setDev } from '../dev';
import { shortWallet } from './address';
import { safeIcon, saveSession, type Session } from './session';

// Connecting a wallet: the picker and Sign In With Solana (loaded only when someone connects: the top bar's chip, the
// lobby's Join / Create, an invite link opened signed out). The wallets are whatever the browser has that speaks the
// Wallet Standard (Phantom, Solflare, Backpack, Jupiter, OKX ...; one that registers while the picker is open shows up)
// on Solana mainnet, with standard:connect and solana:signIn or solana:signMessage. No wallet: install links on a
// computer, and on a phone "Open in Phantom / Solflare / Backpack" - this page in the wallet app's own browser.
// Signing in: the game server makes the whole sign-in request (POST /auth/challenge: server/auth.ts), the wallet signs
// it - solana:signIn, or connect + solana:signMessage of the same text (createSignInMessageText) - and the server checks
// the signature against its own record (POST /auth/verify) and hands back the session token (auth/session.ts keeps it).

const MAINNET = 'solana:mainnet';
const CONNECT = 'standard:connect', DISCONNECT = 'standard:disconnect', SIGN_IN = 'solana:signIn', SIGN_MESSAGE = 'solana:signMessage';

const usable = (w: Wallet) => w.chains.includes(MAINNET) && CONNECT in w.features && (SIGN_IN in w.features || SIGN_MESSAGE in w.features);
/** The wallets this browser has that can sign in (one per name, in the order they registered). */
export function detectedWallets(): Wallet[] {
  const seen = new Set<string>();
  return getWallets().get().filter((w) => usable(w) && !seen.has(w.name) && seen.add(w.name));
}

/** Where to get one, and the universal links that open a page in each app's own browser (phones). */
const KNOWN = [
  { name: 'Phantom', color: '#ab9ff2', ink: '#1c1a2e', get: 'https://phantom.com/download', browse: 'https://phantom.com/ul/browse/' },
  { name: 'Solflare', color: '#fc7227', ink: '#1f1206', get: 'https://solflare.com/download/', browse: 'https://solflare.com/ul/v1/browse/' },
  { name: 'Backpack', color: '#e33e3f', ink: '#fff', get: 'https://backpack.app/download', browse: 'https://backpack.app/ul/v1/browse/' },
];
const browseLink = (base: string) => `${base}${encodeURIComponent(location.href)}?ref=${encodeURIComponent(location.origin)}`;
const isPhone = () => /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent) || (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent));

class SignInError extends Error {}

async function post(url: string, body: unknown) {
  if (url.startsWith('/')) throw new SignInError('The game server is offline. Try again later.'); // (no server set)
  let r: Response;
  try {
    r = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), cache: 'no-store' });
  } catch {
    throw new SignInError("Can't reach the game server to sign in. Try again in a moment.");
  }
  const j = (await r.json().catch(() => ({}))) as Record<string, unknown>;
  if (!r.ok) throw new SignInError(typeof j.error === 'string' ? j.error : `The game server turned the sign-in down (${r.status}).`);
  return j;
}
const b64 = (b: ArrayLike<number>) => {
  let s = '';
  for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]);
  return btoa(s);
};

/** Sign in with this wallet: the server's request, the wallet's signature, the server's token. Saved as the session. */
export async function signInWith(w: Wallet, http = serverHttp(serverUrl())): Promise<Session> {
  const { input } = (await post(`${http}/auth/challenge`, {})) as { input: SolanaSignInInput & { domain: string; nonce: string } };
  let account: WalletAccount, signedMessage: Uint8Array, signature: Uint8Array;
  if (SIGN_IN in w.features) {
    const [out] = await (w.features as SolanaSignInFeature)[SIGN_IN].signIn(input);
    if (!out) throw new SignInError(`${w.name} didn't sign in.`);
    ({ account, signedMessage, signature } = out);
  } else {
    // (a wallet without Sign In With Solana: connect, then sign the very same text the request describes)
    const { accounts } = await (w.features as StandardConnectFeature)[CONNECT].connect();
    const a = accounts.find((x) => x.chains.includes(MAINNET)) ?? accounts[0];
    if (!a) throw new SignInError(`${w.name} has no Solana account to sign in with.`);
    account = a;
    const message = new TextEncoder().encode(createSignInMessageText({ ...input, address: a.address }));
    const [out] = await (w.features as SolanaSignMessageFeature)[SIGN_MESSAGE].signMessage({ account: a, message });
    if (!out) throw new SignInError(`${w.name} didn't sign.`);
    ({ signedMessage, signature } = out);
  }
  const res = (await post(`${http}/auth/verify`, {
    nonce: input.nonce,
    output: { account: { address: account.address, publicKey: b64(account.publicKey) }, signedMessage: b64(signedMessage), signature: b64(signature) },
  })) as { token: string; wallet: string; exp: number };
  const s: Session = { token: res.token, wallet: res.wallet, exp: res.exp, name: w.name, icon: safeIcon(w.icon) };
  saveSession(s);
  return s;
}

/** Tells the wallet to forget this site too (when it can: the session is gone either way). */
export async function disconnectWallet(name: string) {
  const w = getWallets().get().find((x) => x.name === name);
  try {
    await (w?.features as StandardDisconnectFeature | undefined)?.[DISCONNECT]?.disconnect();
  } catch {
    // the wallet's business
  }
}

function explain(e: unknown, w: Wallet) {
  if (e instanceof SignInError) return e.message;
  const err = e as { code?: number; message?: string; name?: string } | null;
  const msg = String(err?.message ?? e ?? '');
  if (err?.code === 4001 || /reject|denied|declin|cancel|clos|abort/i.test(`${msg} ${err?.name ?? ''}`)) return `Cancelled in ${w.name}. Pick it again when you're ready.`;
  return `${w.name} couldn't sign in${msg ? `: ${msg}` : ''}.`;
}

const CSS = `
.wpick { width: min(calc(100vw - 32px), 420px); max-height: calc(100dvh - 32px); padding: 0; border: 1px solid #33353f; border-radius: 20px;
  background: #14151b; color: #eef0f3; box-shadow: 0 30px 80px rgba(0, 0, 0, 0.6); font: 500 14px/1.45 Inter, system-ui, sans-serif;
  -webkit-font-smoothing: antialiased; overscroll-behavior: contain; touch-action: auto; }
.wpick::backdrop { background: rgba(5, 6, 8, 0.72); -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px); }
.wpick * { box-sizing: border-box; }
.wpick .wp-in { position: relative; display: grid; gap: 14px; padding: 22px; }
.wpick h3 { margin: 0; padding-right: 40px; font: 400 30px/1.05 Anton, Impact, sans-serif; letter-spacing: 0.02em; color: #fff; }
.wpick p { margin: 0; }
.wpick .wp-lead { color: #a3a8b6; }
.wpick .wp-lead b { color: #eef0f3; font-weight: 600; }
.wpick .wp-x { position: absolute; top: 16px; right: 16px; display: grid; place-items: center; width: 34px; height: 34px; padding: 0; border-radius: 50%;
  border: 1px solid rgba(255, 255, 255, 0.14); background: rgba(255, 255, 255, 0.06); color: #eef0f3; cursor: pointer; }
.wpick .wp-x:hover { background: rgba(255, 255, 255, 0.12); }
.wpick .wp-x svg { width: 14px; height: 14px; }
.wpick .wp-list { display: grid; gap: 8px; }
.wpick .wp-w { display: flex; align-items: center; gap: 12px; width: 100%; min-height: 58px; padding: 12px 14px; border-radius: 14px; cursor: pointer;
  border: 1px solid #2a2c35; background: #1d1f27; color: #eef0f3; text-align: left; text-decoration: none; font: 600 15px/1.2 Inter, system-ui, sans-serif; }
.wpick .wp-w:hover:not(:disabled) { border-color: rgba(61, 255, 139, 0.6); background: #22242d; }
.wpick .wp-w:focus-visible { outline: 2px solid #3dff8b; outline-offset: 2px; }
.wpick .wp-w:disabled { cursor: default; opacity: 0.45; }
.wpick .wp-w.busy { opacity: 1; border-color: #3dff8b; }
.wpick .wp-w img, .wpick .wp-mono { width: 34px; height: 34px; border-radius: 9px; flex: none; object-fit: contain; }
.wpick .wp-mono { display: grid; place-items: center; background: var(--c); color: var(--ink); font: 400 19px/1 Anton, Impact, sans-serif; }
.wpick .wp-w span { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.wpick .wp-w small { flex: none; display: inline-flex; align-items: center; gap: 7px; font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.18em;
  text-transform: uppercase; color: #8b90a0; }
.wpick .wp-w small.ok { color: #3dff8b; }
.wpick .wp-w small svg { width: 12px; height: 12px; }
.wpick .wp-w.busy small::before { content: ''; width: 12px; height: 12px; border-radius: 50%; border: 2px solid rgba(255, 255, 255, 0.25);
  border-top-color: #3dff8b; animation: wp-spin 0.8s linear infinite; }
@keyframes wp-spin { to { transform: rotate(360deg); } }
.wpick .wp-status { min-height: 1.45em; font-size: 13px; color: #a3a8b6; }
.wpick .wp-status:empty { display: none; }
.wpick .wp-status.err { color: #ffb020; }
.wpick .wp-status.ok { color: #3dff8b; }
.wpick .wp-foot { padding-top: 12px; border-top: 1px solid #2a2c35; font-size: 12.5px; color: #8b90a0; }
.wpick .wp-foot a, .wpick .wp-foot button { color: #eef0f3; font: inherit; text-decoration: underline; text-underline-offset: 3px; background: none; border: 0;
  padding: 0; cursor: pointer; }
.wpick .wp-dev { justify-self: end; display: inline-flex; align-items: center; gap: 8px; margin-top: -4px; padding: 4px 0; border: 0; background: none;
  font: 600 11px/1 Inter, system-ui, sans-serif; letter-spacing: 0.04em; color: #6c7080; cursor: pointer; }
.wpick .wp-dev:hover { color: #a3a8b6; }
.wpick .wp-dev .rc-sw { position: relative; flex: none; width: 24px; height: 14px; border-radius: 7px; background: rgba(255, 255, 255, 0.14); transition: background 0.15s; }
.wpick .wp-dev .rc-sw::after { content: ''; position: absolute; left: 2px; top: 2px; width: 10px; height: 10px; border-radius: 50%; background: #d8dbe2; transition: transform 0.15s; }
.wpick .wp-dev[aria-checked="true"] { color: #ffc04d; }
.wpick .wp-dev[aria-checked="true"] .rc-sw { background: #ffb020; }
.wpick .wp-dev[aria-checked="true"] .rc-sw::after { transform: translateX(10px); background: #fff; }
@media (max-width: 560px) { .wpick .wp-in { padding: 18px; } .wpick h3 { font-size: 27px; } }
`;
const X = '<svg viewBox="0 0 14 14" aria-hidden="true"><path d="M2 2l10 10M12 2L2 12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const ARROW = '<svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 2l4 4-4 4"/></svg>';
const OUT = '<svg viewBox="0 0 12 12" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 2H2v8h8V7M7 2h3v3M10 2L5.5 6.5"/></svg>';
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const mono = (k: (typeof KNOWN)[number]) => `<i class="wp-mono" style="--c:${k.color};--ink:${k.ink}" aria-hidden="true">${k.name[0]}</i>`;

let open: Promise<Session | null> | null = null;

/** The wallet picker. Resolves with the session once a wallet has signed in (then it closes), or null if it was
 *  closed first. `title`/`lead`: what it says on top (why a wallet is needed here). */
export function connectWallet(o: { title?: string; lead?: string } = {}): Promise<Session | null> {
  if (open) return open;
  if (!document.getElementById('wpick-css')) {
    const st = document.createElement('style');
    st.id = 'wpick-css';
    st.textContent = CSS;
    document.head.append(st);
  }
  const dlg = document.createElement('dialog');
  dlg.className = 'wpick';
  dlg.setAttribute('aria-labelledby', 'wp-title');
  dlg.addEventListener('pointerdown', (e) => e.stopPropagation()); // (the drive page steers on taps)
  document.body.append(dlg);
  let result: Session | null = null, busy: Wallet | null = null, status = '', tone = '';
  const lead = o.lead ?? 'Your wallet address is your name in races. Signing in is <b>free: no transaction</b>, nothing leaves your wallet.';

  function render() {
    const ws = detectedWallets();
    const phone = isPhone();
    let title: string, intro: string, rows: string, foot: string;
    if (ws.length) {
      title = o.title ?? 'Connect a wallet';
      intro = lead;
      rows = ws.map((w, i) => {
        const icon = safeIcon(w.icon);
        const tag = busy === w ? 'Check your wallet' : 'Detected';
        return `<button type="button" class="wp-w${busy === w ? ' busy' : ''}" data-i="${i}" ${busy ? 'disabled' : ''}>${icon ? `<img src="${icon}" alt="">` : '<i class="wp-mono" style="--c:#2a2c35;--ink:#fff">?</i>'}<span>${esc(w.name)}</span><small class="${busy === w ? '' : 'ok'}">${tag}</small></button>`;
      }).join('');
      foot = `No wallet yet? Get ${KNOWN.map((k) => `<a href="${k.get}" target="_blank" rel="noopener">${k.name}</a>`).join(', ').replace(/, ([^,]*)$/, ' or $1')} - free.`;
    } else if (phone) {
      title = 'Open in your wallet app';
      intro = 'Racing online needs a Solana wallet: its address is your name on the track. On a phone you race from inside your wallet app: pick yours and this page opens in it.';
      rows = KNOWN.map((k) => `<a class="wp-w" href="${esc(browseLink(k.browse))}" data-open="${k.name}">${mono(k)}<span>Open in ${k.name}</span><small>${ARROW}</small></a>`).join('');
      foot = `No wallet app yet? Get ${KNOWN.map((k) => `<a href="${k.get}" target="_blank" rel="noopener">${k.name}</a>`).join(', ').replace(/, ([^,]*)$/, ' or $1')} (free), then come back to this page.`;
    } else {
      title = 'Get a wallet to race';
      intro = 'Racing online needs a Solana wallet: its address is your name on the track. It\'s free, and signing in <b>sends no transaction</b>.';
      rows = KNOWN.map((k) => `<a class="wp-w" href="${k.get}" target="_blank" rel="noopener" data-get="${k.name}">${mono(k)}<span>${k.name}</span><small>Install ${OUT}</small></a>`).join('');
      foot = 'Installed one? <button type="button" data-reload>Reload this page</button> and connect.';
    }
    dlg.innerHTML = `<div class="wp-in">
      <button type="button" class="wp-x" aria-label="Close">${X}</button>
      <h3 id="wp-title">${esc(title)}</h3>
      <p class="wp-lead">${intro}</p>
      <div class="wp-list">${rows}</div>
      <p class="wp-status ${tone}" role="status">${status}</p>
      <p class="wp-foot">${foot}</p>
      <button type="button" class="wp-dev" role="switch" aria-checked="${isDev()}">Dev mode<i class="rc-sw"></i></button></div>`;
    dlg.dataset.state = ws.length ? 'wallets' : phone ? 'phone' : 'none';
  }
  async function pick(w: Wallet) {
    busy = w;
    status = `Approve the sign-in in ${esc(w.name)}. It's free: no transaction.`;
    tone = '';
    render();
    try {
      const s = await signInWith(w);
      result = s;
      busy = null;
      status = `Signed in as <b>${esc(shortWallet(s.wallet))}</b>`;
      tone = 'ok';
      render();
      setTimeout(() => dlg.open && dlg.close(), 450);
    } catch (e) {
      busy = null;
      status = esc(explain(e, w));
      tone = 'err';
      if (dlg.open) render();
    }
  }

  dlg.addEventListener('click', (e) => {
    const t = e.target as HTMLElement;
    if (t === dlg) return dlg.close(); // the backdrop
    if (t.closest('.wp-x')) return dlg.close();
    if (t.closest('[data-reload]')) return location.reload();
    if (t.closest('.wp-dev')) {
      setDev(!isDev()); // (the top bar follows; the switch here too)
      return void dlg.querySelector('.wp-dev')?.setAttribute('aria-checked', String(isDev()));
    }
    const b = t.closest<HTMLElement>('[data-i]');
    if (b && !busy) {
      const w = detectedWallets()[Number(b.dataset.i)];
      if (w) void pick(w);
    }
  });
  const offs = [getWallets().on('register', () => !busy && render()), getWallets().on('unregister', () => !busy && render())];
  render();
  open = new Promise<Session | null>((resolve) => {
    dlg.addEventListener('close', () => {
      offs.forEach((f) => f());
      dlg.remove();
      open = null;
      resolve(result);
    });
  });
  dlg.showModal();
  (dlg.querySelector<HTMLElement>('.wp-w') ?? dlg.querySelector<HTMLElement>('.wp-x'))?.focus();
  return open;
}
