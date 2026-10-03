import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { GuaranteeStore } from '../src/store.js';

const NOW = 1_000_000;
const FAR = NOW + 10_000_000;

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fail-'));
}

function snapshot(store) {
  return JSON.stringify({
    guarantees: [...store.guarantees.entries()].sort(),
    used: [...store.used.entries()].sort(),
    deleted: [...store.deleted].sort(),
    index: [...store.index.entries()]
      .map(([t, p]) => [t, [...p.entries()].sort()])
      .sort(),
  });
}

function build() {
  const dir = tmpdir();
  const store = new GuaranteeStore(dir);
  store.issue({ id: 'R', exposure: 100, cap: 1000, terms: 'root', expiresAt: FAR, now: NOW });
  store.issue({ id: 'A', parentId: 'R', exposure: 100, cap: 300, terms: 'child a', expiresAt: FAR, now: NOW });
  store.issue({ id: 'A1', parentId: 'A', exposure: 50, cap: 100, terms: 'leaf a1', expiresAt: NOW + 500, now: NOW });
  return { dir, store };
}

test('over-limit issue fails with no partial write', () => {
  const { store } = build();
  const memBefore = snapshot(store);
  const fileBefore = fs.readFileSync(store.file, 'utf8');
  assert.throws(
    () => store.issue({ id: 'X', parentId: 'A', exposure: 250, cap: 999, terms: 'boom', expiresAt: FAR, now: NOW }),
    (e) => e.code === 'OVER_LIMIT',
  );
  assert.equal(snapshot(store), memBefore, 'in-memory state untouched');
  assert.equal(fs.readFileSync(store.file, 'utf8'), fileBefore, 'file untouched');
  assert.ok(!store.guarantees.has('X'));
});

test('missing parent fails with no partial write', () => {
  const { store } = build();
  const memBefore = snapshot(store);
  const fileBefore = fs.readFileSync(store.file, 'utf8');
  assert.throws(
    () => store.issue({ id: 'X', parentId: 'NOPE', exposure: 1, cap: 1, terms: 'x', expiresAt: FAR, now: NOW }),
    (e) => e.code === 'PARENT_NOT_FOUND',
  );
  assert.equal(snapshot(store), memBefore);
  assert.equal(fs.readFileSync(store.file, 'utf8'), fileBefore);
});

test('issue under non-active parent fails', () => {
  const { store } = build();
  store.sweep(NOW + 500); // A1 expires
  const memBefore = snapshot(store);
  assert.throws(
    () => store.issue({ id: 'X', parentId: 'A1', exposure: 1, cap: 1, terms: 'x', expiresAt: FAR, now: NOW + 600 }),
    (e) => e.code === 'PARENT_NOT_ACTIVE',
  );
  assert.equal(snapshot(store), memBefore);
});

test('double revoke fails with no partial write', () => {
  const { store } = build();
  store.revoke('A1', NOW + 1);
  const memBefore = snapshot(store);
  const fileBefore = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.revoke('A1', NOW + 2), (e) => e.code === 'ALREADY_REVOKED');
  assert.equal(snapshot(store), memBefore);
  assert.equal(fs.readFileSync(store.file, 'utf8'), fileBefore);
});

test('purge with live descendants fails with no partial write', () => {
  const { store } = build();
  store.sweep(NOW + 500); // A1 expired, A and R still live
  // purging an active node
  assert.throws(() => store.purge('A'), (e) => e.code === 'NOT_PURGEABLE');
  // make A dead but keep a live grandchild chain: re-issue under A, then revoke A
  store.issue({ id: 'A2', parentId: 'A', exposure: 10, cap: 50, terms: 'live leaf', expiresAt: FAR, now: NOW + 600 });
  store.revoke('A', NOW + 601);
  const memBefore = snapshot(store);
  const fileBefore = fs.readFileSync(store.file, 'utf8');
  assert.throws(() => store.purge('A'), (e) => e.code === 'LIVE_DESCENDANTS');
  assert.equal(snapshot(store), memBefore);
  assert.equal(fs.readFileSync(store.file, 'utf8'), fileBefore);
  // once the live child is gone, purge succeeds and removes the whole dead subtree
  store.revoke('A2', NOW + 602);
  const purged = store.purge('A');
  assert.deepEqual([...purged].sort(), ['A', 'A1', 'A2']);
  assert.ok(!store.guarantees.has('A'));
  assert.ok(!store.guarantees.has('A1'));
  assert.ok(!store.guarantees.has('A2'));
  assert.equal(store.used.get('R'), 100, 'root occupancy unchanged by purge');
  assert.ok(store.verify().ok);
});

test('restart after failures and purge: state verifiable from disk', () => {
  const { dir, store } = build();
  // a mix of failing ops must not leak into persisted state
  assert.throws(() => store.revoke('NOPE'), (e) => e.code === 'NOT_FOUND');
  assert.throws(() => store.purge('R'), (e) => e.code === 'NOT_PURGEABLE');
  assert.throws(
    () => store.issue({ id: 'Z', parentId: 'R', exposure: 901, cap: 901, terms: 'z', expiresAt: FAR, now: NOW }),
    (e) => e.code === 'OVER_LIMIT',
  );
  store.sweep(NOW + 500); // A1 expired
  store.purge('A1');
  const reopened = new GuaranteeStore(dir);
  const v = reopened.verify();
  assert.deepEqual(v, { ok: true, problems: [] });
  assert.ok(!reopened.guarantees.has('A1'));
  assert.equal(reopened.used.get('R'), 200);
  assert.equal(reopened.used.get('A'), 100);
  assert.equal(reopened.remaining('R'), 800);
});
