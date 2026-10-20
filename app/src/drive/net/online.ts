import * as THREE from 'three';
import { BUILD_ID } from 'virtual:build-id';
import { shortWallet } from '../../auth/address';
import { CARS, carFile } from '../../catalog';
import { clearSession, loadSession, onSession, type Session } from '../../auth/session';
import { isDev } from '../../dev';
import { carDropdown, mountNav } from '../../nav';
import { raceableCars } from '../../owned';
import { tierOf } from '../../rarity';
import { createAudio } from '../audio';
import { createChaseCamera } from '../camera';
import { createFx } from '../fx';
import { createHud, fmtTime } from '../hud';
import { createInput } from '../input';
import { startLoop } from '../loop';
import { loadRig, type Rig } from '../rig';
import { buildTrack, courseOf, DEFAULT_COURSE, isCourse, type CourseId } from '../tracks';
import type { CarSpec, DriveInput, VehicleState } from '../types';
import { create } from '../vehicles/arcade';
import { buildWorld } from '../world-outdoor';
import { NetClient } from './client';
import { MSG_SNAP } from './codec';
import { DEFAULT_CAR, roomHref, saveCar, savedCar, serverHttp, serverUrl } from './prefs';
import { H, MAX_PLAYERS, type C2S, type Leaderboard, type PlayerInfo, type ResultRow, type S2C } from './protocol';
import { carSpecOf, progressOf } from './race';
import type { WorldCar } from './world';

// /drive.html?online=1&room=<name>&car=<id>&track=<id>: the drive page online (the multiplayer demo; the server is
// app/server/, `npm run server`). You race as your wallet: the join carries the wallet sign-in's session token
// (auth/session.ts) and your name is the wallet's short address, set by the server. Opened without a sign-in (an
// invite link), the card asks you to connect a wallet first (auth/wallets.ts), then joins; a sign-in the server turns
// down is dropped and asked for again; your wallet joining from another tab or device takes the car there (one car per
// wallet) and this page says so. Dev mode needs no wallet (you race as "Guest n") and takes any car - the server never
// stores laps in a car that isn't the wallet's; its invite link brings friends in in dev mode too. The server is the
// authority and simulates every car; this page
//  - sends its inputs (quantized, tagged with their step: protocol.ts, codec.ts) and drives its own car on them at
//    once, a little ahead of the server - its clock steers so its inputs arrive JITTER_STEPS early;
//  - draws EVERY car in its own timeline: the others are simulated forward from their last snapshot on the input their
//    player is on (net/world.ts, run by net/client.ts), with car-to-car contact predicted here, so a crash happens on
//    your screen the moment you make it, against cars where they really are now; each snapshot (60 Hz) rewinds the
//    world to the server's step, replays to now and lets the visual error decay (~95% gone in 180 ms) - a respawn-sized
//    correction snaps;
//  - plays a crash like a wall hit: sparks at the contact point, the impact and scrape sounds by severity, the camera's
//    kick and shake, rumble - for your car, and sparks and a distant knock for the others';
//  - shows the room: its lobby card (who's in with their cars and Ready, the host, your wallet and car - the car changed
//    in place, the invite link, Ready, Leave), the countdown, the standings and ping, and the results (Race again / Leave).
// The way in is the lobby browser (/online.html: Join / Create room) or an invite link (this page with the room's
// online, room, track and laps); Leave goes back to the browser. &solo=1 is a time trial (the landing's): a room of your
// own on the track - no bots, no one else, not listed - whose clean laps make the week's board; its card shows your best
// this week, Start, and your laps after each run (Leave goes home).
// Knobs on top of the page's usual ones: &auto=1 (the autopilot drives your car), &lag=<ms> &jitter=<ms> &loss=<%>
// (a bad network, simulated here: lag is the round trip added, jitter up to that much more each way, loss drops
// snapshots and input packets), &min=<n> (the room waits for n players), &bots=<n> (a new room adds n server bots),
// &server=ws://host:port. Scripts: window.__online (phase, standings, results, stats).

const SMOOTH = 0.06; // s: the visual error's time constant (~95% gone in 180 ms) ...
const SMOOTH_REMOTE = 0.08; // ... the other cars' (their corrections are their players' input changes)
const KMH = 4.3;
const BOOST_NAMES = ['', 'Boost', 'Super boost', 'Ultra boost', 'Hyper boost!'];
const HARD_HIT = 14; // u/s: a car hit this hard shakes the camera (as main.ts's wall hits)

