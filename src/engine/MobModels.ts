// Procedural mob models: hierarchical box-limb meshes with painted 8x8 skins,
// sized from the vanilla model boxes (1 model pixel = 1/16 block). Split out of
// EntityManager, which owns spawning, AI and the per-frame animation.
//
// Skins stay clean: a flat base colour, gentle top-lit vertical shading and
// sparse low-contrast speckle. Faces, spots and markings are painted on top;
// silhouette features (snouts, horns, wattles, wool) are extra boxes.

import * as THREE from 'three';
import type { MobKind } from './EntityManager';

/** Model pixel (vanilla mob models are authored on a 16 px/block grid). */
const P = 1 / 16;

/** Mob skins render a touch brighter than their paint so they hold up against
 *  the baked-light terrain (Lambert sides otherwise read muddy grey). */
export const MOB_EXPOSURE = 1.18;

export interface LimbSet {
  legs: THREE.Group[];
  arms?: THREE.Group[];
  head?: THREE.Group;
  /** swaying tail (wolf, horse, cat) */
  tail?: THREE.Object3D;
  /** axis the tail swings around: 'y' for a tail held out back, 'z' for one that hangs */
  tailAxis?: 'y' | 'z';
  /** group bobbed gently while idle (body breathing) */
  body?: THREE.Object3D;
  /** ear groups (wolf, cat) for occasional twitches */
  ears?: THREE.Object3D[];
  /** chicken wings: flap when falling / startled */
  wings?: THREE.Group[];
  /** eyes that blink: each face material with its open/closed textures */
  faces?: { mat: THREE.MeshLambertMaterial; open: THREE.Texture; closed: THREE.Texture; angry?: THREE.Texture }[];
  /** the sheep's fleece layer (hidden once sheared) */
  wool?: THREE.Object3D[];
  /** collar shown while tamed (wolf, cat) */
  collar?: THREE.Object3D;
  /** leg length in blocks: short legs step faster for the same ground speed */
  legLen: number;
  /** skeleton bow (drawn while aiming) */
  bow?: THREE.Object3D;
}

/** Horse coat palettes: [body, speckle, mane/tail]. */
export const HORSE_COATS: [string, string, string][] = [
  ['#6b4a2b', '#5a3d22', '#2a1a0e'], // brown
  ['#d8c8a8', '#c8b894', '#8a6a44'], // creamy
  ['#3a2c22', '#2c2018', '#161009'], // black
  ['#a06038', '#8a4f2c', '#e8d8b0'], // chestnut, flaxen mane
  ['#cfcfcf', '#bcbcbc', '#9a9a9a'], // white/grey
];

/** Cat coat palettes: [body, speckle, belly/paws]. */
export const CAT_COATS: [string, string, string][] = [
  ['#3a3530', '#2a2520', '#e8e4da'], // tuxedo
  ['#e0913e', '#c2762c', '#f4dcb0'], // ginger tabby
  ['#ede0c8', '#dccfb4', '#fbf6ea'], // siamese (dark points painted on)
  ['#2a2a2a', '#1c1c1c', '#3a3a3a'], // black
];

/** Sheep fleece colours [base, speckle] with vanilla-ish natural spawn weights. */
export const SHEEP_COATS: [string, string, number][] = [
  ['#f1f1ec', '#e2e2dc', 81.8], // white
  ['#a8a8a2', '#9a9a94', 5],    // light grey
  ['#55595c', '#4b4f52', 5],    // grey
  ['#26262b', '#1d1d22', 5],    // black
  ['#86582f', '#774d28', 3],    // brown
  ['#f2a3bc', '#e493ad', 0.2],  // pink (rare!)
];

/** Rabbit coats: [fur, speckle, belly/tail]. Brown, white (snow), gold
 *  (desert), black-and-white, salt-and-pepper. */
export const RABBIT_COATS: [string, string, string][] = [
  ['#8a6a4c', '#7a5c40', '#e8dccb'],
  ['#f0f0ec', '#e2e2dc', '#ffffff'],
  ['#d9b77a', '#c9a669', '#f3e6c6'],
  ['#2a2a2a', '#1f1f1f', '#f0f0ec'],
  ['#7a766e', '#66625a', '#d6d2c8'],
];

/** Villager outfits: [robe, robe speckle, trim]. */
export const VILLAGER_OUTFITS: [string, string, string][] = [
  ['#6e4c31', '#62432b', '#4a3222'], // plains (brown robe)
  ['#7d5b37', '#6f5030', '#d9c168'], // farmer (straw hat)
  ['#e6dfd0', '#d8d0bf', '#a8322e'], // librarian (white robe, red trim)
  ['#6f3a86', '#62327a', '#e0b84a'], // cleric (purple, gold trim)
  ['#6b4a31', '#5e412b', '#2b2b2e'], // smith (black apron)
];

/** Roll a coat/outfit variant for a freshly spawned mob. */
export function rollVariant(kind: MobKind): number {
  if (kind === 'horse') return (Math.random() * HORSE_COATS.length) | 0;
  if (kind === 'cat') return (Math.random() * CAT_COATS.length) | 0;
  if (kind === 'villager') return (Math.random() * VILLAGER_OUTFITS.length) | 0;
  if (kind === 'rabbit') return (Math.random() * RABBIT_COATS.length) | 0;
  if (kind === 'sheep') {
    const total = SHEEP_COATS.reduce((s, c) => s + c[2], 0);
    let r = Math.random() * total;
    for (let i = 0; i < SHEEP_COATS.length; i++) { r -= SHEEP_COATS[i][2]; if (r <= 0) return i; }
  }
  return 0;
}

