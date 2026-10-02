import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';
import { hashValue } from '../src/canon.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'sched-hist-'));
}

const MACHINE_A = { kind: 'setMachine', id: 'MA', machine: { id: 'MA', calendar: [[0, 480]] } };
const MACHINE_B = { kind: 'setMachine', id: 'MB', machine: { id: 'MB', calendar: [[0, 240], [480, 960]] } };
const ORDER_W1 = {
  kind: 'setOrder',
  order: { id: 'W1', product: 'P1', priority: 2, ops: [{ machine: 'MA', duration: 30 }] },
};

test('3 commits, 2 undos, 1 redo: state, snapshot hash and audit chain consistent', () => {
  const dir = tmpdir();
  let store = Store.init(dir);

  store.commit([MACHINE_A]); // A (seq 1)
  store.commit([MACHINE_B]); // B (seq 2)
  const hashAfterB = hashValue(store.state);
  store.commit([ORDER_W1]); // C (seq 3)

  store.undo(); // undoes C (seq 4)
  store.undo(); // undoes B (seq 5)
  store.redo(); // re-applies B (seq 6)

  // State equals the state right after commit B.
  assert.equal(hashValue(store.state), hashAfterB);
  assert.deepEqual(Object.keys(store.state.machines).sort(), ['MA', 'MB']);
  assert.deepEqual(Object.keys(store.state.orders), []);

  // Undo appends compensation records; nothing is erased.
  assert.equal(store.records.length, 6);
  assert.deepEqual(store.records.map((r) => r.kind), ['commit', 'commit', 'commit', 'undo', 'undo', 'redo']);

  const chainBefore = store.auditChain();
  const snap = store.snapshot();
  const stateHashBefore = hashValue(store.state);

  // Reopen from disk: state, snapshot hash and audit chain fully consistent.
  const reopened = Store.open(dir);
  assert.equal(hashValue(reopened.state), stateHashBefore);
  assert.equal(hashValue(reopened.state), hashAfterB);
  assert.deepEqual(reopened.auditChain(), chainBefore);

  const index = JSON.parse(fs.readFileSync(path.join(dir, 'snapshots', 'index.json'), 'utf8'));
  const latest = index.snapshots[index.snapshots.length - 1];
  assert.equal(latest.stateHash, snap.stateHash);
  assert.equal(latest.stateHash, stateHashBefore);
  assert.equal(latest.logOffset, fs.statSync(path.join(dir, 'journal.log')).size);

  // Effective history is exactly commits A and B.
  const stack = reopened.effectiveStack();
  assert.equal(stack.length, 2);
  assert.equal(stack[0].seq, 1);
  assert.equal(stack[1].seq, 2);
});

test('undo of undo restores via redo only when tail has not diverged', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.commit([MACHINE_A]);
  store.commit([MACHINE_B]);
  store.undo();
  assert.deepEqual(Object.keys(store.state.machines), ['MA']);
  store.redo();
  assert.deepEqual(Object.keys(store.state.machines).sort(), ['MA', 'MB']);

  // Diverge: new commit after an undo invalidates redo.
  store.undo();
  store.commit([ORDER_W1]);
  assert.throws(() => store.redo(), (e) => e.code === 'E_DIVERGED');
});

test('inverse ops are generated for every change kind', () => {
  const dir = tmpdir();
  const store = Store.init(dir);
  store.commit([MACHINE_A, { kind: 'setChangeover', machine: 'MA', from: 'P1', to: 'P2', minutes: 7 }, { kind: 'setBudget', budget: 100 }]);
  store.commit([ORDER_W1]);
  store.undo();
  store.undo();
  assert.deepEqual(store.state.machines, {});
  assert.deepEqual(store.state.changeovers, {});
  assert.equal(store.state.budget, null);
});
