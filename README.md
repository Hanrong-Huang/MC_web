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
| Double-tap **W** | Sprint |
| **Shift** | Sneak (you won't fall off edges) |
| **Left click** | Mine blocks / attack |
| **Right click** | Place blocks · use items · open chests and furnaces · eat · draw a bow · block with a shield |
| **Middle click** | Pick the block you're looking at |
| **E** | Inventory and crafting |
| **1–9** / scroll | Choose hotbar slot |
| **Q** / **Ctrl+Q** | Drop one item / the whole stack |
| **T** | Chat |
| **Tab** (hold) | Player list |
| **F** | Fly (Creative) |
| **H** | Controls help |
| **F1** / **F2** | Hide the HUD / save a screenshot |
| **F3** | Debug info |
| **Esc** | Pause, options and save |

Every key above except the hotbar, Esc and F1–F3 can be rebound in **Options → Key Binds**. There is also **Sneak: Hold / Toggle**, and an optional Sprint key (unbound by default). Ctrl is deliberately not used for movement, because the browser closes the tab on Ctrl+W.

## What you can do

- **Explore** a big, varied world: plains, meadows, flower and dark forests, savanna, jungles, swamps, deserts, badlands mesas, snowy taiga, ice spikes and mountains. Look for volcanoes, craters, sky islands, stone arches, cliff waterfalls, geodes and lush caves.
- **Discover buildings** with loot: villages, temples, mineshafts, shipwrecks, a woodland mansion, raider outposts, lighthouses, windmill farms, river forts, sunken ruins, an underground library and a deep ancient vault.
- **Survive** your health, hunger and the night. Zombies, skeletons, creepers and spiders come out after dark.
- **Craft** tools from wood up to diamond, plus armor, a bow and a shield. Brew potions and enchant your gear with experience. The recipe book shows what you can make.
- **Build** with bricks, stone bricks, slabs, stairs, fences, glass panes, colored wool, terracotta, ice, lanterns and more. Wire up redstone: levers, buttons, pressure plates, torches, repeaters, comparators, observers, daylight detectors, lamps, pistons and tunable note blocks. Open iron doors with a button, or light the TNT. Lay rails (powered, detector and activator too) and ride minecarts.
- **Farm and tame**: grow wheat, pumpkins and melons, bake cake, breed animals, tame wolves and cats, ride horses, shear sheep and chase rabbits.
- **Catch mobs** with the Mob Catcher: throw the orb, watch it wobble and click, then release the mob as a loyal pet that fights beside you.
- **Swim** in water that streams downhill and down waterfalls, reflects the sky and splashes when you dive in.
- **Glide, map and warp**: fly with a glider and fireworks, chart the land with a map and teleport with warp pearls.
- **Venture to the Nether** through an obsidian portal of any size. Cross lava oceans in the Nether Wastes, Crimson and Warped Forests, Soul Sand Valley and Basalt Deltas. Raid fortresses and bastions, barter gold with piglins, ride striders over lava, and face blazes, wither skeletons, hoglins and magma cubes. Climb weeping and twisting vines (shears keep them whole, bone meal grows them), saw crimson and warped stems into fireproof planks for slabs, stairs, fences, gates, doors and trapdoors, mine ancient debris for netherite gear, and set your Nether spawn with a respawn anchor.
- **Relax** to music and ambient sound that follow the biome, weather and time of day: cozy rain, howling blizzards, waves, birdsong and echoing caves. The music is composed live and played on real sampled piano, harp, flute, cello and strings.

## Play together (multiplayer)

### Join the online world

There is one shared, always-on world everyone can join. Nothing to install:

1. Open **[the game](https://hanrong-huang.github.io/MC_web/)**.
2. On the **Multiplayer** card, type **Your Name** and press **Join Server**. Leave **Server Address** blank to join the online world.
3. You spawn in the shared world. Anyone else online shows up with their name above their head.

In game: **T** to chat and hold **Tab** for the player list. Type commands in chat; `/help` lists the ones you can use:

| Command | What it does |
|---|---|
| `/tp <player>` | Teleport to a player |
| `/sethome` · `/home` | Save this spot as your home · go back to it |
| `/spawn` | Go to the world spawn |
| `/msg <player> <text>` | Whisper to one player |
| `/list` | Who's online |
| `/login <password>` | Become an admin (the server owner has the password) |

Admins also get: `/tp <player> <player>`, `/tp [player] <x> <y> <z>` (`~` = relative), `/tphere <player>`, `/time set day|noon|night|midnight`, `/weather clear|rain|thunder`, `/gamemode survival|creative [player]`, `/give <player> <item> [count]`, `/heal [player]`, `/setspawn`, `/kick <player>`, `/op` · `/deop <player>`, `/say <text>`, `/seed`.

Single-player worlds have the same kind of commands (`/help` in chat): `/tp <x> <y> <z>`, `/sethome`, `/home`, `/spawn`, `/time`, `/weather`, `/gamemode`, `/give <item> [count]`, `/heal`, `/seed`.

**What is shared:** the world (every block anyone places, breaks or uses: doors, levers, chests and their contents, TNT craters), the day/night clock, chat and each other's players with name tags. The night is skipped once everyone in the Overworld is in bed.

**Your progress:** your inventory, position and spawn are saved on the server under **your name**. Use the same name next time to carry on. There are no passwords, so anyone typing your name gets your character.

**Not shared yet:** mobs, animals and weather are still simulated separately in each player's game.

> **Mainland China:** if **Join Server** can't connect, the server's `*.workers.dev` address is being blocked on your network. See [Hosting the online world](#hosting-the-online-world-cloudflare) for serving it from a custom domain.

#### 联机玩法（中文）

1. 打开 **[游戏页面](https://hanrong-huang.github.io/MC_web/)**。
2. 在 **Multiplayer** 卡片里填上 **Your Name**（你的名字），点 **Join Server**。Server Address 留空，就是加入在线世界。
3. 进去后就在同一个世界里了，其他玩家头顶会显示名字。

游戏里按 **T** 聊天，按住 **Tab** 看在线玩家。在聊天框输入命令，`/help` 会列出你能用的命令：

- `/tp <玩家名>` 传送到某个玩家身边
- `/sethome` 把当前位置设为家，`/home` 回家
- `/spawn` 回到出生点
- `/msg <玩家名> <内容>` 私聊
- `/list` 看谁在线
- `/login <密码>` 成为管理员（密码在服主那里）。管理员还能用 `/time`、`/weather`、`/gamemode`、`/give`、`/heal`、`/tphere`、`/kick`、`/setspawn` 等，输入 `/help` 查看全部。
你的背包、位置和出生点按**名字**保存在服务器上，下次用同一个名字就能接着玩。没有密码，别人用你的名字也能进你的角色。

### Hosting the online world (Cloudflare)

The game is served from GitHub Pages and the world runs on Cloudflare as a Worker + Durable Object (`worker/index.ts`), on the free plan. It is live at `wss://voxelcraft.voxelcraft.workers.dev`. The Pages build bakes that address in from the repo variable `VITE_MP_SERVER`, which is why the Multiplayer card needs no address.

- **Deploy server changes:** `npx wrangler login` once, then `npm run worker:deploy`. To make pushes to `main` deploy it automatically, add the repo secrets `CLOUDFLARE_API_TOKEN` (a token from the *Edit Cloudflare Workers* template) and `CLOUDFLARE_ACCOUNT_ID`. Without them the *Deploy multiplayer server* workflow only type-checks.
- **Move the world to another server:** change the `VITE_MP_SERVER` variable (Settings → Secrets and variables → Actions → Variables) and re-run *Deploy site*. A direct link also works: `https://hanrong-huang.github.io/MC_web/?server=wss://…`.
- **Admin password** (for `/login`) is the Worker secret `ADMIN_PASSWORD`: set or change it with `npx wrangler secret put ADMIN_PASSWORD`.
- **World settings** live in `wrangler.toml` (`MODE`, `SEED`, `MAX_PLAYERS`, `WORLD_NAME`). With nobody online the world sleeps and the day clock pauses. The free plan comfortably covers a group of friends playing a few hours a day; see Cloudflare's pricing page for the daily request and storage-write limits.
- **Mainland China:** `*.workers.dev` is often blocked there. Add a domain to the Cloudflare account and attach it to the Worker under *Workers & Pages → voxelcraft → Settings → Domains & Routes → Custom domain* (e.g. `mc.example.com`). Then point `VITE_MP_SERVER` at `wss://mc.example.com` and re-run *Deploy site*.
- `npm run worker:dev` runs the same server locally on port 8787.

### Host it yourself

For a private world (LAN party, or a server you control), one person runs the server and everyone else joins it from their browser.

**1. Start the server** (needs [Node.js](https://nodejs.org) 18+):

```bash
npm install
npm run server          # builds the game, then serves it + the world on port 8080
```

It prints something like `play: http://localhost:8080/`. The world is saved in `server-data/world.json` (every 30 s and on Ctrl+C) and keeps going between sessions.

**2. Join.** Open the server's address in a browser, fill in **Your Name** on the **Multiplayer** card and press **Join Server**. Leave **Server Address** blank when the page came from the server itself.

- **Same Wi-Fi / LAN:** friends open `http://<the host's LAN IP>:8080/`, e.g. `http://192.168.1.23:8080/` (on Windows, `ipconfig` shows the IP; allow Node through the firewall if asked).
- **Over the internet:** forward TCP port 8080 on the router to the host, or expose it with a tunnel such as `cloudflared tunnel --url http://localhost:8080` or `ngrok http 8080`, then share the https link it prints. It can also run on any small VPS or container host (Fly.io, Railway, …) with `npm run server`.
- The Play-now page on GitHub Pages can also join a server: type its address (e.g. `wss://your-tunnel.example.com`) into **Server Address**.

Server options (environment variables): `PORT` (8080), `WORLD` (world file name), `SEED`, `MODE` (`survival`/`creative` for new players), `MAX_PLAYERS` (16), `DATA_DIR`, `ADMIN_PASSWORD` (for `/login`; if unset, a random one is printed when the server starts). The chat commands are the ones listed above.

## Run it locally

```bash
npm install
npm run dev        # open the printed localhost URL
```

`npm run build` type-checks the project and outputs a static site to `dist/`. Every push to `main` deploys it to GitHub Pages.

Built from scratch with **TypeScript + Three.js**. Three.js is only the WebGL wrapper; the world generation, meshing, lighting, physics, mob AI, crafting and saving are all hand-written. Contributor notes are in [`CLAUDE.md`](CLAUDE.md).
