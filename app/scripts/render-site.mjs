// The site's own pictures, into static/ (served at the site's root): the icons - the start light of the wordmark,
// upright: two lamps out, the last one green - and the link preview og.jpg (1200 x 630: the featured car's render from
// the landing - src/home/img - and the wordmark, src/brand.ts). The small ones (16, 32) come from static/favicon.svg,
// drawn on a 16 px grid so its lamps land on whole pixels; the big ones (the apple-touch-icon 180, the manifest's 192
// and 512, a maskable 512 with the light inside the middle 80%) from ICON below, with more room around the lamps.
// Needs the dev server for the render. usage: node scripts/render-site.mjs   (BASE=http://localhost:<port>/)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.env.BASE ?? 'http://localhost:5199/';
const dir = new URL('../static/', import.meta.url).pathname;
const svgUrl = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const FAVICON = readFileSync(`${dir}favicon.svg`, 'utf8');
const BG = '#111';
const LAMPS = (s) => `<circle cx="32" cy="${32 - 17 * s}" r="${7 * s}" fill="#333"/><circle cx="32" cy="32" r="${7 * s}" fill="#333"/><circle cx="32" cy="${32 + 17 * s}" r="${7 * s}" fill="#3dff8b"/>`;
/** The big icon: rounded (rx), or a full square for the platforms that cut their own shape (apple-touch, maskable). */
const ICON = (rx, s = 1) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64"><rect width="64" height="64" rx="${rx}" fill="${BG}"/>${LAMPS(s)}</svg>`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });

// (apple-touch-icon: iOS rounds it itself and shows black in any see-through corner, so a full square; maskable: the
//  platform cuts its own shape too, the lamps scaled into its safe zone, the circle of 40% radius)
for (const [name, size, svg] of [['favicon-16.png', 16, FAVICON], ['favicon-32.png', 32, FAVICON], ['apple-touch-icon.png', 180, ICON(0)], ['icon-192.png', 192, ICON(14)], ['icon-512.png', 512, ICON(14)], ['icon-maskable-512.png', 512, ICON(0, 0.8)]]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  await p.setContent(`<body style="margin:0;background:transparent"><img src="${svgUrl(svg)}" style="display:block;width:${size}px;height:${size}px"></body>`);
  await p.waitForTimeout(100);
  writeFileSync(`${dir}${name}`, await p.screenshot({ omitBackground: true }));
  await p.close();
  console.log(name);
}

// the link preview: the car on the landing's stage, the wordmark
const p = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.goto(`${base}404.html`); // (any page of the site: the car's render and the brand module resolve)
const [car, wordmark] = await p.evaluate(async () => {
  const [t, b] = await Promise.all([import('/src/home/tracks.ts'), import('/src/brand.ts')]);
  return [t.carImg('skyline-hck01')?.big, b.WORDMARK];
});
await p.setContent(`<!doctype html><html><head></head>
<body style="margin:0;width:1200px;height:630px;overflow:hidden;background:radial-gradient(60% 80% at 62% 55%, #1f2229 0%, #0b0c10 70%);position:relative">
  <div style="position:absolute;left:260px;right:120px;bottom:120px;height:120px;border-radius:50%;background:radial-gradient(50% 50% at 50% 50%, rgba(61,255,139,0.22), rgba(61,255,139,0) 72%);filter:blur(12px)"></div>
  <img src="${base.replace(/\/$/, '')}${car}" style="position:absolute;left:330px;top:30px;width:860px">
  <div style="position:absolute;left:72px;bottom:78px;color:#fff">${wordmark.replace('class="rc-wm"', 'style="display:block;height:52px;width:458px"')}</div>
</body></html>`, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);
writeFileSync(`${dir}og.jpg`, await p.screenshot({ type: 'jpeg', quality: 88 }));
console.log('og.jpg');
await browser.close();
