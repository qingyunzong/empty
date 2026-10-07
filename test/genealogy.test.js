'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { buildGraph, toNFA, GenealogyError } = require('../src/genealogy');
const { determinize, minimize } = require('../src/dfa');

test('unknown parent batch is rejected', () => {
  assert.throws(
    () => buildGraph([{ batch: 'a', op: 'merge', parents: ['ghost'] }]),
    (e) => e instanceof GenealogyError && e.kind === 'UNKNOWN_PARENT'
  );
});

test('cyclic genealogy is rejected', () => {
  assert.throws(
    () =>
      buildGraph([
        { batch: 'a', op: 'test', parents: ['b'] },
        { batch: 'b', op: 'test', parents: ['a'] },
      ]),
    (e) => e instanceof GenealogyError && e.kind === 'CYCLIC_GENEALOGY'
  );
});

test('self-loop is a cyclic genealogy', () => {
  assert.throws(
    () => buildGraph([{ batch: 'a', op: 'test', parents: ['a'] }]),
    (e) => e.kind === 'CYCLIC_GENEALOGY'
  );
});

test('parents may reference batches from earlier layers', () => {
  const g1 = buildGraph([{ batch: 'root' }]);
  const g2 = buildGraph([{ batch: 'child', op: 'split', parents: ['root'] }], g1);
  assert.equal(g2.size, 2);
});

test('duplicate batch across layers is rejected', () => {
  const g1 = buildGraph([{ batch: 'root' }]);
  assert.throws(() => buildGraph([{ batch: 'root' }], g1), (e) => e.kind === 'DUPLICATE_BATCH');
});

test('pending states are kept, never treated as unsatisfiable', () => {
  const graph = buildGraph([
    { batch: 'root', defects: ['d0'] },
    { batch: 'qc', op: 'test', parents: ['root'], status: 'pending', defects: ['d1'] },
  ]);
  const dfa = determinize(toNFA(graph));
  const members = [...dfa.states.values()].flatMap((s) => s.members);
  assert.ok(members.includes('qc'), 'pending state must survive determinization');
  const min = minimize(dfa);
  const outputs = [...min.states.values()].map((s) => s.output);
  assert.ok(outputs.some((o) => o.includes('d1')), 'pending defects must survive minimization');
});

test('root batch must not declare an op', () => {
  assert.throws(() => buildGraph([{ batch: 'a', op: 'ship' }]), (e) => e.kind === 'BAD_RECORD');
});
