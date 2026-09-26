# Voxelcraft

A Minecraft-style sandbox that runs in your browser. Explore, mine, craft, build and survive in an endless procedurally generated world, with nothing to install.

### ▶ [Play now: hanrong-huang.github.io/MC_web](https://hanrong-huang.github.io/MC_web/)

Works in any modern desktop browser. Phones and tablets get touch controls. Textures, mobs and sounds are generated in code; the music is composed in code and played on a mix of synth voices and real sampled instruments (piano, harp, flute, cello, strings — see [CREDITS.md](CREDITS.md)).

## Getting started

1. Open the link above and create a world. Pick **Survival** for the full challenge or **Creative** to build freely.
2. Click the game to capture the mouse. Press **Esc** at any time to pause.
3. On your first day, punch a tree for logs, craft planks and a crafting table, make a wooden pickaxe, and build a shelter before night falls.

Your worlds are saved in your browser automatically (every 60 s, and when you choose **Save & Quit**).

## Controls

| Key | Action |
|---|---|
| **WASD** + mouse | Move and look |
| **Space** | Jump (swim up / fly up) |
| **Shift** or double-tap **W** | Sprint |
| **Ctrl** | Sneak (you won't fall off edges) |
| **Left click** | Mine blocks / attack |
| **Right click** | Place blocks · use items · open chests and furnaces · eat · draw a bow · block with a shield |
| **Middle click** | Pick the block you're looking at |
| **E** | Inventory and crafting |
| **1–9** / scroll | Choose hotbar slot |
| **Q** / **Ctrl+Q** | Drop one item / the whole stack |
| **F** | Fly (Creative) |
| **H** | Controls help |
| **F1** / **F2** | Hide the HUD / save a screenshot |
| **F3** | Debug info |
| **Esc** | Pause, options and save |

## What you can do

- **Explore** a big, varied world: plains, meadows, flower and dark forests, savanna, jungles, swamps, deserts, badlands mesas, snowy taiga, ice spikes and mountains. Look for volcanoes, craters, sky islands, stone arches, cliff waterfalls, geodes and lush caves.
- **Discover buildings** with loot: villages, temples, mineshafts, shipwrecks, a woodland mansion, raider outposts, lighthouses, windmill farms, river forts, sunken ruins, an underground library and a deep ancient vault.
- **Survive** your health, hunger and the night. Zombies, skeletons, creepers and spiders come out after dark.
- **Craft** tools from wood up to diamond, plus armor, a bow and a shield. Brew potions and enchant your gear with experience. The recipe book shows what you can make.
- **Build** with bricks, stone bricks, slabs, stairs, fences, glass panes, colored wool, terracotta, ice, lanterns and more. Wire up redstone: levers, buttons, pressure plates, torches, repeaters, lamps, pistons and tunable note blocks. Open iron doors with a button, or light the TNT.
- **Farm and tame**: grow wheat, pumpkins and melons, bake cake, breed animals, tame wolves and cats, ride horses, shear sheep and chase rabbits.
- **Catch mobs** with the Mob Catcher: throw the orb, watch it wobble and click, then release the mob as a loyal pet that fights beside you.
- **Swim** in water that streams downhill and down waterfalls, reflects the sky and splashes when you dive in.
- **Glide, map and warp**: fly with a glider and fireworks, chart the land with a map and teleport with warp pearls.
- **Venture to the Nether** through an obsidian portal of any size. Cross lava oceans in the Nether Wastes, Crimson and Warped Forests, Soul Sand Valley and Basalt Deltas. Raid fortresses and bastions, barter gold with piglins, ride striders over lava, and face blazes, wither skeletons, hoglins and magma cubes. Climb weeping and twisting vines (shears keep them whole, bone meal grows them), saw crimson and warped stems into fireproof planks for slabs, stairs, fences, gates, doors and trapdoors, mine ancient debris for netherite gear, and set your Nether spawn with a respawn anchor.
- **Relax** to music and ambient sound that follow the biome, weather and time of day: cozy rain, howling blizzards, waves, birdsong and echoing caves. The music is composed live and played on real sampled piano, harp, flute, cello and strings.

## Run it locally

```bash
npm install
npm run dev        # open the printed localhost URL
```

`npm run build` type-checks the project and outputs a static site to `dist/`. Every push to `main` deploys it to GitHub Pages.

Built from scratch with **TypeScript + Three.js**. Three.js is only the WebGL wrapper; the world generation, meshing, lighting, physics, mob AI, crafting and saving are all hand-written. Contributor notes are in [`CLAUDE.md`](CLAUDE.md).
