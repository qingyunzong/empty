import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuaranteeStore } from '../src/store.js';

const NOW = 1_000_000;
const FAR = NOW + 10_000_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cap-'));
}

// independent tree traversal: sum of exposure over all live nodes in subtree
function traversalUsed(store, id) {
  let sum = 0;
  const stack = [id];
  while (stack.length) {
    const g = store.guarantees.get(stack.pop());
    if (!g) continue;
    if (g.state === 'active') sum += g.exposure;
    for (const c of store.children.get(g.id) ?? []) stack.push(c);
  }
  return sum;
}

function assertAllLevelsConsistent(store) {
  for (const id of store.guarantees.keys()) {
    const expected = traversalUsed(store, id);
    assert.equal(store.used.get(id) ?? 0, expected, `used mismatch at ${id}`);
    const g = store.guarantees.get(id);
    assert.equal(store.remaining(id), g.cap - expected, `remaining mismatch at ${id}`);
  }
}

function buildTree(store) {
  store.issue({ id: 'R', exposure: 100, cap: 1000, terms: 'root guarantee', expiresAt: FAR, now: NOW });
  store.issue({ id: 'A', parentId: 'R', exposure: 100, cap: 500, terms: 'branch a', expiresAt: FAR, now: NOW });
  store.issue({ id: 'B', parentId: 'R', exposure: 200, cap: 400, terms: 'branch b', expiresAt: FAR, now: NOW });
  store.issue({ id: 'A1', parentId: 'A', exposure: 50, cap: 200, terms: 'leaf a1', expiresAt: FAR, now: NOW });
  store.issue({ id: 'A2', parentId: 'A', exposure: 80, cap: 200, terms: 'leaf a2', expiresAt: FAR, now: NOW });
  store.issue({ id: 'B1', parentId: 'B', exposure: 150, cap: 300, terms: 'leaf b1', expiresAt: NOW + 1000, now: NOW });
}

test('multi-branch issue: every level matches independent traversal', () => {
  const store = new GuaranteeStore(tmpdir());
  buildTree(store);
  assertAllLevelsConsistent(store);
  assert.equal(store.used.get('R'), 680); // 100+100+200+50+80+150
  assert.equal(store.remaining('R'), 320);
  assert.equal(store.remaining('A'), 270); // 500-(100+50+80)
  assert.equal(store.remaining('B'), 50); // 400-(200+150)
  assert.ok(store.verify().ok);
});

test('revoke releases only its own occupancy; parent, siblings, other branches unaffected', () => {
  const store = new GuaranteeStore(tmpdir());
  buildTree(store);
  const before = {
    A: store.used.get('A'),
    B: store.used.get('B'),
    B1: store.used.get('B1'),
    A2: store.used.get('A2'),
  };
  store.revoke('A1', NOW + 1);
  assert.equal(store.used.get('A1'), 0);
  assert.equal(store.used.get('A'), before.A - 50);
  assert.equal(store.used.get('R'), 630);
  assert.equal(store.used.get('B'), before.B, 'sibling branch untouched');
  assert.equal(store.used.get('B1'), before.B1, 'other branch leaf untouched');
  assert.equal(store.used.get('A2'), before.A2, 'sibling leaf untouched');
  assertAllLevelsConsistent(store);
  assert.ok(store.verify().ok);
});

test('expiry via sweep releases occupancy and logically deletes', () => {
  const store = new GuaranteeStore(tmpdir());
  buildTree(store);
  const expired = store.sweep(NOW + 1000); // B1 due
  assert.deepEqual(expired, ['B1']);
  assert.equal(store.guarantees.get('B1').state, 'expired');
  assert.equal(store.used.get('B'), 200);
  assert.equal(store.used.get('R'), 530);
  assertAllLevelsConsistent(store);
  // expired doc no longer searchable
  assert.deepEqual(store.phraseQuery('leaf b1'), []);
  assert.ok(store.verify().ok);
});

test('over-limit at any chain level fails; exact fit succeeds', () => {
  const store = new GuaranteeStore(tmpdir());
  buildTree(store);
  // B has 50 remaining -> 51 must fail at level B
  assert.throws(
    () => store.issue({ id: 'B2', parentId: 'B', exposure: 51, cap: 400, terms: 'x', expiresAt: FAR, now: NOW }),
    (e) => e.code === 'OVER_LIMIT',
  );
  // fits B (used 350+50=400) but would overflow R (680+50 > 1000? no) -> fits exactly at B
  store.issue({ id: 'B2', parentId: 'B', exposure: 50, cap: 400, terms: 'x', expiresAt: FAR, now: NOW });
  assert.equal(store.remaining('B'), 0);
  // root has 1000-730=270 left; a fresh deep chain exceeding root remaining must fail at R
  assert.throws(
    () => store.issue({ id: 'C', parentId: 'R', exposure: 271, cap: 9999, terms: 'y', expiresAt: FAR, now: NOW }),
    (e) => e.code === 'OVER_LIMIT',
  );
  assertAllLevelsConsistent(store);
});

test('restart: state reloads and verifies', () => {
  const dir = tmpdir();
  const store = new GuaranteeStore(dir);
  buildTree(store);
  store.revoke('A1', NOW + 1);
  store.sweep(NOW + 1000);
  const reopened = new GuaranteeStore(dir);
  assertAllLevelsConsistent(reopened);
  const v = reopened.verify();
  assert.deepEqual(v, { ok: true, problems: [] });
  assert.equal(reopened.guarantees.get('A1').state, 'revoked');
  assert.equal(reopened.guarantees.get('B1').state, 'expired');
  assert.equal(reopened.used.get('R'), 480);
});
