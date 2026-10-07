'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loadRuleSet } = require('../src/rules');
const { equivalence } = require('../src/equiv');
const { runDfa, NUM_SYMBOLS } = require('../src/automata');
const { ALPHABET, TOKEN_INDEX } = require('../src/tokenize');

function accepts(dfa, tokens) {
  const idx = tokens.map((t) => TOKEN_INDEX.get(t));
  const flags = runDfa(dfa, idx);
  return flags[flags.length - 1];
}

// Acceptance B: equivalent rule sets produce identical certificates.
test('equivalent rule sets yield identical certificates', () => {
  const a = loadRuleSet('r = [a3***h0]|[a3***h1]\n');
  const b = loadRuleSet('r = [a3****]\n');
  assert.deepEqual(a.certificate, b.certificate);
  const { equiv, witness } = equivalence(a.combined, b.combined);
  assert.equal(equiv, true);
  assert.equal(witness, null);

  const c = loadRuleSet('r = [a3****]+\n');
  const d = loadRuleSet('r = [a3****][a3****]*\n');
  assert.deepEqual(c.certificate, d.certificate);
  assert.equal(equivalence(c.combined, d.combined).equiv, true);
});

// Acceptance C: divergent witness is the BFS-shortest, tuple-lexicographic
// smallest string, independently verifiable by enumeration of length <= 8.
test('non-equivalent rule sets yield minimal lexicographic witness', () => {
  const a = loadRuleSet('r = [a3****][a3****]\n');
  const b = loadRuleSet('r = [a3****][a3**c0*]\n');
  assert.notDeepEqual(a.certificate, b.certificate);
  const { equiv, witness } = equivalence(a.combined, b.combined);
  assert.equal(equiv, false);
  assert.ok(witness.length <= 8);
  assert.deepEqual(witness, ['a3t0r0c0h0', 'a3t0r0c1h0']);

  // Independent verification by brute-force enumeration:
  // 1) the witness itself distinguishes the two DFAs;
  const inA = accepts(a.combined, witness);
  const inB = accepts(b.combined, witness);
  assert.notEqual(inA, inB);
  // 2) no shorter string over the full alphabet distinguishes them.
  const shorter = [[]];
  for (const tok of ALPHABET) shorter.push([tok]);
  for (const s of shorter) {
    assert.ok(s.length < witness.length);
    assert.equal(accepts(a.combined, s), accepts(b.combined, s), `string ${s} distinguishes`);
  }
  // 3) no lexicographically smaller string of the same length distinguishes.
  const i0 = TOKEN_INDEX.get(witness[0]);
  const i1 = TOKEN_INDEX.get(witness[1]);
  for (let x = 0; x < NUM_SYMBOLS; x++) {
    for (let y = 0; y < NUM_SYMBOLS; y++) {
      if (x > i0 || (x === i0 && y >= i1)) continue;
      const s = [ALPHABET[x], ALPHABET[y]];
      assert.equal(accepts(a.combined, s), accepts(b.combined, s), `string ${s} distinguishes`);
    }
  }
});

test('empty string can be a witness', () => {
  const a = loadRuleSet('r = [a0****]*\n');
  const b = loadRuleSet('r = [a0****][a0****]\n');
  const { equiv, witness } = equivalence(a.combined, b.combined);
  assert.equal(equiv, false);
  assert.deepEqual(witness, []);
});
