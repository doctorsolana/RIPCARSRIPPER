// The site's own pictures, into static/ (served at the site's root): the favicon PNGs from static/favicon.svg (16, 32,
// the apple-touch-icon 180, the manifest's 192 and 512, a maskable 512 with room around the mark), and the link preview
// og.jpg (1200 x 630: the featured car's render from the landing - src/home/img - and the wordmark). Needs the dev
// server for the fonts and the render. usage: node scripts/render-site.mjs   (BASE=http://localhost:<port>/)
import { chromium } from 'playwright';
import { readFileSync, writeFileSync } from 'node:fs';

const base = process.env.BASE ?? 'http://localhost:5199/';
const dir = new URL('../static/', import.meta.url).pathname;
const svg = readFileSync(`${dir}favicon.svg`, 'utf8');
const svgUrl = `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;
const browser = await chromium.launch({ channel: process.env.PW_CHANNEL ?? 'chrome' });

for (const [name, size, pad] of [['favicon-16.png', 16, 0], ['favicon-32.png', 32, 0], ['apple-touch-icon.png', 180, 0], ['icon-192.png', 192, 0], ['icon-512.png', 512, 0], ['icon-maskable-512.png', 512, 0.1]]) {
  const p = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
  // (maskable: the platform cuts its own shape - the mark in the middle 80% on the brand's pink)
  await p.setContent(`<body style="margin:0;background:${pad ? '#ff3d6e' : 'transparent'}"><img src="${svgUrl}" style="display:block;width:${size * (1 - 2 * pad)}px;height:${size * (1 - 2 * pad)}px;margin:${size * pad}px"></body>`);
  await p.waitForTimeout(100);
  writeFileSync(`${dir}${name}`, await p.screenshot({ omitBackground: !pad }));
  await p.close();
  console.log(name);
}

// the link preview: the car on the landing's stage, the wordmark
const p = await browser.newPage({ viewport: { width: 1200, height: 630 }, deviceScaleFactor: 1 });
await p.goto(`${base}404.html`); // (any page of the site: its fonts and the car's render resolve)
const car = await p.evaluate(async () => {
  const m = await import('/src/home/tracks.ts');
  return m.carImg('skyline-hck01')?.big;
});
await p.setContent(`<!doctype html><html><head><link href="https://fonts.googleapis.com/css2?family=Anton&display=swap" rel="stylesheet"></head>
<body style="margin:0;width:1200px;height:630px;overflow:hidden;background:radial-gradient(60% 80% at 62% 55%, #23263a 0%, #0d0e12 70%);position:relative">
  <div style="position:absolute;left:50%;top:44%;transform:translate(-50%,-50%);font:400 330px/1 Anton;letter-spacing:0.02em;color:transparent;-webkit-text-stroke:2px rgba(255,255,255,0.07);white-space:nowrap">RACECARS</div>
  <div style="position:absolute;left:260px;right:120px;bottom:120px;height:120px;border-radius:50%;background:radial-gradient(50% 50% at 50% 50%, rgba(255,61,110,0.38), rgba(255,61,110,0) 72%);filter:blur(12px)"></div>
  <img src="${base.replace(/\/$/, '')}${car}" style="position:absolute;left:330px;top:40px;width:860px">
  <div style="position:absolute;left:70px;bottom:64px;font:400 104px/1 Anton;letter-spacing:0.04em;color:#fff">RACECARS</div>
  <div style="position:absolute;left:74px;bottom:178px;width:64px;height:8px;border-radius:4px;background:#ff3d6e"></div>
</body></html>`, { waitUntil: 'networkidle' });
await p.evaluate(() => document.fonts.ready);
await p.waitForTimeout(400);
writeFileSync(`${dir}og.jpg`, await p.screenshot({ type: 'jpeg', quality: 88 }));
console.log('og.jpg');
await browser.close();
