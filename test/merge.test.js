// Acceptance scenarios 1 and 2, plus import idempotency and corrupt segments.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-merge-'));
}

test('scenario 1: two non-conflicting replicas merge cleanly', () => {
  const A = Store.open(path.join(tmpdir(), 'a'), 'A');
  const B = Store.open(path.join(tmpdir(), 'b'), 'B');

  A.commit({ writes: { alpha: '1' } });
  A.commit({ reads: ['alpha'], writes: { beta: '2' } });
  B.commit({ writes: { gamma: '3' } });
  B.commit({ reads: ['gamma'], writes: { delta: '4' } });

  // exchange segments both ways
  const segA = A.exportSegment();
  const segB = B.exportSegment();
  const repA = A.importSegment(segB);
  const repB = B.importSegment(segA);
  assert.deepEqual(repA, { imported: 2, duplicates: 0, corrupt: 0, status: 'OK' });
  assert.deepEqual(repB, { imported: 2, duplicates: 0, corrupt: 0, status: 'OK' });

  // both replicas converge to the same, correct state
  const expected = { alpha: '1', beta: '2', gamma: '3', delta: '4' };
  assert.deepEqual(A.state, expected);
  assert.deepEqual(B.state, expected);

  // check passes on both, and replaying the emitted order matches the state
  for (const s of [A, B]) {
    const res = s.check();
    assert.equal(res.serializable, true);
    assert.equal(res.consistent, true);
    assert.equal(res.order.length, 4);
  }
});

test('scenario 2: concurrent read/write of the same key is NON_SERIALIZABLE', () => {
  const A = Store.open(path.join(tmpdir(), 'a'), 'A');
  const B = Store.open(path.join(tmpdir(), 'b'), 'B');

  // shared base value, visible to both replicas
  A.commit({ writes: { x: '0' } });
  B.importSegment(A.exportSegment());

  // concurrent transactions, both read x and write x
  const ta = A.commit({ reads: ['x'], writes: { x: 'A' } });
  const tb = B.commit({ reads: ['x'], writes: { x: 'B' } });
  assert.deepEqual(ta.reads, { x: '0' });
  assert.deepEqual(tb.reads, { x: '0' });

  // merge both ways
  const segA = A.exportSegment();
  const segB = B.exportSegment();
  A.importSegment(segB);
  B.importSegment(segA);

  for (const s of [A, B]) {
    const res = s.check();
    assert.equal(res.serializable, false);
    assert.ok(Array.isArray(res.cycle), 'a conflict cycle is reported');
    // the cycle is a real cycle: first node repeats at the end
    assert.equal(res.cycle[0], res.cycle[res.cycle.length - 1]);
    // the cross-committed transactions are in the cycle and exist in the store
    const ids = new Set(res.cycle);
    assert.ok(ids.has(ta.id), `cycle ${res.cycle} contains ${ta.id}`);
    assert.ok(ids.has(tb.id), `cycle ${res.cycle} contains ${tb.id}`);
    for (const id of ids) assert.ok(s.txns.has(id), `${id} exists in the store`);
  }
});

test('import is idempotent: re-importing a segment is a no-op', () => {
  const A = Store.open(path.join(tmpdir(), 'a'), 'A');
  const B = Store.open(path.join(tmpdir(), 'b'), 'B');
  A.commit({ writes: { k: 'v1' } });
  A.commit({ writes: { k: 'v2' } });
  const seg = A.exportSegment();
  const r1 = B.importSegment(seg);
  assert.deepEqual(r1, { imported: 2, duplicates: 0, corrupt: 0, status: 'OK' });
  const stateAfterFirst = B.state;
  const r2 = B.importSegment(seg);
  assert.deepEqual(r2, { imported: 0, duplicates: 2, corrupt: 0, status: 'OK' });
  assert.deepEqual(B.state, stateAfterFirst);
  // importing your own export is also a no-op
  const r3 = A.importSegment(seg);
  assert.deepEqual(r3, { imported: 0, duplicates: 2, corrupt: 0, status: 'OK' });
});

test('corrupt segment entries return CORRUPT and are skipped', () => {
  const A = Store.open(path.join(tmpdir(), 'a'), 'A');
  const B = Store.open(path.join(tmpdir(), 'b'), 'B');
  A.commit({ writes: { good1: '1' } });
  A.commit({ writes: { good2: '2' } });
  A.commit({ writes: { good3: '3' } });
  const lines = A.exportSegment().trim().split('\n');
  // corrupt the middle commit entry (payload tampered, checksum now invalid)
  lines[2] = lines[2].replace('"good2":"2"', '"good2":"tampered"');
  // and append a completely broken line
  const text = [...lines, '{{{broken'].join('\n') + '\n';
  const report = B.importSegment(text);
  assert.equal(report.status, 'CORRUPT');
  assert.equal(report.corrupt, 2);
  assert.equal(report.imported, 2);
  assert.deepEqual(B.state, { good1: '1', good3: '3' });
});

test('export --since only emits transactions not causally covered', () => {
  const A = Store.open(path.join(tmpdir(), 'a'), 'A');
  A.commit({ writes: { x: '1' } });
  const t2 = A.commit({ writes: { x: '2' } });
  A.commit({ writes: { x: '3' } });
  const seg = A.exportSegment({ since: t2.clock });
  const B = Store.open(path.join(tmpdir(), 'b'), 'B');
  const report = B.importSegment(seg);
  assert.equal(report.imported, 1);
  assert.deepEqual(B.state, { x: '3' });
});
