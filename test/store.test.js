import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Store } from '../src/store.js';

function tmpdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'kv-merge-store-'));
}

test('commit and read basic key-values', () => {
  const dir = tmpdir();
  const s = Store.open(dir, 'A');
  const t1 = s.commit({ writes: { x: '1', y: '2' } });
  assert.equal(t1.id, 'A:1');
  assert.deepEqual(t1.clock, { A: 1 });
  const t2 = s.commit({ reads: ['x'], writes: { x: '3' } });
  assert.deepEqual(t2.reads, { x: '1' });
  assert.deepEqual(t2.parents, ['A:1']);
  assert.equal(s.read('x'), '3');
  assert.equal(s.read('y'), '2');
  assert.equal(s.read('missing'), null);
});

test('snapshot read at a vector clock', () => {
  const dir = tmpdir();
  const s = Store.open(dir, 'A');
  s.commit({ writes: { x: '1' } });
  const t2 = s.commit({ writes: { x: '2', z: '9' } });
  s.commit({ writes: { x: '3' } });
  assert.equal(s.read('x'), '3');
  assert.equal(s.read('x', { at: { A: 1 } }), '1');
  assert.equal(s.read('x', { at: t2.clock }), '2');
  assert.equal(s.read('z', { at: { A: 1 } }), null);
  assert.equal(s.read('z', { at: t2.clock }), '9');
});

test('crash recovery: state rebuilt from WAL after reopen', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir, 'A');
  s1.commit({ writes: { a: '1' } });
  s1.commit({ reads: ['a'], writes: { b: '2' } });
  // "crash": drop the object without any shutdown, reopen from disk
  const s2 = Store.open(dir, 'A');
  assert.deepEqual(s2.state, { a: '1', b: '2' });
  assert.equal(s2.clock.A, 2);
  // commits continue with a fresh, non-colliding id
  const t = s2.commit({ writes: { c: '3' } });
  assert.equal(t.id, 'A:3');
});

test('corrupt WAL lines are skipped and counted on recovery', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir, 'A');
  s1.commit({ writes: { a: '1' } });
  s1.commit({ writes: { b: '2' } });
  // simulate a torn write / bit rot at the tail
  fs.appendFileSync(path.join(dir, 'wal.log'), '{"v":1,"type":"commit","txn":{"id":"A:9\n');
  fs.appendFileSync(path.join(dir, 'wal.log'), 'not json at all\n');
  const s2 = Store.open(dir, 'A');
  assert.equal(s2.corruptLines, 2);
  assert.deepEqual(s2.state, { a: '1', b: '2' });
});

test('tampered WAL entry is detected via checksum', () => {
  const dir = tmpdir();
  const s1 = Store.open(dir, 'A');
  s1.commit({ writes: { a: '1' } });
  const walPath = path.join(dir, 'wal.log');
  const tampered = fs.readFileSync(walPath, 'utf8').replace('"a":"1"', '"a":"evil"');
  fs.writeFileSync(walPath, tampered);
  const s2 = Store.open(dir, 'A');
  assert.equal(s2.corruptLines, 1);
  assert.deepEqual(s2.state, {});
});
