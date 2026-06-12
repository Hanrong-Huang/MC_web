# Voxelcraft

A Minecraft-style voxel sandbox written from scratch in **TypeScript + Three.js**
(Three.js is used only as the WebGL wrapper — chunking, meshing, lighting,
physics, AI, crafting, and persistence are all custom). No game engines, no
voxel/physics libraries, no copied assets: every texture is generated as
16x16 pixel art in code.

## Run

```bash
npm install
npm run dev        # open the printed localhost URL
```

`npm run build` type-checks and produces a static bundle in `dist/`.

## Controls

| Input | Action |
|---|---|
| WASD / mouse | Move / look (click the canvas to capture the mouse) |
| Double-W or Ctrl | Sprint (5.612 m/s, widened FOV) |
| Shift | Sneak (1.295 m/s, can't fall off edges) — descend while flying |
| Space | Jump (1.25 blocks) — ascend while flying |
| F, or double-Space in creative | Toggle flight (2.5x speed) |
| Left click | Break blocks (hold; per-block times + crack overlay) / attack mobs |
| Right click | Place block · open table/furnace/chest · use bed · ignite TNT · hold to eat or draw the bow |
| E | Inventory (2x2 crafting) / creative block panel |
| 1–9, scroll | Hotbar selection |
| F3 | Debug overlay (FPS, XYZ, facing, chunk, biome) |
| Esc | Pause (Save Game, mode toggle, render distance, Save & Quit) |

## Features

- **World**: 16x16x128 chunks streamed to render distance 8 (configurable 6–12),
  multi-octave simplex terrain with temperature/humidity biomes (plains, forest,
  desert, snow mountains), **meandering rivers** that carve through hills,
  **3D-noise cave systems** (spaghetti tunnels + caverns), sea level, beaches,
  and furnished huts (crafting table, furnace, loot chest, torch).
- **Flora**: three tree species — oak, **birch** (white scarred bark), and
  conical **spruce** taiga trees in the snow biome — plus tall grass, poppies,
  dandelions, **cactus** (it hurts), and sugar cane along river banks; plants
  render as crossed billboards, pop off when unsupported, and cane/cactus
  stack and can be farmed.
- **Dungeons**: buried cobblestone rooms (often breached by caves) holding
  **loot chests** — generated chests roll weighted treasure (ingots, diamonds,
  food, arrows, a bow if you're lucky) the first time they're opened; hut
  chests do the same.
- **Ores & progression**: coal everywhere, iron below y=54, gold below y=30,
  diamond below y=14, plus gravel pockets (flint). Tool tiers
  wood → stone → iron → diamond with real Minecraft-style gates: stone needs a
  wooden pick, iron needs stone, gold/diamond need iron. Wrong tier = slow
  break, no drops. Tools have **durability** (bar shown on the icon) and snap
  when worn out.
- **Lighting**: per-face shading + per-vertex ambient occlusion + heightmap
  skylight, and **BFS flood-fill torch light** carried in a second vertex
  channel — a custom shader keeps torch pools warm and bright at night while
  skylight dims, with a faint moonlight floor. Torches pop off if their
  support is mined; cave mobs won't spawn near them.
- **Mobs**: pigs, chickens, sheep, cows (wander, flee, drop porkchops /
  feathers / wool+mutton / beef); zombies and **skeleton archers** (arrows with
  real ballistics and line-of-sight checks) that burn off at dawn when
  sky-exposed; **spiders** (fast, neutral in daylight); **creepers** (hiss,
  flash, explode — craters included). Hostiles also spawn in dark caves at any
  hour. All mobs are hierarchical box models with sine-wave walk cycles.
- **Combat**: melee with knockback + sword damage by tier, and a **bow** —
  hold right-click to draw (FOV zoom), release to loose an arrow; arrows can
  be picked back up.
- **Explosives**: creepers and craftable **TNT** (right-click to ignite,
  chain reactions, container contents spill, sand/gravel above craters fall).
- **Physics extras**: falling **sand and gravel** (turn into falling-block
  entities and chain upward), fall damage, swimming, block-break particles.
- **Crafting**: 2x2 personal grid and 3x3 table — planks, sticks, torches,
  table, furnace, chest, bed, TNT, bow, arrows, sandstone, stone bricks, wool,
  resource blocks (iron/gold/diamond, both directions), and 16 tools across
  4 tiers. Furnace smelts ores → ingots, sand → glass, cobble → stone,
  log → charcoal, and cooks 4 meats.
- **Storage & rest**: **chests** (27 slots, contents persist, spill when
  broken) and **beds** (set your respawn point; sleep to skip the night).
- **Survival**: 10 hearts + 10 hunger shanks, exhaustion, regen, starvation,
  **drowning with an air-bubble meter**, cactus contact damage, 7 foods
  (incl. apples from oak leaves and rotten flesh from zombies), death/respawn
  at your bed.
- **Feel**: view bobbing while walking, item-name popups on hotbar switch,
  slot tooltips, and synthesized **mob voices** (oinks, baas, moos, clucks,
  groans, hisses, and skeleton rattles) attenuated by distance.
- **Farming & growth**: break tall grass for seeds, craft a **hoe**, till
  grass/dirt into farmland, plant and harvest **wheat** (3 visual growth
  stages), bake **bread**. Leaves drop **saplings** that grow into
  biome-appropriate trees; grass spreads onto exposed dirt and dies under
  opaque blocks — all driven by MC-style surface **random ticks**.
- **Music**: a generative Web Audio composer plays calm piano-and-pad pieces
  every few minutes — major-pentatonic by day, minor at night — entirely
  synthesized, no audio files. Music and sounds toggle from the pause menu
  (persisted).
- **Effects**: continuous chip particles at the mined face, bigger break
  bursts, landing dust + thud on hard falls, white poofs on mob deaths,
  TNT chain flashes.
- **Extra visuals**: per-vertex **biome tinting** for grass, foliage, and
  tall grass (dry plains go yellow-green, humid forests deep green, cold
  biomes pale), and **animated water** with a gentle world-anchored wave.
- **Creative**: infinite blocks, instant breaking, flight, full item panel.
- **Persistence**: RLE-compressed chunk diffs + player/inventory/durability/
  chest/furnace/spawn-point/time state in IndexedDB across three save slots.
  **Save Game** from the pause menu, **autosave every 60 s**, and
  Save & Quit — pick the world from the title screen to resume exactly where
  you left off.
- **Resource packs**: load an *unzipped* pack folder using the standard
  `assets/minecraft/textures/{block,item}/*.png` layout to swap in real
  textures (tinting handled).
- **Audio**: Web Audio synthesis for digging/steps per block class, combat,
  bow shots, explosions, fuses, tool breaks, eating, pickups, ambient pads.

## Architecture

```
src/main.ts                  app + game loop (uniform 20 Hz tick), day cycle, saves, autosave
src/engine/Noise.ts          seeded PRNG, hashing, 2D + 3D simplex, fBm
src/engine/Blocks.ts         block/item registry: hardness, tool tiers, durability, drops, food, fuel
src/engine/Textures.ts       procedural 16x16 atlas, item sprites, icons, resource-pack loader
src/engine/Chunk.ts          16x16x128 Uint8Array chunk + heightmap + torch index
src/engine/WorldGenerator.ts biomes, terrain, caves, ores, trees, structures
src/engine/World.ts          chunk streaming, block edits, DDA raycast, block entities
src/engine/Mesher.ts         face culling, shading, AO, skylight + torch flood-fill, torch models
src/engine/Renderer.ts       custom chunk shader (2-channel light), sky/sun/moon/clouds/fog, held item
src/engine/Physics.ts        swept AABB collision, sneak edge guard, ray-AABB
src/engine/Player.ts         movement, mining, bow, eating, durability, health/hunger, modes
src/engine/Input.ts          pointer lock, keys, double-tap, edge-queued clicks
src/engine/Inventory.ts      slots, shaped recipes, furnace + chest state
src/engine/EntityManager.ts  drops, 8 mobs, arrows, TNT, falling blocks, particles, explosions
src/engine/Persistence.ts    RLE codec + IndexedDB save slots
src/engine/Audio.ts          Web Audio synthesis
src/ui/HUD.ts                menus, hotbar, hearts, durability bars, container screens
```

## Tests

- `node smoke-test.mjs` — boots the game headless in Edge (SwiftShader), creates a
  world, and fails on any console error.
- `node persist-test.mjs` — save & quit, reload, verifies exact position restoration.
- `npx esbuild logic-test.ts --bundle --format=esm --platform=node --outfile=t.mjs && node t.mjs`
  — unit tests for the RLE codec, all recipes, smelting, furnace timing, chest
  serialization, and tool-tier/break-time math.
- `npx esbuild light-test.ts --bundle --format=esm --platform=node --outfile=t.mjs && node t.mjs`
  — deterministic torch flood-fill test (placement, attenuation, removal).

Dev helper: open the game with `#night` in the URL to start just after sundown.