const CSS = `
#hud .net-board { position: absolute; right: max(16px, env(safe-area-inset-right)); top: calc(max(0px, env(safe-area-inset-top)) + 66px);
  text-align: right; font-variant-numeric: tabular-nums; }
@media (max-width: 1199px) { #hud .net-board { top: calc(max(0px, env(safe-area-inset-top)) + 96px); } }
#hud .net-board .pos { font: 400 36px/1 Anton, Impact, sans-serif; letter-spacing: 0.03em; }
#hud .net-board .pos small { font-size: 20px; opacity: 0.6; }
#hud .net-board .pos i { font: 700 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.3em; font-style: normal; opacity: 0.7; margin-right: 8px; vertical-align: 8px; }
#hud .net-board ol { list-style: none; margin: 8px 0 0; padding: 0; display: grid; gap: 3px; font-size: 12px; }
#hud .net-board li { opacity: 0.75; }
#hud .net-board li.me { opacity: 1; color: #3dff8b; }
#hud .net-board li b { display: inline-block; min-width: 1.4em; margin-right: 6px; opacity: 0.6; }
#hud .net-ping { margin-top: 8px; font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; opacity: 0.6; }
#hud .net-ping.bad { color: #ff8a5a; opacity: 0.9; }
#hud .net-count { position: absolute; left: 0; right: 0; top: 24%; text-align: center; font: 400 clamp(60px, 13vw, 130px)/1 Anton, Impact, sans-serif;
  opacity: 0; transform: scale(0.7); transition: opacity 0.15s, transform 0.3s cubic-bezier(0.2, 1.7, 0.4, 1); }
#hud .net-count.on { opacity: 1; transform: scale(1); }
/* the room's card: lobby / results / waiting / notice. Under the top bar, scrolls when the screen is short */
#hud .card.net { width: min(calc(100vw - 32px), 440px); top: calc(50% + 24px); max-height: calc(100% - 48px - 24px); overflow-y: auto;
  text-align: left; padding: 20px 20px 16px; overscroll-behavior: contain; }
#hud .card.net .medal { display: flex; align-items: center; gap: 8px; color: rgba(255, 255, 255, 0.6); letter-spacing: 0.22em; }
#hud .card.net .cdot { width: 7px; height: 7px; border-radius: 50%; background: var(--c); box-shadow: 0 0 8px var(--c); flex: none; }
#hud .card.net .nl-big { font-size: 44px; }
#hud .card.net .nl-text { margin: 10px 0 0; font: 500 14px/1.5 Inter, system-ui, sans-serif; color: rgba(255, 255, 255, 0.72); }
#hud .card.net .nl-text b { color: #fff; }
#hud .card.net .nl-head { display: flex; align-items: flex-start; justify-content: space-between; gap: 12px; }
#hud .card.net .nl-head > div { min-width: 0; }
#hud .card.net .nl-room { font: 400 38px/1.05 Anton, Impact, sans-serif; letter-spacing: 0.02em; margin-top: 8px; overflow-wrap: anywhere; }
#hud .card.net .nl-invite { flex: none; display: inline-flex; align-items: center; gap: 7px; padding: 9px 12px; letter-spacing: 0.04em;
  text-transform: none; font: 600 12px/1 Inter, system-ui, sans-serif; color: #fff; background: rgba(255, 255, 255, 0.08);
  border: 1px solid rgba(255, 255, 255, 0.18); }
#hud .card.net .nl-invite:hover { background: rgba(255, 255, 255, 0.14); }
#hud .card.net .nl-invite.done { color: #3dff8b; border-color: rgba(61, 255, 139, 0.6); }
#hud .card.net .nl-invite svg { width: 14px; height: 14px; flex: none; }
#hud .card.net .nl-count { margin-top: 16px; font-size: 10px; letter-spacing: 0.24em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }
#hud .card.net ol.nl-list { margin-top: 6px; gap: 0; }
#hud .card.net .nl-list li { align-items: center; gap: 10px; padding: 9px 2px; }
#hud .card.net .nl-list li:last-child { border-bottom: 0; }
#hud .card.net li span.nm { flex: 1; min-width: 0; text-align: left; opacity: 1; font-size: 14px; letter-spacing: 0.01em; text-transform: none; }
#hud .card.net li span.nm small { display: block; margin: 3px 0 0; font-size: 11px; letter-spacing: 0.02em; opacity: 0.55; text-transform: none;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
#hud .card.net li span.nm em { font: 700 9px/1 Inter, system-ui, sans-serif; font-style: normal; letter-spacing: 0.16em; text-transform: uppercase;
  margin-left: 7px; padding: 3px 5px; border-radius: 4px; vertical-align: 2px; background: rgba(255, 255, 255, 0.12); color: rgba(255, 255, 255, 0.85); }
#hud .card.net li span.nm em.h { background: rgba(255, 176, 32, 0.2); color: #ffc04d; }
#hud .card.net li.me span.nm { color: #3dff8b; }
#hud .card.net li .st { opacity: 1; text-align: right; font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }
#hud .card.net li .st.on { color: #3dff8b; }
#hud .card.net li .st small { display: block; margin: 3px 0 0; font-size: 10px; letter-spacing: 0.04em; text-transform: none; opacity: 0.8; color: rgba(255, 255, 255, 0.5); }
#hud .card.net li b.ps { min-width: 1.2em; opacity: 0.6; }
#hud .card.net li .dot { width: 8px; height: 8px; border-radius: 50%; background: rgba(255, 255, 255, 0.2); flex: none; }
#hud .card.net li .dot.on { background: #3dff8b; box-shadow: 0 0 8px rgba(61, 255, 139, 0.7); }
#hud .card.net .nl-you { display: grid; grid-template-columns: 1fr 1.25fr; gap: 10px; margin-top: 14px; }
#hud .card.net .nl-car { display: grid; gap: 6px; min-width: 0; }
#hud .card.net .nl-car > span, #hud .card.net .nl-me > span { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }
/* your car: the top bar's car dropdown as a field (nav.ts carDropdown: its panel floats over the page) */
#hud .card.net .nl-car .dd { position: relative; min-width: 0; }
#hud .card.net .nl-car .dd-b { display: flex; align-items: center; gap: 8px; width: 100%; min-width: 0; height: 38px; padding: 0 10px 0 4px; border-radius: 10px;
  font: 600 14px/1.1 Inter, system-ui, sans-serif; letter-spacing: 0; text-transform: none; text-align: left; color: #fff;
  background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.14); }
#hud .card.net .nl-car .dd-b:hover:not(:disabled), #hud .card.net .nl-car .dd-b[aria-expanded="true"] { border-color: #3dff8b; }
#hud .card.net .nl-car .dd-b:disabled { opacity: 0.5; cursor: default; }
#hud .card.net .nl-car .thumb { width: 44px; height: 28px; object-fit: contain; flex: none; }
#hud .card.net .nl-car .dd-t { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
#hud .card.net .nl-car .chev { width: 10px; height: 10px; flex: none; opacity: 0.55; transition: transform 0.15s; }
#hud .card.net .nl-car .dd-b[aria-expanded="true"] .chev { transform: rotate(180deg); }
#hud .card.net .nl-me { display: grid; gap: 6px; min-width: 0; }
#hud .card.net .nl-me b { display: flex; align-items: center; gap: 8px; min-width: 0; padding: 10px; border-radius: 10px; font: 600 14px/1.1 Inter, system-ui, sans-serif;
  font-variant-numeric: tabular-nums; white-space: nowrap; background: rgba(255, 255, 255, 0.04); border: 1px solid rgba(255, 255, 255, 0.1); }
#hud .card.net .nl-me img { width: 16px; height: 16px; border-radius: 4px; flex: none; }
#hud .card.net input { width: 100%; min-width: 0; font: 600 14px/1.1 Inter, system-ui, sans-serif; color: #fff;
  background: rgba(255, 255, 255, 0.07); border: 1px solid rgba(255, 255, 255, 0.14); border-radius: 10px; padding: 10px; user-select: text; -webkit-user-select: text; }
#hud .card.net input:focus { outline: none; border-color: #3dff8b; }
#hud .card.net .nl-ready { display: block; width: 100%; margin-top: 16px; padding: 16px 10px; font-size: 14px; letter-spacing: 0.24em; }
#hud .card.net .nl-ready.on { color: #0b0c10; background: #3dff8b; box-shadow: 0 6px 24px rgba(61, 255, 139, 0.2); }
#hud .card.net .nl-status { margin-top: 10px; min-height: 1.4em; text-align: center; font: 500 13px/1.4 Inter, system-ui, sans-serif; color: rgba(255, 255, 255, 0.65); }
#hud .card.net .nl-status .sel { user-select: all; -webkit-user-select: all; color: #fff; word-break: break-all; }
#hud .card.net .nl-leave { display: block; margin: 12px auto 0; padding: 8px; background: none; border: 0; text-align: center;
  font: 600 12px/1 Inter, system-ui, sans-serif; letter-spacing: 0.06em; text-transform: none; color: rgba(255, 255, 255, 0.55); text-decoration: underline; text-underline-offset: 3px; }
#hud .card.net .nl-leave:hover { color: #fff; }
#hud .card.net .btns a.leave, #hud .card.net .btns a { display: flex; align-items: center; justify-content: center; }
@media (max-width: 560px) {
  #hud .card.net { padding: 16px 16px 12px; }
  #hud .card.net .nl-room { font-size: 32px; }
  #hud .card.net .nl-head { flex-direction: column; align-items: stretch; gap: 12px; }
  #hud .card.net .nl-invite { justify-content: center; padding: 11px 12px; }
  #hud .card.net .nl-big { font-size: 38px; }
}
#hud .card.net .nl-week { display: flex; align-items: baseline; justify-content: space-between; gap: 12px; margin-top: 14px; padding: 12px 14px; border-radius: 12px;
  background: rgba(255, 255, 255, 0.05); font-variant-numeric: tabular-nums; }
#hud .card.net .nl-week span { font-size: 10px; letter-spacing: 0.22em; text-transform: uppercase; color: rgba(255, 255, 255, 0.5); }
#hud .card.net .nl-week b { font: 600 15px/1 Inter, system-ui, sans-serif; letter-spacing: 0.02em; text-transform: none; }
#hud .card.net .nl-week b i { font-style: normal; color: #ffc531; margin-right: 8px; }
#hud .card.net .nl-week em { font: 800 9px/1 Inter, system-ui, sans-serif; font-style: normal; letter-spacing: 0.14em; text-transform: uppercase; margin-left: 8px;
  padding: 3px 5px; border-radius: 4px; background: #3dff8b; color: #0b0c10; vertical-align: 2px; }
#hud .card.net.solo .nl-count, #hud .card.net.solo .nl-list.pl { display: none; }
#hud .net-board.solo .pos, #hud .net-board.solo ol { display: none; }
/* with the card up the race HUD (lap, times, standings) has nothing to say: it comes back for the race */
body.net-card #hud .net-board, body.net-card #hud .tl { visibility: hidden; }
/* name tags: just the name, small, no plate; they fade out with distance (drawRemotes) */
#hud .net-tag { position: absolute; left: 0; top: 0; transform: translate(-50%, -100%); transform-origin: 50% 100%; white-space: nowrap;
  pointer-events: none; font: 600 10px/1 Inter, system-ui, sans-serif; letter-spacing: 0.03em; color: #fff;
  text-shadow: 0 1px 2px rgba(0, 0, 0, 0.6), 0 0 6px rgba(0, 0, 0, 0.3); }
`;

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);


