# Voxelcraft

A Minecraft-style sandbox that runs in your browser. Explore, mine, craft, build and survive in an endless procedurally generated world, with nothing to install.

### ▶ [Play now: hanrong-huang.github.io/MC_web](https://hanrong-huang.github.io/MC_web/)

Works in any modern desktop browser. Phones and tablets get touch controls. Every texture, mob, sound and music track is generated in code, with no downloaded assets.

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
| **F3** | Debug info |
| **Esc** | Pause, options and save |

## What you can do

- **Explore** varied biomes, including plains, forests, deserts, snowy mountains, jungles, swamps and oceans. You'll also find caves, rivers, villages, temples, ruins, mineshafts and shipwrecks.
- **Survive** your health, hunger and the night. Zombies, skeletons, creepers and spiders come out after dark.
- **Craft** tools from wood up to diamond, plus armor, food, a bow and arrows, a shield, beds, chests, furnaces and more. The recipe book shows what you can make.
- **Farm and tame**: grow wheat, carrots and potatoes; breed animals; tame wolves and cats; ride horses; shear sheep.
- **Catch mobs** with the Mob Catcher, a thrown orb that traps hostile mobs so you can release them as loyal pets that fight beside you.
- **Build** with a huge block palette, doors, ladders, torches, redstone levers and lamps, pistons and TNT.
- **Venture to the Nether** through an obsidian portal.
- **Relax** to generative music and ambient sound that change with the biome, the weather and the time of day.

## Run it locally

```bash
npm install
npm run dev        # open the printed localhost URL
```

`npm run build` type-checks the project and outputs a static site to `dist/`. Every push to `main` deploys it to GitHub Pages.

Built from scratch with **TypeScript + Three.js**. Three.js is only the WebGL wrapper; the world generation, meshing, lighting, physics, mob AI, crafting and saving are all hand-written. Contributor notes are in [`CLAUDE.md`](CLAUDE.md).
