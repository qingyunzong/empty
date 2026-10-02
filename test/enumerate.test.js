'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Interpreter } = require('../src/interpreter');
const { crossCheck } = require('../src/enumerate');
const { DEFAULT_ALPHABET, findIllegalAutoStart, minimalPrefix } = require('../src/counterexample');

test('D: exhaustive cross-check of every event sequence of length <= 9', () => {
  const { checked, failures } = crossCheck({ alphabet: DEFAULT_ALPHABET, maxLen: 9 });
  assert.equal(checked, 349525); // sum_{k=0..9} 4^k
  assert.deepEqual(failures, []);
});

test('counterexample: safe interpreter admits no illegal auto start (depth 9)', () => {
  const res = findIllegalAutoStart({ maxDepth: 9 });
  assert.equal(res.found, false);
  assert.equal(res.checked, 349524); // lengths 1..9
});

test('counterexample: minimal prefix is found for a broken interpreter', () => {
  const res = findIllegalAutoStart({
    maxDepth: 6,
    makeInterpreter: () => new Interpreter({ trace: false, naive: true }),
  });
  assert.equal(res.found, true);
  assert.equal(res.prefix.length, 2, 'shortest illegal prefix: request auto, then start');
  assert.deepEqual(res.prefix.map((e) => e.type), ['mode_request', 'auto_start']);
  assert.equal(res.state.running, true);
});

test('minimalPrefix locates the shortest violating prefix of a concrete log', () => {
  const log = [
    { clock: 1, seq: 1, source: 'hmi', type: 'key_grant', key: 'K1', level: 'team' },
    { clock: 2, seq: 2, source: 'door', type: 'door', state: 'open' },
    { clock: 3, seq: 3, source: 'plc', type: 'auto_start' },
    { clock: 4, seq: 4, source: 'door', type: 'door', state: 'closed' },
  ];
  const prefix = minimalPrefix(log, (interp) => interp.violations.length > 0);
  assert.equal(prefix.length, 3);
  assert.equal(prefix.at(-1).type, 'auto_start');
});
