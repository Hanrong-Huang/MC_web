import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5242 } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader','--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text())}); page.on('pageerror',e=>errors.push('PAGEERROR: '+e.message));
await page.goto('http://localhost:5242/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button',{hasText:'Creative'}).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden',{timeout:60000,state:'attached'});
await page.waitForTimeout(1500);
await page.mouse.click(640,360);
const res = await page.evaluate(()=>{
  const a = window.__game.audio;
  a.ensure();
  const out = { state: a.ctx ? a.ctx.state : 'no-ctx', fired: 0 };
  // force-fire every env's atmosphere cue several times
  for (const env of ['day','night','cave','nether']) {
    for (let i=0;i<6;i++){ a.atmosphereT = 0; a.ambientTick(0.016, env); out.fired++; }
  }
  // also the heartbeat at low health
  for (let i=0;i<5;i++) a.heartbeatTick(0.2, 0.1);
  return out;
});
await page.waitForTimeout(800);
console.log('audio:', JSON.stringify(res));
console.log(errors.length?errors.slice(0,8).join('\n'):'NONE');
await browser.close(); await server.close(); process.exit(0);
