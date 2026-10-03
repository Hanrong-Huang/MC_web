// One-off: render the home-screen / install icons (public/icons/*.png) from
// the favicon's pixel-art grass block. `node icon-gen.mjs`
import { chromium } from 'playwright';
import { mkdirSync } from 'fs';

const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' shape-rendering='crispEdges'>
<rect width='16' height='16' fill='#79553a'/><rect width='16' height='5' fill='#5d9b3d'/>
<rect x='2' y='5' width='2' height='2' fill='#5d9b3d'/><rect x='9' y='5' width='3' height='1' fill='#5d9b3d'/>
<rect x='13' y='5' width='1' height='2' fill='#5d9b3d'/><rect x='6' y='5' width='1' height='1' fill='#5d9b3d'/>
<rect x='1' y='1' width='1' height='1' fill='#4a8530'/><rect x='5' y='2' width='1' height='1' fill='#72b04e'/>
<rect x='11' y='1' width='1' height='1' fill='#72b04e'/><rect x='8' y='3' width='1' height='1' fill='#4a8530'/>
<rect x='14' y='2' width='1' height='1' fill='#4a8530'/>
<rect x='5' y='9' width='2' height='2' fill='#604030'/><rect x='11' y='11' width='2' height='2' fill='#604030'/>
<rect x='2' y='13' width='1' height='1' fill='#8a6444'/><rect x='9' y='8' width='1' height='1' fill='#8a6444'/>
<rect x='13' y='8' width='1' height='1' fill='#604030'/><rect x='7' y='13' width='2' height='1' fill='#604030'/>
</svg>`;

mkdirSync('public/icons', { recursive: true });
const browser = await chromium.launch({ channel: 'msedge' });
for (const [name, size] of [['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
  const page = await browser.newPage({ viewport: { width: size, height: size } });
  await page.setContent(`<body style="margin:0"><img style="display:block;width:${size}px;height:${size}px;image-rendering:pixelated" src="data:image/svg+xml,${encodeURIComponent(svg)}"></body>`);
  await page.waitForTimeout(200);
  await page.screenshot({ path: `public/icons/${name}` });
  await page.close();
}
await browser.close();
console.log('icons written');
