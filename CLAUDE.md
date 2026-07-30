# CLAUDE.md — Voxelcraft

Working notes for AI agents in this repo. Player-facing feature docs live in `README.md`; this file is about *how to work here*.

## What this is

A from-scratch Minecraft clone in **TypeScript + Three.js + Vite**. Three.js is only the WebGL wrapper — chunking, meshing, lighting, physics, mob AI, crafting, and persistence are all hand-written. **No game/voxel/physics libraries and no asset files of any kind**: every texture, mob, sound, and music track is generated procedurally in code. Keep it that way — if you need a new texture/sprite/sound, generate it, don't add a binary.

Solo project. Commits go straight to `main`.

## Commands

```bash
npm run dev      # vite dev server (open the printed localhost URL)
npm run build    # tsc --noEmit then vite build → dist/  (this is the CI gate)
npm run preview  # serve the built bundle
```

Always run `npm run build` (or at least `npx tsc --noEmit`) before committing — `tsc` is strict and is the only automated correctness gate besides the headless tests.

## Environment gotchas (Windows / PowerShell)

- Shell is **PowerShell**; a Bash tool is also available for POSIX scripts.
- The repo lives under **OneDrive**, which intermittently file-locks freshly written PNGs. Headless tests write `shot-*.png`; if a test dies with `UNKNOWN: ... open shot-*.png`, delete them first: `Remove-Item -Force shot-*.png` (or `rm -f shot-*.png`).
- Headless browser tests use Playwright with the **Edge** channel and SwiftShader:
  `chromium.launch({ channel: 'msedge', args: ['--use-angle=swiftshader', '--enable-unsafe-swiftshader'] })`.
- Each Playwright launch is a **fresh ephemeral profile**, so the title-screen world slots are empty — create into `World 2`/`World 3`, not high-numbered rows that don't exist.
- Pointer-lock camera in tests: `page.mouse.move(x, y)` works as a look-toward gesture (see `sleep-test.mjs`); number-key hotbar switches often **don't** register under pointer lock in headless.

## Conventions

- Commit message trailer (required): `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>`.
- Match surrounding style: 2-space indent, single quotes, terse purpose-first comments.
- Procedural art: mob skins via `EntityManager.skin()`, item/block pixel art via `Textures.ts` (`pixmap` + palettes), sounds/music via `Audio.ts`. New visuals follow these.
- `.mjs` files in the repo root are headless test harnesses, not app code.

## Architecture map

See the table in `README.md` for the full per-file breakdown. The big/hot files:

| File | Responsibility |
|---|---|
| `src/main.ts` | App + 20 Hz logic tick / rAF render loop, day cycle, autosave, `GameUIState` machine, dev hooks |
| `src/engine/EntityManager.ts` | Drops + all mobs (box-limb models, `buildMobMesh`, `animateMob`, state-tree AI), arrows, TNT, particles, breeding |
| `src/engine/Textures.ts` | Procedural 16×16 atlas, item sprites, isometric icons, `extrudeSpriteGeometry` (shared by held items + drops), resource-pack loader |
| `src/engine/Renderer.ts` | Custom 2-channel-light chunk shader, sky/sun/moon/clouds/fog, chunk fade-in, held-item rig |
| `src/engine/Mesher.ts` | Face culling, AO, skylight + BFS torch flood-fill, cross/torch/door models |
| `src/engine/Player.ts` | Movement, mining, bow, eating, durability, health/hunger, mob interaction, riding |
| `src/engine/Blocks.ts` | Block/item registry (`B`, `I`, `def`) — single source of truth for ids, drops, tiers, recipes inputs |
| `src/engine/Inventory.ts` | Slots, shaped recipes, furnace + chest state |

## Key invariants & gotchas

