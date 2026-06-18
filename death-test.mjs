import { chromium } from 'playwright';
import { createServer } from 'vite';
const server = await createServer({ root: process.cwd(), server: { port: 5230 } });
await server.listen();
const browser = await chromium.launch({ channel: 'msedge', headless: true, args: ['--use-angle=swiftshader','--enable-unsafe-swiftshader'] });
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors=[]; page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
await page.goto('http://localhost:5230/#debugmobs');
await page.waitForTimeout(1000);
await page.locator('.mode-pick button',{hasText:'Survival'}).click();
await page.locator('.create-btn').click();
await page.waitForSelector('#loading.hidden',{timeout:60000,state:'attached'});
await page.waitForTimeout(2500);
await page.mouse.click(640,360);
// teleport to nether, then kill the player, then respawn and check dimension
await page.evaluate(()=>{ window.__game.teleportPlayerDimension(); });
await page.waitForTimeout(3000);
const dimInNether = await page.evaluate(()=> window.__game.world.dimension);
await page.evaluate(()=>{ const g=window.__game; g.player.mode='survival'; g.player.hurtCooldown=0; g.player.damage(100); });
await page.waitForTimeout(500);
// click the respawn button
await page.locator('#death-overlay button, .death button, button:has-text("Respawn")').first().click().catch(()=>{});
await page.waitForTimeout(2500);
const after = await page.evaluate(()=>({ dim: window.__game.world.dimension, y: window.__game.player.pos.y, feet: window.__game.world.getBlock(Math.floor(window.__game.player.pos.x), Math.floor(window.__game.player.pos.y)-1, Math.floor(window.__game.player.pos.z)) }));
console.log('dim in nether before death:', dimInNether);
console.log('after respawn:', JSON.stringify(after));
console.log(errors.length?errors.slice(0,5).join('\n'):'NONE');
await browser.close(); await server.close(); process.exit(0);
