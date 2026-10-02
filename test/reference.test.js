'use strict';

// Cross-check: for instruction sets of size n <= 9, replay legal patches with
// an independent reference implementation and compare final tables against the
// production implementation. Every produced proof must also pass verify.

const test = require('node:test');
const assert = require('node:assert/strict');
const { applyOps } = require('../src/migrate');
const { verifyMigration } = require('../src/verify');
const { replay, canonical } = require('./helpers/reference');
const { mulberry32, randInt, genInstructions, allLegalOps } = require('./helpers/generator');

const PAIR_SAMPLES_PER_N = 400;
const SEQUENCE_SAMPLES_PER_N = 200;
const MAX_SEQUENCE_LEN = 4;

function checkPatch(oldSet, ops, context) {
  const expected = canonical(replay(oldSet, ops));
  const { instructions, proof } = applyOps(oldSet, ops);
  assert.deepEqual(canonical(instructions), expected, `final table mismatch: ${context}`);
  const result = verifyMigration(oldSet, instructions, proof);
  assert.equal(result.ok, true, `verify failed for ${context}: ${result.failure && result.failure.message}`);
  return instructions;
}

for (let n = 1; n <= 9; n += 1) {
  test(`reference replay: n=${n} exhaustive single ops + sampled sequences`, () => {
    const rand = mulberry32(1000 + n);
    const oldSet = genInstructions(rand, n);
    const singles = allLegalOps(oldSet);

    // Exhaustive: every legal single-op patch.
    for (const op of singles) {
      checkPatch(oldSet, [op], `n=${n} single ${JSON.stringify(op)}`);
    }

    // Sampled pairs: apply op1, regenerate legal ops on the result, apply op2.
    for (let s = 0; s < PAIR_SAMPLES_PER_N; s += 1) {
      const op1 = singles[randInt(rand, 0, singles.length - 1)];
      const mid = checkPatch(oldSet, [op1], `n=${n} pair-first`);
      const seconds = allLegalOps(mid);
      if (seconds.length === 0) continue;
      const op2 = seconds[randInt(rand, 0, seconds.length - 1)];
      checkPatch(oldSet, [op1, op2], `n=${n} pair ${JSON.stringify([op1, op2])}`);
    }

    // Sampled longer sequences (length 2..MAX_SEQUENCE_LEN).
    for (let s = 0; s < SEQUENCE_SAMPLES_PER_N; s += 1) {
      const len = randInt(rand, 2, MAX_SEQUENCE_LEN);
      const ops = [];
      let current = oldSet;
      let ok = true;
      for (let step = 0; step < len; step += 1) {
        const legal = allLegalOps(current);
        if (legal.length === 0) {
          ok = false;
          break;
        }
        const op = legal[randInt(rand, 0, legal.length - 1)];
        ops.push(op);
        current = canonical(replay(current, [op]));
      }
      if (ok) checkPatch(oldSet, ops, `n=${n} sequence ${JSON.stringify(ops)}`);
    }
  });
}
