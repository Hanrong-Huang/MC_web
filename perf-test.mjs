import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5221 } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.goto('http://localhost:5221/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button',{hasText:'Creative'}).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden',{timeout:60000,state:'attached'});
await page.waitForTimeout(2000);
// enable flying and fly forward to stream/mesh many chunks
await page.evaluate(()=>{ const g=window.__game; g.player.flying=true; g.player.mode='creative'; });
const samples=[];
for (let i=0;i<10;i++){
  await page.evaluate(()=>{ const g=window.__game; g.player.pos.x += 24; g.player.vel.x=0; }); // jump 1.5 chunks
  await page.waitForTimeout(900);
  const s = await page.evaluate(()=>({ meshMs: window.__game.meshMs, dirty: window.__game.world.dirtySet.size, loaded: window.__game.world.countLoaded(), fps: window.__game.fps }));
  samples.push(s);
}
// also measure raw mesher cost over N chunks via direct timing isn't exposed; report EMA
const last = samples[samples.length-1];
const maxMesh = Math.max(...samples.map(s=>s.meshMs));
console.log('samples:', JSON.stringify(samples.map(s=>({mesh:+s.meshMs.toFixed(2), dirty:s.dirty, fps:+s.fps.toFixed(0)}))));
console.log('meshMs max EMA:', maxMesh.toFixed(2), 'final dirty:', last.dirty, 'loaded:', last.loaded);
console.log(errors.length?errors.slice(0,5).join('\n'):'NONE');
await browser.close(); await server.close(); process.exit(0);
