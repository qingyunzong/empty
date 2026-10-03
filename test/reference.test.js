import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkConvergence, ReferenceState, permutations } from '../src/reference.js';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';

const rev = (hash, parents, patch = {}, cancelled = false) => ({
  hash,
  txId: 'T1',
  type: cancelled ? 'cancel' : parents.length === 0 ? 'put' : 'replace',
  parents,
  author: 'ref',
  seq: 1,
  patch,
  cancelled,
  ts: 0,
});

test('linear chain of 4 revisions converges to the tip', () => {
  const revs = [
    rev('a', [], { price: 1, qty: 1 }),
    rev('b', ['a'], { price: 2 }),
    rev('c', ['b'], { qty: 3 }),
    rev('d', ['c'], { price: 4 }),
  ];
  const r = checkConvergence(revs);
  assert.equal(r.ok, true);
  assert.equal(r.permutations, 24);
  assert.deepEqual(r.heads, ['d']);
  assert.deepEqual(r.winner, { status: 'OK', version: 'd' });
});

test('concurrent disjoint branches converge to MERGED with both heads', () => {
  const revs = [
    rev('a', [], { price: 1, qty: 1 }),
    rev('b', ['a'], { price: 2 }),
    rev('c', ['a'], { qty: 9 }),
  ];
  const r = checkConvergence(revs);
  assert.equal(r.ok, true);
  assert.equal(r.permutations, 6);
  assert.deepEqual(r.heads, ['b', 'c']);
  assert.equal(r.winner.status, 'MERGED');
});

test('concurrent same-field branches converge to CONFLICT', () => {
  const revs = [
    rev('a', [], { price: 1, qty: 1 }),
    rev('b', ['a'], { price: 2 }),
    rev('c', ['a'], { price: 3 }),
  ];
  const r = checkConvergence(revs);
  assert.equal(r.ok, true);
  assert.equal(r.winner.status, 'CONFLICT');
  assert.deepEqual(r.heads, ['b', 'c']);
});

test('cancel concurrent with field modify converges to CANCELLED (cancel wins)', () => {
  const revs = [
    rev('a', [], { price: 1, qty: 1 }),
    rev('b', ['a'], { price: 2 }),
    rev('c', ['a'], {}, true),
  ];
  const r = checkConvergence(revs);
  assert.equal(r.ok, true);
  assert.equal(r.winner.status, 'CANCELLED');
});

test('six revisions incl. merge node converge (720 permutations)', () => {
  const revs = [
    rev('a', [], { price: 1, qty: 1 }),
    rev('b', ['a'], { price: 2 }),
    rev('c', ['a'], { qty: 9 }),
    rev('m', ['b', 'c'], { price: 2, qty: 9 }),
    rev('d', ['m'], { price: 5 }),
    rev('e', ['d'], { qty: 6 }),
  ];
  const r = checkConvergence(revs);
  assert.equal(r.ok, true);
  assert.equal(r.permutations, 720);
  assert.deepEqual(r.heads, ['e']);
  assert.deepEqual(r.winner, { status: 'OK', version: 'e' });
});

test('more than 6 revisions are rejected', () => {
  const revs = Array.from({ length: 7 }, (_, i) => rev(`h${i}`, i === 0 ? [] : [`h${i - 1}`]));
  assert.throws(() => checkConvergence(revs), RangeError);
});

test('permutations generator yields n! orders', () => {
  assert.equal([...permutations([1, 2, 3])].length, 6);
  assert.equal([...permutations([1])].length, 1);
});

test('reference cross-checks the real engine on a merged scenario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txref-'));
  const engine = new Engine(new Store(dir));
  const p = engine.put({ txId: 'T1', price: 100, qty: 5, author: 'a' });
  engine.replace({ txId: 'T1', base: p.head, price: 101, author: 'b' });
  engine.replace({ txId: 'T1', base: p.head, qty: 9, author: 'c' });
  const hist = engine.history({ txId: 'T1' }).revisions;
  assert.ok(hist.length <= 6);
  const r = checkConvergence(hist);
  assert.equal(r.ok, true);
  // engine head set equals reference head set
  assert.deepEqual(r.heads, hist.length ? engine.history({ txId: 'T1' }).heads.slice().sort() : []);
  assert.equal(r.winner.status, 'OK');
  assert.equal(engine.materialize({ txId: 'T1' }).version, r.winner.version);
});

test('reference cross-checks the real engine on a conflict scenario', () => {
  const dir = mkdtempSync(join(tmpdir(), 'txref-'));
  const engine = new Engine(new Store(dir));
  const p = engine.put({ txId: 'T1', price: 100, qty: 5, author: 'a' });
  engine.replace({ txId: 'T1', base: p.head, price: 101, author: 'b' });
  const c = engine.replace({ txId: 'T1', base: p.head, price: 102, author: 'c' });
  assert.equal(c.status, 'CONFLICT');
  const hist = engine.history({ txId: 'T1' }).revisions;
  const r = checkConvergence(hist);
  assert.equal(r.ok, true);
  assert.equal(r.winner.status, 'CONFLICT');
  assert.deepEqual(r.heads, c.heads.slice().sort());
});

test('reference state applies out-of-order parents via deferral', () => {
  const s = new ReferenceState();
  s.apply(rev('b', ['a'], { price: 2 }));
  s.apply(rev('a', [], { price: 1, qty: 1 }));
  assert.equal(s.pending.length, 0);
  assert.deepEqual([...s.heads], ['b']);
});
