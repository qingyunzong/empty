'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RecipeEngine } = require('../src/engine');

const up = (name, type, rest) => ({ op: 'upsert', name, type, ...rest });

test('multi-level incremental update leaves unrelated branches untouched', () => {
  const e = new RecipeEngine();
  e.execute(up('a', 'const', { value: 2 }));
  e.execute(up('b', 'const', { value: 3 }));
  e.execute(up('c', 'formula', { expr: 'a*b' }));
  e.execute(up('d', 'formula', { expr: 'c+a' }));
  e.execute(up('e', 'formula', { expr: 'd*2' }));
  e.execute(up('ind1', 'const', { value: 10 }));
  e.execute(up('ind2', 'formula', { expr: 'ind1*2' }));
  assert.deepEqual(e.finalState().values, { a: 2, b: 3, c: 6, d: 8, e: 16, ind1: 10, ind2: 20 });

  const entry = e.execute({ op: 'set', name: 'a', value: 4 });
  assert.deepEqual(e.finalState().values, { a: 4, b: 3, c: 12, d: 16, e: 32, ind1: 10, ind2: 20 });
  assert.deepEqual(entry.recomputed, ['a', 'c', 'd', 'e']);
  assert.ok(!entry.recomputed.includes('ind1') && !entry.recomputed.includes('ind2'));
  assert.deepEqual(entry.diff.changed, {
    a: { from: 2, to: 4 },
    c: { from: 6, to: 12 },
    d: { from: 8, to: 16 },
    e: { from: 16, to: 32 },
  });
});

test('cycle invalidates downstream only; break recovers; undo restores old topology', () => {
  const e = new RecipeEngine();
  e.execute(up('s', 'const', { value: 7 }));
  e.execute(up('a', 'const', { value: 1 }));
  e.execute(up('p', 'formula', { expr: 'a+1' }));
  e.execute(up('q', 'formula', { expr: 'p+1' }));
  e.execute(up('r', 'formula', { expr: 'p*2' }));

  const cyc = e.execute(up('a', 'formula', { expr: 'q+1' }));
  let st = e.finalState();
  assert.equal(st.invalid.a, 'cycle');
  assert.equal(st.invalid.p, 'cycle');
  assert.equal(st.invalid.q, 'cycle');
  assert.equal(st.invalid.r, 'invalid-upstream');
  assert.equal(st.values.s, 7);
  assert.equal(st.invalid.s, undefined);
  assert.ok(!cyc.recomputed.includes('s'));

  e.execute(up('p', 'const', { value: 5 }));
  st = e.finalState();
  assert.deepEqual(st.invalid, {});
  assert.deepEqual(st.values, { a: 7, p: 5, q: 6, r: 10, s: 7 });

  e.execute({ op: 'undo' });
  st = e.finalState();
  assert.equal(st.invalid.a, 'cycle');
  assert.equal(st.invalid.p, 'cycle');
  assert.equal(st.invalid.q, 'cycle');
  assert.equal(st.invalid.r, 'invalid-upstream');
  assert.equal(st.values.s, 7);

  e.execute({ op: 'redo' });
  st = e.finalState();
  assert.deepEqual(st.invalid, {});
  assert.deepEqual(st.values, { a: 7, p: 5, q: 6, r: 10, s: 7 });
});

test('self-dependency is a cycle', () => {
  const e = new RecipeEngine();
  e.execute(up('x', 'formula', { expr: 'x + 1' }));
  assert.equal(e.finalState().invalid.x, 'cycle');
});

test('unknown dependency invalidates dependents, heals when dependency appears', () => {
  const e = new RecipeEngine();
  e.execute(up('f1', 'formula', { expr: 'nope + 1' }));
  e.execute(up('f2', 'formula', { expr: 'f1 * 2' }));
  let st = e.finalState();
  assert.equal(st.invalid.f1, 'unknown-dependency');
  assert.equal(st.invalid.f2, 'invalid-upstream');
  e.execute(up('nope', 'const', { value: 3 }));
  st = e.finalState();
  assert.deepEqual(st.invalid, {});
  assert.deepEqual(st.values, { f1: 4, f2: 8, nope: 3 });
});

