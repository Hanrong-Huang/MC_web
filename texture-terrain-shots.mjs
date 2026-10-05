// Screenshot harness for the texture/terrain look: a fixed-seed creative world
// shot from the same spots every run (landscape from above, forest, desert,
// mountains/snow, a torch-lit cave, a y=108 wall of common blocks), plus the
// raw atlas and an icon sheet. Compare runs before/after a texture or
// generator change. Env: PORT (default 5431), SHOT_DIR (default .), SEED.
import { chromium } from 'playwright';
import { createServer } from 'vite';
import fs from 'node:fs';

const PORT = +(process.env.PORT ?? 5431);
const DIR = process.env.SHOT_DIR ?? '.';
const SEED = process.env.SEED ?? '424242';
fs.mkdirSync(DIR, { recursive: true });
const server = await createServer({ root: process.cwd(), server: { port: PORT, strictPort: true, watch: { ignored: ['**/.claude/**'] } } });
await server.listen();
const browser = await chromium.launch({
  channel: 'msedge', headless: true,
  args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
});
const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
const errors = [];
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()); });
page.on('pageerror', (e) => errors.push(`PAGEERROR: ${e.message}`));

await page.goto(`http://localhost:${PORT}/#dev`, { timeout: 180000 });
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.waitForTimeout(3000);
await page.waitForLoadState('networkidle', { timeout: 180000 });
await page.locator('.mode-pick button', { hasText: 'Creative' }).click({ timeout: 120000 });
await page.fill('#new-world-seed', SEED);
await page.locator('.create-btn').click({ timeout: 120000, noWaitAfter: true });
await page.waitForSelector('#loading.hidden', { timeout: 180000, state: 'attached' });
await page.waitForFunction(() => !!window.__game, null, { timeout: 60000 });
await page.waitForTimeout(1500);
await page.mouse.click(640, 360);

// steady, clear midday; hide the HUD so the shots are just the world
await page.evaluate(() => {
  const g = window.__game;
  g.weather.netControlled = true; g.weather.setKind('clear'); g.weather.intensity = 0;
  g.world.viewDist = 7; g.renderer.setViewDistance(7);
  document.getElementById('hud')?.style.setProperty('visibility', 'hidden');
});

// --- atlas + icon sheet ---------------------------------------------------
const atlas = await page.evaluate(() => {
  const g = window.__game, a = g.atlas;
  const S = 4, W = a.canvas.width, H = a.canvas.height;
  const c = document.createElement('canvas');
  c.width = W * S * 2; c.height = H * S / 2; // two halves side by side
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
  x.fillStyle = '#ff00ff'; x.fillRect(0, 0, c.width, c.height);
  x.drawImage(a.canvas, 0, 0, W, H / 2, 0, 0, W * S, H * S / 2);
  x.drawImage(a.canvas, 0, H / 2, W, H / 2, W * S, 0, W * S, H * S / 2);
  return { url: c.toDataURL('image/png'), tiles: a.tiles.size, W, H };
});
fs.writeFileSync(`${DIR}/tt-atlas.png`, Buffer.from(atlas.url.split(',')[1], 'base64'));
console.log(`atlas ${atlas.W}x${atlas.H}, ${atlas.tiles} tiles (capacity ${(atlas.W / 16) * (atlas.H / 16)})`);

const close = await page.evaluate(() => {
  // close-up of common tiles, 8x, labelled
  const a = window.__game.atlas;
  const names = ['stone', 'cobble', 'dirt', 'grass_top', 'grass_side', 'sand', 'gravel', 'sandstone_side', 'sandstone_top',
    'planks', 'log_side', 'log_top', 'birch_log_side', 'spruce_log_side', 'leaves', 'birch_leaves', 'spruce_leaves', 'jungle_leaves',
    'coal_ore', 'iron_ore', 'gold_ore', 'diamond_ore', 'stone_bricks', 'bricks', 'snow_top', 'snow_side', 'clay', 'mossy_cobble',
    'glass', 'tall_grass', 'poppy', 'dandelion', 'bedrock', 'terracotta', 'ice', 'cactus_side'];
  const S = 8, cols = 9;
  const c = document.createElement('canvas');
  c.width = cols * (16 * S + 8); c.height = Math.ceil(names.length / cols) * (16 * S + 22);
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
  x.fillStyle = '#222'; x.fillRect(0, 0, c.width, c.height);
  x.font = '12px monospace'; x.fillStyle = '#fff';
  names.forEach((n, i) => {
    const px = (i % cols) * (16 * S + 8) + 4, py = Math.floor(i / cols) * (16 * S + 22) + 16;
    try {
      const t = a.tileCanvas(n);
      x.fillStyle = '#5a7'; x.fillRect(px, py, 16 * S, 16 * S);
      x.drawImage(t, px, py, 16 * S, 16 * S);
    } catch { /* missing */ }
    x.fillStyle = '#fff'; x.fillText(n, px, py - 3);
  });
  // also a 3x3 tiling of a few tiles to show seams/repetition
  return c.toDataURL('image/png');
});
fs.writeFileSync(`${DIR}/tt-tiles.png`, Buffer.from(close.split(',')[1], 'base64'));

