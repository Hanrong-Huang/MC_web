import assert from 'node:assert/strict';
import { WorldCore, newWorld, type Socket } from './server/core';
import { B, I } from './src/engine/Blocks';
import { World } from './src/engine/World';
import { NetSync } from './src/net/NetSync';
import type { NetClient } from './src/net/NetClient';
import { PROTOCOL, type CellState, type ClientMsg, type PlayerSave, type ServerMsg } from './src/net/protocol';

class TestSocket implements Socket {
  open = true;
  readonly messages: ServerMsg[] = [];

  send(data: string): void { this.messages.push(JSON.parse(data) as ServerMsg); }
  close(): void { this.open = false; }
  clear(): void { this.messages.length = 0; }
}

const core = new WorldCore(newWorld(123, 'survival'), { world: 'test', maxPlayers: 4 });
const aSock = new TestSocket();
const bSock = new TestSocket();
const a = core.connect(aSock);
const b = core.connect(bSock);
core.message(a, JSON.stringify({ t: 'hello', v: PROTOCOL, name: 'Alice' }));
core.message(b, JSON.stringify({ t: 'hello', v: PROTOCOL, name: 'Bob' }));
aSock.clear();
bSock.clear();

const key = '4,70,4';
const fullKey = `overworld|${key}`;
const baseline: CellState = {
  d: 'overworld', k: key, id: B.CHEST,
  be: { type: 'chest', slots: [{ id: B.DIRT, count: 1 }] },
};
core.message(a, JSON.stringify({ t: 'cells', cells: [baseline] }));
aSock.clear();
bSock.clear();

core.message(a, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: key, req: 1 }));
const aGrant = aSock.messages.find((m) => m.t === 'container');
assert(aGrant?.t === 'container' && aGrant.ok, 'first editor should acquire the lease');
assert.deepEqual(aGrant.cell, baseline, 'grant should include the authoritative cell');
assert(aSock.messages.some((m) => m.t === 'containerLock' && m.k === key && m.owner === a.id),
  'the owner should receive the live lock announcement');
assert(bSock.messages.some((m) => m.t === 'containerLock' && m.k === key && m.owner === a.id),
  'peers should learn the lock before attempting local destruction');

// A retry can reach the server after the first grant was delayed in transit.
// It must be idempotent and echo the new request token without toggling the
// shared lock, otherwise the late first response can invalidate the new UI.
aSock.clear();
bSock.clear();
core.message(a, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: key, req: 2 }));
const retryGrant = aSock.messages.find((m) => m.t === 'container');
assert(retryGrant?.t === 'container' && retryGrant.ok && retryGrant.req === 2,
  'same-owner retry should keep the lease and echo its request token');
assert.equal(aSock.messages.some((m) => m.t === 'containerLock'), false,
  'same-owner retry must not rebroadcast or toggle the lock');
assert.equal(bSock.messages.some((m) => m.t === 'containerLock'), false,
  'peers should not observe a lock transition for an idempotent retry');

// Even the lease owner may not bypass the atomic path with an ordinary AIR
// cell while a grant is pending/open. This is the server-side backstop for a
// local mine, explosion, or fire racing the container UI.
aSock.clear();
bSock.clear();
core.message(a, JSON.stringify({
  t: 'cells', cells: [{ d: 'overworld', k: key, id: B.AIR } satisfies CellState],
}));
assert.deepEqual(core.data.cells.get(fullKey), baseline,
  'the owner ordinary-cell stream must not destroy its leased container');
const ownerCorrection = aSock.messages.find((m) => m.t === 'cells' && m.from === 0);
assert(ownerCorrection?.t === 'cells' && ownerCorrection.cells[0]?.id === B.CHEST,
  'the owner should receive the authoritative container after a rejected bypass');
assert.equal(bSock.messages.some((m) => m.t === 'cells'), false,
  'a rejected owner bypass must not be broadcast');