- **Two clocks**: logic runs at a fixed 20 Hz tick; rendering is rAF. Don't put gameplay state changes in render code.
- **GameUIState** (`main.ts`): `loading | playing | paused | container | dead | sleeping`. `isUIOpen()` is `state !== 'playing'`, which gates player input. Add new modal states here, not ad-hoc flags.
- **Blocks/items registry is authoritative.** Add a block/item by extending the `B`/`I` enums + `itemDefs`/`CREATIVE_ITEMS` in `Blocks.ts`; everything (meshing, drops, icons, recipes) keys off `def(id)`.
- **`extrudeSpriteGeometry`** in `Textures.ts` is shared between in-hand items and dropped items — change it once, both update.
- **Mob skins**: `skin(key, base, speckle, face?)` paints an 8×8 canvas — clean flat base + gentle top-lit vertical shading + sparse speckle (intentionally *not* heavy noise; heavy noise made mobs unrecognizable). Face details are drawn after the base loop. Per-mob features (snouts, patches, markings) are added as extra boxes in `buildMobMesh`.
- **Wall torches**: a single `B.TORCH` id; orientation lives in `world.torchFacings` (Map keyed `"x,y,z"` → 0..3). Keep it in sync on place/break and in persistence.
- **`emitBox` winding** (`Mesher.ts`): its six faces push corners *clockwise as seen from outside*, so the triangles are wound `0,2,1 / 0,3,2` via the local `quad()` helper. Winding them the other way renders every partial block (bed, pressure plate, lever, button, piston head) inside-out — the top face gets culled and you see the bottom plate through it, which reads as a hollow trough. The single-quad emitters (trapdoor panel, redstone wire, torch flame tip) are *not* routed through `quad()` and still use the plain `0,1,2 / 0,2,3` push.
- **Pets are hostile *kinds*.** `isPet()` is `tamed && ownerName === 'player'` minus wolf/cat/horse, but a pet zombie still hits `MOB_STATS[kind].hostile`. Every "scan for a hostile to bite" loop must skip `m === self` and `m.tamed`, or pets bite themselves to death (3 dmg/0.7 s). `catch-throw-test.mjs` guards this.
- **Wild mob ↔ pet combat** uses `Entity.foe` (a wild hostile's non-player quarry) alongside `Entity.target` (a pet's quarry). `clearFoe()` drops both references when an entity is removed; forget that and mobs chase ghosts.
- **Persistence**: RLE chunk diffs + state in IndexedDB across 3 slots (`Persistence.ts`, `SaveState`). When you add persistent state, extend `SaveState` and both the save and load paths.
- **Dev URL hooks**: `#night` starts just after sundown; `#debugmobs` spawns tameable/rideable mobs at spawn, stocks a tool kit, builds a torch pillar + a full 2-block bed; `#debugcatch` stocks catchers/amethyst and lines up throwable targets (zombie, creeper, skeleton, spider + a cow for the bounce case). Note `#debugmobs` places the bed directly in front of the player, which occludes forward screenshots — pan or reposition when capturing mobs. Both hooks expose `window.__game` / `window.__B`.
- **`GameUIState.sleeping`** is frame-driven from `main.updateSleep(dt)`: 0–1.2 s lying awake, 1.2–1.9 s fade to black, night skips at 1.9 s, 1.9–2.7 s fade in, wake at 2.7 s. `leaveBed()` can cancel at any point (Leave Bed button / Esc), which is why the fade is an opacity the loop sets rather than a chain of `setTimeout`s.

## Testing

Headless harnesses (`node <name>.mjs`) boot the game in Edge/SwiftShader and fail on any console error:
- `smoke-test.mjs` — boot + create world + assert no console errors (run this after engine changes).
- `persist-test.mjs` — save/quit/reload position restoration.
- `ride-test.mjs`, `held-test.mjs`, `sleep-test.mjs`, `mob-test.mjs`, `visual-test.mjs` — feature-specific screenshot checks.
- `catch-test.mjs` (direct capture/release/recall API) and `catch-throw-test.mjs` (the thrown orb end-to-end, plus the pet self-damage guard) — both assert, not just screenshot.
- `verify-bed-catcher.mjs` — bed model from four angles/facings, sprite sheet at 8x, held bed + orb, bed screen. Builds its arena on a **stone platform at y=108** so framing is identical whatever world the fresh Playwright profile rolled — terrain-relative arenas produce camera-buried screenshots.

Two harness gotchas worth remembering: editing `src/` while a harness runs triggers a Vite HMR reload that wipes `window.__game` mid-test, and a zombie/skeleton spawned under open sky in daylight burns away before a thrown orb reaches it (set `g.dayTime = 0.72` first).

Pure-logic unit tests bundle with esbuild to `t.mjs` then run under node (RLE codec, recipes, smelting, torch flood-fill) — see the Tests section of `README.md` for exact commands. `t.mjs` is a throwaway bundle output; don't commit meaningful work to it.

