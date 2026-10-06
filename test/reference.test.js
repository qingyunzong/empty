import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../src/compiler.js';
import { run } from '../src/vm.js';
import { evaluateRule, LEVELS } from './reference.js';

// Cross-checks the bytecode VM against an independent tree-walking
// reference evaluator by exhaustive enumeration of every input with
// at most 10 samples.
const SRC = `rule "REF" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param worst: defect_level
  let accept_max: quantity = 1
  decide {
    when worst >= critical -> REJECT
    when defects >= accept_max + 1 -> REJECT
    when sampled >= batch_size and defects <= accept_max -> ACCEPT
    otherwise -> CONTINUE
  }
}`;

test('VM matches reference for all inputs with <= 10 samples', () => {
  const prog = compileRule(SRC);
  let cases = 0;
  const seen = { ACCEPT: 0, REJECT: 0, CONTINUE: 0 };
  for (let batch = 1; batch <= 10; batch++) {
    for (let sampled = 0; sampled <= batch; sampled++) {
      for (let defects = 0; defects <= sampled; defects++) {
        for (const worst of LEVELS) {
          const inputs = { batch_size: batch, sampled, defects, worst };
          const expected = evaluateRule(SRC, inputs);
          const actual = run(prog, inputs);
          assert.equal(actual, expected, `mismatch at ${JSON.stringify(inputs)}`);
          seen[actual]++;
          cases++;
        }
      }
    }
  }
  assert.equal(cases, 4 * 285); // 4 levels * sum_{b=1..10} (b+1)(b+2)/2 = 4 * 285
  // all three decision classes were exercised
  assert.ok(seen.ACCEPT > 0 && seen.REJECT > 0 && seen.CONTINUE > 0, JSON.stringify(seen));
});

test('VM matches reference on a rule with ratios, floor and shadowing', () => {
  const src = `rule "REF2" version 1 {
    param batch_size: quantity
    param sampled: quantity
    param defects: quantity
    param worst: defect_level
    let sample_size: quantity = max(1, floor(batch_size * 25%))
    let sample_size: quantity = min(sample_size, batch_size)
    decide {
      let ratio_hit: ratio = defects / max(1, sampled)
      when worst >= major and ratio_hit > 10% -> REJECT
      when sampled >= sample_size and not defects >= 2 -> ACCEPT
      otherwise -> CONTINUE
    }
  }`;
  const prog = compileRule(src);
  for (let batch = 1; batch <= 10; batch++) {
    for (let sampled = 0; sampled <= batch; sampled++) {
      for (let defects = 0; defects <= sampled; defects++) {
        for (const worst of LEVELS) {
          const inputs = { batch_size: batch, sampled, defects, worst };
          assert.equal(run(prog, inputs), evaluateRule(src, inputs), `mismatch at ${JSON.stringify(inputs)}`);
        }
      }
    }
  }
});