bSock.clear();
core.message(b, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: key, req: 1 }));
const bDenied = bSock.messages.find((m) => m.t === 'container');
assert(bDenied?.t === 'container' && !bDenied.ok, 'second editor must be denied');
assert.equal(bDenied.owner, 'Alice');
bSock.clear();

const aliceEdit: CellState = {
  ...baseline,
  be: { type: 'chest', slots: [] },
};
const aliceSave: PlayerSave = {
  gameMode: 'survival', player: { hp: 20 }, inventory: { slots: [{ id: B.DIRT, count: 1 }] }, dimension: 'overworld',
};
aSock.clear();
bSock.clear();
core.message(a, JSON.stringify({ t: 'containerCommit', cell: aliceEdit, save: aliceSave }));
assert.deepEqual(core.data.cells.get(fullKey), aliceEdit);
assert.deepEqual(core.data.players.get('Alice'), aliceSave,
  'container and player halves should be accepted by the same handler');
assert(core.dirtyCells.has(fullKey) && core.dirtyPlayers.has('Alice'),
  'both rows should be queued for the same persistence flush');
const atomicRelay = bSock.messages.find((m) => m.t === 'cells');
assert(atomicRelay?.t === 'cells' && atomicRelay.cells[0]?.be?.type === 'chest',
  'an accepted atomic commit should still publish its cell to peers');

const rejectedSave: PlayerSave = {
  gameMode: 'survival', player: { hp: 1 }, inventory: { slots: [{ id: 99, count: 99 }] }, dimension: 'overworld',
};
bSock.clear();
core.message(b, JSON.stringify({ t: 'containerCommit', cell: baseline, save: rejectedSave }));
assert.deepEqual(core.data.cells.get(fullKey), aliceEdit, 'a non-owner commit must not change the container');
assert.equal(core.data.players.has('Bob'), false, 'a non-owner commit must not save its matching inventory');

// A malformed block entity must not poison the authoritative cell or get
// paired with the attacker's player snapshot. Exercise structural, stack
// metadata and block/entity-kind failures while Alice owns this lease.
const beforeBadCell = core.data.cells.get(fullKey);
const beforeBadSave = core.data.players.get('Alice');
const badCells: CellState[] = [
  { ...aliceEdit, be: { type: 'chest', slots: new Array(28).fill(null) } },
  { ...aliceEdit, be: { type: 'chest', slots: [{ id: B.DIRT, count: 1.5 }] } },
  { ...aliceEdit, be: { type: 'chest', slots: [{ id: I.IRON_PICK, count: 1, dur: 999999 }] } },
  { ...aliceEdit, be: { type: 'chest', slots: [{ id: I.IRON_PICK, count: 1, ench: { efficiency: 99 } }] } },
  { ...aliceEdit, id: B.FURNACE, be: { type: 'chest', slots: [] } },
];
for (const badCell of badCells) {
  core.dirtyCells.clear();
  core.dirtyPlayers.clear();
  bSock.clear();
  core.message(a, JSON.stringify({ t: 'containerCommit', cell: badCell, save: rejectedSave }));
  assert.strictEqual(core.data.cells.get(fullKey), beforeBadCell, 'bad block entity must not replace the world cell');
  assert.strictEqual(core.data.players.get('Alice'), beforeBadSave, 'bad block entity must not save the paired player state');
  assert.equal(core.dirtyCells.size, 0, 'bad block entity must not dirty a cell');
  assert.equal(core.dirtyPlayers.size, 0, 'bad block entity must not dirty a player');
  assert.equal(bSock.messages.some((m) => m.t === 'cells'), false, 'bad block entity must not be relayed');
}

aSock.clear();
bSock.clear();