When adding a feature, prefer adding/extending a `.mjs` harness and capturing a screenshot to confirm rendering, then clean up `shot-*.png` before committing.

## Current status (2026-07)

Latest pass — thrown mob catcher + bed/sleep rework:
- **Catcher is a projectile** (`EntityManager` kind `'catcher'`, `throwCatcher`/`updateCatcher`/`resolveCatcherHit`). Right-click throws; `CATCH_SLACK = 0.85` expands the mob AABB for the hit test; block hits, timeouts and animal bounces all drop the orb back as a pickup. Point-blank right-click on your own pet still recalls without a throw (`Player.use` handles that before throwing). `CAPTURABLE` is now every hostile kind, including the two flyers.
- **Pet combat is two-sided**: wild hostiles pick a pet as `foe` and melee/shoot it, `hurt()` wires up mutual aggro, hostile arrows/fireballs damage pets, and pets regen between fights. Flying pets use `updateFlyingPet` (escort overhead, dive/fireball the target). Pets persist via `SaveState.pets` + `savePets`/`loadPets`, show in a HUD roster (`HUD.updatePets` ← `EntityManager.petStatus`), and toggle stay/follow through `interactMob`.
- **Bed**: dedicated `bed` item sprite (icon + extruded held model), head-half top texture with a full-width painted pillow matching a 1.5/16 raised pillow box, and the `emitBox` winding fix that finally makes partial-block top faces visible.
- **Sleep** follows vanilla: dusk→pre-dawn window or thunderstorm, 8-block monster check, obstruction check, bed explodes outside the Overworld, lying-in-bed camera + Leave Bed button, weather cleared on waking.

Earlier polish passes: chunk fade-in, 3D extruded held/dropped items, wall-mounted torches, ambient particles, mob shadows, breeding + babies, horse riding, wolf/cat taming, bed sleep-to-morning, mob-silhouette recognizability pass + beveled tool/weapon sprites. Before those: chunk fade-in, 3D extruded held/dropped items, wall-mounted torches, ambient particles, mob shadows, breeding + babies, horse riding, wolf/cat taming, bed sleep-to-morning, mob-silhouette recognizability pass + beveled tool/weapon sprites. Newest additions:
- **Player armor** (`Blocks.ts` `armor` field, `Inventory.armor[4]`, `Player.equipArmor/damageArmor`): 12 pieces (leather/iron/diamond × helmet/chest/legs/boots), 4%/point damage reduction (cap 80%), durability, HUD armor bar, inventory armor column, right-click to equip.
- **Flowing water** (`World.ts` `waterLevels` + `tickWater`, a pull-model cellular automaton ticked ~5 Hz from `main.tick20`): sources spread/recede; absent-from-map water = permanent source. **Bucket** (`Player.tryScoopWater/tryPlaceWater`) scoops/pours sources. Swimming hops you onto 1-block ledges; touching water cancels fall damage.
- **Title screen**: unlimited named worlds (IndexedDB keyed by name) with create/delete + UI sounds.

## Directions for further improvement

Backlog ideas, roughly highest-value first — confirm scope with the user before large ones:

- **Performance**: the chunk mesher and lighting flood-fill run on the main thread; moving meshing to a Web Worker would cut frame hitches at higher render distance. The bundle is ~730 kB — consider code-splitting if startup matters.
- **More mob fidelity**: idle head-tracking for passive mobs, baby-animal proportions/sounds, mob sounds on breed, drowning/falling mob reactions.
- **World depth**: villages with villager trading UI, mineshafts/ravines, more biomes (jungle, mesa, swamp), structures with loot tables.
- **Redstone-lite**: levers/buttons/doors wiring, pressure plates (doors already exist).
- **Decoration**: item frames, paintings, signs, banners — all paintable with the existing procedural pipeline.
- **Combat/progression**: enchanting-lite, hunger-tuned regen, more hostile variety (player armor now exists).
- **Lava + buckets**: a lava fluid reusing the water automaton, lava bucket, water+lava → stone/obsidian.
- **UX**: crafting recipe book/search, achievements UI polish (`Advancements.ts` exists), controller/touch input.
- **Tech debt**: `EntityManager.ts` (2.1k lines) and `main.ts` (1.2k) are large — consider splitting mob definitions and the game-state machine into their own modules when next touching them.