/** "#rrggbb" -> [r,g,b]. */
function hexRgb(h: string): [number, number, number] {
  const n = parseInt(h.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
const clamp255 = (v: number) => Math.max(0, Math.min(255, Math.round(v)));

type Ctx = CanvasRenderingContext2D;
/** Paint a w×h pixel block. */
function px(ctx: Ctx, col: string, x: number, y: number, w = 1, h = 1): void {
  ctx.fillStyle = col;
  ctx.fillRect(x, y, w, h);
}

export class MobModels {
  private skinCache = new Map<string, THREE.Texture>();

  /** 8×8 skin: flat base + gentle top-lit shading + sparse speckle, then an
   *  optional paint pass for faces/markings. Cached by key. */
  skin(key: string, base: string, speckle: string, paint?: (ctx: Ctx) => void, speckRate = 0.12): THREE.Texture {
    const cached = this.skinCache.get(key);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d')!;
    const [br, bg, bb] = hexRgb(base);
    const [sr, sg, sb] = hexRgb(speckle);
    let s = 7;
    for (let i = 0; i < key.length; i++) s = (s * 31 + key.charCodeAt(i)) % 2147483647;
    s = s || 1;
    const rng = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    for (let y = 0; y < 8; y++) {
      const shade = 1 + (3.5 - y) / 3.5 * 0.1; // lighter up top, darker low
      for (let x = 0; x < 8; x++) {
        const speck = rng() < speckRate;
        const f = shade * (1 + (rng() - 0.5) * 0.05);
        const r = speck ? sr : br, gg = speck ? sg : bg, b = speck ? sb : bb;
        ctx.fillStyle = `rgb(${clamp255(r * f)},${clamp255(gg * f)},${clamp255(b * f)})`;
        ctx.fillRect(x, y, 1, 1);
      }
    }
    if (paint) paint(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace; // painted in sRGB; linear read washed every mob out
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.skinCache.set(key, tex);
    return tex;
  }

  private mat(tex: THREE.Texture, mats: THREE.MeshLambertMaterial[]): THREE.MeshLambertMaterial {
    const m = new THREE.MeshLambertMaterial({ map: tex });
    m.color.setScalar(MOB_EXPOSURE);
    mats.push(m);
    return m;
  }

  /** Face material with a blink frame: `paint(ctx, closed)` draws the face with
   *  the eyes open or shut. Registers the pair on `limbs.faces`. */
  private face(key: string, base: string, speckle: string, paint: (ctx: Ctx, closed: boolean) => void,
    mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>): THREE.MeshLambertMaterial {
    const open = this.skin(key, base, speckle, (ctx) => paint(ctx, false));
    const closed = this.skin(key + '_blink', base, speckle, (ctx) => paint(ctx, true));
    const m = this.mat(open, mats);
    (limbs.faces ??= []).push({ mat: m, open, closed });
    return m;
  }

  /** Unlit material (glowing eyes stay bright at night). */
  private glow(tex: THREE.Texture): THREE.MeshBasicMaterial {
    return new THREE.MeshBasicMaterial({ map: tex, transparent: true, alphaTest: 0.3 });
  }

  private box(w: number, h: number, d: number, mat: THREE.Material | THREE.Material[],
    x = 0, y = 0, z = 0): THREE.Mesh {
    const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
    m.position.set(x, y, z);
    return m;
  }

  /** Six-face material list with a distinct front (-z) face. */
  private front(side: THREE.Material, face: THREE.Material): THREE.Material[] {
    return [side, side, side, side, side, face];
  }

  /** Leg pivot at the hip so sine swings look right. */
  private leg(w: number, len: number, mat: THREE.Material | THREE.Material[], x: number, hipY: number, z: number, d = w): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, hipY, z);
    g.add(this.box(w, len, d, mat, 0, -len / 2, 0));
    return g;
  }

  /** Transparent 8×8 overlay texture (eye glints, markings on a plane). */
  private overlay(key: string, paint: (ctx: Ctx) => void): THREE.Texture {
    const cached = this.skinCache.get(key);
    if (cached) return cached;
    const c = document.createElement('canvas');
    c.width = 8; c.height = 8;
    const ctx = c.getContext('2d')!;
    paint(ctx);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    this.skinCache.set(key, tex);
    return tex;
  }

  build(kind: MobKind, variant = 0): { mesh: THREE.Group; limbs: LimbSet; mats: THREE.MeshLambertMaterial[] } {
    const g = new THREE.Group();
    const mats: THREE.MeshLambertMaterial[] = [];
    const limbs: Partial<LimbSet> = {};
    const done = (l: Omit<LimbSet, 'faces'>): { mesh: THREE.Group; limbs: LimbSet; mats: THREE.MeshLambertMaterial[] } =>
      ({ mesh: g, limbs: { ...limbs, ...l } as LimbSet, mats });

    switch (kind) {
      case 'pig': return this.pig(g, mats, limbs, done, variant);
      case 'cow': return this.cow(g, mats, limbs, done, variant);
      case 'sheep': return this.sheep(g, mats, limbs, done, variant);
      case 'chicken': return this.chicken(g, mats, limbs, done, variant);
      case 'rabbit': return this.rabbit(g, mats, limbs, done, variant);
      case 'bat': return this.bat(g, mats, limbs, done);
      case 'zombie': return this.zombie(g, mats, limbs, done);
      case 'skeleton': return this.skeleton(g, mats, limbs, done);
      case 'creeper': return this.creeper(g, mats, limbs, done);
      case 'spider': return this.spider(g, mats, limbs, done);
      case 'villager': return this.villager(g, mats, limbs, done, variant);
      case 'horse': return this.horse(g, mats, limbs, done, variant);
      case 'wolf': return this.wolf(g, mats, limbs, done);
      case 'cat': return this.cat(g, mats, limbs, done, variant);
      case 'cinderling': return this.cinderling(g, mats, done);
      case 'ashstalker': return this.ashstalker(g, mats, done);
      case 'emberghast': return this.emberghast(g, mats, done);
      default: return this.phantom(g, mats, done);
    }
  }

  // --- farm animals -------------------------------------------------------------

  private pig(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant = 0): Built {
    // climate variants: temperate pink, warm ginger with dark spots, cold pale with grey patches
    const [pink, pinkD] = variant === 1 ? ['#d88d63', '#c97d55'] : variant === 2 ? ['#f3cfc6', '#e6bfb6'] : ['#f0a5a2', '#e2908f'];
    const spot = variant === 1 ? '#5a3424' : '#6a6260';
    const spots = variant !== 0 ? (ctx: Ctx): void => {
      px(ctx, spot, 1, 1, 2, 2); px(ctx, spot, 5, 4, 2, 1); px(ctx, spot, 6, 5, 1, 1); px(ctx, spot, 2, 6, 1, 1);
    } : undefined;
    const bodyM = this.mat(this.skin(`pig_${variant}`, pink, pinkD, spots), mats);
    const faceM = this.face(`pig_face_${variant}`, pink, pinkD, (ctx, closed) => {
      if (variant === 2) px(ctx, spot, 5, 0, 3, 2); // eye patch
      if (closed) { px(ctx, pinkD, 1, 3, 2, 1); px(ctx, pinkD, 5, 3, 2, 1); return; }
      px(ctx, '#ffffff', 1, 3); px(ctx, '#2b2530', 2, 3);   // white + pupil, like vanilla
      px(ctx, '#2b2530', 5, 3); px(ctx, '#ffffff', 6, 3);
    }, mats, limbs);
    const snoutSide = this.mat(this.skin('pig_snout', '#f5b3b0', '#eaa4a1'), mats);
    const snoutFront = this.mat(this.skin('pig_snout_f', '#f5b3b0', '#eaa4a1', (ctx) => {
      px(ctx, '#9c4f58', 1, 3, 2, 3); px(ctx, '#9c4f58', 5, 3, 2, 3); // nostrils
    }, 0), mats);
    // 10×8×16 body on 6 px legs
    g.add(this.box(10 * P, 8 * P, 16 * P, bodyM, 0, 10 * P, P));
    const head = new THREE.Group();
    head.position.set(0, 12 * P, -6 * P);
    head.add(this.box(8 * P, 8 * P, 8 * P, this.front(bodyM, faceM), 0, 0, -4 * P));
    head.add(this.box(4 * P, 3 * P, 1 * P, this.front(snoutSide, snoutFront), 0, -1.5 * P, -8.5 * P));
    g.add(head);
    const legs = [
      this.leg(4 * P, 6 * P, bodyM, -3 * P, 6 * P, -5 * P),
      this.leg(4 * P, 6 * P, bodyM, 3 * P, 6 * P, -5 * P),
      this.leg(4 * P, 6 * P, bodyM, 3 * P, 6 * P, 7 * P),
      this.leg(4 * P, 6 * P, bodyM, -3 * P, 6 * P, 7 * P),
    ];
    g.add(...legs);
    return done({ legs, head, legLen: 6 * P });
  }

  private cow(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant = 0): Built {
    // climate variants: temperate holstein, warm red-brown hereford, cold shaggy dun
    const [brown, brownD, white] = variant === 1 ? ['#8e4a2a', '#7e3f22', '#efe4d2']
      : variant === 2 ? ['#6a5440', '#5c4836', '#b8a58a'] : ['#4b3424', '#402c1e', '#ebe7df'];
    const V = `_${variant}`;
    // Holstein blotches painted into the hide (wraps every face of the torso)
    const hide = this.skin('cow' + V, brown, brownD, (ctx) => {
      if (variant === 1) { px(ctx, white, 0, 6, 8, 2); return; } // pale belly only
      px(ctx, white, 1, 1, 3, 2); px(ctx, white, 2, 3, 1, 1);
      px(ctx, white, 5, 4, 3, 3); px(ctx, white, 6, 3, 1, 1);
      px(ctx, white, 0, 6, 2, 1);
    });
    const bodyM = this.mat(hide, mats);
    const headM = this.mat(this.skin('cow_head' + V, brown, brownD, (ctx) => {
      px(ctx, white, 3, 0, 2, 3); // white blaze runs over the crown
    }), mats);
    const faceM = this.face('cow_face' + V, brown, brownD, (ctx, closed) => {
      if (variant === 1) px(ctx, white, 1, 0, 6, 8); // white-faced hereford
      else px(ctx, white, 3, 0, 2, 4);               // blaze down the forehead
      if (closed) { px(ctx, '#2e2016', 1, 3, 2, 1); px(ctx, '#2e2016', 5, 3, 2, 1); }
      else {
        px(ctx, '#ffffff', 1, 3); px(ctx, '#161111', 2, 3);
        px(ctx, '#161111', 5, 3); px(ctx, '#ffffff', 6, 3);
      }
    }, mats, limbs);
    const muzzleM = this.mat(this.skin('cow_muzzle', '#c9b3a7', '#bca498'), mats);
    const muzzleF = this.mat(this.skin('cow_muzzle_f', '#c9b3a7', '#bca498', (ctx) => {
      px(ctx, '#5a3f36', 1, 3, 2, 2); px(ctx, '#5a3f36', 5, 3, 2, 2); // nostrils
    }, 0), mats);
    const hornM = this.mat(this.skin('cow_horn', '#e0dace', '#d0c9bb', (ctx) => px(ctx, '#a8a090', 0, 0, 8, 2)), mats);
    const legM = this.mat(this.skin('cow_leg' + V, brown, brownD, (ctx) => {
      px(ctx, white, 0, 4, 8, 3);   // white socks
      px(ctx, '#2a1f18', 0, 7, 8, 1); // hooves
    }), mats);
    const udderM = this.mat(this.skin('cow_udder', '#eaa2a8', '#dc939a'), mats);

    // 12×10×18 torso on 12 px legs
    g.add(this.box(12 * P, 10 * P, 18 * P, bodyM, 0, 17 * P, P));
    g.add(this.box(4 * P, 1.5 * P, 6 * P, udderM, 0, 11.4 * P, 5 * P)); // udder
    if (variant === 2) {
      // cold-climate cattle: a shaggy coat hangs off the flanks and the neck
      const shagM = this.mat(this.skin('cow_shag', brownD, brown, undefined, 0.35), mats);
      g.add(this.box(13 * P, 4 * P, 17 * P, shagM, 0, 13 * P, 1.5 * P));
      g.add(this.box(9 * P, 5 * P, 3 * P, shagM, 0, 16 * P, -8 * P));
    }
    const head = new THREE.Group();
    head.position.set(0, 20 * P, -8 * P);
    head.add(this.box(8 * P, 8 * P, 6 * P, [headM, headM, headM, headM, headM, faceM], 0, 0, -3 * P));
    head.add(this.box(6 * P, 3 * P, 1 * P, this.front(muzzleM, muzzleF), 0, -2.5 * P, -6.5 * P));
    for (const sx of [-1, 1]) {
      const horn = new THREE.Group();
      horn.position.set(sx * 4 * P, 3 * P, -4 * P);
      horn.add(this.box(2 * P, 1 * P, 1 * P, hornM, sx * 1 * P, 0, 0));   // out...
      horn.add(this.box(1 * P, 2.5 * P, 1 * P, hornM, sx * 1.5 * P, 1.5 * P, 0)); // ...and up
      head.add(horn);
    }
    g.add(head);
    const legs = [
      this.leg(4 * P, 12 * P, legM, -4 * P, 12 * P, -6 * P),
      this.leg(4 * P, 12 * P, legM, 4 * P, 12 * P, -6 * P),
      this.leg(4 * P, 12 * P, legM, 4 * P, 12 * P, 7 * P),
      this.leg(4 * P, 12 * P, legM, -4 * P, 12 * P, 7 * P),
    ];
    g.add(...legs);
    return done({ legs, head, legLen: 12 * P });
  }

  private sheep(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant: number): Built {
    const [woolC, woolS] = SHEEP_COATS[variant] ?? SHEEP_COATS[0];
    const skinC = '#dbbfa6', skinS = '#cfb29a';
    const woolM = this.mat(this.skin(`sheep_wool_${variant}`, woolC, woolS, undefined, 0.3), mats);
    const skinM = this.mat(this.skin('sheep_skin', skinC, skinS), mats);
    const faceM = this.face('sheep_face', skinC, skinS, (ctx, closed) => {
      if (closed) { px(ctx, '#a88f7b', 1, 3, 2, 1); px(ctx, '#a88f7b', 5, 3, 2, 1); }
      else {
        px(ctx, '#ffffff', 1, 3); px(ctx, '#1d1d24', 2, 3);
        px(ctx, '#1d1d24', 5, 3); px(ctx, '#ffffff', 6, 3);
      }
      px(ctx, '#e7a1a8', 3, 5, 2, 1); // pink nose
      px(ctx, '#b99a86', 3, 6, 2, 1);
    }, mats, limbs);
    const hoofM = this.mat(this.skin('sheep_leg', skinC, skinS, (ctx) => px(ctx, '#6d5a4c', 0, 7, 8, 1)), mats);

    // shorn body 8×6×16, fleece inflated 1.75 px all round
    g.add(this.box(8 * P, 6 * P, 16 * P, skinM, 0, 15 * P, P));
    const fleece = this.box(11.5 * P, 9.5 * P, 19.5 * P, woolM, 0, 15.2 * P, P);
    g.add(fleece);
    const head = new THREE.Group();
    head.position.set(0, 18 * P, -8 * P);
    head.add(this.box(6 * P, 6 * P, 8 * P, [skinM, skinM, skinM, skinM, skinM, faceM], 0, 1 * P, -2 * P));
    // head fleece is shorter than the skull, so the face pokes out the front
    const headWool = this.box(7.2 * P, 7.2 * P, 7.2 * P, woolM, 0, 1.6 * P, -0.2 * P);
    head.add(headWool);
    g.add(head);
    const legs: THREE.Group[] = [];
    const woolParts: THREE.Object3D[] = [fleece, headWool];
    for (const [x, z] of [[-3, -5], [3, -5], [3, 7], [-3, 7]]) {
      const l = this.leg(4 * P, 12 * P, hoofM, x * P, 12 * P, z * P);
      const sleeve = this.box(5 * P, 6 * P, 5 * P, woolM, 0, -3 * P, 0); // woolly thighs
      l.add(sleeve);
      woolParts.push(sleeve);
      legs.push(l);
    }
    g.add(...legs);
    return done({ legs, head, wool: woolParts, legLen: 12 * P });
  }

  private chicken(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant = 0): Built {
    // climate variants: white leghorn, warm ginger hen, cold speckled grey
    const [white, whiteS] = variant === 1 ? ['#c9793c', '#a95f2c'] : variant === 2 ? ['#a9adb3', '#6f737a'] : ['#f6f6f2', '#e6e6e0'];
    const bodyM = this.mat(this.skin(`chicken_${variant}`, white, whiteS, undefined, variant === 2 ? 0.35 : 0.12), mats);
    const faceM = this.face(`chicken_face_${variant}`, white, whiteS, (ctx, closed) => {
      const c = closed ? whiteS : '#1b1b20';
      px(ctx, c, 0, 2, 2, closed ? 1 : 2); px(ctx, c, 6, 2, 2, closed ? 1 : 2);
    }, mats, limbs);
    const beakM = this.mat(this.skin('chk_beak', '#f2b33a', '#e3a22c'), mats);
    const wattleM = this.mat(this.skin('chk_wattle', '#d6282b', '#c42024'), mats);
    const legM = this.mat(this.skin('chk_leg', '#eaa53a', '#d8942e'), mats);

    // 6×6×8 body, 4×6×3 head perched at the front, 4×2×2 beak + red wattle
    g.add(this.box(6 * P, 6 * P, 8 * P, bodyM, 0, 8 * P, 0));
    const head = new THREE.Group();
    head.position.set(0, 9 * P, -4 * P);
    head.add(this.box(4 * P, 6 * P, 3 * P, this.front(bodyM, faceM), 0, 3 * P, -0.5 * P));
    head.add(this.box(4 * P, 2 * P, 2 * P, beakM, 0, 3 * P, -3 * P));
    head.add(this.box(2 * P, 2 * P, 2 * P, wattleM, 0, 1 * P, -2.5 * P));
    g.add(head);
    const wings: THREE.Group[] = [];
    for (const sx of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(sx * 3 * P, 11 * P, 0);      // hinge at the shoulder top
      w.add(this.box(1 * P, 4 * P, 6 * P, bodyM, sx * 0.5 * P, -2 * P, 0));
      wings.push(w);
    }
    g.add(...wings);
    const legs: THREE.Group[] = [];
    for (const sx of [-1, 1]) {
      const l = this.leg(1.2 * P, 5 * P, legM, sx * 1.5 * P, 5 * P, 1 * P);
      l.add(this.box(2 * P, 0.6 * P, 2.6 * P, legM, sx * 0.3 * P, -4.7 * P, -0.8 * P)); // splayed toes
      legs.push(l);
    }
    g.add(...legs);
    return done({ legs, head, wings, legLen: 5 * P });
  }

  // --- hostiles -----------------------------------------------------------------

  private zombie(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done): Built {
    const green = '#5f9a4c', greenS = '#528a42';
    const skinM = this.mat(this.skin('zombie', green, greenS), mats);
    const hairM = this.mat(this.skin('zombie_hair', green, greenS, (ctx) => px(ctx, '#3f6b34', 0, 0, 8, 2)), mats);
    const topM = this.mat(this.skin('zombie_top', '#3f6b34', '#365d2d'), mats);
    const faceM = this.mat(this.skin('zombie_face', green, greenS, (ctx) => {
      px(ctx, '#3f6b34', 0, 0, 8, 2);                         // hairline
      px(ctx, '#0f140e', 1, 4, 2, 1); px(ctx, '#0f140e', 5, 4, 2, 1); // hollow eyes
      px(ctx, '#3f6b34', 3, 5, 2, 1);                         // nose shadow
      px(ctx, '#2c4526', 2, 6, 4, 1);                         // slack mouth
    }), mats);
    const shirtM = this.mat(this.skin('zombie_shirt', '#27a0a2', '#20898b', (ctx) => px(ctx, '#1d7b7d', 0, 7, 8, 1)), mats);
    const pantsM = this.mat(this.skin('zombie_pants', '#463f9e', '#3c368b', (ctx) => px(ctx, '#505050', 0, 6, 8, 2)), mats);

    g.add(this.box(8 * P, 12 * P, 4 * P, shirtM, 0, 18 * P, 0));
    const head = new THREE.Group();
    head.position.set(0, 24 * P, 0);
    head.add(this.box(8 * P, 8 * P, 8 * P, [hairM, hairM, topM, skinM, hairM, faceM], 0, 4 * P, 0));
    g.add(head);
    const legs = [
      this.leg(4 * P, 12 * P, pantsM, -2 * P, 12 * P, 0),
      this.leg(4 * P, 12 * P, pantsM, 2 * P, 12 * P, 0),
    ];
    const arms: THREE.Group[] = [];
    for (const sx of [-1, 1]) {
      const a = new THREE.Group();
      a.position.set(sx * 6 * P, 22 * P, 0);
      a.add(this.box(4 * P, 4 * P, 4 * P, shirtM, 0, 0, 0));        // short sleeve
      a.add(this.box(3.9 * P, 8 * P, 3.9 * P, skinM, 0, -6 * P, 0)); // rotting arm
      a.rotation.x = Math.PI / 2;
      arms.push(a);
    }
    g.add(...legs, ...arms);
    return done({ legs, arms, head, legLen: 12 * P });
  }

  private skeleton(g: THREE.Group, mats: THREE.MeshLambertMaterial[], _limbs: Partial<LimbSet>, done: Done): Built {
    const bone = '#d6d6ce', boneS = '#c4c4bb';
    const boneM = this.mat(this.skin('skeleton', bone, boneS), mats);
    const darkM = this.mat(this.skin('skeleton_dark', '#8e8e88', '#83837d'), mats);
    const faceM = this.mat(this.skin('skeleton_face', bone, boneS, (ctx) => {
      px(ctx, '#111113', 1, 3, 2, 2); px(ctx, '#111113', 5, 3, 2, 2); // eye sockets
      px(ctx, '#56564f', 3, 5, 2, 1);                               // nasal hole
      px(ctx, '#2a2a28', 1, 6, 6, 1);                               // jaw line
      px(ctx, bone, 2, 6); px(ctx, bone, 4, 6);                     // teeth
    }), mats);

    // spine + three ribs + shoulder girdle + pelvis instead of a solid torso
    g.add(this.box(2 * P, 12 * P, 2 * P, darkM, 0, 18 * P, 1 * P));
    g.add(this.box(8 * P, 1.5 * P, 3 * P, boneM, 0, 23 * P, 0));
    for (let i = 0; i < 3; i++) g.add(this.box(7 * P, 1 * P, 3.4 * P, boneM, 0, (20.5 - i * 2.2) * P, 0));
    g.add(this.box(6 * P, 2 * P, 3 * P, boneM, 0, 12.5 * P, 0));
    const head = new THREE.Group();
    head.position.set(0, 24 * P, 0);
    head.add(this.box(8 * P, 8 * P, 8 * P, this.front(boneM, faceM), 0, 4 * P, 0));
    g.add(head);
    const legs = [
      this.leg(2 * P, 12 * P, boneM, -2 * P, 12 * P, 0),
      this.leg(2 * P, 12 * P, boneM, 2 * P, 12 * P, 0),
    ];
    const arms: THREE.Group[] = [];
    let bow: THREE.Object3D | undefined;
    for (const sx of [-1, 1]) {
      const a = new THREE.Group();
      a.position.set(sx * 5 * P, 22 * P, 0);
      a.add(this.box(2 * P, 12 * P, 2 * P, boneM, 0, -5 * P, 0));
      arms.push(a);
      if (sx === 1) {
        // bow gripped in the right hand: limbs run along the arm's local z (vertical
        // when the arm is raised) and bend back toward the archer, string taut
        const woodM = this.mat(this.skin('skel_bow', '#7a5430', '#6a4828'), mats);
        const stringM = this.mat(this.skin('skel_string', '#e6e6e6', '#d4d4d4'), mats);
        const b = new THREE.Group();
        b.position.set(0, -11 * P, 0);
        b.add(this.box(1.2 * P, 1.2 * P, 3 * P, woodM, 0, 0, 0));
        for (const sz of [-1, 1]) {
          const limb = this.box(1 * P, 1 * P, 5 * P, woodM, 0, 0.9 * P, sz * 4 * P);
          limb.rotation.x = -sz * 0.35; // tips bend back toward the archer
          b.add(limb);
          b.add(this.box(1 * P, 1 * P, 2 * P, woodM, 0, 2.6 * P, sz * 7 * P));
        }
        const str = this.box(0.35 * P, 0.35 * P, 15 * P, stringM, 0, 3.4 * P, 0);
        str.name = 'string';
        b.add(str);
        a.add(b);
        bow = b;
      }
    }
    g.add(...legs, ...arms);
    return done({ legs, arms, head, bow, legLen: 12 * P });
  }

  private creeper(g: THREE.Group, mats: THREE.MeshLambertMaterial[], _limbs: Partial<LimbSet>, done: Done): Built {
    const green = '#5aab47', greenS = '#7fcb6b';
    // blotchy two-tone camo: light speckle from skin() plus a few darker patches
    const mottle = (ctx: Ctx) => {
      px(ctx, '#3f8a34', 0, 1); px(ctx, '#3f8a34', 6, 0, 2, 1); px(ctx, '#3f8a34', 3, 4);
      px(ctx, '#3f8a34', 7, 5); px(ctx, '#3f8a34', 1, 6, 2, 1); px(ctx, '#3f8a34', 5, 7);
    };
    const skinM = this.mat(this.skin('creeper', green, greenS, mottle, 0.22), mats);
    const faceM = this.mat(this.skin('creeper_face', green, greenS, (ctx) => {
      px(ctx, '#0c0c0c', 1, 1, 2, 2); px(ctx, '#0c0c0c', 5, 1, 2, 2); // eyes
      px(ctx, '#0c0c0c', 3, 3, 2, 3);                               // mouth
      px(ctx, '#0c0c0c', 2, 4, 1, 3); px(ctx, '#0c0c0c', 5, 4, 1, 3); // frown flares
      px(ctx, '#262626', 3, 5, 2, 1);
    }, 0.22), mats);
    const footM = this.mat(this.skin('creeper_foot', green, greenS, (ctx) => px(ctx, '#3f8a34', 0, 6, 8, 2), 0.22), mats);

    g.add(this.box(8 * P, 12 * P, 4 * P, skinM, 0, 12 * P, 0));
    const head = new THREE.Group();
    head.position.set(0, 18 * P, 0);
    head.add(this.box(8 * P, 8 * P, 8 * P, this.front(skinM, faceM), 0, 4 * P, 0));
    g.add(head);
    // the four stubby feet poke out front and back of the thin torso
    const legs = [
      this.leg(4 * P, 6 * P, footM, -2 * P, 6 * P, -4 * P),
      this.leg(4 * P, 6 * P, footM, 2 * P, 6 * P, -4 * P),
      this.leg(4 * P, 6 * P, footM, 2 * P, 6 * P, 4 * P),
      this.leg(4 * P, 6 * P, footM, -2 * P, 6 * P, 4 * P),
    ];
    g.add(...legs);
    return done({ legs, head, legLen: 6 * P });
  }

  private spider(g: THREE.Group, mats: THREE.MeshLambertMaterial[], _limbs: Partial<LimbSet>, done: Done): Built {
    const dark = '#352c29', darkS = '#443934';
    const bodyM = this.mat(this.skin('spider', dark, darkS), mats);
    const backM = this.mat(this.skin('spider_back', dark, darkS, (ctx) => {
      px(ctx, '#4d403a', 3, 1, 2, 5); px(ctx, '#4d403a', 1, 3, 6, 1); // cross marking
    }), mats);
    const legM = this.mat(this.skin('spider_leg', '#2c2422', '#3a302c'), mats);
    g.add(this.box(10 * P, 8 * P, 12 * P, [bodyM, bodyM, backM, bodyM, bodyM, bodyM], 0, 9 * P, 9 * P)); // abdomen
    g.add(this.box(6 * P, 6 * P, 6 * P, bodyM, 0, 9 * P, 0));                                             // thorax
    const head = new THREE.Group();
    head.position.set(0, 9 * P, -3 * P);
    head.add(this.box(8 * P, 8 * P, 8 * P, bodyM, 0, 0, -4 * P));
    // eight eyes on an unlit overlay: two big pairs + a small row, glowing red
    const eyes = this.overlay('spider_eyes', (ctx) => {
      px(ctx, '#d11d1d', 1, 4, 2, 2); px(ctx, '#d11d1d', 5, 4, 2, 2);
      px(ctx, '#ff5a4a', 1, 4); px(ctx, '#ff5a4a', 5, 4);
      px(ctx, '#b81616', 0, 2); px(ctx, '#b81616', 2, 2); px(ctx, '#b81616', 5, 2); px(ctx, '#b81616', 7, 2);
    });
    const eyePlane = new THREE.Mesh(new THREE.PlaneGeometry(8 * P, 8 * P), this.glow(eyes));
    eyePlane.position.set(0, 0, -8.05 * P);
    eyePlane.rotation.y = Math.PI; // plane faces +z by default; flip to face forward
    head.add(eyePlane);
    g.add(head);
    // eight 16 px legs splayed like the vanilla rig: rolled 45° down, fanned in yaw
    const legs: THREE.Group[] = [];
    const fan = [Math.PI / 4, Math.PI / 8, -Math.PI / 8, -Math.PI / 4];
    const roll = [Math.PI / 4, Math.PI / 4 * 0.74, Math.PI / 4 * 0.74, Math.PI / 4];
    for (let i = 0; i < 4; i++) {
      for (const sx of [-1, 1]) {
        const lg = new THREE.Group();
        lg.position.set(sx * 4 * P, 9 * P, (2 - i) * -1 * P);
        const lm = this.box(16 * P, 2 * P, 2 * P, legM, sx * 8 * P, 0, 0);
        lg.add(lm);
        // YXZ-ish: yaw (fan) then roll the leg down toward the ground
        lg.rotation.order = 'YXZ';
        lg.rotation.y = sx * fan[i];
        lg.rotation.z = -sx * roll[i];
        lg.userData.baseY = lg.rotation.y;
        lg.userData.baseZ = lg.rotation.z;
        lg.userData.side = sx;
        legs.push(lg);
      }
    }
    g.add(...legs);
    return done({ legs, head, legLen: 8 * P });
  }

  // --- villagers & companions --------------------------------------------------------

  private villager(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant: number): Built {
    const [robe, robeS, trim] = VILLAGER_OUTFITS[variant] ?? VILLAGER_OUTFITS[0];
    const skinC = '#bd8b72', skinS = '#b17f66';
    const robeM = this.mat(this.skin(`villager_robe_${variant}`, robe, robeS, (ctx) => {
      px(ctx, trim, 0, 7, 8, 1);           // hem
      if (variant === 2 || variant === 3) px(ctx, trim, 3, 0, 2, 7); // front stole
    }), mats);
    const sleeveM = this.mat(this.skin(`villager_sleeve_${variant}`, robe, robeS), mats);
    const legM = this.mat(this.skin('villager_leg', '#4d3829', '#433125', (ctx) => px(ctx, '#2f241c', 0, 6, 8, 2)), mats);
    const headM = this.mat(this.skin('villager_head', skinC, skinS, (ctx) => px(ctx, '#5b3b2a', 0, 0, 8, 1)), mats);
    const topM = this.mat(this.skin('villager_top', '#5b3b2a', '#51352a'), mats);
    const faceM = this.face('villager_face', skinC, skinS, (ctx, closed) => {
      px(ctx, '#5b3b2a', 0, 0, 8, 1);   // hairline
      px(ctx, '#3d2a1f', 1, 2, 6, 1);   // the famous unibrow
      if (closed) { px(ctx, '#9c6f5a', 1, 3, 2, 1); px(ctx, '#9c6f5a', 5, 3, 2, 1); }
      else {
        px(ctx, '#f4f4f0', 1, 3); px(ctx, '#2f8a3a', 2, 3); // white + green iris
        px(ctx, '#2f8a3a', 5, 3); px(ctx, '#f4f4f0', 6, 3);
      }
      px(ctx, '#a37560', 2, 6, 4, 1);   // mouth shadow under the nose
    }, mats, limbs);
    const skinM = this.mat(this.skin('villager_skin', skinC, skinS), mats);

    // robe from the shoulders down to shin height; legs peek out underneath
    g.add(this.box(9 * P, 19 * P, 7 * P, robeM, 0, 14.5 * P, 0));
    if (variant === 4) g.add(this.box(7 * P, 13 * P, 0.8 * P, this.mat(this.skin('villager_apron', trim, '#232326'), mats), 0, 13 * P, -3.8 * P));
    const head = new THREE.Group();
    head.position.set(0, 24 * P, 0);
    head.add(this.box(8 * P, 10 * P, 8 * P, [headM, headM, topM, skinM, headM, faceM], 0, 5 * P, 0));
    head.add(this.box(2 * P, 4 * P, 2 * P, skinM, 0, 3 * P, -5 * P)); // big nose
    if (variant === 1) {
      // farmer's straw hat
      const straw = this.mat(this.skin('villager_straw', '#d9c168', '#c9b058', (ctx) => px(ctx, '#8a6a2a', 0, 6, 8, 1)), mats);
      head.add(this.box(14 * P, 1 * P, 14 * P, straw, 0, 10.5 * P, 0));
      head.add(this.box(8.6 * P, 3 * P, 8.6 * P, straw, 0, 11.5 * P, 0));
    }
    g.add(head);
    // folded arms: one U-shaped sleeve bar hung in front of the chest, hands in the middle
    const arms = new THREE.Group();
    arms.position.set(0, 21 * P, -1 * P);
    arms.rotation.x = 0.75;
    arms.add(this.box(4 * P, 8 * P, 4 * P, sleeveM, -6 * P, -2 * P, 0));
    arms.add(this.box(4 * P, 8 * P, 4 * P, sleeveM, 6 * P, -2 * P, 0));
    arms.add(this.box(8 * P, 4 * P, 4 * P, sleeveM, 0, -4 * P, 0));
    arms.add(this.box(4 * P, 3 * P, 1 * P, skinM, 0, -4 * P, -2.2 * P)); // clasped hands
    g.add(arms);
    const legs = [
      this.leg(4 * P, 12 * P, legM, -2 * P, 12 * P, 0),
      this.leg(4 * P, 12 * P, legM, 2 * P, 12 * P, 0),
    ];
    g.add(...legs);
    return done({ legs, head, body: arms, legLen: 12 * P });
  }

  private horse(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant: number): Built {
    const [coat, speck, mane] = HORSE_COATS[variant] ?? HORSE_COATS[0];
    const bodyM = this.mat(this.skin(`horse_${variant}`, coat, speck), mats);
    const maneM = this.mat(this.skin(`horse_mane_${variant}`, mane, mane, undefined, 0), mats);
    const legM = this.mat(this.skin(`horse_leg_${variant}`, coat, speck, (ctx) => px(ctx, '#2b2520', 0, 7, 8, 1)), mats);
    // eyes sit on the sides of a horse's head, not the front: paint mirrored
    // side textures (box +x face runs +z→-z across u, the -x face the reverse)
    const eye = (right: boolean) => (ctx: Ctx, closed: boolean) => {
      const x = right ? 5 : 1;
      if (closed) { px(ctx, speck, x, 3, 2, 1); return; }
      px(ctx, '#15100c', x, 2, 2, 2); px(ctx, '#f0ece4', right ? x : x + 1, 2);
    };
    const sideR = this.face(`horse_eye_r_${variant}`, coat, speck, eye(true), mats, limbs);
    const sideL = this.face(`horse_eye_l_${variant}`, coat, speck, eye(false), mats, limbs);
    const muzzleF = this.mat(this.skin(`horse_muzzle_${variant}`, coat, speck, (ctx) => {
      px(ctx, '#2a211a', 1, 5); px(ctx, '#2a211a', 6, 5); // nostrils
    }), mats);

    // barrel + neck + head ride in one body group (the buck-off rears it all)
    const body = new THREE.Group();
    body.add(this.box(10 * P, 10 * P, 22 * P, bodyM, 0, 17 * P, 1.5 * P));
    const head = new THREE.Group();
    head.position.set(0, 21 * P, -8 * P);          // base of the neck
    const neck = new THREE.Group();
    neck.rotation.x = -0.52;                        // neck leans forward 30°
    neck.add(this.box(5 * P, 12 * P, 7 * P, bodyM, 0, 5 * P, -1 * P));
    neck.add(this.box(2 * P, 13 * P, 3 * P, maneM, 0, 6 * P, 3.4 * P)); // mane crest
    const skull = new THREE.Group();
    skull.position.set(0, 11 * P, -2 * P);
    skull.rotation.x = 0.52 - 0.3;                  // undo the lean, then nose slightly down
    skull.add(this.box(5.6 * P, 5 * P, 7 * P, [sideR, sideL, bodyM, bodyM, bodyM, bodyM], 0, 0, -3 * P));
    skull.add(this.box(4.4 * P, 4.4 * P, 5 * P, this.front(bodyM, muzzleF), 0, -0.4 * P, -8.8 * P));
    for (const sx of [-1, 1]) skull.add(this.box(1.6 * P, 3 * P, 1 * P, bodyM, sx * 1.8 * P, 3.8 * P, 0));
    skull.add(this.box(2.2 * P, 2 * P, 3 * P, maneM, 0, 3 * P, -1.5 * P)); // forelock
    neck.add(skull);
    head.add(neck);
    body.add(head);
    g.add(body);

    const legs = [
      this.leg(4 * P, 12 * P, legM, -3.5 * P, 12 * P, -7 * P),
      this.leg(4 * P, 12 * P, legM, 3.5 * P, 12 * P, -7 * P),
      this.leg(4 * P, 12 * P, legM, 3.5 * P, 12 * P, 10 * P),
      this.leg(4 * P, 12 * P, legM, -3.5 * P, 12 * P, 10 * P),
    ];
    const tail = new THREE.Group();
    tail.position.set(0, 20.5 * P, 12.5 * P);
    tail.add(this.box(3 * P, 13 * P, 3 * P, maneM, 0, -6 * P, 0));
    tail.rotation.x = -0.35; // hangs down and out behind the rump
    g.add(tail, ...legs);
    return done({ legs, head, tail, tailAxis: 'z', body, legLen: 12 * P });
  }

  private wolf(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done): Built {
    const grey = '#a3a09c', greyS = '#8f8c88';
    const bodyM = this.mat(this.skin('wolf', grey, greyS), mats);
    const faceM = this.face('wolf_face', grey, greyS, (ctx, closed) => {
      px(ctx, '#6f6c68', 1, 2, 2, 1); px(ctx, '#6f6c68', 5, 2, 2, 1); // brows
      if (closed) { px(ctx, '#6f6c68', 1, 3, 2, 1); px(ctx, '#6f6c68', 5, 3, 2, 1); }
      else { px(ctx, '#1c1a18', 2, 3); px(ctx, '#1c1a18', 5, 3); px(ctx, '#e6e2da', 1, 3); px(ctx, '#e6e2da', 6, 3); }
    }, mats, limbs);
    // angry: scowling brows slanting in over red eyes
    limbs.faces![0].angry = this.skin('wolf_face_angry', grey, greyS, (ctx) => {
      px(ctx, '#3a3836', 1, 2); px(ctx, '#3a3836', 2, 3); px(ctx, '#3a3836', 6, 2); px(ctx, '#3a3836', 5, 3);
      px(ctx, '#d42020', 1, 3); px(ctx, '#d42020', 6, 3);
      px(ctx, '#e6e2da', 2, 5, 1, 1); px(ctx, '#e6e2da', 5, 5, 1, 1); // bared fangs
    });
    const whiteM = this.mat(this.skin('wolf_white', '#ece9e2', '#dbd7cd'), mats);
    const snoutF = this.mat(this.skin('wolf_snout_f', '#ece9e2', '#dbd7cd', (ctx) => {
      px(ctx, '#1d1b1a', 2, 0, 4, 3);  // black nose on the tip
      px(ctx, '#b8b3aa', 2, 6, 4, 1);  // mouth line
    }), mats);

    // trunk (body + chest + ruff + tail) in one group so breathing lifts it together
    const trunk = new THREE.Group();
    trunk.add(this.box(0.48, 0.4, 0.72, bodyM, 0, 0.62, 0.04));
    trunk.add(this.box(0.34, 0.3, 0.18, whiteM, 0, 0.54, -0.32));  // white bib
    trunk.add(this.box(0.46, 0.42, 0.26, bodyM, 0, 0.72, -0.28));  // shaggy ruff
    const collar = this.box(0.5, 0.09, 0.3, this.mat(this.skin('wolf_collar', '#c62e2e', '#b22626', (ctx) => px(ctx, '#e0c050', 3, 3, 2, 2)), mats), 0, 0.84, -0.3);
    collar.visible = false;
    trunk.add(collar);
    const tail = new THREE.Group();
    tail.position.set(0, 0.72, 0.3);
    tail.add(this.box(0.16, 0.16, 0.3, bodyM, 0, 0, 0.1));
    tail.add(this.box(0.14, 0.14, 0.2, bodyM, 0, 0, 0.3));
    tail.add(this.box(0.12, 0.12, 0.1, whiteM, 0, 0, 0.44));
    tail.rotation.x = 0.7;
    trunk.add(tail);

    const head = new THREE.Group();
    head.position.set(0, 0.82, -0.46);
    head.add(this.box(0.36, 0.32, 0.3, this.front(bodyM, faceM)));
    head.add(this.box(0.2, 0.15, 0.24, this.front(whiteM, snoutF), 0, -0.08, -0.26));
    const ears: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 0.12, 0.17, 0.04);
      ear.rotation.z = sx * -0.08;
      ear.add(this.box(0.11, 0.1, 0.06, bodyM));
      ear.add(this.box(0.06, 0.07, 0.06, bodyM, 0, 0.08, 0));
      head.add(ear);
      ears.push(ear);
    }
    const legs = [
      this.leg(0.14, 0.44, bodyM, -0.14, 0.44, -0.22),
      this.leg(0.14, 0.44, bodyM, 0.14, 0.44, -0.22),
      this.leg(0.14, 0.44, bodyM, 0.14, 0.44, 0.3),
      this.leg(0.14, 0.44, bodyM, -0.14, 0.44, 0.3),
    ];
    g.add(trunk, head, ...legs);
    return done({ legs, head, tail, tailAxis: 'y', body: trunk, ears, collar, legLen: 0.44 });
  }

  private cat(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant: number): Built {
    const [coat, speck, belly] = CAT_COATS[variant] ?? CAT_COATS[0];
    const tabby = variant === 1, siamese = variant === 2;
    const stripe = tabby ? '#b8662a' : siamese ? '#5a4436' : speck;
    const fur = this.skin(`cat_${variant}`, coat, speck, (ctx) => {
      if (tabby) for (let x = 0; x < 8; x += 3) px(ctx, stripe, x, 0, 1, 8); // tabby bands
    });
    const bodyM = this.mat(fur, mats);
    const faceM = this.face(`cat_face_${variant}`, coat, speck, (ctx, closed) => {
      if (siamese) px(ctx, '#5a4436', 1, 2, 6, 6);          // dark siamese mask
      if (variant === 0) px(ctx, belly, 2, 5, 4, 3);        // tuxedo muzzle
      if (closed) { px(ctx, '#1b1b1b', 1, 3, 2, 1); px(ctx, '#1b1b1b', 5, 3, 2, 1); }
      else {
        const iris = siamese ? '#5aa8e8' : '#8ed84a';
        px(ctx, iris, 1, 3, 2, 1); px(ctx, iris, 5, 3, 2, 1);
        px(ctx, '#101010', 2, 3); px(ctx, '#101010', 5, 3);  // slit pupils
      }
      px(ctx, '#e59aa0', 3, 5, 2, 1);                       // pink nose
    }, mats, limbs);
    const pointM = siamese ? this.mat(this.skin('cat_points', '#5a4436', '#4d3a2e'), mats) : bodyM;
    const pawM = this.mat(this.skin(`cat_paw_${variant}`, variant === 0 ? belly : siamese ? '#5a4436' : coat, speck,
      (ctx) => px(ctx, variant === 0 || tabby ? belly : '#4d3a2e', 0, 6, 8, 2)), mats);

    const body = new THREE.Group();
    body.add(this.box(0.28, 0.26, 0.62, bodyM, 0, 0.36, 0.05));
    const collar = this.box(0.24, 0.07, 0.2, this.mat(this.skin('cat_collar', '#2f6fd0', '#285fb8', (ctx) => px(ctx, '#e0c050', 3, 3, 2, 2)), mats), 0, 0.42, -0.32);
    collar.visible = false;
    body.add(collar);
    const head = new THREE.Group();
    head.position.set(0, 0.45, -0.32);
    head.add(this.box(0.27, 0.23, 0.24, this.front(bodyM, faceM)));
    head.add(this.box(0.14, 0.08, 0.06, this.front(siamese ? pointM : bodyM, siamese ? pointM : bodyM), 0, -0.07, -0.14)); // muzzle
    const ears: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 0.08, 0.12, -0.02);
      ear.add(this.box(0.08, 0.06, 0.05, pointM));
      ear.add(this.box(0.04, 0.05, 0.05, pointM, 0, 0.05, 0));
      head.add(ear);
      ears.push(ear);
    }
    const legs = [
      this.leg(0.09, 0.3, pawM, -0.08, 0.3, -0.18),
      this.leg(0.09, 0.3, pawM, 0.08, 0.3, -0.18),
      this.leg(0.09, 0.3, pawM, 0.08, 0.3, 0.26),
      this.leg(0.09, 0.3, pawM, -0.08, 0.3, 0.26),
    ];
    // long tail, raised with a curl at the tip
    const tail = new THREE.Group();
    tail.position.set(0, 0.44, 0.34);
    tail.add(this.box(0.07, 0.3, 0.07, siamese ? pointM : bodyM, 0, 0.13, 0));
    const tip = new THREE.Group();
    tip.position.set(0, 0.27, 0);
    tip.rotation.x = -0.6;
    tip.add(this.box(0.065, 0.2, 0.065, siamese ? pointM : bodyM, 0, 0.09, 0));
    tail.add(tip);
    tail.rotation.x = 0.55;
    g.add(body, head, tail, ...legs);
    return done({ legs, head, tail, tailAxis: 'z', body, ears, collar, legLen: 0.3 });
  }

  // --- nether + flyers (kept from the original set) -----------------------------------

  private cinderling(g: THREE.Group, mats: THREE.MeshLambertMaterial[], done: Done): Built {
    // a small upright charcoal imp: blazing eyes, ember horns, glowing chest crack
    const charM = this.mat(this.skin('cinderling', '#2a2320', '#d65a16'), mats);
    const faceM = this.mat(this.skin('cinderling_face', '#2a2320', '#d65a16', (ctx) => {
      px(ctx, '#ffd24a', 1, 2, 2, 2); px(ctx, '#ffd24a', 5, 2, 2, 2); // blazing eyes
      px(ctx, '#ff8a1a', 2, 6, 4, 1);                               // grin
    }), mats);
    const emberM = this.mat(this.skin('cinder_ember', '#ff7a1a', '#ffd24a'), mats);
    emberM.userData.ember = true; // glows bright; the charcoal hide stays dark
    g.add(this.box(0.36, 0.36, 0.26, charM, 0, 0.5, 0));
    g.add(this.box(0.1, 0.24, 0.04, emberM, 0, 0.48, -0.14)); // ember crack down the chest
    const head = new THREE.Group();
    head.position.set(0, 0.74, 0);
    head.add(this.box(0.32, 0.3, 0.3, this.front(charM, faceM)));
    for (const sx of [-1, 1]) {
      const horn = new THREE.Group();
      horn.position.set(sx * 0.1, 0.15, 0);
      horn.add(this.box(0.06, 0.12, 0.06, emberM));
      horn.add(this.box(0.05, 0.08, 0.05, emberM, sx * 0.04, 0.09, 0.02));
      horn.rotation.z = sx * -0.32; horn.rotation.x = 0.2;
      head.add(horn);
    }
    const legs = [
      this.leg(0.11, 0.3, charM, -0.1, 0.34, 0),
      this.leg(0.11, 0.3, charM, 0.1, 0.34, 0),
    ];
    for (const sx of [-1, 1]) {
      const arm = this.box(0.09, 0.28, 0.09, emberM, sx * 0.23, 0.5, 0);
      arm.rotation.z = sx * -0.1;
      g.add(arm);
    }
    g.add(head, ...legs);
    return done({ legs, head, legLen: 0.3 });
  }

  private ashstalker(g: THREE.Group, mats: THREE.MeshLambertMaterial[], done: Done): Built {
    // a charred four-legged hell-beast: ember-lit spine, glowing maw + underbelly
    const hideM = this.mat(this.skin('ashstalker', '#241e1c', '#b8501a'), mats);
    const faceM = this.mat(this.skin('ashstalker_face', '#241e1c', '#b8501a', (ctx) => {
      px(ctx, '#ffd24a', 1, 2, 2, 2); px(ctx, '#ffd24a', 5, 2, 2, 2); // eyes
      px(ctx, '#ff7a1a', 1, 6, 6, 1);                               // glowing maw
    }), mats);
    const emberM = this.mat(this.skin('ash_ember', '#ff7a1a', '#ffd24a'), mats);
    emberM.userData.ember = true;
    g.add(this.box(0.52, 0.42, 0.92, hideM, 0, 0.58, 0.05));
    g.add(this.box(0.3, 0.12, 0.66, emberM, 0, 0.4, 0.04)); // molten underbelly seam
    for (let i = 0; i < 4; i++) {
      const sp = this.box(0.08, 0.2, 0.1, emberM, 0, 0.82, -0.26 + i * 0.26);
      sp.rotation.x = -0.12;
      g.add(sp);
    }
    const head = new THREE.Group();
    head.position.set(0, 0.62, -0.5);
    head.add(this.box(0.4, 0.36, 0.34, this.front(hideM, faceM)));
    head.add(this.box(0.24, 0.18, 0.2, this.front(hideM, faceM), 0, -0.08, -0.24));
    for (const sx of [-1, 1]) {
      const ear = this.box(0.09, 0.14, 0.07, hideM, sx * 0.13, 0.24, 0.06);
      ear.rotation.z = sx * -0.2;
      head.add(ear);
    }
    const legs = [
      this.leg(0.16, 0.36, hideM, -0.18, 0.38, -0.3),
      this.leg(0.16, 0.36, hideM, 0.18, 0.38, -0.3),
      this.leg(0.16, 0.36, hideM, 0.18, 0.38, 0.34),
      this.leg(0.16, 0.36, hideM, -0.18, 0.38, 0.34),
    ];
    g.add(head, ...legs);
    return done({ legs, head, legLen: 0.36 });
  }

  private emberghast(g: THREE.Group, mats: THREE.MeshLambertMaterial[], done: Done): Built {
    // a floating charcoal cube with a molten maw and nine ember-tipped tendrils
    const charM = this.mat(this.skin('emberghast', '#2a2320', '#3a2f28'), mats);
    const faceM = this.mat(this.skin('emberghast_face', '#2a2320', '#3a2f28', (ctx) => {
      px(ctx, '#ffd24a', 1, 2, 2, 2); px(ctx, '#ffd24a', 5, 2, 2, 2);
      px(ctx, '#ff5a10', 2, 5, 4, 2);
    }), mats);
    const emberM = this.mat(this.skin('ghast_ember', '#ff7a1a', '#ffd24a'), mats);
    emberM.userData.ember = true;
    g.add(this.box(0.8, 0.8, 0.8, this.front(charM, faceM), 0, 0.7, 0));
    g.add(this.box(0.5, 0.07, 0.06, emberM, 0, 0.36, -0.4));
    const legs: THREE.Group[] = [];
    for (const lx of [-0.26, 0, 0.26]) {
      for (const lz of [-0.26, 0, 0.26]) {
        const tendril = new THREE.Group();
        tendril.position.set(lx, 0.32, lz);
        tendril.add(this.box(0.09, 0.34, 0.09, charM, 0, -0.17, 0));
        tendril.add(this.box(0.07, 0.1, 0.07, emberM, 0, -0.36, 0));
        g.add(tendril);
        legs.push(tendril);
      }
    }
    return done({ legs, legLen: 0.34 });
  }

  // --- ambient critters -----------------------------------------------------------

  private rabbit(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done, variant: number): Built {
    const [fur, furS, belly] = RABBIT_COATS[variant] ?? RABBIT_COATS[0];
    const bodyM = this.mat(this.skin(`rabbit_${variant}`, fur, furS, variant === 3 ? (ctx) => {
      px(ctx, belly, 0, 3, 8, 3); // black-and-white: a white saddle band
    } : undefined), mats);
    const faceM = this.face(`rabbit_face_${variant}`, fur, furS, (ctx, closed) => {
      if (closed) { px(ctx, furS, 1, 3, 2, 1); px(ctx, furS, 5, 3, 2, 1); }
      else {
        const eye = variant === 1 ? '#c8283a' : '#1a1414'; // white rabbits have ruby eyes
        px(ctx, eye, 1, 3, 2, 2); px(ctx, eye, 5, 3, 2, 2);
        px(ctx, '#ffffff', 1, 3); px(ctx, '#ffffff', 6, 3);
      }
      px(ctx, belly, 2, 5, 4, 3);      // pale muzzle
      px(ctx, '#e89aa6', 3, 5, 2, 1); // pink nose
    }, mats, limbs);
    const earM = this.mat(this.skin(`rabbit_ear_${variant}`, fur, furS, (ctx) => px(ctx, '#e7a9b0', 3, 1, 2, 6)), mats);
    const tailM = this.mat(this.skin(`rabbit_tail_${variant}`, belly, belly), mats);
    // a hunched 5×5×7 body sitting low on big hind feet
    const body = new THREE.Group();
    body.add(this.box(5 * P, 5 * P, 7 * P, bodyM, 0, 4.5 * P, 0.5 * P));
    body.add(this.box(3 * P, 3 * P, 2 * P, tailM, 0, 5 * P, 4.8 * P)); // cotton tail
    g.add(body);
    const head = new THREE.Group();
    head.position.set(0, 6.5 * P, -3 * P);
    head.add(this.box(5 * P, 4 * P, 5 * P, this.front(bodyM, faceM), 0, 1.5 * P, -2.5 * P));
    const ears: THREE.Object3D[] = [];
    for (const sx of [-1, 1]) {
      const ear = new THREE.Group();
      ear.position.set(sx * 1.2 * P, 3.5 * P, -2 * P);
      ear.add(this.box(1.6 * P, 5 * P, 1 * P, earM, sx * 0.3 * P, 2.5 * P, 0));
      head.add(ear);
      ears.push(ear);
    }
    g.add(head);
    // legs: short forepaws, long hind feet laid flat
    const legs = [
      this.leg(1.5 * P, 3 * P, bodyM, -1.5 * P, 3 * P, -2.5 * P),
      this.leg(1.5 * P, 3 * P, bodyM, 1.5 * P, 3 * P, -2.5 * P),
      this.leg(2 * P, 2 * P, bodyM, 2 * P, 2 * P, 2.5 * P, 5 * P),
      this.leg(2 * P, 2 * P, bodyM, -2 * P, 2 * P, 2.5 * P, 5 * P),
    ];
    g.add(...legs);
    return done({ legs, head, body, ears, legLen: 3 * P });
  }

  private bat(g: THREE.Group, mats: THREE.MeshLambertMaterial[], limbs: Partial<LimbSet>, done: Done): Built {
    const fur = '#4a3a2c', furS = '#3c2e22';
    const bodyM = this.mat(this.skin('bat', fur, furS), mats);
    const faceM = this.face('bat_face', fur, furS, (ctx, closed) => {
      const c = closed ? furS : '#101010';
      px(ctx, c, 1, 3, 2, 1); px(ctx, c, 5, 3, 2, 1);
      px(ctx, '#e8e0d0', 3, 6); px(ctx, '#e8e0d0', 4, 6); // tiny fangs
    }, mats, limbs);
    const wingM = this.mat(this.skin('bat_wing', '#2a2019', '#21190f', (ctx) => {
      px(ctx, '#3a2c20', 0, 0, 8, 1); px(ctx, '#3a2c20', 2, 0, 1, 8); px(ctx, '#3a2c20', 5, 0, 1, 8); // finger bones
    }), mats);
    const body = new THREE.Group();
    body.add(this.box(4 * P, 7 * P, 3 * P, bodyM, 0, 4 * P, 0));
    g.add(body);
    const head = new THREE.Group();
    head.position.set(0, 8 * P, 0);
    head.add(this.box(4.5 * P, 4 * P, 4 * P, this.front(bodyM, faceM), 0, 2 * P, 0));
    for (const sx of [-1, 1]) head.add(this.box(1.5 * P, 2.5 * P, 1 * P, bodyM, sx * 1.6 * P, 5 * P, 0));
    g.add(head);
    const wings: THREE.Group[] = [];
    for (const sx of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(sx * 2 * P, 7 * P, 0);
      w.add(this.box(8 * P, 7 * P, 0.6 * P, wingM, sx * 4 * P, -3 * P, 0));
      const tip = new THREE.Group();
      tip.position.set(sx * 8 * P, 0, 0);
      tip.add(this.box(6 * P, 5 * P, 0.5 * P, wingM, sx * 3 * P, -2 * P, 0));
      w.add(tip);
      wings.push(w);
    }
    g.add(...wings);
    return done({ legs: [], head, body, wings, legLen: 4 * P });
  }


  private phantom(g: THREE.Group, mats: THREE.MeshLambertMaterial[], done: Done): Built {
    const bodyM = this.mat(this.skin('phantom', '#4a5a7a', '#3c4a68'), mats);
    const faceM = this.mat(this.skin('phantom_face', '#4a5a7a', '#3c4a68', (ctx) => {
      px(ctx, '#7ee06a', 1, 3, 2, 1); px(ctx, '#7ee06a', 5, 3, 2, 1); // glowing green eyes
      px(ctx, '#1a1a24', 2, 5, 4, 1);
    }), mats);
    g.add(this.box(0.5, 0.3, 0.9, bodyM, 0, 0.2, 0));
    const tail = this.box(0.3, 0.16, 0.5, bodyM, 0, 0.22, 0.65);
    g.add(tail);
    const head = new THREE.Group();
    head.position.set(0, 0.25, -0.55);
    head.add(this.box(0.4, 0.26, 0.34, this.front(bodyM, faceM)));
    // eyes glow in the dark sky like the vanilla phantom's
    const eyes = this.overlay('phantom_eyes', (ctx) => { px(ctx, '#9cf07a', 1, 3, 2, 1); px(ctx, '#9cf07a', 5, 3, 2, 1); });
    const eyePlane = new THREE.Mesh(new THREE.PlaneGeometry(0.4, 0.26), this.glow(eyes));
    eyePlane.position.z = -0.172;
    eyePlane.rotation.y = Math.PI;
    head.add(eyePlane);
    const wings: THREE.Group[] = [];
    for (const side of [-1, 1]) {
      const w = new THREE.Group();
      w.position.set(side * 0.25, 0.3, 0);
      const wm = this.box(0.8, 0.05, 0.6, bodyM, side * 0.42, 0, 0.05);
      w.add(wm);
      const tip = this.box(0.5, 0.04, 0.4, bodyM, side * 1.05, 0, 0.12);
      w.add(tip);
      wings.push(w);
    }
    g.add(head, ...wings);
    return done({ legs: wings, head, legLen: 0.3 });
  }
}

type Built = { mesh: THREE.Group; limbs: LimbSet; mats: THREE.MeshLambertMaterial[] };
type Done = (l: Omit<LimbSet, 'faces'>) => Built;
