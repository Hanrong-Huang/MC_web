// Lightweight Node-side fire lifecycle regression. Bundle with esbuild, then
// run under Node; no DOM, renderer, or browser is required.
import { B } from './src/engine/Blocks.ts';
import { FireSystem } from './src/engine/Fire.ts';
import type { World } from './src/engine/World.ts';

const cells = new Map<string, number>([
  ['0,0,0', B.AIR],
  ['1,0,0', B.BARREL],
]);
const burnt: Array<[number, number, number, number]> = [];
let canAdvance = false;
const world = {
  dimension: 'overworld',
  getBlock: (x: number, y: number, z: number): number => cells.get(`${x},${y},${z}`) ?? B.AIR,
  setBlock: (x: number, y: number, z: number, id: number): boolean => {
    cells.set(`${x},${y},${z}`, id);
    return true;
  },
  getChunk: (): { ready: boolean } => ({ ready: true }),
} as unknown as World;

const fire = new FireSystem(world, {
  canAdvance: () => canAdvance,
  rainingAt: () => false,
  igniteTnt: () => {},
  burnBlock: (x, y, z, id) => {
    burnt.push([x, y, z, id]);
    cells.set(`${x},${y},${z}`, B.AIR);
  },
});

if (!fire.ignite(0, 0, 0)) throw new Error('test fire did not ignite');
fire.tick(10);
if (burnt.length !== 0 || cells.get('0,0,0') !== B.FIRE) {
  throw new Error('non-authority advanced a shared fire');
}
console.log('PASS non-authority leaves shared fire untouched');
canAdvance = true;
fire.tick(10);
if (burnt.length !== 1 || burnt[0].join(',') !== `1,0,0,${B.BARREL}`) {
  throw new Error(`burn hook mismatch: ${JSON.stringify(burnt)}`);
}
console.log('PASS fire delegates flammable block destruction to lifecycle hook');

const remoteCells = new Map<string, number>([['2,0,0', B.FIRE]]);
const remoteWorld = {
  dimension: 'overworld',
  getBlock: (x: number, y: number, z: number): number => remoteCells.get(`${x},${y},${z}`) ?? B.AIR,
  setBlock: () => true,
  getChunk: (): { ready: boolean } => ({ ready: true }),
} as unknown as World;
const remoteFire = new FireSystem(remoteWorld, {
  rainingAt: () => false,
  igniteTnt: () => {},
  burnBlock: () => {},
});
if (!remoteFire.ignite(2, 0, 0) || remoteFire.count !== 1) {
  throw new Error('existing remote FIRE block was not registered');
}
console.log('PASS existing remote fire is registered for later authority handoff');