const unrelated: CellState = { d: 'overworld', k: '5,70,4', id: 3 };
core.message(b, JSON.stringify({ t: 'cells', cells: [baseline, unrelated] }));
assert.deepEqual(core.data.cells.get(fullKey), aliceEdit, 'stale editor must not overwrite the leased cell');
assert.deepEqual(core.data.cells.get('overworld|5,70,4'), unrelated, 'unlocked cells in the batch still apply');
const correction = bSock.messages.find((m) => m.t === 'cells' && m.from === 0);
assert(correction?.t === 'cells' && correction.cells.length === 1);
assert.deepEqual(correction.cells[0], aliceEdit, 'rejected writer receives the authoritative rollback');
const relayed = aSock.messages.find((m) => m.t === 'cells');
assert(relayed?.t === 'cells' && relayed.cells.length === 1);
assert.deepEqual(relayed.cells[0], unrelated, 'only accepted cells are broadcast');

core.message(a, JSON.stringify({ t: 'container', op: 'close', d: 'overworld', k: key }));
assert(bSock.messages.some((m) => m.t === 'containerLock' && m.k === key && m.owner === null),
  'releasing a lease should be broadcast');
bSock.clear();
core.message(b, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: key, req: 2 }));
const bGrant = bSock.messages.find((m) => m.t === 'container');
assert(bGrant?.t === 'container' && bGrant.ok, 'close should release the lease');
assert.deepEqual(bGrant.cell, aliceEdit);

const freshKey = '8,70,8';
bSock.clear();
core.message(b, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: freshKey, req: 3 }));
const freshGrant = bSock.messages.find((m) => m.t === 'container');
assert(freshGrant?.t === 'container' && freshGrant.ok && !freshGrant.cell,
  'an unseen generated container can be leased before its baseline exists');
const freshBaseline: CellState = {
  d: 'overworld', k: freshKey, id: B.CHEST,
  be: { type: 'chest', slots: [{ id: 4, count: 2 }] },
};
const bobSave: PlayerSave = {
  gameMode: 'survival', player: { hp: 20 }, inventory: { slots: [] }, dimension: 'overworld',
};
core.message(b, JSON.stringify({ t: 'containerCommit', cell: freshBaseline, save: bobSave }));
aSock.clear();
core.message(a, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: freshKey, req: 2 }));
const freshDenied = aSock.messages.find((m) => m.t === 'container');
assert(freshDenied?.t === 'container' && !freshDenied.ok);
assert.deepEqual(freshDenied.cell, freshBaseline, 'the owner-published baseline becomes authoritative');

core.disconnect(b);
const cSock = new TestSocket();
const c = core.connect(cSock);
core.message(c, JSON.stringify({ t: 'hello', v: PROTOCOL, name: 'Cara' }));
cSock.clear();
core.message(c, JSON.stringify({ t: 'container', op: 'open', d: 'overworld', k: freshKey, req: 1 }));
const cGrant = cSock.messages.find((m) => m.t === 'container');
assert(cGrant?.t === 'container' && cGrant.ok, 'disconnect should release the lease');

aSock.clear();
cSock.clear();
const destroyed: CellState = { d: 'overworld', k: freshKey, id: 0 };
core.message(a, JSON.stringify({ t: 'cells', cells: [destroyed] }));
assert.deepEqual(core.data.cells.get(`overworld|${freshKey}`), freshBaseline,
  'a non-owner must not destroy a leased container');
const destructionCorrection = aSock.messages.find((m) => m.t === 'cells' && m.from === 0);
assert(destructionCorrection?.t === 'cells' && destructionCorrection.cells[0].be,
  'a racing destroyer receives the authoritative container rollback');
assert.equal(cSock.messages.some((m) => m.t === 'cells'), false,
  'a rejected destruction must not be broadcast');

const caraSave: PlayerSave = {
  gameMode: 'survival', player: { hp: 18 }, inventory: { slots: [{ id: 4, count: 2 }] }, dimension: 'overworld',
};
aSock.clear();
cSock.clear();
core.message(c, JSON.stringify({ t: 'containerCommit', cell: destroyed, save: caraSave }));
assert.deepEqual(core.data.cells.get(`overworld|${freshKey}`), destroyed,
  'the lease owner may commit real destruction');
