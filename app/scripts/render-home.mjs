// The landing's pictures, rendered from the game itself into src/home/img/ (the dev server must be running):
//   cars    every modelled car on the landing's turntable at its first frame (stills.html), transparent:
//           car-<id>-1440.webp and car-<id>-640.webp - the hero's still under the 3D, and the garage's cards
//   tracks  a frame of the drive page on each course, the autopilot driving, at a moment picked per course (below):
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

// Each course's moment: the car and the race time to freeze at (s from the drop; the autopilot drives, the camera frames
// it): the meadow's big jump in its side-on "ad" shot, the Sky Tower's sky jump by its hoop, the Touge's tunnel jump out
// over its switchbacks. MEADOW_AT / SKY_AT / TOUGE_AT to try others (0 skips that course).
const SHOTS = { meadow: { car: 'skyline-hck01', at: Number(process.env.MEADOW_AT ?? 43.2) }, sky: { car: 'skyline-hck01', at: Number(process.env.SKY_AT ?? 57.3) },
  touge: { car: 'skyline-hck01', at: Number(process.env.TOUGE_AT ?? 22.9) } };
if (want('tracks')) {
  for (const [id, s] of Object.entries(SHOTS)) {
    if (!s.at) continue;
    console.log(id, s);
    await page.setViewportSize({ width: 1600, height: 900 });
    await open(page, `${base}drive.html?track=${id}&car=${s.car}&auto=1&laps=3`);
    await page.addStyleTag({ content: '#nav, #hud, #boot { display: none !important; }' });
    // run the race on to the moment (the sim at real time, timed by the page's own race clock), then hold the frame
    await page.waitForFunction((at) => window.__drive.time >= at, s.at, { timeout: 180000, polling: 16 });
    await page.evaluate(() => ((window.__drive.frozen = true), window.__drive.timeScale(0)));
    await page.waitForTimeout(300);
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
