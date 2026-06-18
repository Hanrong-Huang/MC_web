import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5226 } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.goto('http://localhost:5226/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button',{hasText:'Creative'}).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden',{timeout:60000,state:'attached'});
await page.waitForTimeout(2000);
await page.mouse.click(640,360);
async function shot(kinds, name){
  await page.evaluate((kinds)=>{
    const g=window.__game, B=window.__B, w=g.world;
    for (const e of g.entities.entities) if (g.entities.isMob(e)) e.dead = true;
    const Y=110, cx=Math.round(g.player.pos.x), cz=Math.round(g.player.pos.z);
    const z=cz-2;
    for (let dx=-7;dx<=7;dx++) for (let dz=-2;dz<=4;dz++) w.setBlock(cx+dx, Y-1, z+dz, B.STONE);
    for (let i=0;i<kinds.length;i++){
      const x = cx - (kinds.length-1)*1.0 + i*2.0;
      const m = g.entities.spawnMob(kinds[i], x, Y, z);
      m.tamed=false; m.sitting=false; m.yaw=0.45; m.pos.y=Y; m.vel={x:0,y:0,z:0};
    }
    const p=g.player; p.pos.x=cx; p.pos.y=Y-0.5; p.pos.z=z+4.5; p.vel={x:0,y:0,z:0}; p.yaw=0; p.pitch=-0.12; p.flying=true;
  }, kinds);
  await page.waitForTimeout(150);
  await page.screenshot({ path: `shot-lineup-${name}.png` });
}
await shot(['pig','cow','sheep','chicken'], 'farm');
await shot(['zombie','skeleton','creeper','spider'], 'hostile');
await shot(['villager','horse','wolf','cat'], 'misc');
await shot(['cinderling','ashstalker'], 'nether');
console.log(errors.length?errors.slice(0,5).join('\n'):'NONE');
await browser.close(); await server.close(); process.exit(0);
