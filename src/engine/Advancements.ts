// Advancements: a lightweight milestone tracker. Each advancement has an id,
// a display name + description, optional prerequisites, and a predicate the
// game calls to test completion. The HUD shows a toast on unlock and a full
// list panel (press L).

export interface AdvancementDef {
  id: string;
  label: string;
  desc: string;
  /** icon emoji shown in the toast + panel */
  icon: string;
  /** ids that must be unlocked first */
  requires?: string[];
}

export const ADVANCEMENTS: AdvancementDef[] = [
  { id: 'root', label: 'Voxelcraft', desc: 'The beginning of your adventure', icon: '🌱' },
  { id: 'punch_wood', label: 'Getting Wood', desc: 'Break a log block', icon: '🪵', requires: ['root'] },
  { id: 'planks', label: 'Time to Mine!', desc: 'Craft a crafting table', icon: '🪓', requires: ['punch_wood'] },
  { id: 'stone_age', label: 'Stone Age', desc: 'Craft a stone pickaxe', icon: '⛏️', requires: ['planks'] },
  { id: 'iron_age', label: 'Iron Age', desc: 'Smelt an iron ingot', icon: '🔧', requires: ['stone_age'] },
  { id: 'diamonds', label: 'Diamonds!', desc: 'Mine a diamond ore', icon: '💎', requires: ['iron_age'] },
  { id: 'bed', label: 'Home Sweet Home', desc: 'Set your spawn with a bed', icon: '🛏️', requires: ['planks'] },
  { id: 'farm', label: 'Sow the Seeds', desc: 'Plant wheat seeds on farmland', icon: '🌾', requires: ['planks'] },
  { id: 'bread', label: 'Bake Bread', desc: 'Craft a loaf of bread', icon: '🍞', requires: ['farm'] },
  { id: 'bow', label: 'Take Aim', desc: 'Craft a bow', icon: '🏹', requires: ['iron_age'] },
  { id: 'kill_mob', label: 'Monster Hunter', desc: 'Defeat a hostile mob', icon: '⚔️', requires: ['root'] },
  { id: 'creeper', label: 'Boom.', desc: 'Survive (or cause) an explosion', icon: '💥', requires: ['root'] },
  { id: 'dungeon', label: 'Treasure Hunter', desc: 'Loot a generated chest', icon: '🗝️', requires: ['root'] },
  { id: 'door', label: 'Knock Knock', desc: 'Place or open a wooden door', icon: '🚪', requires: ['planks'] },
  { id: 'thunder', label: 'Storm Chaser', desc: 'Witness a lightning strike', icon: '⚡', requires: ['root'] },
  { id: 'survive_night', label: 'Survivor', desc: 'Live through a full night', icon: '🌙', requires: ['root'] },
  { id: 'fish', label: 'Catch of the Day', desc: 'Reel in a fish with a fishing rod', icon: '🐟', requires: ['root'] },
  { id: 'wolf', label: 'Best Friends Forever', desc: 'Tame a wolf with bones', icon: '🐺', requires: ['root'] },
  { id: 'catch', label: 'Monster Wrangler', desc: 'Capture a hostile mob with a mob catcher', icon: '🔮', requires: ['root'] },
  { id: 'trade', label: 'What a Deal!', desc: 'Trade with a villager', icon: '💱', requires: ['root'] },
  { id: 'village', label: 'Civilization', desc: 'Discover a village', icon: '🏘️', requires: ['root'] },
  { id: 'iron_pick', label: "Isn't It Iron Pick", desc: 'Craft an iron pickaxe', icon: '⛏️', requires: ['iron_age'] },
  { id: 'suit_up', label: 'Suit Up', desc: 'Put on a piece of armor', icon: '🛡️', requires: ['root'] },
  { id: 'diamond_armor', label: 'Cover Me with Diamonds', desc: 'Wear a piece of diamond armor', icon: '💠', requires: ['suit_up'] },
  { id: 'shield_block', label: 'Not Today, Thank You', desc: 'Deflect a blow with a shield', icon: '🛡️', requires: ['root'] },
  { id: 'hot_stuff', label: 'Hot Stuff', desc: 'Fill a bucket with lava', icon: '🪣', requires: ['iron_age'] },
  { id: 'milk', label: 'Moo Juice', desc: 'Milk a cow with a bucket', icon: '🥛', requires: ['root'] },
  { id: 'shear', label: 'Snip Snip', desc: 'Shear a sheep for its wool', icon: '✂️', requires: ['root'] },
  { id: 'golden_apple', label: 'Apple of My Eye', desc: 'Eat a golden apple', icon: '🍎', requires: ['root'] },
  { id: 'spyglass', label: 'Is It a Bird?', desc: 'Look through a spyglass', icon: '🔭', requires: ['root'] },
  { id: 'critical', label: 'Critical Hit', desc: 'Land a critical hit on a mob', icon: '✨', requires: ['root'] },
  // building + decoration pass
  { id: 'builder', label: 'Master Builder', desc: 'Craft slabs or stairs', icon: '🧱', requires: ['planks'] },
  { id: 'lantern', label: 'Light the Way', desc: "Craft a lantern or a jack o'lantern", icon: '🏮', requires: ['planks'] },
  { id: 'dye', label: 'A Splash of Colour', desc: 'Dye a block of wool', icon: '🎨', requires: ['root'] },
  { id: 'flower_pot', label: 'Green Thumb', desc: 'Pot a plant in a flower pot', icon: '🪴', requires: ['root'] },
  { id: 'compost', label: 'Waste Not', desc: 'Fill a composter to make bone meal', icon: '♻️', requires: ['farm'] },
  { id: 'campfire', label: 'Cookout', desc: 'Cook food on a campfire', icon: '🔥', requires: ['root'] },
  { id: 'baker', label: 'Sweet Tooth', desc: 'Eat a cookie, pumpkin pie or mushroom stew', icon: '🍪', requires: ['farm'] },
  { id: 'bake_cake', label: 'The Cake Is Real', desc: 'Bake a cake', icon: '🎂', requires: ['farm'] },
  { id: 'cake', label: 'Piece of Cake', desc: 'Eat a slice of cake', icon: '🍰', requires: ['root'] },
  { id: 'potion', label: 'Local Brewery', desc: 'Drink a potion', icon: '🧪', requires: ['root'] },
  { id: 'xp_10', label: 'Seasoned', desc: 'Reach experience level 10', icon: '🟢', requires: ['root'] },
  { id: 'ench_table', label: 'Enchanter', desc: 'Craft an enchanting table', icon: '📖', requires: ['diamonds'] },
  { id: 'enchant', label: 'Arcane Arts', desc: 'Enchant an item', icon: '🔮', requires: ['root'] },
  { id: 'anvil', label: 'Good as New', desc: 'Mend a tool on an anvil', icon: '⚒️', requires: ['iron_age'] },
  { id: 'cartographer', label: 'Cartographer', desc: 'Craft an explorer map', icon: '🗺️', requires: ['root'] },
  { id: 'glide', label: 'Sky Is the Limit', desc: 'Soar on a glider', icon: '🪂', requires: ['root'] },
  { id: 'warp', label: 'Blink', desc: 'Teleport with a warp pearl', icon: '🌀', requires: ['root'] },
];

