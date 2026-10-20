// The landing's pictures, rendered from the game itself into src/home/img/ (the dev server must be running):
//   cars    every modelled car on the landing's turntable at its first frame (stills.html), transparent:
//           car-<id>-1440.webp and car-<id>-640.webp - the hero's still under the 3D, and the garage's cards
//   tracks  each course from the air (the drive page, the race held a few seconds in, the camera placed by
//           __drive.shot over the course's middle - VIEWS below - with the fog pushed back for the distance):
//           track-<id>-1600.webp and track-<id>-800.webp
// usage: node scripts/render-home.mjs [cars] [tracks] [only=<car id>]   (BASE=http://localhost:<port>/ for another server)
import { chromium } from 'playwright';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const args = process.argv.slice(2);
const want = (k) => !args.some((a) => a === 'cars' || a === 'tracks') || args.includes(k);
const only = args.find((a) => a.startsWith('only='))?.slice(5);
const base = process.env.BASE ?? 'http://localhost:5199/';
const out = new URL('../src/home/img/', import.meta.url).pathname;
mkdirSync(out, { recursive: true });
/** goto, again if the dev server reloads the page under it (a dependency it just optimised, a file it saw change) */
async function open(page, url, ready = () => window.__ready === true) {
  for (let i = 0; ; i++) {
    try {
      await page.goto(url);
      await page.waitForFunction(ready, null, { timeout: 90000 });
      return;
    } catch (e) {
      if (i >= 2) throw e;
      await page.waitForTimeout(1500);
    }
  }
}
const save = (name, dataUrl) => {
  const b = Buffer.from(dataUrl.split(',')[1], 'base64');
  writeFileSync(`${out}${name}.webp`, b);
  console.log(`  ${name}.webp ${(b.length / 1024).toFixed(0)} KB`);
};

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-angle=metal', '--enable-gpu', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));

if (want('cars')) {
  const { cars } = JSON.parse(readFileSync(new URL('../../asset-generation/assets/cars/index.json', import.meta.url), 'utf8'));
  for (const c of cars.filter((x) => x.modelled && (!only || x.id === only))) {
    console.log(c.id);
    await page.setViewportSize({ width: 1440, height: 900 });
    await open(page, `${base}stills.html?car=${c.id}`);
    await page.waitForTimeout(400);
    save(`car-${c.id}-1440`, await page.evaluate(() => window.__still(0.86)));
    save(`car-${c.id}-640`, await page.evaluate(() => window.__still(0.84, 640)));
  }
}

// Each course's view from the air: [azimuth deg (0 = from +z, 180 = from -z), elevation deg, distance u, fov deg,
// target offset x, z from the course's middle (u)] and the fog's near / far for it (the chase camera's fog would wash
// the whole course out from up there). The middle is the course's bounds, so a re-laid course stays framed.
const VIEWS = {
  meadow: { view: [180, 50, 470, 40, 0, -70], fog: [450, 1800] }, // from the south, steep: the start, the pond, the big jump, the loop, the road north
  sky: { view: [180, 52, 560, 38, 0, -20], fog: [450, 1900] }, // from the south: the tower, both loops, the bridge, the spiral, the pond
  touge: { view: [220, 40, 560, 40, 0, 0], fog: [500, 1900] }, // from inland: the switchbacks below, the village, the coast and the sea
};
const AT = 4; // s into the race: the field (the car) just off the line
if (want('tracks')) {
  const { buildTrack } = await import('../src/drive/tracks/index.ts');
  for (const [id, v] of Object.entries(VIEWS)) {
    if (only && only in VIEWS && only !== id) continue; // (only=<course id>: that course alone)
    console.log(id, v);
    let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    for (const f of buildTrack(id).frames) {
      x0 = Math.min(x0, f.p.x), x1 = Math.max(x1, f.p.x), y0 = Math.min(y0, f.p.y), y1 = Math.max(y1, f.p.y), z0 = Math.min(z0, f.p.z), z1 = Math.max(z1, f.p.z);
    }
    const [az, el, dist, fov, dx, dz] = v.view, a = (az * Math.PI) / 180, e = (el * Math.PI) / 180;
    const t = [(x0 + x1) / 2 + dx, (y0 + y1) / 2, (z0 + z1) / 2 + dz];
    const p = [t[0] + dist * Math.cos(e) * Math.sin(a), t[1] + dist * Math.sin(e), t[2] + dist * Math.cos(e) * Math.cos(a)];
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, `${base}drive.html?track=${id}&car=skyline-hck01&auto=1&laps=3`);
    await page.addStyleTag({ content: '#nav, #hud, #boot { display: none !important; }' });
    await page.keyboard.press('Enter');
    await page.waitForFunction((at) => window.__drive.time >= at, AT, { timeout: 180000, polling: 16 });
    // hold the race, place the camera, let it render, then hold the frame
    await page.evaluate(([p, t, fov, fog]) => (window.__drive.timeScale(0), (window.__drive.shot = { p, t, fov, fog })), [p, t, fov, v.fog]);
    await page.waitForTimeout(400);
    await page.evaluate(() => (window.__drive.frozen = true));
    await page.waitForTimeout(100);
    const png = (await page.screenshot({ type: 'png' })).toString('base64');
    const webp = (w, q) => page.evaluate(([png, w, q]) => new Promise((res) => {
      const img = new Image();
      img.onload = () => {
        const c = document.createElement('canvas');
        c.width = w;
        c.height = Math.round((w * img.height) / img.width);
        const g = c.getContext('2d');
        g.imageSmoothingQuality = 'high';
        g.drawImage(img, 0, 0, c.width, c.height);
        res(c.toDataURL('image/webp', q));
      };
      img.src = `data:image/png;base64,${png}`;
    }), [png, w, q]);
    save(`track-${id}-1600`, await webp(1600, 0.8));
    save(`track-${id}-800`, await webp(800, 0.8));
  }
}
await browser.close();