const tiling = await page.evaluate(() => {
  const a = window.__game.atlas;
  const names = ['stone', 'dirt', 'grass_top', 'sand', 'gravel', 'cobble', 'leaves', 'planks'];
  const S = 3, N = 4, sz = 16 * S * N;
  const c = document.createElement('canvas');
  c.width = 4 * (sz + 6); c.height = 2 * (sz + 6);
  const x = c.getContext('2d'); x.imageSmoothingEnabled = false;
  names.forEach((n, i) => {
    const t = a.tileCanvas(n);
    const ox = (i % 4) * (sz + 6), oy = Math.floor(i / 4) * (sz + 6);
    x.fillStyle = '#4a6'; x.fillRect(ox, oy, sz, sz);
    for (let j = 0; j < N; j++) for (let k = 0; k < N; k++) x.drawImage(t, ox + k * 16 * S, oy + j * 16 * S, 16 * S, 16 * S);
  });
  return c.toDataURL('image/png');
});
fs.writeFileSync(`${DIR}/tt-tiling.png`, Buffer.from(tiling.split(',')[1], 'base64'));

// --- helpers ------------------------------------------------------------------
async function settle(maxMs = 90000) {
  await page.waitForTimeout(600);
  await page.waitForFunction(() => {
    const g = window.__game, w = g.world;
    return w.genQueue.length === 0 && w.dirtySet.size === 0 && g.meshInFlight.size === 0;
  }, null, { timeout: maxMs, polling: 300 }).catch(() => console.log('  (settle timed out)'));
  await page.waitForTimeout(900); // chunk fade-in
}

async function look(eye, target) {
  await page.evaluate(({ eye, target }) => {
    const p = window.__game.player;
    p.flying = true; p.vel = { x: 0, y: 0, z: 0 };
    p.pos.x = eye[0]; p.pos.y = eye[1] - p.eyeHeight(); p.pos.z = eye[2];
    const dx = target[0] - eye[0], dy = target[1] - eye[1], dz = target[2] - eye[2];
    p.yaw = Math.atan2(-dx, -dz);
    p.pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }, { eye, target });
}

async function shot(name, eye, target) {
  await look(eye, target);
  await settle();
  await look(eye, target); // physics may have nudged us while loading
  await page.waitForTimeout(400);
  await page.screenshot({ path: `${DIR}/${name}.png` });
  console.log('shot', name, eye.map(Math.round).join(','));
}

const find = (biomes, from) => page.evaluate(({ biomes, from }) => {
  const gen = window.__game.world.generator;
  for (let r = 64; r < 4000; r += 48) {
    for (let a = 0; a < 24; a++) {
      const x = Math.round(from[0] + Math.cos(a / 24 * Math.PI * 2) * r);
      const z = Math.round(from[1] + Math.sin(a / 24 * Math.PI * 2) * r);
      // want the biome to hold for a while around the point
      let ok = true;
      for (const [ox, oz] of [[0, 0], [24, 0], [-24, 0], [0, 24], [0, -24]]) if (!biomes.includes(gen.biomeAt(x + ox, z + oz))) ok = false;
      if (ok) return [x, z, gen.surfaceY(x, z)];
    }
  }
  return null;
}, { biomes, from });

const spawn = await page.evaluate(() => {
  const p = window.__game.player.pos; return [Math.floor(p.x), Math.floor(p.z)];
});
const surf = (x, z) => page.evaluate(({ x, z }) => window.__game.world.generator.surfaceY(x, z), { x, z });

// 1. wide landscape from above
{
  const [x, z] = spawn; const h = await surf(x, z);
  await shot('tt-landscape', [x, Math.max(h, 64) + 42, z], [x + 60, Math.max(h, 64), z + 40]);
  await shot('tt-ground', [x, (await surf(x, z)) + 3.2, z], [x + 30, (await surf(x + 30, z + 10)) + 1, z + 10]);
}
// 2..4 biomes
for (const [name, biomes] of [['tt-forest', ['forest']], ['tt-desert', ['desert']], ['tt-mountains', ['mountains', 'snow']], ['tt-taiga', ['taiga', 'snow']], ['tt-jungle', ['jungle']], ['tt-swamp', ['swamp']]]) {
  const at = await find(biomes, spawn);
  if (!at) { console.log('no', name); continue; }
  const [x, z, h] = at;
  await shot(name, [x - 18, Math.max(h, 63) + 14, z - 18], [x + 10, Math.max(h, 63), z + 10]);
}