test('division by zero invalidates only the affected chain', () => {
  const e = new RecipeEngine();
  e.execute(up('n', 'const', { value: 1 }));
  e.execute(up('m', 'const', { value: 0 }));
  e.execute(up('q', 'formula', { expr: 'n / m' }));
  e.execute(up('r', 'formula', { expr: 'q + 1' }));
  e.execute(up('safe', 'formula', { expr: 'n * 2' }));
  let st = e.finalState();
  assert.equal(st.invalid.q, 'division-by-zero');
  assert.equal(st.invalid.r, 'invalid-upstream');
  assert.equal(st.values.safe, 2);
  e.execute({ op: 'set', name: 'm', value: 2 });
  st = e.finalState();
  assert.deepEqual(st.invalid, {});
  assert.equal(st.values.q, 0.5);
  assert.equal(st.values.r, 1.5);
});

test('remove makes dependents invalid with unknown-dependency', () => {
  const e = new RecipeEngine();
  e.execute(up('a', 'const', { value: 2 }));
  e.execute(up('c', 'formula', { expr: 'a * 10' }));
  e.execute(up('d', 'formula', { expr: 'c + 1' }));
  const entry = e.execute({ op: 'remove', name: 'a' });
  const st = e.finalState();
  assert.equal(st.invalid.c, 'unknown-dependency');
  assert.equal(st.invalid.d, 'invalid-upstream');
  assert.deepEqual(entry.diff.removed, ['a']);
  assert.deepEqual(entry.diff.invalidated, ['c', 'd']);
  const noop = e.execute({ op: 'remove', name: 'a' });
  assert.equal(noop.status, 'noop');
});

test('undo/redo on empty history is a noop', () => {
  const e = new RecipeEngine();
  assert.equal(e.execute({ op: 'undo' }).status, 'noop');
  assert.equal(e.execute({ op: 'redo' }).status, 'noop');
});

test('command errors do not mutate state', () => {
  const e = new RecipeEngine();
  e.execute(up('k', 'const', { value: 1 }));
  e.execute(up('f', 'formula', { expr: 'k + 1' }));
  const err1 = e.execute({ op: 'set', name: 'f', value: 9 });
  assert.equal(err1.status, 'error');
  const err2 = e.execute({ op: 'wat' });
  assert.equal(err2.status, 'error');
  assert.match(err2.message, /unknown op/);
  const err3 = e.execute(up('bad', 'formula', { expr: '1+' }));
  assert.equal(err3.status, 'error');
  const st = e.finalState();
  assert.deepEqual(st.values, { f: 2, k: 1 });
  assert.equal(st.invalid.bad, undefined);
});

test('certificate is deterministic and topo order breaks ties by tag name', () => {
  const cmds = [
    up('b', 'const', { value: 2 }),
    up('a', 'const', { value: 1 }),
    up('c', 'formula', { expr: 'a + b' }),
    { op: 'set', name: 'a', value: 5 },
  ];
  const runAll = () => {
    const e = new RecipeEngine();
    cmds.forEach((c) => e.execute(c));
    return e.finalState();
  };
  const s1 = runAll();
  const s2 = runAll();
  assert.equal(s1.certificate.hash, s2.certificate.hash);
  assert.deepEqual(s1.certificate.topo, ['a', 'b', 'c']);
  assert.equal(s1.certificate.seq, 4);
  assert.equal(s1.certificate.hashAlgorithm, 'sha256');
});

test('commit marks state as committed', () => {
  const e = new RecipeEngine();
  e.execute(up('a', 'const', { value: 1 }));
  const entry = e.execute({ op: 'commit' });
  assert.equal(entry.committed, true);
  assert.equal(e.finalState().committed, true);
});
