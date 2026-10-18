// Re-simulate a stored race from its input log (server/logs/<room>/*.jsonl) and check it ends exactly as it did live:
// the same results (finish order, total and lap times, to the step), the same car-to-car contact counts and the same
// hash of every car's full state - every collision re-simulated - and every lap the log has with the same time and the
// same contact flags (the leaderboard's: touched another car during the lap / in the 3 s before it).
// usage: node server/replay.ts <log.jsonl> [more.jsonl ...]   (exit code 1 on any mismatch)
import { H, LOG_VERSION, type QInput, type ResultRow } from '../src/drive/net/protocol.ts';
import { RaceSim } from './sim.ts';

let bad = 0;
for (const file of process.argv.slice(2)) {
  const { readFileSync } = await import('node:fs');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const head = lines[0], end = lines.find((l) => l.t === 'end');
  if (head?.t !== 'head') throw new Error(`${file}: no header`);
  if (head.v !== LOG_VERSION) {
    console.log(`${file}: log version ${head.v}, this code writes ${LOG_VERSION} (another contact model) - skipped`);
    continue;
  }
  if (!end) {
    console.log(`${file}: no end line (the race was cut off) - skipped`);
    continue;
  }
  const sim = new RaceSim(head.course, head.laps);
  for (const c of head.cars) await sim.addCar(c.id, c.car, c.slot);
  sim.start(head.go);
  // the log, by step: input changes (car, steer, throttle, brake, drift: flat) and leaves
  const at = new Map<number, { in?: number[]; out?: number }[]>();
  for (const l of lines) if (l.in || l.out !== undefined) (at.get(l.k) ?? at.set(l.k, []).get(l.k)!).push(l);
  const c0 = { ...sim.contact };
  const t0 = performance.now();
  // the laps as the re-simulation runs them (car index, lap, time, flags), against the log's lap lines
  const laps = new Map<string, string>();
  const onLap = (c: (typeof sim.cars)[number]) => void laps.set(`${sim.cars.indexOf(c)}:${c.lap.laps}`, `${c.lap.lapTimes[c.lap.lapTimes.length - 1]} ${c.lapTouch ? 1 : 0} ${c.preTouch ? 1 : 0}`);
  for (let k = head.go; k < end.k; k++) {
    for (const l of at.get(k) ?? []) {
      if (l.out !== undefined) sim.cars[l.out].out = true;
      const a = l.in ?? [];
      for (let j = 0; j + 4 < a.length; j += 5) {
        const q = sim.cars[a[j]].last as QInput;
        q[0] = a[j + 1], q[1] = a[j + 2], q[2] = a[j + 3], q[3] = a[j + 4];
      }
    }
    sim.step(k, () => false, onLap);
  }
  const logged = lines.filter((l) => l.lap !== undefined && l.time !== undefined && l.c !== undefined);
  const lapsBad = logged.filter((l) => laps.get(`${l.lap}:${l.n}`) !== `${l.time} ${l.c} ${l.pc}`);
  const ms = performance.now() - t0;
  const names = new Map<number, string>(head.cars.map((c: { id: number; name: string }) => [c.id, c.name]));
  const rows = sim.results((c) => names.get(c.key) ?? '');
  const hash = sim.hash();
  const contact = { pairs: sim.contact.pairs - c0.pairs, touches: sim.contact.touches - c0.touches, hits: sim.contact.hits - c0.hits };
  const same = JSON.stringify(rows.map((r) => [r.id, r.pos, r.total, r.laps])) === JSON.stringify(end.results.map((r: ResultRow) => [r.id, r.pos, r.total, r.laps]));
  const sameContact = !end.contact || (end.contact.touches === contact.touches && end.contact.hits === contact.hits);
  console.log(`${file}\n  ${head.course}, ${head.laps} laps, ${head.cars.length} cars, steps ${head.go}..${end.k} (${((end.k - head.go) * H).toFixed(1)} s) re-simulated in ${ms.toFixed(0)} ms (${end.why})`);
  for (const r of rows) {
    const c = sim.cars.find((x) => x.key === r.id)!, p = c.veh.state.position;
    console.log(`  P${r.pos} ${r.name.padEnd(10)} ${r.car.padEnd(24)} ${r.total == null ? 'DNF     ' : (r.total * H).toFixed(3) + ' s'} laps ${r.laps.map((x) => (x * H).toFixed(3)).join(' ')}  at s=${c.veh.state.trackS.toFixed(2)} (${p.x.toFixed(2)}, ${p.y.toFixed(2)}, ${p.z.toFixed(2)})`);
  }
  console.log(`  contact: ${contact.touches} touching pair-passes, ${contact.hits} hits vs live ${end.contact ? `${end.contact.touches}, ${end.contact.hits}` : '-'}: ${sameContact ? 'MATCH' : 'DIFFER'}`);
  const touched = logged.filter((l) => l.c || l.pc).length;
  console.log(`  laps: ${logged.length} with contact flags (${touched} touched another car), ${lapsBad.length ? `${lapsBad.length} DIFFER` : 'MATCH'}`);
  console.log(`  results ${same ? 'MATCH' : 'DIFFER'} the live race; state hash ${hash} vs live ${end.hash}: ${hash === end.hash ? 'MATCH' : 'DIFFER'}`);
  if (!same || hash !== end.hash || !sameContact || lapsBad.length) bad++;
}
process.exit(bad ? 1 : 0);
