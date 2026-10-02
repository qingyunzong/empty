import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { Store, FAULTS } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-'));
}

function seed(store) {
  store.commit('add_fact', { id: 'f1', source: 's1', value: 2 });
  store.commit('add_fact', { id: 'f2', source: 's2', value: 3 });
  store.commit('add_rule', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 4 });
  store.commit('revoke_source', { source: 's2' });
}

test('reopen replays WAL and reproduces state', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  const expected = s1.graph.materialize();
  const s2 = Store.open(dir);
  assert.deepEqual(s2.graph.materialize(), expected);
  assert.equal(s2.lastSeq, 4);
  assert.equal(s2.headHash, s1.headHash);
});

test('snapshot + further events recover to the same state', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  s1.snapshot();
  assert.equal(fs.readFileSync(path.join(dir, 'wal.log'), 'utf8'), '');
  s1.commit('restore_source', { source: 's2' });
  s1.commit('add_fact', { id: 'f3', source: 's3' });
  const expected = s1.graph.materialize();
  const s2 = Store.open(dir);
  assert.deepEqual(s2.graph.materialize(), expected);
  assert.equal(s2.lastSeq, 6);
  assert.equal(Store.verify(dir).ok, true);
});

test('tampered WAL record fails with E_HASH', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n').filter(Boolean);
  const record = JSON.parse(lines[1]);
  record.payload.value = 999; // tamper without fixing the hash
  lines[1] = JSON.stringify(record);
  fs.writeFileSync(wal, lines.join('\n') + '\n');
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_HASH');
});

test('broken hash chain linkage fails with E_HASH', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  const wal = path.join(dir, 'wal.log');
  const lines = fs.readFileSync(wal, 'utf8').split('\n').filter(Boolean);
  lines.splice(1, 1); // drop a record: seq gap / broken linkage
  fs.writeFileSync(wal, lines.join('\n') + '\n');
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_HASH' || e.code === 'E_WAL');
});

test('unparseable WAL record fails with E_WAL', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  fs.appendFileSync(path.join(dir, 'wal.log'), '{not json\n');
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_WAL');
});

test('tampered snapshot fails with E_HASH', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir);
  seed(s1);
  s1.snapshot();
  const snapPath = path.join(dir, 'snapshot.json');
  const snap = JSON.parse(fs.readFileSync(snapPath, 'utf8'));
  snap.state.facts[0].value = 12345;
  fs.writeFileSync(snapPath, JSON.stringify(snap));
  assert.throws(() => Store.open(dir), (e) => e.code === 'E_HASH');
});

test('crash injection at all three fault points recovers deterministically', () => {
  // baseline: no fault
  const baseDir = tmpdir();
  const base = Store.open(baseDir);
  seed(base);
  base.snapshot();
  base.commit('restore_source', { source: 's2' });
  const baseline = { nodes: base.graph.materialize(), lastSeq: base.lastSeq, headHash: base.headHash };

  for (const point of [FAULTS.AFTER_APPEND, FAULTS.BEFORE_INDEX, FAULTS.AFTER_SNAPSHOT]) {
    const dir = tmpdir();
    // phase 1: seed without faults
    let store = Store.open(dir);
    store.commit('add_fact', { id: 'f1', source: 's1', value: 2 });
    store.commit('add_fact', { id: 'f2', source: 's2', value: 3 });
    // phase 2: crash during the third commit / or during snapshot
    store = Store.open(dir, { faultAt: point });
    assert.throws(() => {
      if (point === FAULTS.AFTER_SNAPSHOT) {
        store.commit('add_rule', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 4 });
        store.commit('revoke_source', { source: 's2' });
        store.snapshot();
      } else {
        store.commit('add_rule', { id: 'r1', op: 'sum', premises: ['f1', 'f2'], threshold: 4 });
      }
    }, (e) => e.code === 'E_CRASH' && e.details.faultPoint === point);
    // a crashed instance must refuse further use
    assert.throws(() => store.commit('add_fact', { id: 'x', source: 's' }), (e) => e.code === 'E_CRASH');
    // phase 3: restart without fault, finish the same logical workload
    store = Store.open(dir);
    if (point === FAULTS.AFTER_SNAPSHOT) {
      // snapshot was written, WAL not truncated; replay must be idempotent
      store.snapshot();
      store.commit('restore_source', { source: 's2' });
    } else {
      // the crashed commit is durable in the WAL (append happened first)
      store.commit('revoke_source', { source: 's2' });
      store.snapshot();
      store.commit('restore_source', { source: 's2' });
    }
    const recovered = { nodes: store.graph.materialize(), lastSeq: store.lastSeq, headHash: store.headHash };
    assert.deepEqual(recovered, baseline, `fault point ${point}`);
    assert.equal(Store.verify(dir).ok, true);
  }
});

test('verifylog reports head hash and event count', () => {
  const dir = tmpdir();
  const store = Store.open(dir);
  seed(store);
  const report = Store.verify(dir);
  assert.equal(report.ok, true);
  assert.equal(report.lastSeq, 4);
  assert.match(report.headHash, /^[0-9a-f]{64}$/);
});