export class AdvancementTracker {
  private unlocked = new Set<string>();
  /** queued toasts the HUD will display: id + wall-clock time unlocked */
  pendingToasts: { id: string; label: string; icon: string }[] = [];
  onChange: () => void = () => {};

  isUnlocked(id: string): boolean { return this.unlocked.has(id); }

  /** Attempt to unlock an advancement; returns true if newly unlocked. */
  unlock(id: string): boolean {
    if (this.unlocked.has(id)) return false;
    const def = ADVANCEMENTS.find((a) => a.id === id);
    if (!def) return false;
    // prerequisites
    if (def.requires) for (const r of def.requires) if (!this.unlocked.has(r)) return false;
    this.unlocked.add(id);
    this.pendingToasts.push({ id, label: def.label, icon: def.icon });
    this.onChange();
    return true;
  }

  /** Pop the next toast for the HUD, or null. */
  popToast(): { id: string; label: string; icon: string } | null {
    return this.pendingToasts.shift() ?? null;
  }

  count(): { done: number; total: number } {
    return { done: this.unlocked.size, total: ADVANCEMENTS.length };
  }

  /** All defs with current unlocked state, for the panel. */
  list(): (AdvancementDef & { done: boolean })[] {
    return ADVANCEMENTS.map((a) => ({ ...a, done: this.unlocked.has(a.id) }));
  }

  serialize(): string[] { return [...this.unlocked]; }
  load(ids: string[]): void {
    this.unloaded = new Set(ids);
    this.unlocked = new Set(ids);
  }
  /** carry-over from load so unlock() can re-fire newly-earned ones */
  unloaded: Set<string> = new Set();
}
