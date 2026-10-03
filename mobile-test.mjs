// Mobile (touch) harness: boots the game as a landscape phone (touch events,
// coarse pointer) and drives the Bedrock-style controls with real multi-touch
// events through CDP — stick, look-drag, tap-to-place at the finger, hold to
// break, tap a mob to hit it, the context button, jump / sneak / flight, the
// hotbar (hold to drop, "…"), inventory double-tap quick-move, chat, pause,
// Touch Controls options (D-pad), the portrait hint, and the switch to mouse
// + keyboard and back. Asserts each step; screenshots unless NO_SHOTS=1.
// Env: PORT (5201), SHOT_DIR (.), VW/VH (844×390).
import { chromium } from 'playwright';
import { createServer } from 'vite';

const PORT = +(process.env.PORT ?? 5201);
const DIR = process.env.SHOT_DIR ?? '.';
const W = +(process.env.VW ?? 844), H = +(process.env.VH ?? 390);
const SHOTS = !process.env.NO_SHOTS;
const server = await createServer({ root: process.cwd(), server: { port: PORT, strictPort: true }, logLevel: 'warn' });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
const page = await ctx.newPage();
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));
const cdp = await ctx.newCDPSession(page);

let failed = 0;
const check = (name, ok, extra = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${extra ? ` (${extra})` : ''}`);
  if (!ok) failed++;
};
const shot = async (n) => { if (SHOTS) await page.screenshot({ path: `${DIR}/shot-mobile-${n}.png` }); };
const wait = (ms) => page.waitForTimeout(ms);
const g = (fn, arg) => page.evaluate(fn, arg);
/** Poll a page condition (SwiftShader frames are slow; state changes land a frame later). */
const until = (fn, ms = 4000, arg) => page.waitForFunction(fn, arg, { timeout: ms }).then(() => true, () => false);

// --- multi-touch through CDP: every event lists all fingers still down
const fingers = new Map();
// `ts` (seconds since the epoch) stamps an event: the game times taps and
// double-taps by event timestamps, and SwiftShader frames are slow enough
// that wall-clock gaps between CDP calls would read as holds
const sendTouch = (type, ts) => cdp.send('Input.dispatchTouchEvent', {
  type, touchPoints: [...fingers.values()].map((p) => ({ x: p.x, y: p.y, id: p.id, radiusX: 4, radiusY: 4, force: 1 })),
  ...(ts ? { timestamp: ts } : {}),
});
async function down(id, x, y, ts) { fingers.set(id, { id, x, y }); await sendTouch('touchStart', ts); }
async function move(id, x, y) { fingers.set(id, { id, x, y }); await sendTouch('touchMove'); }
async function up(id, ts) {
  fingers.delete(id);
  // touchEnd lists the remaining fingers; the lifted one is implied
  await cdp.send('Input.dispatchTouchEvent', {
    type: 'touchEnd', touchPoints: [...fingers.values()].map((q) => ({ x: q.x, y: q.y, id: q.id })),
    ...(ts ? { timestamp: ts } : {}),
  });
}
/** A quick tap (60 ms by its timestamps); `t0` chains taps into a double-tap. */
async function tap(x, y, id = 9, t0 = Date.now() / 1000) {
  // fire both without waiting on the first ack, so a slow frame can't land
  // between them and turn the tap into a hold
  await Promise.all([down(id, x, y, t0), up(id, t0 + 0.06)]);
  return t0;
}
/** Press for `ms` of wall time from the moment the press is sent (not from its
 *  slow SwiftShader ack), then lift. */
async function holdFor(id, x, y, ms) {
  const d = down(id, x, y);
  await wait(ms);
  await Promise.all([d, up(id)]);
}
async function drag(id, x0, y0, x1, y1, steps = 12, ms = 240) {
  await down(id, x0, y0);
  for (let i = 1; i <= steps; i++) { await move(id, x0 + (x1 - x0) * i / steps, y0 + (y1 - y0) * i / steps); await wait(ms / steps); }
}
const center = async (sel) => {
  // a short phone has to scroll the title screen to reach some buttons
  await page.locator(sel).first().scrollIntoViewIfNeeded().catch(() => {});
  const b = await page.locator(sel).first().boundingBox();
  return b ? { x: b.x + b.width / 2, y: b.y + b.height / 2 } : null;
};
async function tapEl(sel) { const c = await center(sel); if (!c) throw new Error(`no ${sel}`); await tap(c.x, c.y); }

// --- boot
// spy on fullscreen requests (stubbed: a real headless fullscreen would resize the
// viewport under the test) and the share sheet the phone screenshot uses
await page.addInitScript(() => {
  window.__fsCalls = 0;
  Element.prototype.requestFullscreen = function () { window.__fsCalls++; return Promise.resolve(); };
  navigator.canShare = () => true;
  navigator.share = async (d) => { window.__shared = d.files?.[0]?.name ?? 'none'; };
});
await page.goto(`http://localhost:${PORT}/#dev-nointro`);
await page.waitForSelector('.create-btn', { timeout: 30000 });
await wait(1200);
check('starts in touch layout', await g(() => document.documentElement.classList.contains('touch-ui')));
check('title help shows touch gestures', /Hold/.test(await page.locator('.menu-help').innerText()));
await shot('title');
check('nothing asks for fullscreen before a touch', await g(() => window.__fsCalls === 0));
await tapEl('.create-btn');
check('first lifted finger asks for fullscreen', await until(() => window.__fsCalls === 1, 3000));
await page.waitForSelector('#loading.hidden', { timeout: 120000, state: 'attached' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
await wait(1500);
check('touch overlay visible', await g(() => !document.getElementById('touch-controls').classList.contains('hidden')));
check('no pointer lock on touch', await g(() => !window.__game.input.pointerLocked));
await shot('hud');

// --- a stone test arena at y=108, player facing -z, creative
await g(() => {
  const gm = window.__game, B = window.__B;
  const p = gm.player;
  // the arena stays inside one chunk (a cell in a chunk still generating is lost)
  const ox = Math.floor(p.pos.x / 16) * 16, oz = Math.floor(p.pos.z / 16) * 16;
  const cx = ox + 8, cz = oz + 12;
  for (let x = ox; x < ox + 16; x++) for (let z = oz; z < oz + 16; z++) {
    gm.world.setBlock(x, 108, z, B.STONE);
    for (let y = 109; y <= 116; y++) gm.world.setBlock(x, y, z, B.AIR);
  }
  p.pos = { x: cx + 0.5, y: 109.01, z: cz + 0.5 };
  p.fallDist = 0;
  p.vel = { x: 0, y: 0, z: 0 };
  p.flying = false;
  p.mode = 'creative';
  p.yaw = 0; p.pitch = -0.75;
  p.inventory.selected = 0;
  p.inventory.slots[0] = { id: B.DIRT, count: 64 };
  p.inventory.slots[1] = { id: window.__findId('diamond_sword'), count: 1 };
  p.inventory.slots[2] = { id: window.__findId('wheat'), count: 32 };
  p.inventory.slots[3] = { id: B.COBBLE, count: 40 };
  p.inventory.slots[9] = { id: B.PLANKS, count: 20 };
  for (let i = 4; i < 9; i++) p.inventory.slots[i] = null;
  p.inventory.onChange();
  window.__arena = { cx, cz, ox, oz };
});
await page.waitForFunction(() => window.__game.world.getBlock(window.__arena.cx, 108, window.__arena.cz) > 0, null, { timeout: 20000 });
// stand on the platform (re-placed each poll: a chunk installing under us can reset it)
await page.waitForFunction(() => {
  const p = window.__game.player, a = window.__arena;
  if (Math.abs(p.pos.y - 109) > 0.05 || Math.abs(p.pos.x - a.cx - 0.5) > 0.05) {
    p.pos = { x: a.cx + 0.5, y: 109.01, z: a.cz + 0.5 }; p.vel = { x: 0, y: 0, z: 0 }; p.fallDist = 0;
    return false;
  }
  return p.onGround;
}, null, { timeout: 20000, polling: 300 });
await wait(800);
console.log('arena', JSON.stringify(await g(() => ({ a: window.__arena, pos: window.__game.player.pos }))));

// --- look: drag on the right half turns the camera (survival: a slow frame
// letting the hold timer win can't instantly break the floor)
await g(() => { window.__game.player.mode = 'survival'; });
let yaw0 = await g(() => window.__game.player.yaw);
await drag(1, W * 0.7, H * 0.4, W * 0.7 - 120, H * 0.4, 10, 200);
await up(1);
await wait(150);
let yaw1 = await g(() => window.__game.player.yaw);
check('a new world asks for fullscreen again on the next lift (once)', await g(() => window.__fsCalls === 2), String(await g(() => window.__fsCalls)));
check('drag-to-look turns the camera', Math.abs(yaw1 - yaw0) > 0.15, `Δyaw ${(yaw1 - yaw0).toFixed(2)}`);
check('a look-drag places nothing', await g(() => window.__game.player.inventory.slots[0].count === 64));
await g(() => { window.__game.player.mode = 'creative'; });
const resetView = (pitch = -0.75) => g((pt) => { const gm = window.__game; gm.input.consumeMouse(); gm.player.yaw = 0; gm.player.pitch = pt; }, pitch);
await wait(300);
await resetView();
await wait(100);

// --- tap acts where the finger is: predict the block under the finger, tap, see dirt on it
const tapPt = { x: W * 0.68, y: H * 0.62 };
const predicted = await g(({ x, y, W, H }) => {
  const gm = window.__game;
  gm.input.aimNDC = { x: (x / W) * 2 - 1, y: 1 - (y / H) * 2 };
  const d = gm.player.aimDir();
  gm.input.aimNDC = null;
  const p = gm.player.pos;
  const hit = gm.world.raycast(p.x, p.y + gm.player.eyeHeight(), p.z, d.x, d.y, d.z, 4.5);
  return hit && { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
}, { ...tapPt, W, H });
const centreCell = await g(() => {
  const gm = window.__game; const d = gm.player.lookDir(); const p = gm.player.pos;
  const hit = gm.world.raycast(p.x, p.y + gm.player.eyeHeight(), p.z, d.x, d.y, d.z, 4.5);
  return hit && { x: hit.x + hit.nx, y: hit.y + hit.ny, z: hit.z + hit.nz };
});
check('finger ray differs from the crosshair ray', !!predicted && !!centreCell &&
  (predicted.x !== centreCell.x || predicted.z !== centreCell.z), JSON.stringify({ predicted, centreCell }));
// survival for the tap: should a slow SwiftShader frame land mid-tap and
// start a hold, a creative hold would break the floor before the lift undoes it
await g(() => { window.__game.player.mode = 'survival'; });
await tap(tapPt.x, tapPt.y);
await wait(400);
await page.waitForFunction((c) => window.__game.world.getBlock(c.x, c.y, c.z) !== 0, predicted, { timeout: 5000 }).catch(() => {});
const placedId = await g((c) => window.__game.world.getBlock(c.x, c.y, c.z), predicted);
await g(() => { window.__game.player.mode = 'creative'; });
check('tap places a block under the finger', placedId === (await g(() => window.__B.DIRT)), `id ${placedId}`);
check('no block at the crosshair instead', (await g((c) => window.__game.world.getBlock(c.x, c.y, c.z), centreCell)) === 0);
check('outline hidden between touches (tap aim)', await page.waitForFunction(() => window.__game.player.target === null, null, { timeout: 4000 }).then(() => true, () => false));

// --- hold breaks what is under the finger
await down(2, tapPt.x, tapPt.y);
await wait(700);
const ringShown = await g(() => !document.querySelector('#touch-controls .touch-ring').classList.contains('hidden'));
await up(2);
await wait(250);
check('hold breaks the block under the finger', (await g((c) => window.__game.world.getBlock(c.x, c.y, c.z), predicted)) === 0);
void ringShown; // creative breaks instantly, so the ring may not get to show

// --- survival hold: the progress ring follows the finger, then the block goes
await g((c) => { const gm = window.__game; gm.world.setBlock(c.x, c.y, c.z, window.__B.DIRT); gm.player.mode = 'survival'; gm.onInventoryChange?.(); }, predicted);
await wait(150);
await down(2, tapPt.x, tapPt.y);
const ring2 = await page.waitForFunction(() => !document.querySelector('#touch-controls .touch-ring').classList.contains('hidden'), null, { timeout: 5000 }).then(() => true, () => false);
await page.waitForFunction((c) => window.__game.world.getBlock(c.x, c.y, c.z) === 0, predicted, { timeout: 8000 }).catch(() => {});
await up(2);
check('survival hold shows the breaking ring', ring2);
check('survival hold breaks the block', (await g((c) => window.__game.world.getBlock(c.x, c.y, c.z), predicted)) === 0);
await g(() => { window.__game.player.mode = 'creative'; });
await shot('placed');

// --- stick: walk forward, rim push sprints
const startZ = await g(() => window.__game.player.pos.z);
await g(() => { const p = window.__game.player; p.pitch = 0; });
await drag(3, 110, H - 90, 110, H - 130, 6, 120);
await wait(900);
const walkZ = await g(() => window.__game.player.pos.z);
check('stick walks forward', startZ - walkZ > 0.8, `moved ${(startZ - walkZ).toFixed(2)}`);
await move(3, 110, H - 200);
check('stick to the rim sprints', await until(() => window.__game.player.sprinting));
await shot('stick');
await up(3);
check('stick released stops', await until(() => window.__game.input.moveAxis === null && Math.hypot(window.__game.player.vel.x, window.__game.player.vel.z) < 1.5));

// --- stick + look at once (two thumbs)
yaw0 = await g(() => window.__game.player.yaw);
await down(4, 110, H - 90);
await move(4, 110, H - 140);
await drag(5, W * 0.72, H * 0.35, W * 0.72 + 90, H * 0.35, 8, 200);
await up(5); await up(4);
yaw1 = await g(() => window.__game.player.yaw);
check('look while walking (multi-touch)', Math.abs(yaw1 - yaw0) > 0.1);

/** Back to the middle of the arena, standing still (the stick tests walk off it). */
const home = async () => {
  await g(() => {
    const gm = window.__game, p = gm.player, a = window.__arena, B = window.__B;
    for (let x = a.ox; x < a.ox + 16; x++) for (let z = a.oz; z < a.oz + 16; z++) {
      gm.world.setBlock(x, 108, z, B.STONE);
      for (let y = 109; y <= 116; y++) if (gm.world.getBlock(x, y, z)) gm.world.setBlock(x, y, z, B.AIR);
    }
    for (const e of gm.entities.entities) if (e.kind === 'drop') e.dead = true;
    p.pos = { x: a.cx + 0.5, y: 109.01, z: a.cz + 0.5 }; p.vel = { x: 0, y: 0, z: 0 }; p.fallDist = 0; p.flying = false;
    gm.input.consumeMouse(); p.yaw = 0;
  });
  await until(() => window.__game.player.onGround && !window.__game.player.swimming, 6000);
};

// --- jump double-tap flies (creative); the buttons turn into up/down
await home();
await g(() => { window.__game.player.flying = false; });
const jb = await center('.tb-jump');
{ const t0 = await tap(jb.x, jb.y); await tap(jb.x, jb.y, 9, t0 + 0.15); }
check('double-tap jump toggles flight', await until(() => window.__game.player.flying));
check('sneak becomes descend while flying', await until(() => document.querySelector('.tb-sneak').title === 'Descend'));
await tapEl('.tb-fly');
check('wings button toggles flight off', await until(() => !window.__game.player.flying));
await page.waitForFunction(() => window.__game.player.onGround, null, { timeout: 8000 }).catch(() => {});

// --- sneak is a toggle on the ground
await tapEl('.tb-sneak');
const sneakOn = await until(() => window.__game.player.sneaking);
if (!sneakOn) console.log('sneak debug', JSON.stringify(await g(() => { const gm = window.__game, t = gm.touch; return { fs: t.frameState, latched: t.sneakLatched, held: t.sneakHeld, keys: [...gm.input.keys], p: { fly: gm.player.flying, ground: gm.player.onGround, swim: gm.player.swimming, y: gm.player.pos.y, state: gm.state } }; })));
check('sneak toggles on', sneakOn);
await tapEl('.tb-sneak');
check('sneak toggles off', await until(() => !window.__game.player.sneaking));

// --- jump never sticks: a thumb drifting off the button before lifting, and
// a lift whose pointer event never arrives (iOS Safari can lose both); the
// "no fingers left" backstop must let go of it
{
  const jb2 = await center('.tb-jump');
  await down(11, jb2.x, jb2.y);
  check('jump held while pressed', await until(() => window.__game.input.keys.has('@jump')));
  await move(11, jb2.x - 160, jb2.y - 120); // drift over the look surface
  await up(11);
  check('jump lets go when the finger drifted off before lifting', await until(() => !window.__game.input.keys.has('@jump')));
  await g(() => {
    window.__swallow = (e) => { if (e.pointerType === 'touch') { e.stopImmediatePropagation(); window.removeEventListener('pointerup', window.__swallow, true); } };
    window.addEventListener('pointerup', window.__swallow, true);
  });
  await down(12, jb2.x, jb2.y);
  await until(() => window.__game.input.keys.has('@jump'));
  await up(12); // its pointerup is swallowed: only the touchend backstop is left
  check('jump lets go even when the lift event is lost', await until(() => !window.__game.input.keys.has('@jump') &&
    !document.querySelector('.tb-jump').classList.contains('held')));
  // land (game time runs slower than the wall clock here), then stay down: a
  // stuck jump key would launch the player again within a few frames
  const landed = await until(() => window.__game.player.onGround, 8000);
  await g(() => { window.__airborne = false; const p = window.__game.player; const tick = () => { if (!p.onGround) window.__airborne = true; window.__ab = requestAnimationFrame(tick); }; tick(); });
  await wait(1500);
  check('…and the player stops jumping', landed && await g(() => { cancelAnimationFrame(window.__ab); return !window.__airborne; }));
}

// --- mobs: context button when centred, tap on it to hit it
await g(() => {
  const gm = window.__game, p = gm.player, a = window.__arena;
  p.pos = { x: a.cx + 0.5, y: 109.01, z: a.cz + 0.5 }; p.vel = { x: 0, y: 0, z: 0 }; p.fallDist = 0;
  gm.input.consumeMouse(); p.yaw = 0; p.pitch = -0.3; // eyes above a cow's back: look down at it
  p.inventory.selected = 2; // wheat
  p.inventory.onChange();
  const cow = gm.entities.spawnMob('cow', p.pos.x, p.pos.y, p.pos.z - 2.2);
  cow.ai = 'idle'; cow.vel = { x: 0, y: 0, z: 0 };
  window.__cow = cow;
});
await wait(500);
await page.waitForFunction(() => !document.querySelector('.tb-ctx').classList.contains('hidden'), null, { timeout: 4000 }).catch(() => {});
const ctxText = await page.locator('.tb-ctx').innerText().catch(() => '');
if (!/Feed/.test(ctxText)) console.log('ctx debug', JSON.stringify(await g(() => { const gm = window.__game, p = gm.player, c = window.__cow; const e = p.aimedEntity(p.lookDir()); return { cow: { pos: c.pos, baby: c.baby, dead: c.dead, love: c.loveT, cd: c.breedCooldown }, pos: p.pos, yaw: p.yaw, pitch: p.pitch, aimed: e && e.kind, label: e && gm.entities.interactLabel(e, p.heldId()), held: p.heldId(), flying: p.flying }; })));
check('context button offers to feed the centred cow', /Feed/.test(ctxText), ctxText);
await shot('context');
await tapEl('.tb-ctx');
check('context button feeds (love mode)', await until(() => window.__cow.loveT > 0));
// tap on the cow with a sword: hit it where it stands on screen
await g(() => { const p = window.__game.player; p.inventory.selected = 1; p.inventory.onChange(); });
await wait(1000); // let the attack recharge
const cowPt = await g(({ W, H }) => {
  const gm = window.__game, c = window.__cow, cam = gm.renderer.camera;
  const V = cam.position.constructor;
  const v = new V(c.pos.x, c.pos.y + c.box.h * 0.6, c.pos.z).project(cam);
  return { x: (v.x + 1) / 2 * W, y: (1 - v.y) / 2 * H, hp: c.hp };
}, { W, H });
await tap(cowPt.x, cowPt.y);
await wait(300);
check('tapping a mob hits it', (await g(() => window.__cow.hp)) < cowPt.hp, `hp ${cowPt.hp} → ${await g(() => window.__cow.hp)}`);
await g(() => { window.__cow.hp = 0; window.__cow.dead = true; });

// --- hotbar: tap selects, sliding selects, resting drops, "…" opens the inventory
await home();
await g(() => {
  const p = window.__game.player, B = window.__B;
  p.mode = 'survival';
  p.inventory.slots[0] = { id: B.DIRT, count: 64 };
  p.inventory.slots[1] = { id: window.__findId('diamond_sword'), count: 1 };
  p.inventory.slots[2] = { id: window.__findId('wheat'), count: 32 };
  p.inventory.slots[3] = { id: B.COBBLE, count: 40 };
  for (let i = 4; i < 36; i++) p.inventory.slots[i] = null;
  p.inventory.slots[9] = { id: B.PLANKS, count: 20 };
  p.inventory.selected = 0;
  p.inventory.onChange();
});
await wait(200);
const slots = page.locator('#hotbar .hotbar-slot');
const s3 = await slots.nth(3).boundingBox();
await tap(s3.x + s3.width / 2, s3.y + s3.height / 2);
await wait(150);
check('tap a hotbar slot selects it', (await g(() => window.__game.player.inventory.selected)) === 3);
const s0 = await slots.nth(0).boundingBox();
await drag(6, s0.x + s0.width / 2, s0.y + s0.height / 2, s3.x + s3.width / 2 + s3.width * 2, s0.y + s0.height / 2, 10, 200);
await up(6);
check('sliding along the hotbar selects', (await g(() => window.__game.player.inventory.selected)) === 5);
check('a slide never throws items', await g(() => { const s = window.__game.player.inventory.slots; return s[2]?.count === 32 && s[3]?.count === 40; }));
const before = await g(() => window.__game.player.inventory.slots[3].count);
const dropCount = () => g(() => window.__game.entities.entities.filter((e) => e.kind === 'drop' && !e.dead).length);
// a throw is decided on release by the event timestamps: 0.55 s = one item, 1.3 s = the stack
await holdFor(7, s3.x + s3.width / 2, s3.y + s3.height / 2, 850);
await wait(500);
const after = await g(() => window.__game.player.inventory.slots[3]?.count ?? 0);
check('resting on a hotbar slot, then letting go, throws one item (Q)', after === before - 1, `${before} → ${after}`);
check('the dropped item flies off as a drop', await g(() => window.__game.entities.entities.some((e) => e.kind === 'drop' && !e.dead && e.itemId === window.__B.COBBLE && e.count === 1)));
await wait(1500); // beyond the 1.4 s pickup delay since the drop
check('…and is not picked straight back up', (await g(() => window.__game.player.inventory.slots[3]?.count ?? 0)) === before - 1);
check('the slot fills red while held past one item', await (async () => {
  const d = down(7, s3.x + s3.width / 2, s3.y + s3.height / 2);
  const red = await until(() => !!document.querySelector('#hotbar .hotbar-slot.holding-all'), 5000);
  await wait(1300);
  await Promise.all([d, up(7)]);
  return red;
})());
check('held past red, then let go: the whole stack (Ctrl+Q)', await until(() => !window.__game.player.inventory.slots[3], 3000));
await g(() => { const p = window.__game.player; p.inventory.slots[4] = { id: window.__B.DIRT, count: 10 }; p.inventory.onChange(); });
await wait(200);
// slots are rebuilt on every inventory change (a pickup can land mid-measure): retry
let s4 = null;
for (let k = 0; k < 20 && !s4; k++) { s4 = await slots.nth(4).boundingBox(); if (!s4) await wait(100); }
await tap(s4.x + s4.width / 2, s4.y + s4.height / 2);
await wait(400);
check('a quick tap on a slot throws nothing', (await g(() => window.__game.player.inventory.slots[4]?.count)) === 10);
await tapEl('.hotbar-more');
await wait(500);
check('"…" opens the inventory', await g(() => window.__game.state === 'container'));
check('touch overlay hidden in menus', await g(() => document.getElementById('touch-controls').classList.contains('hidden')));
await shot('inventory');

// --- inventory: double-tap quick-moves a stack from the backpack to the hotbar
const planksBefore = await g(() => window.__game.player.inventory.slots[9]?.count ?? 0);
// slot 9 is the first backpack slot: find its element by its position in the 9-wide grid
const slot9 = await g(() => {
  // the backpack grid is the one holding 27 slots
  const gridsEls = [...document.querySelectorAll('#container-screen .ctr-grid')];
  const grid = gridsEls.find((e) => e.children.length === 27);
  const s = grid?.children[0];
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (slot9) {
  const t0 = await tap(slot9.x, slot9.y); await wait(120); await tap(slot9.x, slot9.y, 9, t0 + 0.2);
  await wait(300);
  const moved = await g(() => {
    const inv = window.__game.player.inventory;
    return { back: inv.slots[9]?.count ?? 0, hot: inv.slots.slice(0, 9).some((s) => s && s.count === 20) };
  });
  check('double-tap quick-moves a stack', planksBefore === 20 && moved.back === 0 && moved.hot, JSON.stringify(moved));
} else check('double-tap quick-moves a stack', false, 'backpack grid not found');
// pick up the wheat (hotbar slot 2 in the inventory's hotbar row) and tap outside the panels
const wheatSlot = await g(() => {
  const grid = [...document.querySelectorAll('#container-screen .ctr-grid')].find((e) => e.children.length === 9);
  const s = grid?.children[2];
  if (!s) return null;
  const r = s.getBoundingClientRect();
  return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
});
if (wheatSlot) {
  await tap(wheatSlot.x, wheatSlot.y);
  check('tap picks a stack onto the cursor', await until(() => window.__game.player.inventory.slots[2] === null));
  await tap(6, H - 6);
  check('tap outside the panel throws the held stack', await until(() => !document.querySelector('#cursor-item canvas') &&
    window.__game.entities.entities.some((e) => e.kind === 'drop' && !e.dead && e.itemId === window.__findId('wheat') && e.count === 32)));
  await wait(2000);
  check('…and it is not picked straight back up', await g(() => !window.__game.player.inventory.slots.some((s) => s && s.id === window.__findId('wheat'))));
} else check('tap picks a stack onto the cursor', false, 'hotbar grid not found');
await tapEl('#container-screen .ctr-close');
await wait(400);
check('✕ closes the inventory', await g(() => window.__game.state === 'playing'));

// --- chat: button opens it, ✕ closes it
await tapEl('.tb-chat');
await wait(300);
check('chat button opens chat', await g(() => window.__game.state === 'chat'));
await shot('chat');
await tapEl('.chat-close');
await wait(300);
check('chat ✕ closes chat', await g(() => window.__game.state === 'playing'));

// --- pick block: press Pick, then tap a block — it lands in the hotbar
await home();
await g(() => {
  const gm = window.__game, p = gm.player, B = window.__B;
  p.mode = 'creative'; p.pitch = -0.75; gm.input.consumeMouse();
  for (let i = 0; i < 9; i++) if (p.inventory.slots[i]?.id === B.STONE) p.inventory.slots[i] = null;
  p.inventory.onChange();
});
await wait(300);
const countBlocks = () => g(() => {
  const gm = window.__game, a = window.__arena; let n = 0;
  for (let x = a.cx - 8; x <= a.cx + 8; x++) for (let z = a.cz - 12; z <= a.cz + 4; z++) for (let y = 109; y < 113; y++) if (gm.world.getBlock(x, y, z)) n++;
  return n;
});
await tapEl('.tb-pick');
check('pick button arms (tap aim)', await until(() => document.querySelector('.tb-pick').classList.contains('on')));
const blocksBefore = await countBlocks();
await tap(W * 0.6, H * 0.7);
check('the next tap picks the block under the finger', await until(() => {
  const p = window.__game.player; return p.inventory.slots[p.inventory.selected]?.id === window.__B.STONE;
}));
await wait(300);
check('…without placing anything', blocksBefore === await countBlocks());
check('pick disarms after use', await g(() => !document.querySelector('.tb-pick').classList.contains('on')));

// --- fullscreen button (shown while not fullscreen) asks on the lift
const fsBefore = await g(() => window.__fsCalls);
check('fullscreen button shown when not fullscreen', await page.locator('.tb-fs').isVisible());
await tapEl('.tb-fs');
check('fullscreen button asks for fullscreen', await until((n) => window.__fsCalls === n + 1, 3000, fsBefore));

// --- pause menu: Screenshot (share sheet on a phone) and Hide HUD (+ the eye to undo)
await tapEl('.tb-pause');
await until(() => window.__game.state === 'paused');
await page.locator('#pause-overlay button', { hasText: 'Screenshot' }).tap();
check('screenshot goes to the share sheet', await until(() => /^voxelcraft_.*[.]png$/.test(window.__shared ?? '')), String(await g(() => window.__shared)));
await page.locator('#pause-overlay button', { hasText: 'Hide HUD' }).tap();
check('Hide HUD resumes with the HUD hidden', await until(() => window.__game.state === 'playing' && document.getElementById('app').classList.contains('hud-off')));
check('only the eye button is left up top', await until(() => {
  const vis = (s) => { const e = document.querySelector(s); return !!e && getComputedStyle(e).display !== 'none' && e.getBoundingClientRect().width > 0; };
  return vis('.tb-showhud') && !vis('.tb-pause') && !vis('.tb-chat');
}));
await shot('hud-hidden');
await tapEl('.tb-showhud');
check('the eye brings the HUD back', await until(() => !document.getElementById('app').classList.contains('hud-off')));

// --- pause + options → Touch Controls → D-pad
await tapEl('.tb-pause');
await wait(400);
check('pause button pauses', await g(() => window.__game.state === 'paused'));
await shot('pause');
await page.locator('#pause-overlay button', { hasText: 'Options' }).tap();
await wait(300);
await page.locator('#pause-overlay button', { hasText: 'Touch Controls' }).tap();
await wait(300);
await shot('touch-options');
await page.locator('#pause-overlay button', { hasText: 'Movement:' }).tap();
await wait(150);
check('movement setting switches to D-pad', /D-pad/.test(await page.locator('#pause-overlay button', { hasText: 'Movement:' }).innerText()));
await page.locator('#pause-overlay .touch-opts button', { hasText: 'Done' }).tap();
await wait(200);
await page.locator('#pause-overlay button', { hasText: 'Done' }).first().tap();
await wait(200);
await page.locator('#pause-overlay button', { hasText: 'Back to Game' }).tap();
await wait(400);
check('D-pad shown', await until(() => { const d = document.querySelector('.touch-dpad'); return !!d && d.getBoundingClientRect().width > 0 && !document.getElementById('touch-controls').classList.contains('hidden'); }, 6000));
await home();
const zBefore = await g(() => window.__game.player.pos.z);
const up1 = await center('.touch-dpad .dp-u');
await down(8, up1.x, up1.y);
await wait(500);
check('D-pad forward shows the diagonals', await page.locator('.touch-dpad .dp-ul').isVisible());
await shot('dpad');
await wait(400);
await up(8);
check('D-pad walks forward', zBefore - (await g(() => window.__game.player.pos.z)) > 0.8);
await g(() => {
  // back to the stick for anyone running the harness again
  localStorage.setItem('voxelcraft-controls', JSON.stringify({ ...JSON.parse(localStorage.getItem('voxelcraft-controls') || '{}'), touchScheme: 'joystick' }));
});

// --- a mouse click switches to mouse + keyboard; a touch switches back
await page.mouse.click(W / 2, H / 2);
await wait(300);
check('mouse click leaves the touch layout', await g(() => !document.documentElement.classList.contains('touch-ui') &&
  document.getElementById('touch-controls').classList.contains('hidden') && !window.__game.input.touchActive));
check('…without pausing', await g(() => window.__game.state === 'playing'));
await tap(W * 0.6, H * 0.3);
check('a touch brings the touch layout back', await until(() => document.documentElement.classList.contains('touch-ui') &&
  !document.getElementById('touch-controls').classList.contains('hidden') && window.__game.input.touchActive));

// --- portrait: rotate hint
await page.setViewportSize({ width: H, height: W });
await wait(400);
check('portrait shows the rotate hint', await page.locator('.touch-rotate').isVisible());
await shot('portrait');
await page.locator('.touch-rotate button').tap();
await wait(200);
check('rotate hint can be dismissed', !(await page.locator('.touch-rotate').isVisible()));
check('portrait hotbar (with "…") fits the screen', await g(() => {
  const r = document.querySelector('.hotbar-more').getBoundingClientRect();
  const h = document.getElementById('hotbar').getBoundingClientRect();
  return r.right <= innerWidth && h.left >= 0;
}));
await shot('portrait-play');
await page.setViewportSize({ width: W, height: H });

// --- iPhone: Safari in landscape with its bars showing (812×292), no
// fullscreen API for pages — the ⛶ button and the title screen explain Add to
// Home Screen; chat must fit the short screen
if (!process.env.SKIP_IPHONE) {
  const ictx = await browser.newContext({
    viewport: { width: 812, height: 292 }, deviceScaleFactor: 3, isMobile: true, hasTouch: true,
    userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  });
  const ip = await ictx.newPage();
  ip.on('console', (m) => { if (m.type() === 'error') errors.push(`[iphone] ${m.text()}`); });
  ip.on('pageerror', (e) => errors.push(`[iphone] PAGEERROR: ${e.message}`));
  await ip.addInitScript(() => {
    Object.defineProperty(Document.prototype, 'fullscreenEnabled', { get: () => false });
    Object.defineProperty(Document.prototype, 'webkitFullscreenEnabled', { get: () => false });
    window.__fsCalls = 0;
    Element.prototype.requestFullscreen = function () { window.__fsCalls++; return Promise.reject(new TypeError('unsupported')); };
    // Safari's Audio Session API (iOS 16.4+): the game must ask for 'playback'
    // or the silent switch mutes it
    navigator.audioSession = { type: 'auto' };
  });
  const icdp = await ictx.newCDPSession(ip);
  const itap = async (sel) => {
    const l = ip.locator(sel).first();
    await l.scrollIntoViewIfNeeded().catch(() => {});
    const b = await l.boundingBox();
    if (!b) throw new Error(`no ${sel}`);
    const pt = [{ x: b.x + b.width / 2, y: b.y + b.height / 2, id: 1 }];
    const ts = Date.now() / 1000;
    await Promise.all([
      icdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pt, timestamp: ts }),
      icdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [], timestamp: ts + 0.06 }),
    ]);
  };
  const iuntil = (fn, ms = 4000) => ip.waitForFunction(fn, null, { timeout: ms }).then(() => true, () => false);
  await ip.goto(`http://localhost:${PORT}/#dev-nointro`, { waitUntil: 'domcontentloaded', timeout: 120000 });
  await ip.waitForSelector('.create-btn', { timeout: 30000 });
  await ip.waitForTimeout(800);
  check('iPhone: page text is not inflated', await ip.evaluate(() => /100%/.test(getComputedStyle(document.documentElement).webkitTextSizeAdjust || getComputedStyle(document.documentElement).textSizeAdjust || '')));
  check('iPhone: title offers the fullscreen guide', await ip.locator('.ios-fs-link').isVisible());
  check('iPhone: audio session asks for playback after a tap (silent switch)', await iuntil(() => navigator.audioSession.type === 'playback'));
  await itap('.ios-fs-link');
  check('iPhone: guide explains Add to Home Screen', await iuntil(() => /Add to Home Screen/.test(document.getElementById('ios-fs-help')?.innerText ?? '')));
  check('iPhone: the guide button is on screen', await ip.evaluate(() => { const r = document.querySelector('#ios-fs-help .mc-btn').getBoundingClientRect(); return r.bottom <= innerHeight && r.top >= 0; }));
  if (SHOTS) await ip.screenshot({ path: `${DIR}/shot-mobile-iphone-guide.png` });
  await itap('#ios-fs-help .mc-btn');
  check('iPhone: guide closes', await iuntil(() => !document.getElementById('ios-fs-help')));
  await itap('.create-btn');
  await ip.waitForSelector('#loading.hidden', { timeout: 120000, state: 'attached' });
  await ip.waitForFunction(() => !!window.__game, null, { timeout: 30000 });
  await iuntil(() => !document.getElementById('touch-controls').classList.contains('hidden'), 10000);
  check('iPhone: ⛶ button shown (no fullscreen API)', await ip.locator('.tb-fs').isVisible());
  // a cow in front so the mob button shows too, then nothing on the right may overlap
  await ip.evaluate(() => {
    const gm = window.__game, p = gm.player;
    p.mode = 'creative'; gm.onInventoryChange(); // the minimap shows in creative: include it
    p.yaw = 0; p.pitch = -0.3; gm.input.consumeMouse();
    const cow = gm.entities.spawnMob('cow', p.pos.x, p.pos.y, p.pos.z - 2.2);
    cow.vel = { x: 0, y: 0, z: 0 };
  });
  await iuntil(() => !document.querySelector('.tb-ctx').classList.contains('hidden'), 6000);
  await ip.waitForTimeout(300);
  const clash = await ip.evaluate(() => {
    const sels = ['.tb-jump', '.tb-sneak', '.tb-ctx', '.minimap', '#hotbar-wrap', '.hotbar-more', '.touch-top', '.touch-stick'];
    const R = sels.map((s) => { const e = document.querySelector(s); const r = e && getComputedStyle(e).display !== 'none' ? e.getBoundingClientRect() : null; return [s, r]; })
      .filter(([, r]) => r && r.width > 0);
    const out = [];
    for (let i = 0; i < R.length; i++) {
      const [s, r] = R[i];
      if (r.left < 0 || r.top < 0 || r.right > innerWidth + 0.5 || r.bottom > innerHeight + 0.5) out.push(s + ' off-screen');
      for (let j = i + 1; j < R.length; j++) {
        const [s2, r2] = R[j];
        if ((s === '#hotbar-wrap' && s2 === '.hotbar-more')) continue; // the "…" sits on the bar
        if (r.left < r2.right && r2.left < r.right && r.top < r2.bottom && r2.top < r.bottom) out.push(s + ' × ' + s2);
      }
    }
    return out;
  });
  check('iPhone: thumb buttons, minimap and hotbar do not overlap at 812×292', clash.length === 0, clash.join(', '));
  if (SHOTS) await ip.screenshot({ path: `${DIR}/shot-mobile-iphone-hud.png` });
  await itap('.tb-fs');
  check('iPhone: ⛶ opens the guide instead of failing', await iuntil(() => !!document.getElementById('ios-fs-help')));
  await itap('#ios-fs-help .mc-btn');
  await iuntil(() => !document.getElementById('ios-fs-help'));
  await itap('.tb-chat');
  check('iPhone: chat opens', await iuntil(() => window.__game.state === 'chat'));
  await ip.evaluate(() => { window.__game.chat.add('You', 'hi'); });
  const fit = await ip.evaluate(() => {
    const r = document.querySelector('.chat-root').getBoundingClientRect();
    const mm = document.querySelector('.minimap')?.getBoundingClientRect();
    const inp = document.querySelector('.chat-input input');
    return { right: r.right, bottom: r.bottom, top: r.top, w: innerWidth, h: innerHeight, mmLeft: mm && mm.width > 0 ? mm.left : innerWidth - 120 /* hidden while chatting: keep clear of where it sits */, font: parseFloat(getComputedStyle(inp).fontSize) };
  });
  check('iPhone: chat fits the short landscape screen, clear of the minimap',
    fit.right <= fit.mmLeft && fit.top >= 0 && fit.bottom <= fit.h * 0.6, JSON.stringify(fit));
  check('iPhone: chat input is 16px (Safari zooms into smaller inputs)', fit.font >= 16);
  if (SHOTS) await ip.screenshot({ path: `${DIR}/shot-mobile-iphone-chat.png` });
  await itap('.chat-close');
  check('iPhone: chat closes', await iuntil(() => window.__game.state === 'playing'));
  await ictx.close();
}

console.log('console errors:', errors.length ? errors.slice(0, 10).join('\n') : 'NONE');
await browser.close();
await server.close();
console.log(failed ? `${failed} FAILED` : 'ALL PASSED');
process.exit(failed || errors.length ? 1 : 0);
