// The server's step alone, timed: a room as the server runs it (inputs through the same checks' ring, the sim,
// car-to-car contact, laps, the race log, and a binary snapshot for every player at 60 Hz), its players driven here.
//   node server/bench.ts [cars=4] [course=meadow] [laps=3] [mode=race]
// mode  race    everyone on the autopilot from the grid (a full race; prints the results)
//       spread  the cars spread evenly round the lap, on the autopilot (no one near anyone: the sim's own cost)
//       pack    the worst case: every car aims for the same spot on the track, all the time - a pack shoving and
//               colliding constantly (20 s)
// Prints the step time (avg, p50, p99, max), contact counts, the snapshot bytes per player and the log's path.
import { createAutopilot } from '../src/drive/input.ts';
import { H, Q, quantizeInto, type QInput } from '../src/drive/net/protocol.ts';
import { Room, newPlayerId } from './room.ts';

const n = Number(process.argv[2] ?? 4), course = process.argv[3] ?? 'meadow', laps = Number(process.argv[4] ?? 3), mode = process.argv[5] ?? 'race';
const room = new Room(`bench-${mode}-${course}-${n}`, course, laps);
room.botsOnly = true;
room.assumeMatch = true; // (the players here don't predict: count their prediction as matching, as a real client's does)
let results: unknown = null, bytes = 0;
for (let i = 0; i < n; i++) {
  await room.join({
    id: newPlayerId(), name: `P${i + 1}`, car: ['skyline-hck01', 'chevy-impala-jkb99', 'roxy-porsche-hrv96', 'civic-type-r-hcy12', 'beach-bomb-too-k3370',
      'porsche-964-gdf88', 'pontiac-firebird-htf40', 'mustang-cobra-r-hgk61', 'porsche-911-gt3-rs', 'skyline-fyg14'][i % 10],
    send: (m) => void (m.t === 'results' && (results = m.rows)), sendBin: (b) => void (bytes += b.length), ready: true, ping: 0,
  }, 0);
}
const track = room.sim.track, L = track.length;
const aps = room.players.map(() => createAutopilot());
const q: QInput = [0, 0, 0, 0];
let seed = 1;
const rnd = () => ((seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 2 ** 32);
/** The player's input for step k, into its ring (as if it had arrived). */
function drive(k: number) {
  const cars = room.sim.cars;
  let ms = 0, md = 0;
  if (mode === 'pack') {
    for (const c of cars) (ms += ((c.veh.state.trackS - cars[0].veh.state.trackS + L * 1.5) % L) - L / 2), (md += c.veh.trackPose!().d);
    ms /= cars.length, md /= cars.length;
  }
  room.players.forEach((p, i) => {
    const c = p.sim!;
    if (mode === 'pack' && k > room.sim.go + 120) {
      // aim for the pack's middle (and a little jostle): they shove each other constantly
      const tp = c.veh.trackPose!(), ds = ((tp.s - cars[0].veh.state.trackS + L * 1.5) % L) - L / 2 - ms;
      const ap = aps[i](c.veh.state, track);
      const st = Math.max(-1, Math.min(1, ap.steer + 0.25 * (md - tp.d) + (rnd() - 0.5) * 0.4));
      quantizeInto({ steer: st, throttle: ds > 1 ? 0.2 : 1, brake: 0, drift: false }, c.last, q);
    } else quantizeInto(aps[i](c.veh.state, track), c.last, q);
    const r = (k % 1024) * 4;
    p.ring[r] = q[0], p.ring[r + 1] = Math.min(Q, q[1]), p.ring[r + 2] = q[2], p.ring[r + 3] = q[3];
    p.ringK[k % 1024] = k;
    p.newest = p.seen = k;
  });
}
const times: number[] = [];
let k = 0, spreadDone = false, touches0 = 0;
const t0 = performance.now();
const limit = mode === 'race' ? 600 / H : 20 / H;
let raceSteps = 0;
for (; raceSteps < limit && !results; k++) {
  if (room.phase === 'race' && k >= room.sim.go) {
    if (mode === 'spread' && !spreadDone) {
      spreadDone = true;
      room.sim.cars.forEach((c, i) => c.veh.reset((track.start + 40 + (i * L) / n) % L));
    }
    if (!touches0) touches0 = room.sim.contact.touches + 1e-9;
    drive(k);
  }
  const a = performance.now();
  room.step(k);
  if (room.phase === 'race' && k > room.sim.go) times.push((performance.now() - a) * 1000), raceSteps++;
}
const wall = (performance.now() - t0) / 1000;
times.sort((a, b) => a - b);
const qq = (x: number) => times[Math.min(times.length - 1, Math.floor(x * times.length))];
const avg = times.reduce((a, b) => a + b, 0) / times.length;
const cs = room.sim.contact;
console.log(`${course}, ${n} cars, ${mode}: ${times.length} race steps (${(times.length * H).toFixed(1)} s of racing) in ${wall.toFixed(1)} s wall`);
console.log(`step time: avg ${avg.toFixed(1)} us, p50 ${qq(0.5).toFixed(1)}, p99 ${qq(0.99).toFixed(1)}, max ${qq(1).toFixed(1)} us  (budget 8333 us; ${(avg / n).toFixed(1)} us per car)`);
console.log(`contact: ${cs.touches} touching pair-passes (${(cs.touches / Math.max(1, times.length)).toFixed(2)} per step), ${cs.hits} hits, hardest ${cs.maxVn.toFixed(1)} u/s, deepest ${cs.maxDepth.toFixed(2)} u; ${cs.pairs} pairs tested`);
console.log(`snapshots: ${(bytes / n / (times.length * H) / 1024).toFixed(2)} KB/s per player (${n - 1} other cars at 60 Hz)`);
if (mode === 'race') for (const r of (results ?? room.results()) as { pos: number; name: string; car: string; total: number | null; best: number | null }[])
  console.log(`  P${r.pos} ${r.name.padEnd(7)} ${r.car.padEnd(24)} ${r.total == null ? 'DNF' : (r.total * H).toFixed(3) + ' s'}  best lap ${r.best == null ? '-' : (r.best * H).toFixed(3)}`);
room.close(k);
console.log('log:', room.logPath);
await new Promise((r) => setTimeout(r, 300)); // let the log flush
void touches0;