assert.deepEqual(core.data.players.get('Cara'), caraSave,
  'owner destruction and its player snapshot commit together');
const destructionRelay = aSock.messages.find((m) => m.t === 'cells');
assert(destructionRelay?.t === 'cells' && destructionRelay.cells[0].id === 0,
  'accepted owner destruction is broadcast');

aSock.clear();
core.disconnect(c);
assert(aSock.messages.some((m) => m.t === 'containerLock' && m.k === freshKey && m.owner === null),
  'disconnect should broadcast lease release');

// Pending furnace rewards are part of the authoritative block entity. Older
// snapshots may omit them, while malformed or inflated rewards are rejected.
const rewardKey = '12,70,12';
const rewardCell: CellState = {
  d: 'overworld', k: rewardKey, id: B.FURNACE,
  be: {
    type: 'furnace', input: null, fuel: null, output: { id: I.IRON_INGOT, count: 1 },
    burn: 0, burnTotal: 0, cook: 0, pendingXp: 1, pendingIron: true,
  },
};
core.message(a, JSON.stringify({ t: 'cells', cells: [rewardCell] }));
assert.deepEqual(core.data.cells.get(`overworld|${rewardKey}`), rewardCell,
  'valid pending furnace rewards should survive server validation');
for (const badReward of [
  { pendingXp: 129 },
  { pendingXp: 0.5 },
  { pendingIron: 'yes' },
]) {
  const badRewardCell: CellState = { ...rewardCell, be: { ...rewardCell.be!, ...badReward } };
  core.message(a, JSON.stringify({ t: 'cells', cells: [badRewardCell] }));
  assert.deepEqual(core.data.cells.get(`overworld|${rewardKey}`), rewardCell,
    'invalid pending furnace rewards must not replace the authoritative cell');
}

// Client-side guard: the requested cell is protected before the grant, and an
// unrelated/late reply must not apply its stale authoritative snapshot.
const clientMessages: ClientMsg[] = [];
const mockClient = {
  id: 77,
  send: (msg: ClientMsg): boolean => { clientMessages.push(msg); return true; },
} as unknown as NetClient;
const clientSync = new NetSync(new World(456), mockClient, {
  ignite: () => false,
  redstoneUpdate: () => {},
});
let appliedReplies = 0;
clientSync.applyRemote = () => { appliedReplies++; };
const clientKey = '3,70,3';
void clientSync.acquireContainer('overworld', clientKey);
assert.equal(clientSync.isContainerProtected('overworld', clientKey), true,
  'a pending open request must protect the cell from local destruction');
const clientOpen = clientMessages.find((m): m is Extract<ClientMsg, { t: 'container'; op: 'open' }> =>
  m.t === 'container' && m.op === 'open');
assert(clientOpen, 'client should send an open request');
clientSync.handleContainer({
  t: 'container', d: 'overworld', k: clientKey, req: clientOpen.req, ok: true,
  cell: { d: 'overworld', k: clientKey, id: B.CHEST, be: { type: 'chest', slots: [] } },
});
assert.equal(appliedReplies, 1, 'the matching grant should apply its authoritative snapshot');
assert.equal(clientSync.isContainerProtected('overworld', clientKey), true,
  'the held lease must continue protecting the cell');
appliedReplies = 0;
clientSync.handleContainer({
  t: 'container', d: 'overworld', k: clientKey, req: clientOpen.req + 1, ok: true,
  cell: { d: 'overworld', k: clientKey, id: B.AIR },
});
assert.equal(appliedReplies, 0, 'a stale or unrelated grant must not overwrite the open container');
clientSync.releaseContainer('overworld', clientKey);
assert.equal(clientSync.isContainerProtected('overworld', clientKey), false,
  'local protection should end after releasing an unannounced lease');

console.log('container-lock-test: all lease/concurrency cases passed');
