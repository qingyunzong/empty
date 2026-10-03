'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMachine } = require('../src/dfa');
const { compare } = require('../src/equiv');
const { minCover } = require('../src/cover');

// Acceptance 1: a renamed but isomorphic machine must be reported equal.
test('renamed equivalent machine yields equal=true', () => {
  const oldM = validateMachine({
    states: ['A', 'B'],
    alphabet: ['x'],
    start: 'A',
    transitions: { A: { x: 'B' }, B: { x: 'A' } },
    risk: { A: 'low', B: 'high' },
  }, 'old');
  const newM = validateMachine({
    states: ['S1', 'S2'],
    alphabet: ['x'],
    start: 'S1',
    transitions: { S1: { x: 'S2' }, S2: { x: 'S1' } },
    risk: { S1: 'low', S2: 'high' },
  }, 'new');
  const res = compare(oldM, newM, 4);
  assert.equal(res.equal, true);
  assert.equal(res.witness, null);
  assert.deepEqual(res.diffStates, []);
});

// Acceptance 2: when the first divergence appears exactly at step 3, the
// witness must have length 3.
test('difference only at step 3 yields witness of length 3', () => {
  const chain = (prefix, risks) => ({
    states: [0, 1, 2, 3].map((i) => `${prefix}${i}`),
    alphabet: ['a', 'b'],
    start: `${prefix}0`,
    transitions: Object.fromEntries([0, 1, 2, 3].map((i) => [
      `${prefix}${i}`,
      { a: `${prefix}${Math.min(i + 1, 3)}`, b: `${prefix}${i}` },
    ])),
    risk: Object.fromEntries([0, 1, 2, 3].map((i) => [`${prefix}${i}`, risks[i]])),
  });
  const oldM = validateMachine(chain('q', ['low', 'low', 'low', 'high']), 'old');
  const newM = validateMachine(chain('p', ['low', 'low', 'low', 'low']), 'new');
  const res = compare(oldM, newM, 16);
  assert.equal(res.equal, false);
  assert.equal(res.witness.length, 3);
  assert.deepEqual(res.witness, ['a', 'a', 'a']);
  assert.deepEqual(res.diffStates, ['q3']);
});

// Acceptance 3: tied optimal task sets resolve deterministically.
test('tied optimal covers resolve deterministically by sorted id', () => {
  const single = minCover(['s1'], [
    { id: 't2', cost: 2, covers: ['s1'] },
    { id: 't1', cost: 2, covers: ['s1'] },
  ]);
  const singleReversed = minCover(['s1'], [
    { id: 't1', cost: 2, covers: ['s1'] },
    { id: 't2', cost: 2, covers: ['s1'] },
  ]);
  assert.deepEqual(single, singleReversed);
  assert.deepEqual(single.tasks, ['t1']);
  assert.equal(single.cost, 2);

  // Four tied two-task covers; lexicographically smallest sorted id list wins.
  const multi = minCover(['s1', 's2'], [
    { id: 'e', cost: 1, covers: ['s2'] },
    { id: 'd', cost: 1, covers: ['s1'] },
    { id: 'b', cost: 1, covers: ['s2'] },
    { id: 'a', cost: 1, covers: ['s1'] },
  ]);
  assert.deepEqual(multi.tasks, ['a', 'b']);
  assert.equal(multi.cost, 2);

  // Fewer tasks breaks a cost tie before lexicography.
  const fewer = minCover(['s1', 's2'], [
    { id: 'a', cost: 1, covers: ['s1'] },
    { id: 'b', cost: 1, covers: ['s2'] },
    { id: 'c', cost: 2, covers: ['s1', 's2'] },
  ]);
  assert.deepEqual(fewer.tasks, ['c']);

  // Uncoverable difference state -> null (caller reports INFEASIBLE).
  assert.equal(minCover(['s9'], [{ id: 'a', cost: 1, covers: ['s1'] }]), null);
});

// Acceptance 4: cross-check the product-automaton BFS against brute-force
// enumeration of every operation sequence of length <= m, for m up to 6.
function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function randomMachine(rand, nStates, label) {
  const states = Array.from({ length: nStates }, (_, i) => `q${i}`);
  const transitions = {};
  const risk = {};
  for (const s of states) {
    transitions[s] = {
      a: `q${Math.floor(rand() * nStates)}`,
      b: `q${Math.floor(rand() * nStates)}`,
    };
    risk[s] = rand() < 0.5 ? 'low' : 'high';
  }
  return validateMachine({ states, alphabet: ['a', 'b'], start: 'q0', transitions, risk }, label);
}

function bruteForceMinDistinguishingLength(oldM, newM, m) {
  let minLen = Infinity;
  const walk = (qo, qn, depth) => {
    if (depth >= minLen) return;
    if (oldM.risk[qo] !== newM.risk[qn]) {
      minLen = depth;
      return;
    }
    if (depth === m) return;
    for (const sym of oldM.alphabet) {
      walk(oldM.transitions[qo][sym], newM.transitions[qn][sym], depth + 1);
    }
  };
  walk(oldM.start, newM.start, 0);
  return minLen === Infinity ? null : minLen;
}

test('BFS agrees with exhaustive sequence enumeration for m<=6', () => {
  for (let seed = 1; seed <= 25; seed += 1) {
    const rand = lcg(seed);
    const oldM = randomMachine(rand, 1 + Math.floor(rand() * 4), 'old');
    const newM = randomMachine(rand, 1 + Math.floor(rand() * 4), 'new');
    for (let m = 0; m <= 6; m += 1) {
      const res = compare(oldM, newM, m);
      const brute = bruteForceMinDistinguishingLength(oldM, newM, m);
      assert.equal(res.equal, brute === null, `seed=${seed} m=${m} equal mismatch`);
      if (brute !== null) {
        assert.equal(res.witness.length, brute, `seed=${seed} m=${m} witness length`);
        // The witness must actually distinguish the machines.
        let qo = oldM.start;
        let qn = newM.start;
        for (const sym of res.witness) {
          qo = oldM.transitions[qo][sym];
          qn = newM.transitions[qn][sym];
        }
        assert.notEqual(oldM.risk[qo], newM.risk[qn]);
      }
    }
  }
});
