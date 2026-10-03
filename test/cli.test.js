'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { main } = require('../src/cli-main');

function runCli(doc) {
  const { status, out, err } = main(JSON.stringify(doc));
  assert.equal(status, 0, err);
  return JSON.parse(out);
}

test('CLI applies ops from stdin and emits certificates plus final state', () => {
  const { results, state } = runCli({
    ops: [
      { type: 'addPlate', plate: 'P1' },
      { type: 'setWell', plate: 'P1', well: 'W1', value: 0.5 },
      { type: 'setWell', plate: 'P1', well: 'W2', value: 1.5 },
      { type: 'setControl', plate: 'P1', kind: 'neg', well: 'W1' },
      { type: 'setControl', plate: 'P1', kind: 'pos', well: 'W2' },
      { type: 'addGroup', group: 'G1' },
      { type: 'addToGroup', group: 'G1', plate: 'P1', well: 'W1' },
      { type: 'addToGroup', group: 'G1', plate: 'P1', well: 'W2' },
    ],
  });
  assert.equal(results.length, 8);
  assert.deepStrictEqual(results.map((r) => r.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(state.values['corr:P1:W2'].value, 1.0);
  assert.equal(state.values['ratio:P1:W2'].value, 1.0);
  assert.equal(state.values['mean:P1'].value, 0.5);
  assert.equal(state.values['rep:G1:mean'].value, 0.5);
  assert.equal(state.values['rep:G1:cv'].value, 100 * Math.sqrt(2)); // sd=sqrt(0.5), mean=0.5
  assert.deepStrictEqual(state.invalid, []);
  assert.deepStrictEqual(state.errors, {});
});

test('CLI supports undo/redo inside the op stream', () => {
  const { state } = runCli({
    ops: [
      { type: 'addPlate', plate: 'P1' },
      { type: 'setWell', plate: 'P1', well: 'W1', value: 2.0 },
      { type: 'undo' },
    ],
  });
  assert.equal(state.values['mean:P1'].error, 'E_QC'); // empty plate again
  assert.equal(state.values['well:P1:W1'], undefined);
});

test('CLI rejects malformed input with exit code 1', () => {
  const bad = main('not json');
  assert.equal(bad.status, 1);
  assert.match(bad.err, /error:/);

  const badOp = main(JSON.stringify({ ops: [{ type: 'setWell', plate: 'GHOST', well: 'W1', value: 1 }] }));
  assert.equal(badOp.status, 1);
  assert.match(badOp.err, /unknown plate/);
});