export async function runOnline() {
  const q = new URLSearchParams(location.search);
  let CAR = q.get('car') || savedCar() || DEFAULT_CAR;
  let serverCar: string | null = null; // the car the server set (its { t: 'car' }), not yet swapped to
  const trackQ = q.get('track');
  const COURSE: CourseId = isCourse(trackQ) ? trackQ : DEFAULT_COURSE;
  const COURSE_DEF = courseOf(COURSE);
  const LAPS = Math.min(9, Math.max(1, Math.round(Number(q.get('laps')) || 3)));
  const AUTO = q.get('auto') === '1';
  let autoDrive = false; // tests: __online.autoDrive(true) - the autopilot drives, but Ready stays the player's
  const RAW = q.get('raw') === '1'; // tests: skip the steering's slew (the server's checks count it)
  const ROOM = (q.get('room') ?? 'demo').replace(/[^a-z0-9_-]/gi, '').slice(0, 32) || 'demo';
  const SOLO = q.get('solo') === '1'; // a time trial (a room of your own)
  let session: Session | null = loadSession(); // who you race as (none: the card asks you to connect a wallet first)
  let signinWhy: 'none' | 'expired' = 'none';
  const DEV = isDev(); // (no wallet needed - a guest - and any car)
  let devRefused = false; // (a server that doesn't take dev mode's joins: a wallet after all)
  const LAG = Math.max(0, Number(q.get('lag')) || 0), JIT = Math.max(0, Number(q.get('jitter')) || 0);
  const LOSS = Math.min(50, Math.max(0, Number(q.get('loss')) || 0)) / 100;
  const SERVER = serverUrl(q);
  const MIN = Math.round(Number(q.get('min')) || 0), BOTS = Math.round(Number(q.get('bots')) || 0);
  // a car this wallet can't race (a link, the remembered one): the starter, and one line to say so
  const notMine = !DEV && !!session && !(await raceableCars(session.wallet)).has(CAR);
  if (notMine) CAR = DEFAULT_CAR;

  const hudRoot = document.getElementById('hud')!;
  const hud = createHud(hudRoot);
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.append(style);
  hud.setCourse(COURSE_DEF.name, COURSE_DEF.color);
  hud.gate(false, false);
  if (notMine) hud.toast('Not in your garage', '#fff');
  // (no track switch online: the room has its course; the car picker swaps the car in place, in the lobby)
  // the picker: the cars this wallet may race (signed out, or dev mode: all - the server sets the car at the join: { t: 'car' })
  const navP = mountNav('online', { onCar: (id) => void swapCar(id), allow: session && !DEV ? raceableCars(session.wallet) : undefined });
  // the lobby card's own picker, as the bar's: the same cars
  const pick = carDropdown(CARS.filter((c) => c.modelled), 'Your car', (id) => void swapCar(id), DEV, true);
  const pickCars = async () => pick.only(session && !DEV ? await raceableCars(session.wallet) : null);
  void pickCars();
  let pickShown = '';
  navP.then((n) => n.setCar(CAR));
  const canvas = document.getElementById('c') as HTMLCanvasElement;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, powerPreference: 'high-performance' });
  let dpr = Math.min(devicePixelRatio, 1.5);
  renderer.setPixelRatio(dpr);
  renderer.toneMapping = THREE.AgXToneMapping;
  renderer.toneMappingExposure = 1.1;
  renderer.setClearColor('#0d0e12');
  const scene = new THREE.Scene();
  const track = buildTrack(COURSE);
  scene.add(track.object);
  const world = buildWorld(scene, renderer, track);

  let rig: Rig;
  let fxScene = new THREE.Scene(); // the effects' own group (a car swap rebuilds them: they're sized to the car)
  scene.add(fxScene);
  try {
    rig = await loadRig(CAR);
  } catch (err) {
    console.error(err);
    hud.error(`No drivable 3D model for <b>${esc(CAR)}</b> yet.`);
    document.getElementById('boot')?.remove();
    Object.assign(window as any, { __ready: true });
    return;
  }
  scene.add(rig.root);
  let vehicle = await create(track, rig.spec);
  let st = vehicle.state;
  let tier = tierOf('common'), carName = CAR;
  const carLook = () => {
    const meta = rig.spec.meta as { make?: string; model?: string; rarity?: string };
    tier = tierOf(String(meta.rarity ?? 'common'));
    carName = [meta.make, meta.model].filter(Boolean).join(' ') || CAR;
    hud.setCar(carName, tier.color);
    document.title = `${SOLO ? 'Time trial' : `Online · ${ROOM}`} · ${carName} · racecars`;
  };
  carLook();
  const cam = createChaseCamera();
  scene.add(cam.camera);
  let fx = createFx(fxScene, rig.spec, new THREE.Color(tier.color));
  const audio = createAudio();
  fx.setTrack(track);
  audio.setTrack(track);
  audio.setCar(rig.spec);
  const input = createInput(canvas);
  hud.onMute((m) => audio.setMuted(m));
  input.firstInput.then(() => audio.unlock());

  // ---- the overlay: standings + ping (top right), countdown, the lobby / results card, name tags
  const board = document.createElement('div');
  board.className = 'net-board';
  board.innerHTML = '<div class="pos"><i>POS</i><span class="pn">-</span><small>/<span class="pt">-</span></small></div><ol></ol><div class="net-ping">ping -</div>';
  const count = document.createElement('div');
  count.className = 'net-count';
  const card = document.createElement('div');
  card.className = 'card net';
  card.addEventListener('pointerdown', (e) => e.stopPropagation());
  const tags = document.createElement('div');
  hudRoot.append(tags, board, count, card);
  const pingEl = board.querySelector<HTMLElement>('.net-ping')!;
  board.classList.toggle('solo', SOLO); // (a time trial: no standings, just you)
  card.classList.toggle('solo', SOLO);

  // ---- the link, with an optional bad network (lag: round trip added, half each way; jitter: up to that much more
  // each way, order kept as TCP keeps it; loss: snapshots and input packets dropped - a lost snapshot is still read,
  // as the next one is the change from it, but not acted on)
  const stats = { bytesUp: 0, bytesDown: 0, since: performance.now(), remoteFrames: 0, stutter: 0, remoteJerk: [] as number[], longFrames: 0, maxFrame: 0 };
  const sim = LAG > 0 || JIT > 0 || LOSS > 0;
  const outQ: { at: number; d: string | Uint8Array }[] = [], inQ: { at: number; d: string | ArrayBuffer; lost: boolean }[] = [];
  let lastOut = 0, lastIn = 0;
  let ws: WebSocket | null = null; // (opened once you're signed in: connect())
  const sendRaw = (d: string | Uint8Array, droppable: boolean) => {
    stats.bytesUp += d.length;
    if (!sim) return void (ws?.readyState === 1 && ws.send(d as string | Uint8Array<ArrayBuffer>));
    if (droppable && Math.random() < LOSS) return;
    lastOut = Math.max(lastOut, performance.now() + LAG / 2 + Math.random() * JIT);
    outQ.push({ at: lastOut, d });
  };
  const send = (m: C2S) => sendRaw(JSON.stringify(m), false);
  const specOf = async (id: string): Promise<CarSpec> => {
    const json = (f: string) => fetch(carFile(id, f)).then((r) => (r.ok ? r.json() : null)).catch(() => null);
    const [info, meta] = await Promise.all([json('model.json'), json('meta.json')]);
    return carSpecOf(id, info, meta);
  };
  const net = new NetClient({ track, specOf, vehicle, car: CAR, send: sendRaw, raw: RAW });
  const onMessage = (e: MessageEvent) => {
    const d = e.data as string | ArrayBuffer;
    stats.bytesDown += typeof d === 'string' ? d.length : d.byteLength;
    if (!sim) return receive(d, false);
    const lost = typeof d !== 'string' && Math.random() < LOSS;
    lastIn = Math.max(lastIn, performance.now() + LAG / 2 + Math.random() * JIT);
    inQ.push({ at: lastIn, d, lost });
  };
  const pump = () => {
    const now = performance.now();
    while (outQ.length && outQ[0].at <= now) {
      const d = outQ.shift()!.d;
      if (ws?.readyState === 1) ws.send(d as string | Uint8Array<ArrayBuffer>);
    }
    while (inQ.length && inQ[0].at <= now) {
      const m = inQ.shift()!;
      receive(m.d, m.lost);
    }
  };
  if (sim) setInterval(pump, 2);
  function receive(d: string | ArrayBuffer, lost: boolean) {
    if (typeof d === 'string') return handle(JSON.parse(d));
    const b = new Uint8Array(d);
    if (b[0] === MSG_SNAP) onSnap(b, !lost);
  }
  /** Into the room as your wallet (the session token is all the server needs) - or, dev mode, as a guest. */
  const join = () => (session || DEV) && send({
    t: 'join', room: ROOM, token: session?.token ?? '', car: CAR, track: COURSE, laps: LAPS, min: MIN || undefined, bots: BOTS || undefined,
    solo: SOLO || undefined, auto: AUTO || autoDrive || undefined, dev: DEV || undefined, v: BUILD_ID,
  });
  function connect() {
    if (!SERVER) {
      // (an https page with no game server set: nothing to connect to)
      return void setTimeout(() => {
        notice = { title: 'Game server offline', text: 'Online races are not available right now.', reload: false };
        renderCard();
      });
    }
    ws = new WebSocket(SERVER);
    ws.binaryType = 'arraybuffer';
    ws.onmessage = onMessage;
    ws.onopen = () => {
      join();
      ping();
    };
    ws.onclose = () => {
      if (notice) return; // (the server said why first: a full room, your wallet racing elsewhere)
      notice = me >= 0
        ? { title: 'Disconnected', text: 'Lost the connection to the game server.', reload: true }
        : { title: 'Game server offline', text: isDev() ? `Nothing at ${esc(SERVER)}: <b>npm run server</b> in the app folder starts it.` : 'Online races are not available right now.', reload: true };
      renderCard();
    };
  }
  /** Signed in (the card's Connect wallet, or another tab): join on the open connection, or open one. */
  function signedIn(s: Session) {
    session = s;
    void pickCars();
    renderCard();
    if (ws?.readyState === 1) join();
    else if (!ws) connect();
  }
  async function askToConnect() {
    const now = loadSession(); // (signed in meanwhile, in another tab: no need to sign again)
    if (now) return signedIn(now);
    const { connectWallet } = await import('../../auth/wallets');
    const s = await connectWallet();
    if (s) signedIn(s);
  }
  // signed out (the top bar's Disconnect, here or in another tab) while in the room: start over - the page asks you to
  // connect. (A sign-in in another tab doesn't join from here: a wallet races one car, so that would bump the other tab.)
  onSession((s) => {
    if (!s && session && me >= 0) location.reload();
  });
  const ping = () => send({ t: 'p', c: performance.now(), rtt: Math.round(net.rtt) });
  setInterval(() => ws?.readyState === 1 && ping(), 1000);
  if (session || DEV) connect(); // (signed out: the card's Connect wallet comes first - dev mode: a guest)
  /** Back to the lobby browser (with this car, and the server if it was given). */
  function roomsHref() {
    if (SOLO) return q.get('server') ? `/?server=${encodeURIComponent(q.get('server')!)}` : '/'; // (a time trial came from the landing)
    const p = new URLSearchParams({ car: CAR });
    if (q.get('server')) p.set('server', q.get('server')!);
    return `/online.html?${p}`;
  }
  /** The link a friend opens to land in this room (with their own wallet and car). */
  const invite = () => roomHref(ROOM, COURSE, LAPS, { server: q.get('server'), absolute: true, dev: DEV });

  // ---- the room as the server tells it (net keeps the race's own: phase, players, the start, your slot and lap)
  let me = -1, phase = net.phase, players: PlayerInfo[] = [];
  let inRace = false, ready = false, results: ResultRow[] | null = null, roomMin = 1, host = -1;
  // the card instead of the room: no server, a full room, your wallet racing elsewhere (`again`: the reload button's words)
  let notice: { title: string; text: string; reload: boolean; again?: string } | null = null;
  let done = false, far = false, lapsSeen = 0;
  // a time trial: this visit's best lap (steps), and your best and rank on this week's board (GET /leaderboard)
  let bestRun: number | null = null, week: { rank: number; steps: number } | null | undefined;
  async function loadWeek() {
    if (!SOLO || !session || !SERVER) return;
    try {
      const r = await fetch(`${serverHttp(SERVER)}/leaderboard?wallet=${session.wallet}`, { cache: 'no-store' });
      const lb = (await r.json()) as Leaderboard;
      const t = lb.tracks.find((x) => x.id === COURSE);
      week = t?.you ? { rank: t.you.rank, steps: t.you.steps } : null;
    } catch {
      week = undefined;
    }
    if (cardView === 'lobby') updateLobby();
    if (cardView === 'results') build('results');
  }

  // ---- drawing: your car as main.ts draws it (the pose between the last two steps), plus the visual error each
  // correction leaves (WorldCar.off / qOff), which decays
  const qI = new THREE.Quaternion();
  const rs: VehicleState = { ...st, position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), accelLocal: new THREE.Vector3() };
  function sync(alpha: number) {
    const o = net.own;
    if (o) {
      rs.position.lerpVectors(o.prevP, st.position, alpha).add(o.off);
      rs.quaternion.slerpQuaternions(o.prevQ, st.quaternion, alpha).premultiply(o.qOff);
    } else {
      rs.position.copy(st.position);
      rs.quaternion.copy(st.quaternion);
    }
    rs.velocity.copy(st.velocity);
    rs.accelLocal.copy(st.accelLocal);
    rs.speed = st.speed;
    rs.steerVisual = st.steerVisual;
    rs.wheelSpinRate = st.wheelSpinRate;
    rs.slip = st.slip;
    rs.drifting = st.drifting;
    rs.driftTier = st.driftTier;
    rs.boosting = st.boosting;
    rs.boostStack = st.boostStack;
    rs.grounded = st.grounded;
    rs.trackS = st.trackS;
    rs.lapDelta = st.lapDelta;
    rs.events = st.events;
    rs.wrongWay = st.wrongWay;
    rs.contact = st.contact;
    rig.root.position.copy(rs.position);
    rig.root.quaternion.copy(rs.quaternion);
  }
  const clearEvents = () => {
    const e = st.events as Record<string, unknown>;
    for (const k in e) e[k] = undefined;
  };
  function placeOnGrid() {
    net.placeOnGrid();
    sync(1);
    cam.reset(rs, track, rig.root);
    fx.reset();
    done = false;
    far = false;
    lapsSeen = 0;
  }

  function handle(m: S2C) {
    if (m.t === 'P') {
      net.onPong(m, performance.now());
      pingEl.textContent = `ping ${Math.round(net.rtt)} ms${sim ? ' (sim)' : ''}`;
      pingEl.classList.toggle('bad', net.rtt > 120);
      return;
    }
    if (m.t === 'welcome') {
      net.onWelcome(m);
      me = m.you;
      if (autoDrive) send({ t: 'auto' }); // (switched on while this join was on its way)
      void loadWeek();
      renderCard();
      syncRemotes();
      return;
    }
    if (m.t === 'track') {
      const p = new URLSearchParams(location.search);
      p.set('track', m.track);
      p.set('laps', String(m.laps));
      location.search = p.toString();
      return;
    }
    if (m.t === 'error') {
      if (m.code === 'auth') {
        // the server doesn't take this sign-in (expired, or it restarted with a new secret): sign in again, then join
        const stale = session;
        session = null;
        if (stale && loadSession()?.token === stale.token) clearSession(); // (not a newer one from another tab)
        signinWhy = stale ? 'expired' : 'none';
        devRefused = true;
        return void renderCard();
      }
      notice = m.code === 'replaced'
        ? { title: 'Racing elsewhere', text: `${esc(m.msg)}. A wallet races one car at a time, so your car left this room.`, reload: true, again: 'Race here' }
        : m.code === 'version'
        ? { title: 'A new version is out', text: 'Reload the page to race on it.', reload: true, again: 'Reload' }
        : m.code === 'restart'
        ? { title: 'Server restarting', text: 'The game server is restarting for an update. Try again in a minute.', reload: true }
        : { title: "Can't join", text: `${esc(m.msg)}. Pick another room, or make your own.`, reload: false };
      return void renderCard();
    }
    if (m.t === 'notice') {
      // the server restarts once the race on now is over (no new one starts): say so, in the race or on the card
      if (inRace && (phase === 'race' || phase === 'countdown')) hud.toast('Server restarts after this race', '#ffb347');
      else (notice = { title: 'Server restarting', text: 'The game server is restarting for an update. Try again in a minute.', reload: true }), renderCard();
      return;
    }
    if (m.t === 'room') return onRoom(m);
    if (m.t === 'car') {
      // the car asked for isn't one of the wallet's: the server races this one
      hud.toast(m.msg, '#fff');
      return void swapCar(m.car, false);
    }
    if (m.t === 'lap') {
      if (m.id === me) {
        const n = m.lap;
        if (SOLO && (bestRun == null || m.time < bestRun)) bestRun = m.time;
        if (n < LAPS) hud.toast(n === LAPS - 1 ? 'Final lap' : `Lap ${n + 1}`, tier.color);
      }
      return;
    }
    if (m.t === 'results') {
      results = m.rows;
      showResults = true;
      renderCard();
      if (SOLO) setTimeout(() => void loadWeek(), 400); // (the run's laps are on the board by now)
    }
  }

  function onRoom(m: Extract<S2C, { t: 'room' }>) {
    const what = net.onRoom(m);
    phase = net.phase;
    players = net.players;
    roomMin = m.min;
    host = m.host;
    inRace = net.inRace;
    const mine = players.find((p) => p.id === me);
    ready = !!mine?.ready;
    syncRemotes();
    if (phase === 'lobby' && serverCar && serverCar !== CAR) void swapCar(serverCar, false);
    if (what === 'race') {
      results = null;
      showResults = false;
      placeOnGrid();
    } else if (what === 'lobby') {
      placeOnGrid();
      if (AUTO && !ready && net.mySlot >= 0) send({ t: 'ready', on: true });
    }
    renderCard();
  }

  function onSnap(b: Uint8Array, apply: boolean) {
    net.onSnapshot(b, apply, performance.now());
    if (!apply) return;
    if (net.lap[2] >= 0 && !done && net.racing()) {
      done = true;
      const pos = standings().findIndex((r) => r.id === me) + 1;
      hud.toast(SOLO ? 'Finish' : pos === 1 ? 'You win!' : `P${pos}`, tier.color);
      fx.confetti(st.position, 160);
    }
  }

  // ---- the other cars: each its rig (the vehicle and its state are the predicted world's) and a name tag
  interface Remote { id: number; name: string; car: string; rig: Rig | null; tag: HTMLElement; last: THREE.Vector3; has: boolean; rs: VehicleState }
  const remotes = new Map<number, Remote>();
  function syncRemotes() {
    if (me < 0) return; // (the room can arrive before the welcome: who's me isn't known yet)
    for (const p of players) {
      const had = remotes.get(p.id);
      if (had && had.name !== p.name) {
        had.name = p.name; // renamed
        (had.tag.firstChild as Text).textContent = p.name;
      }
      if (had && had.car !== p.car) {
        // another car (picked in the lobby): drop this one, load that below
        had.rig?.dispose();
        had.tag.remove();
        remotes.delete(p.id);
      }
      if (p.id === me || remotes.has(p.id)) continue;
      const tag = document.createElement('div');
      tag.className = 'net-tag';
      tag.textContent = p.name;
      tags.append(tag);
      const r: Remote = {
        id: p.id, name: p.name, car: p.car, rig: null, tag, last: new THREE.Vector3(), has: false,
        rs: {
          position: new THREE.Vector3(), quaternion: new THREE.Quaternion(), velocity: new THREE.Vector3(), speed: 0, steerVisual: 0, wheelSpinRate: 0,
          slip: 0, drifting: false, driftTier: 0, boosting: false, boostStack: 0, grounded: true, accelLocal: new THREE.Vector3(), trackS: 0, lapDelta: 0, events: {},
        },
      };
      remotes.set(p.id, r);
      loadRig(p.car).then((g) => {
        if (remotes.get(p.id) !== r) return g.dispose();
        r.rig = g;
        scene.add(g.root);
        warm(g.root);
      }).catch((e) => console.warn('no rig for', p.car, e));
    }
    for (const [id, r] of remotes) {
      if (id !== me && players.some((p) => p.id === id)) continue;
      r.rig?.dispose();
      r.tag.remove();
      remotes.delete(id);
    }
  }
  /** A car that just loaded, ready to draw before it's first seen: its shaders compiled (off the main thread where the
   *  GPU can) and its textures on the GPU - else the frame it first comes into view (it overtakes you, it rounds a bend)
   *  stalls on them. */
  function warm(root: THREE.Object3D) {
    const was = root.visible;
    root.visible = true;
    void renderer.compileAsync(root, cam.camera, scene).catch(() => {});
    root.visible = was;
    root.traverse((o) => {
      for (const m of ([] as THREE.Material[]).concat((o as THREE.Mesh).material ?? [])) {
        for (const v of Object.values(m)) if ((v as THREE.Texture)?.isTexture) renderer.initTexture(v as THREE.Texture);
      }
    });
  }
  const proj = new THREE.Vector3(), V = new THREE.Vector3();
  /** Every other car at its predicted pose (between its last two steps) plus its visual error; its hits' sparks and
   *  knocks (yours play with your car's effects). */
  function drawRemotes(alpha: number, dt: number) {
    const w = canvas.clientWidth, h = canvas.clientHeight;
    for (const r of remotes.values()) {
      const c: WorldCar | null = net.world.get(r.id);
      const v = c?.veh;
      if (!r.rig || !c || !v || !c.has) {
        if (r.rig) r.rig.root.visible = false;
        r.tag.style.display = 'none';
        continue;
      }
      r.rig.root.visible = true;
      const s = r.rs, vs = v.state, a = c.active ? alpha : 1;
      s.position.lerpVectors(c.active ? c.prevP : vs.position, vs.position, a).add(c.off);
      s.quaternion.slerpQuaternions(c.active ? c.prevQ : vs.quaternion, vs.quaternion, a).premultiply(c.qOff);
      s.velocity.copy(vs.velocity);
      s.accelLocal.copy(vs.accelLocal);
      s.speed = vs.speed;
      s.steerVisual = vs.steerVisual;
      s.wheelSpinRate = vs.wheelSpinRate;
      s.drifting = vs.drifting;
      s.grounded = vs.grounded;
      s.boosting = vs.boosting;
      s.events = vs.events;
      // smoothness: how far it moved this frame against how far its speed says it should have
      if (r.has && dt > 0 && s.speed > 8 && c.active) {
        const moved = r.last.distanceTo(s.position), want = s.speed * dt;
        stats.remoteFrames++;
        const ratio = moved / want;
        stats.remoteJerk.push(ratio);
        if (stats.remoteJerk.length > 20000) stats.remoteJerk.splice(0, 10000);
        if (ratio < 0.5 || ratio > 1.6) stats.stutter++;
      }
      r.last.copy(s.position);
      r.has = true;
      r.rig.root.position.copy(s.position);
      r.rig.root.quaternion.copy(s.quaternion);
      r.rig.update(s, dt);
      // its crash with another car (yours shows from your side): sparks where they touched, a knock by distance
      const ev = vs.events;
      if (ev.carHit && vs.contact) {
        const other = net.world.cars.find((o) => o.own && o.veh && o.veh.state.position.distanceTo(vs.contact!.at) < 3);
        if (!other) {
          fx.carBurst(vs.contact.at, vs.contact.normal, ev.carHit, V.copy(vs.velocity));
          audio.carHit(ev.carHit, cam.camera.position.distanceTo(vs.contact.at));
        }
      }
      for (const k in ev) (ev as Record<string, unknown>)[k] = undefined;
      // name tag over the car
      // (just over the roof, along the car's own up: on a bank or the wall ride it stays on its car)
      proj.set(0, 1, 0).applyQuaternion(s.quaternion).multiplyScalar(r.rig.spec.height + 0.3).add(s.position).project(cam.camera);
      // (full from 8 to 35 u away, gone by 110 - and right by the camera, where it would stick to the screen's edge; a
      // little smaller far off)
      const far = cam.camera.position.distanceTo(s.position);
      const fade = (1 - THREE.MathUtils.smoothstep(far, 35, 110)) * THREE.MathUtils.smoothstep(far, 4, 8);
      const on = proj.z < 1 && fade > 0.02 && Math.abs(proj.x) < 1.2 && Math.abs(proj.y) < 1.2;
      r.tag.style.display = on ? '' : 'none';
      if (on) {
        r.tag.style.opacity = (0.72 * fade).toFixed(2);
        r.tag.style.transform = `translate(${((proj.x + 1) / 2) * w}px, ${((1 - proj.y) / 2) * h}px) translate(-50%, -100%) scale(${(1 - 0.2 * THREE.MathUtils.smoothstep(far, 8, 80)).toFixed(3)})`;
      }
    }
  }

  // ---- standings: finishers by their step, then by how far along the race (the others' from their last snapshot;
  // yours from your own car)
  const standings = () => {
    const L = track.length, rows: { id: number; laps: number; fin: number; prog: number }[] = [];
    for (const c of net.world.cars) {
      if (!c.veh || (!c.own && !c.has)) continue;
      if (c.own) rows.push({ id: me, laps: net.lap[0], fin: net.lap[2], prog: progressOf({ far, laps: net.lap[0], lapStart: 0, lapTimes: [], finish: net.lap[2] }, st, track) });
      else rows.push({ id: c.id, laps: c.laps, fin: c.finish, prog: progressOf({ far: c.far, laps: c.laps, lapStart: 0, lapTimes: [], finish: c.finish }, c.veh.state, track) });
    }
    void L;
    return rows.sort((a, b) => {
      const fa = a.fin >= 0, fb = b.fin >= 0;
      if (fa !== fb) return fa ? -1 : 1;
      if (fa) return a.fin - b.fin;
      return b.prog - a.prog;
    });
  };
  const nameOf = (id: number) => players.find((p) => p.id === id)?.name ?? `#${id}`;
  let boardAt = 0;
  function drawBoard() {
    const now = performance.now();
    if (now - boardAt < 200) return;
    boardAt = now;
    const rows = standings().filter((r) => players.some((p) => p.id === r.id && p.slot >= 0) && (r.id !== me || inRace));
    const pos = rows.findIndex((r) => r.id === me) + 1;
    board.querySelector('.pn')!.textContent = pos ? String(pos) : '-';
    board.querySelector('.pt')!.textContent = String(rows.length || '-');
    const html = rows.map((r, i) => `<li class="${r.id === me ? 'me' : ''}"><b>${i + 1}</b>${esc(nameOf(r.id))}${r.fin >= 0 ? ' ✓' : ''}</li>`).join('');
    const ol = board.querySelector('ol')!;
    if (ol.innerHTML !== html) ol.innerHTML = html;
  }

  // ---- the card: connect your wallet (signed out), the room's lobby, the results, waiting for a race to end, or a notice
  // (no server, room full, your wallet racing elsewhere). A view is built once and then only its changing parts are
  // updated, so an open car menu is never re-rendered away.
  // The results stay up until Race again (back to this room's lobby) or the next countdown.
  type View = 'signin' | 'lobby' | 'results' | 'wait' | 'notice' | 'none';
  let cardView: View = 'none', showResults = false;
  const ordinal = (n: number) => `${n}${n % 10 === 1 && n % 100 !== 11 ? 'st' : n % 10 === 2 && n % 100 !== 12 ? 'nd' : n % 10 === 3 && n % 100 !== 13 ? 'rd' : 'th'}`;
  const lapsText = `${LAPS} ${LAPS === 1 ? 'lap' : 'laps'}`;
  const courseTag = `<i class="cdot" style="--c:${COURSE_DEF.color}"></i>${esc(COURSE_DEF.name)} · ${lapsText}`;

  function viewOf(): View {
    if (notice) return 'notice';
    if (!session && (!DEV || devRefused)) return 'signin';
    if (showResults && results) return 'results';
    if (phase === 'lobby' || phase === 'results') return 'lobby';
    if (!inRace) return 'wait';
    return 'none';
  }
  function showCard(html: string) {
    card.innerHTML = html;
    card.classList.add('on');
    document.body.classList.add('net-card');
  }
  function renderCard() {
    const v = viewOf();
    card.dataset.view = v;
    if (v !== 'lobby') pick.close();
    if (v === 'none') {
      card.classList.remove('on');
      document.body.classList.remove('net-card');
      cardView = v;
      return;
    }
    if (v !== cardView || v === 'results' || v === 'wait' || v === 'notice' || v === 'signin') build(v);
    cardView = v;
    if (v === 'lobby') updateLobby();
  }
  function build(v: View) {
    if (v === 'notice' && notice) {
      showCard(`<div class="medal">Online</div><div class="total nl-big">${esc(notice.title)}</div><p class="nl-text">${notice.text}</p>
        <div class="btns">${notice.reload ? `<button type="button" class="reload">${esc(notice.again ?? 'Try again')}</button>` : ''}<a href="${esc(roomsHref())}">Back to rooms</a></div>`);
      card.querySelector('.reload')?.addEventListener('click', () => location.reload());
    } else if (v === 'signin') {
      const expired = signinWhy === 'expired';
      showCard(`<div class="medal">${courseTag}</div><div class="total nl-big">${expired ? 'Sign in again' : 'Connect your wallet'}</div>
        <p class="nl-text">${expired ? 'Your sign-in has expired. ' : ''}${SOLO ? 'A time trial: your laps count for this week\'s board.' : `You're joining room <b>${esc(ROOM)}</b>.`} Your wallet address is your name in the race: connecting is <b>free, no transaction</b>.</p>
        <button type="button" class="connect nl-ready">Connect wallet</button><a href="${esc(roomsHref())}" class="nl-leave">Back to rooms</a>`);
      card.querySelector('.connect')!.addEventListener('click', (e) => {
        e.stopPropagation();
        void askToConnect();
      });
    } else if (v === 'results' && results && SOLO) {
      // a time trial's run: its laps (the best lit), the total, and where you stand this week
      const mine = results.find((r) => r.id === me);
      const laps = mine?.laps ?? [], best = laps.length ? Math.min(...laps) : null;
      const rows = laps.map((t, i) => `<li class="${t === best ? 'me' : ''}"><span class="nm">Lap ${i + 1}</span><b>${lapTime(t)}</b></li>`).join('')
        + (mine?.total != null ? `<li><span class="nm">Total</span><b>${fmtTime(mine.total * H)}</b></li>` : '');
      showCard(`<div class="medal">Time trial · ${courseTag}</div><div class="total nl-big">${best != null ? lapTime(best) : 'Run over'}</div>
        <ol class="nl-list">${rows}</ol>${weekLine(best)}
        <div class="btns"><button type="button" class="again">Again</button><a href="${esc(roomsHref())}" class="leave">Leave</a></div>`);
      card.querySelector('.again')!.addEventListener('click', (e) => {
        e.stopPropagation();
        showResults = false;
        send({ t: 'ready', on: true }); // (straight into the next run)
        renderCard();
      });
    } else if (v === 'results' && results) {
      const mine = results.find((r) => r.id === me);
      const title = !mine ? 'Race over' : mine.total == null ? 'Did not finish' : mine.pos === 1 ? 'You win!' : `${ordinal(mine.pos)} place`;
      const win = results.find((r) => r.pos === 1)?.total ?? null;
      const rows = results.map((r) => {
        const t = r.total == null ? 'DNF' : r.pos === 1 || win == null ? fmtTime(r.total * H) : `+${((r.total - win) * H).toFixed(2)}`;
        return `<li class="${r.id === me ? 'me' : ''}"><b class="ps">${r.pos}</b><span class="nm">${esc(r.name)}<small>${esc(players.find((p) => p.id === r.id)?.carName ?? r.car)}</small></span><b>${t}</b></li>`;
      }).join('');
      showCard(`<div class="medal">Results · ${courseTag}</div><div class="total nl-big">${title}</div><ol class="nl-list">${rows}</ol>
        <div class="btns"><button type="button" class="again">Race again</button><a href="${esc(roomsHref())}" class="leave">Leave</a></div>`);
      card.querySelector('.again')!.addEventListener('click', (e) => {
        e.stopPropagation();
        showResults = false;
        renderCard();
      });
    } else if (v === 'wait') {
      const rows = players.filter((p) => p.slot >= 0).map((p) => `<li><span class="nm">${esc(p.name)}<small>${esc(p.carName || p.car)}</small></span></li>`).join('');
      showCard(`<div class="medal">${courseTag}</div><div class="total nl-big">Race on</div>
        <p class="nl-text">Room <b>${esc(ROOM)}</b> is mid-race. You're in the next one: it starts once this race ends and everyone presses Ready.</p><ol class="nl-list">${rows}</ol>
        <div class="btns"><a href="${esc(roomsHref())}" class="leave">Leave room</a></div>`);
    } else if (v === 'lobby') {
      showCard(`<div class="nl-head"><div><div class="medal">${courseTag}</div><div class="nl-room">${SOLO ? 'Time trial' : esc(ROOM)}</div></div>
          ${SOLO ? '' : `<button type="button" class="nl-invite" title="Copy a link that brings a friend straight into this room">${LINK}<span>Copy invite link</span></button>`}</div>
        <div class="nl-count"></div>
        <ol class="nl-list pl"></ol>${SOLO ? '<div class="nl-wk"></div>' : ''}
        <div class="nl-you"><div class="nl-me"><span>Racing as</span><b title="${esc(session?.wallet ?? '')}">${session?.icon ? `<img src="${session.icon}" alt="">` : ''}<span class="nm-t">${esc(myName())}</span></b></div>
          <div class="nl-car"><span>Your car</span></div></div>
        <button type="button" class="ready nl-ready"></button>
        <div class="nl-status"></div>
        <a href="${esc(roomsHref())}" class="nl-leave">${SOLO ? 'Leave' : 'Leave room'}</a>`);
      card.querySelector('.nl-car')!.append(pick.box);
      pickShown = '';
      card.querySelector('.nl-ready')!.addEventListener('click', (e) => {
        e.stopPropagation();
        send({ t: 'ready', on: !ready });
      });
      card.querySelector('.nl-invite')?.addEventListener('click', copyInvite);
    }
  }
  /** A lap in steps, as the board shows it (m:ss.sss). */
  function lapTime(steps: number) {
    const t = steps * H, m = Math.floor(t / 60), s = t - m * 60;
    return `${m}:${s < 10 ? '0' : ''}${s.toFixed(3)}`;
  }
  /** Your place on this week's board on this track (a time trial's lobby and results); `run`: this run's best lap. */
  function weekLine(run: number | null = null) {
    if (week === undefined) return '';
    const fresh = run != null && week && week.steps === run;
    return `<div class="nl-week"><span>This week</span><b>${week ? `<i>#${week.rank}</i>${lapTime(week.steps)}${fresh ? '<em>New best</em>' : ''}` : '-'}</b></div>`;
  }
  function updateLobby() {
    const humans = players.filter((p) => !p.bot);
    const rows = players.map((p) => {
      const tags = `${p.id === me ? '<em>You</em>' : ''}${p.id === host ? '<em class="h">Host</em>' : ''}${p.bot ? '<em>Bot</em>' : ''}`;
      const state = p.bot ? '' : p.ready ? 'Ready' : 'Not ready';
      const sub = `${esc(p.carName || p.car)}${p.slot < 0 ? ' · next race' : ''}${p.viol ? ` · ${p.viol} flagged` : ''}`;
      return `<li class="${p.id === me ? 'me' : ''}"><i class="dot ${p.ready ? 'on' : ''}"></i><span class="nm"${p.wallet ? ` title="${esc(p.wallet)}"` : ''}>${esc(p.name)}${tags}<small>${sub}</small></span>
        <span class="st ${p.ready ? 'on' : ''}">${state}${p.bot ? '' : `<small>${p.ping} ms</small>`}</span></li>`;
    }).join('');
    const list = card.querySelector('.nl-list')!;
    if (list.innerHTML !== rows) list.innerHTML = rows;
    card.querySelector('.nl-count')!.textContent = `Players ${players.length}/${MAX_PLAYERS}`;
    const btn = card.querySelector<HTMLButtonElement>('.nl-ready')!;
    btn.textContent = SOLO ? (ready ? 'Starting…' : 'Start') : ready ? 'Ready ✓' : 'Ready';
    btn.classList.toggle('on', ready);
    const wk = card.querySelector('.nl-wk');
    if (wk && wk.innerHTML !== weekLine()) wk.innerHTML = weekLine();
    if (pickShown !== CAR) pick.set((pickShown = CAR));
    const nmT = card.querySelector('.nl-me .nm-t');
    if (nmT && nmT.textContent !== myName()) nmT.textContent = myName(); // (a guest's name comes with the welcome)
    pick.btn.disabled = phase !== 'lobby' || swapping;
    pick.btn.title = phase !== 'lobby' ? 'You can change cars once everyone is back in the lobby' : 'Your car for the next race';
    // what happens next, in a line
    const waiting = humans.filter((p) => !p.ready && p.id !== me);
    const names = (ps: PlayerInfo[]) => ps.length <= 2 ? ps.map((p) => p.name).join(' and ') : `${ps[0].name}, ${ps[1].name} and ${ps.length - 2} more`;
    let status: string;
    if (SOLO) status = '';
    else if (phase === 'results') status = ready ? 'Waiting for the others to finish with the results' : 'Press Ready for the next race';
    else if (humans.length < roomMin) status = `Waiting for ${roomMin - humans.length} more ${roomMin - humans.length === 1 ? 'player' : 'players'} to join`;
    else if (!ready && humans.length === 1) status = 'Just you so far. Send the invite link, or press Ready to race now';
    else if (!ready) status = waiting.length ? 'Press Ready when you are set' : 'Everyone else is ready. Press Ready to start';
    else if (waiting.length) status = `Waiting for ${esc(names(waiting))} to get ready`;
    else status = 'Starting…';
    const st = card.querySelector('.nl-status')!;
    if (st.innerHTML !== status) st.innerHTML = status;
  }
  const LINK = '<svg viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"><path d="M6.6 9.4a2.6 2.6 0 0 0 3.7 0l2.4-2.4a2.6 2.6 0 0 0-3.7-3.7l-.9.9"/><path d="M9.4 6.6a2.6 2.6 0 0 0-3.7 0L3.3 9a2.6 2.6 0 0 0 3.7 3.7l.9-.9"/></svg>';
  async function copyInvite() {
    const link = invite();
    const btn = card.querySelector<HTMLElement>('.nl-invite');
    let ok = false;
    try {
      await navigator.clipboard.writeText(link);
      ok = true;
    } catch {
      // no clipboard API (plain http on a LAN address): the old way
      const ta = document.createElement('textarea');
      ta.value = link;
      document.body.append(ta);
      ta.select();
      try {
        ok = document.execCommand('copy');
      } catch {
        ok = false;
      }
      ta.remove();
    }
    if (!btn) return;
    btn.querySelector('span')!.textContent = ok ? 'Link copied' : 'Copy failed';
    btn.classList.toggle('done', ok);
    const st = card.querySelector('.nl-status');
    if (st) st.innerHTML = ok ? 'Send it to a friend: it opens this room' : `Copy this link: <span class="sel">${esc(link)}</span>`;
    setTimeout(() => {
      if (!btn.isConnected) return;
      btn.querySelector('span')!.textContent = 'Copy invite link';
      btn.classList.remove('done');
      if (cardView === 'lobby') updateLobby();
    }, 2500);
  }
  /** Your name in the room: your wallet's (as the server shows it). */
  const myName = () => players.find((p) => p.id === me)?.name ?? (session ? shortWallet(session.wallet) : 'Guest');
  /** Another car, in place: its rig, a fresh vehicle on my grid slot, the effects and engine for it; the server swaps
   *  its car too (and un-readies me). Only in the lobby - mid-race the car is the race's. */
  let swapping = false;
  /** `tell`: ask the server for it (false: it's the server's own pick - { t: 'car' } - taken once in the lobby). */
  async function swapCar(id: string, tell = true) {
    const nav = await navP;
    if (!tell) serverCar = id;
    if (id === CAR || swapping) return;
    if (phase !== 'lobby') {
      if (!tell) return; // (in the lobby: onRoom)
      nav.setCar(CAR);
      hud.toast('Change cars in the lobby', '#fff');
      return;
    }
    swapping = true;
    renderCard();
    try {
      const g = await loadRig(id);
      const v = await create(track, g.spec);
      scene.remove(rig.root);
      rig.dispose();
      rig = g;
      scene.add(rig.root);
      vehicle = v;
      st = v.state;
      net.setVehicle(v, id);
      CAR = id;
      carLook();
      scene.remove(fxScene);
      fxScene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        for (const mat of ([] as THREE.Material[]).concat(m.material ?? [])) mat.dispose();
      });
      fxScene = new THREE.Scene();
      scene.add(fxScene);
      fx = createFx(fxScene, rig.spec, new THREE.Color(tier.color));
      fx.warm(true); // (its shaders before the race, not on first use)
      void renderer.compileAsync(fxScene, cam.camera, scene).catch(() => {});
      fx.warm(false);
      fx.setTrack(track);
      audio.setCar(rig.spec);
      placeOnGrid();
      saveCar(id);
      const p = new URLSearchParams(location.search);
      p.set('car', id);
      history.replaceState(null, '', `${location.pathname}?${p}`);
      if (tell) send({ t: 'car', car: id });
      if (serverCar === id) serverCar = null;
    } catch (err) {
      console.warn('car swap failed', id, err);
      hud.toast('No 3D model for that car', '#fff');
    }
    swapping = false;
    nav.setCar(CAR);
    renderCard();
  }
  addEventListener('keydown', (e) => {
    if ((e.code === 'Enter' || e.code === 'NumpadEnter') && !(e.target instanceof HTMLInputElement || e.target instanceof HTMLSelectElement) && cardView === 'lobby')
      send({ t: 'ready', on: !ready });
  });

  // ---- view

  // ---- view
  const resize = () => {
    const w = canvas.clientWidth || innerWidth, h = canvas.clientHeight || innerHeight;
    renderer.setSize(w, h, false);
    cam.resize(w, h);
  };
  addEventListener('resize', resize);
  resize();
  placeOnGrid();
  fx.warm(true); // (the hidden effects too: their shaders would build mid-race, on first use)
  await renderer.compileAsync(scene, cam.camera).catch(() => {});
  fx.warm(false);
  document.getElementById('boot')?.remove();
  renderCard();

  const online = {
    get phase() { return phase; }, get me() { return me; }, get cs() { return net.cs; }, get players() { return players; },
    get results() { return results; }, get lap() { return net.lap; }, get go() { return net.go; }, get race() { return net.raceNo; },
    standings: () => standings().map((r) => ({ id: r.id, name: nameOf(r.id), laps: r.laps, fin: r.fin, prog: r.prog })),
    ready: (on = true) => send({ t: 'ready', on }),
    get view() { return cardView; }, get car() { return CAR; }, get name() { return myName(); }, get wallet() { return session?.wallet ?? null; },
    get host() { return host; },
    invite: () => invite(),
    // (the server marks the wallet's laps as the autopilot's from now on: never on the leaderboard)
    autoDrive: (on = true) => void ((autoDrive = on), on && me >= 0 && send({ t: 'auto' })),
    /** Tests: the steering the autopilot gets on top (shove the car into another: crash tests) and its throttle's
     *  share (keep pace with another car) ... */
    nudge: (x: number, p = 1) => void ((nudge = x), (pace = p)),
    /** ... or the whole input, instead of the keys or the autopilot (null: back to them). */
    override: (inp: DriveInput | null) => void (override = inp),
    stats: Object.defineProperty(Object.assign(stats, { net: net.stats }), 'rtt', { get: () => net.rtt, enumerable: true }),
    net, get state() { return st; },
  };
  Object.assign(window as any, { __online: online, __drive: { get state() { return st; }, get phase() { return phase; } } });

  let frames = 0, ftAvg = 1 / 60, cooldown = 3, lastTier = 0, wrong = false, countShown = -1, nudge = 0, scale = 1;
  let override: DriveInput | null = null, pace = 1;
  const adaptive = !navigator.webdriver;
  const showFps = q.get('fps') === '1';
  const idle: DriveInput = { steer: 0, throttle: 0, brake: 0, drift: false };

  /** Your input for a step: keys, pad or touch, or the autopilot - a victory lap once you've finished. */
  const read = (race: boolean): DriveInput => {
    if (!race) {
      input.read(H);
      return idle;
    }
    if (override) {
      input.read(H);
      return override;
    }
    if (done) {
      input.read(H);
      return { ...input.autopilot(st, track), throttle: 0.6 }; // a victory lap (as offline, behind the results)
    }
    if (AUTO || autoDrive) {
      const a = input.autopilot(st, track);
      return nudge || pace !== 1 ? { ...a, steer: Math.max(-1, Math.min(1, a.steer + nudge)), throttle: a.throttle * pace } : a;
    }
    return input.read(H);
  };

  const loop = startLoop({
    maxSteps: 60, // online, the sim must keep real time even on a slow frame
    step() {
      net.stepOnce(read);
    },
    render(alpha, dt) {
      const now = performance.now();
      if (frames > 30) {
        if (dt > 0.05) stats.longFrames++;
        if (dt > stats.maxFrame) stats.maxFrame = dt;
      }
      if (!sim) pump();
      const sc = net.steerClock(now);
      if (sc !== scale) loop.setTimeScale((scale = sc));
      for (let n = 0; net.extra > 0 && n < 60; n++, net.extra--) net.stepOnce(read);
      net.settle(); // (a snapshot's rewind that no step took up this frame)
      net.flush();
      // the visual errors decay
      const kx = 1 - Math.exp(-dt / SMOOTH), kr = 1 - Math.exp(-dt / SMOOTH_REMOTE);
      for (const c of net.world.cars) {
        const k = c.own ? kx : kr;
        c.off.multiplyScalar(1 - k);
        c.qOff.slerp(qI, k);
      }
      const racing = net.racing();
      sync(racing ? alpha : 1);
      // your laps for the standings (the far side of the lap, as the server's rule)
      if (racing) {
        const L = track.length, r = (((st.trackS - track.start) % L) + L) % L;
        if (net.lap[0] !== lapsSeen) (lapsSeen = net.lap[0]), (far = false);
        if (r > L * 0.5 && r < L * 0.9) far = true;
      }
      rig.update(rs, dt);
      world.update(rs, dt);
      cam.lookBack = input.lookBack;
      cam.intro = phase === 'lobby' || phase === 'countdown'; // before the gate drops: the car from the front
      cam.update(rs, dt, track, rig.root);
      fx.update(rs, dt, rig.root);
      audio.update(rs, net.input, dt);
      drawRemotes(racing ? alpha : 1, dt);

      const ev = st.events;
      if (ev.carHit && ev.carHit > HARD_HIT) input.rumble(ev.spinOut ? 1 : Math.min(1, 0.5 + ev.carHit / 40), ev.spinOut ? 160 : 100);
      else if (ev.carHit && ev.carHit > 4) input.rumble(Math.min(0.6, ev.carHit / 30), 60);
      else if (ev.carScrape && ev.carScrape > 4) input.rumble(Math.min(0.35, ev.carScrape / 60), 40);
      else if (ev.wallHit && ev.wallHit > 25) input.rumble(0.8, 90);
      if (ev.perfectLanding) hud.toast('Perfect!', '#3dff8b');
      else if (ev.tierUp === 4) hud.toast('Max drift!', '#fff', 'max');
      else if (ev.boostStart && lastTier > 0) {
        const c = lastTier === 4 ? '#fff' : lastTier === 3 ? tier.color : lastTier === 2 ? '#a35cff' : '#3d8bff';
        hud.toast(BOOST_NAMES[lastTier], c, lastTier === 4 ? 'max' : undefined);
      }
      if (ev.respawn) hud.flash();
      lastTier = st.driftTier;
      clearEvents();
      const w = racing && !!st.wrongWay;
      if (w !== wrong) hud.wrongWay((wrong = w));

      // countdown (on my own clock: GO is when my car goes)
      const cs = net.cs, go = net.go;
      if (phase === 'countdown' && cs !== null && go >= 0 && cs < go) {
        const n = Math.ceil((go - cs) * H);
        if (n !== countShown && n <= 3) {
          countShown = n;
          count.textContent = String(n);
          count.style.color = n === 1 ? tier.color : '#fff';
          count.classList.remove('on');
          void count.offsetWidth;
          count.classList.add('on');
        }
      } else if (countShown > 0) {
        countShown = -1;
        count.classList.remove('on');
        if (racing) hud.toast('Go!', tier.color);
      }

      hud.setSpeed(st.speed * KMH);
      const lap = net.lap;
      if (racing && cs !== null) {
        const fin = lap[2] >= 0;
        hud.setLap(Math.min(LAPS, lap[0] + 1), LAPS);
        hud.setTimes(((fin ? lap[2] : cs) - (fin ? lap[2] : lap[1])) * H, ((fin ? lap[2] : cs) - go) * H, SOLO && bestRun != null ? bestRun * H : null, fin);
      } else {
        hud.setLap(1, LAPS);
        hud.setTimes(0, 0, null);
      }
      drawBoard();
      renderer.render(scene, cam.camera);
      if (++frames === 3) Object.assign(window as any, { __ready: true });
      if (showFps) hud.fps(dt);
      if (adaptive && frames > 90) {
        ftAvg += (dt - ftAvg) * 0.05;
        cooldown -= dt;
        // (never in the thick of it - a boost, a drift, a flight: the switch itself costs a frame, and the slow frames
        // that ask for it come exactly then. It waits for calm driving)
        const calm = !st.boosting && !st.drifting && st.grounded;
        if (cooldown <= 0 && calm && ftAvg > 0.018 && dpr > 0.75) {
          dpr = Math.max(0.75, dpr - 0.25);
          renderer.setPixelRatio(dpr);
          resize();
          cooldown = 2;
          ftAvg = 1 / 60;
        }
      }
    },
  });
}
