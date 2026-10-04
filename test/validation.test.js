import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir, addLot, addEvent, cli } from '../testkit/helpers.js';

test('merge conservation out of tolerance is rejected with exit 2', () => {
  const dir = tmpdir();
  assert.equal(addLot(dir, 'f1', 'A', 50, 1).code, 0);
  assert.equal(addLot(dir, 'f1', 'B', 50, 1).code, 0);
  const r = addEvent(dir, 'f1', 'merge', [['A', 50], ['B', 50]], [['C', 120]], 2);
  assert.equal(r.code, 2);
  const err = r.errJson();
  assert.equal(err.ok, false);
  assert.equal(err.code, 2);
  assert.match(err.error, /conservation/i);
});

test('merge within tolerance is accepted', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 50, 1);
  addLot(dir, 'f1', 'B', 50, 1);
  const r = cli(['add', '--dir', dir, '--site', 'f1', '--op', 'merge', '--in', 'A:50,B:50', '--out', 'C:100.0000000001', '--ts', '2', '--tol', '1e-6']);
  assert.equal(r.code, 0, r.stderr);
});

test('cyclic relabel is rejected with exit 2', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 10, 1);
  assert.equal(addEvent(dir, 'f1', 'relabel', [['A', 10]], [['B', 10]], 2).code, 0);
  const r = addEvent(dir, 'f1', 'relabel', [['B', 10]], [['A', 10]], 3);
  assert.equal(r.code, 2);
  assert.match(r.errJson().error, /cycle|already exists/i);
});

test('self relabel is rejected as a cycle', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 10, 1);
  const r = addEvent(dir, 'f1', 'relabel', [['A', 10]], [['A', 10]], 2);
  assert.equal(r.code, 2);
});

test('over-consumption of a lot is rejected', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 100, 1);
  const r = addEvent(dir, 'f1', 'split', [['A', 100]], [['C', 70], ['D', 70]], 2);
  assert.equal(r.code, 2);
  assert.match(r.errJson().error, /conservation|over-consumed/i);
});

test('consuming more than remaining across two events is rejected', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 100, 1);
  assert.equal(addEvent(dir, 'f1', 'split', [['A', 60]], [['C', 60]], 2).code, 0);
  const r = addEvent(dir, 'f1', 'split', [['A', 60]], [['D', 60]], 3);
  assert.equal(r.code, 2);
  assert.match(r.errJson().error, /over-consumed/i);
});

test('event earlier than input lot createdAt is rejected', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 100, 10);
  const r = addEvent(dir, 'f1', 'split', [['A', 50]], [['C', 50]], 5);
  assert.equal(r.code, 2);
  assert.match(r.errJson().error, /createdAt/i);
});

test('consuming a closed lot is rejected', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 100, 1, ['--status', 'closed']);
  const r = addEvent(dir, 'f1', 'split', [['A', 50]], [['C', 50]], 2);
  assert.equal(r.code, 2);
  assert.match(r.errJson().error, /closed/i);
});

test('relabel must preserve mass', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 10, 1);
  const r = addEvent(dir, 'f1', 'relabel', [['A', 10]], [['B', 11]], 2);
  assert.equal(r.code, 2);
});

test('fully consumed lot cannot be consumed again', () => {
  const dir = tmpdir();
  addLot(dir, 'f1', 'A', 100, 1);
  assert.equal(addEvent(dir, 'f1', 'split', [['A', 100]], [['C', 100]], 2).code, 0);
  const r = addEvent(dir, 'f1', 'split', [['A', 1]], [['D', 1]], 3);
  assert.equal(r.code, 2);
});