// 5. cave interior: find a roomy air pocket below y=45 near spawn, light it with torches
{
  // load around a spot then look for caves in loaded chunks
  const [x, z] = spawn;
  await look([x, 90, z], [x + 1, 80, z]);
  await settle();
  const cave = await page.evaluate(({ x, z }) => {
    const g = window.__game, w = g.world, B = window.__B;
    let best = null, bestScore = 0;
    for (let dx = -40; dx <= 40; dx += 2) for (let dz = -40; dz <= 40; dz += 2) for (let y = 14; y < 48; y += 2) {
      const cx = x + dx, cz = z + dz;
      if (w.getBlock(cx, y, cz) !== 0) continue;
      let air = 0, ore = 0;
      for (let ox = -4; ox <= 4; ox += 2) for (let oy = -2; oy <= 2; oy++) for (let oz = -4; oz <= 4; oz += 2) {
        const id = w.getBlock(cx + ox, y + oy, cz + oz);
        if (id === 0) air++;
        if (id === B.COAL_ORE || id === B.IRON_ORE || id === B.GOLD_ORE || id === B.DIAMOND_ORE) ore++;
      }
      // no sky above (it's a cave, not a ravine/open pit)
      let roofed = false;
      for (let yy = y + 1; yy < y + 30; yy++) if (w.getBlock(cx, yy, cz) !== 0) { roofed = true; break; }
      const score = roofed ? Math.min(air, 80) + ore * 6 : 0;
      if (score > bestScore) { bestScore = score; best = [cx, y, cz]; }
    }
    if (!best) return null;
    // torches on floor cells around
    const [cx, cy, cz] = best;
    let placed = 0;
    for (let ox = -8; ox <= 8; ox += 4) for (let oz = -8; oz <= 8; oz += 4) {
      for (let yy = cy + 3; yy > cy - 6; yy--) {
        if (w.getBlock(cx + ox, yy, cz + oz) === 0 && w.getBlock(cx + ox, yy - 1, cz + oz) !== 0 && w.getBlock(cx + ox, yy - 1, cz + oz) !== B.TORCH) {
          w.setBlock(cx + ox, yy, cz + oz, B.TORCH); placed++; break;
        }
      }
    }
    // camera direction: the longest air run
    let dir = [1, 0], run = 0;
    for (const [ddx, ddz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1]]) {
      let n = 0; while (n < 20 && w.getBlock(cx + ddx * n, cy, cz + ddz * n) === 0) n++;
      if (n > run) { run = n; dir = [ddx, ddz]; }
    }
    return { best, dir, placed, bestScore };
  }, { x, z });
  if (cave) {
    const [cx, cy, cz] = cave.best;
    console.log('cave', cave);
    await shot('tt-cave', [cx + 0.5, cy + 1.2, cz + 0.5], [cx + cave.dir[0] * 10, cy, cz + cave.dir[1] * 10]);
  } else console.log('no cave found');
}

// 6. close-up wall of common blocks on a y=108 stone platform
{
  const built = await page.evaluate(() => {
    const g = window.__game, p = g.player, B = window.__B, w = g.world;
    const ox = Math.floor(p.pos.x), oy = 108, oz = Math.floor(p.pos.z);
    for (let dx = -3; dx <= 14; dx++) for (let dz = -3; dz <= 14; dz++) {
      w.setBlock(ox + dx, oy - 1, oz + dz, B.STONE);
      for (let dy = 0; dy <= 6; dy++) w.setBlock(ox + dx, oy + dy, oz + dz, 0);
    }
    const rows = [
      [B.STONE, B.COBBLESTONE ?? B.COBBLE, B.DIRT, B.GRASS, B.SAND, B.GRAVEL, B.SANDSTONE, B.CLAY, B.SNOW_BLOCK],
      [B.PLANKS, B.LOG, B.BIRCH_LOG, B.SPRUCE_LOG, B.JUNGLE_LOG, B.LEAVES, B.BIRCH_LEAVES, B.SPRUCE_LEAVES, B.JUNGLE_LEAVES],
      [B.COAL_ORE, B.IRON_ORE, B.GOLD_ORE, B.DIAMOND_ORE, B.STONE_BRICKS, B.BRICKS, B.MOSSY_COBBLE, B.BEDROCK, B.TERRACOTTA],
    ];
    rows.forEach((row, j) => row.forEach((id, i) => { if (id) w.setBlock(ox + 1 + i, oy + 2 - j, oz + 8, id); }));
    // a little 3x3 floor patch of each surface block in front of the wall
    [B.GRASS, B.SAND, B.GRAVEL, B.DIRT, B.STONE].forEach((id, i) => {
      for (let a = 0; a < 2; a++) for (let b = 0; b < 3; b++) w.setBlock(ox + i * 2 + a, oy - 1, oz + 3 + b, id);
    });
    g.dayTime = 0.12;
    return { ox, oy, oz };
  });
  const { ox, oy, oz } = built;
  await shot('tt-wall', [ox + 5.5, oy + 1.6, oz + 3], [ox + 5.5, oy + 1.2, oz + 8]);
  await shot('tt-wall-angle', [ox + 0, oy + 3.5, oz + 2], [ox + 6, oy + 0.5, oz + 8]);
}

console.log(errors.length ? `console errors:\n${errors.slice(0, 10).join('\n')}` : 'no console errors');
await browser.close();
await server.close();
process.exit(0);
