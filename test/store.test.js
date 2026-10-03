'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { Store } = require('../src/store');
const { tmpdir } = require('./helpers');

test('commit records reads/writes with vector clock in WAL', () => {
  const dir = tmpdir();
  const s = Store.open(dir, { node: 'A' });
  const r1 = s.commit({ writes: { x: '1' } });
  const r2 = s.commit({ reads: ['x', 'y'], writes: { y: '2' } });
  assert.equal(r1.id, 'A:1');
  assert.deepEqual(r1.clock, { A: 1 });
  assert.deepEqual(r2.clock, { A: 2 });
  assert.deepEqual(r2.reads, { x: '1', y: null });
  assert.equal(s.read('x'), '1');
  assert.equal(s.read('y'), '2');
  assert.equal(s.read('z'), null);
  const lines = fs.readFileSync(path.join(dir, 'wal.log'), 'utf8').trim().split('\n');
  assert.equal(lines.length, 2);
});

test('crash recovery: reopening rebuilds state from WAL', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir, { node: 'A' });
  s1.commit({ writes: { a: '1' } });
  s1.commit({ reads: ['a'], writes: { b: '2' } });
  // no clean shutdown; just open a fresh instance on the same dir
  const s2 = Store.open(dir);
  assert.equal(s2.read('a'), '1');
  assert.equal(s2.read('b'), '2');
  assert.equal(s2.corrupt, 0);
  // commit continues with correct seq/clock
  const r = s2.commit({ writes: { c: '3' } });
  assert.equal(r.id, 'A:3');
  assert.deepEqual(r.clock, { A: 3 });
});

test('torn tail write is skipped on recovery (CORRUPT)', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir, { node: 'A' });
  s1.commit({ writes: { a: '1' } });
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"id":"A:2","node":"A"'); // torn
  const s2 = Store.open(dir);
  assert.equal(s2.corrupt, 1);
  assert.equal(s2.read('a'), '1');
  assert.equal(s2.txns.size, 1);
});

test('snapshot reads at a vector clock', () => {
  const dir = tmpdir();
  const s = Store.open(dir, { node: 'A' });
  const t1 = s.commit({ writes: { k: 'v1' } });
  s.commit({ writes: { k: 'v2' } });
  assert.equal(s.read('k'), 'v2');
  assert.equal(s.read('k', { at: t1.clock }), 'v1');
  assert.equal(s.read('k', { at: {} }), null);
  const snap = s.snapshot(t1.clock);
  assert.equal(snap.read('k'), 'v1');
});

test('import is idempotent and reports duplicates', () => {
  const d1 = tmpdir();
  const d2 = tmpdir();
  const a = Store.open(d1, { node: 'A' });
  a.commit({ writes: { x: '1' } });
  a.commit({ writes: { y: '2' } });
  const seg = a.exportSegment();
  const b = Store.open(d2, { node: 'B' });
  const r1 = b.importSegment(seg);
  assert.deepEqual([r1.status, r1.imported, r1.duplicates], ['OK', 2, 0]);
  const r2 = b.importSegment(seg);
  assert.deepEqual([r2.status, r2.imported, r2.duplicates], ['OK', 0, 2]);
  assert.equal(b.txns.size, 2);
  assert.equal(b.read('x'), '1');
});

test('corrupt segment lines are skipped, valid ones imported', () => {
  const d1 = tmpdir();
  const d2 = tmpdir();
  const a = Store.open(d1, { node: 'A' });
  a.commit({ writes: { x: '1' } });
  a.commit({ writes: { y: '2' } });
  a.commit({ writes: { z: '3' } });
  const lines = a.exportSegment().trim().split('\n');
  // corrupt the middle record: flip a value character
  lines[1] = lines[1].replace('"y":"2"', '"y":"9"');
  const b = Store.open(d2, { node: 'B' });
  const res = b.importSegment(lines.join('\n') + '\n');
  assert.equal(res.status, 'CORRUPT');
  assert.equal(res.skipped, 1);
  assert.equal(res.imported, 2);
  assert.equal(b.read('x'), '1');
  assert.equal(b.read('y'), null);
  assert.equal(b.read('z'), '3');
});
