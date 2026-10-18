// Screenshot the reveal (rip.html) or a review page in headless Chrome (the dev server must be running).
// usage: node scripts/shoot.mjs <outDir> <W>x<H> name:target [name:target ...]
//   target is a reveal query, or a review page with its query (captured full-page):
//     "spin:car=skyline-hck01&t=5"   "land:car=skyline-hck01&mode=final&card=0.6"
//     "cmp:compare.html?car=skyline-hck01&m=snapshot-a,current&view=-2.4,0.9,5.2"
//     "views:views.html?car=skyline-hck01"
import { chromium } from 'playwright';
import { mkdirSync } from 'node:fs';

const [outDir, size, ...shots] = process.argv.slice(2);
const [width, height] = size.split('x').map(Number);
const base = process.env.BASE ?? 'http://localhost:5199/';
mkdirSync(outDir, { recursive: true });

const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] });
const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
page.on('pageerror', (e) => console.error('pageerror:', e.message));
page.on('console', (m) => m.type() === 'error' && !m.text().includes('404') && console.error('console:', m.text()));
for (const shot of shots) {
  const [name, target] = shot.split(/:(.*)/s);
  const review = /^[\w-]+\.html/.test(target);
  await page.goto(base + (review ? target : `rip.html?${target}`));
  await page.waitForFunction(() => window.__ready === true, null, { timeout: 90000 });
  await page.waitForTimeout(review ? 1500 : 250); // review pages: let every model's textures decode
  await page.screenshot({ path: `${outDir}/${name}.png`, fullPage: review });
  console.log('saved', `${outDir}/${name}.png`);
}
await browser.close();
