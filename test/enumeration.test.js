import test from 'node:test';
import assert from 'node:assert/strict';
import { compileRule } from '../src/engine.js';
import { run } from '../src/vm.js';
import { evaluate } from '../src/reference.js';
import { tokenize } from '../src/lexer.js';
import { parse } from '../src/parser.js';
import { checkRule } from '../src/types.js';

// Acceptance: for every sample set of up to 10 samples, the bytecode VM must
// agree with the independent tree-walking reference implementation.

const SOURCE = `
rule "enum" version 1 {
  param batch_size: quantity
  param sampled: quantity
  param defects: quantity
  param severity: level

  const max_defects: quantity = 2
  const min_sample: quantity = 4
  const max_rate: ratio = 25%

  when defects > max_defects or severity >= critical => REJECT
  when sampled > 0 and defects / sampled > max_rate => REJECT
  when sampled >= min_sample and not (defects > max_defects) => ACCEPT
  otherwise => CONTINUE
}
`;

const { program, ast } = compileRule(SOURCE, 'enum.dsl');

test('VM matches reference for all defect vectors of up to 10 samples', () => {
  let cases = 0;
  for (let n = 0; n <= 10; n += 1) {
    const vectors = 2 ** n;
    for (let mask = 0; mask < vectors; mask += 1) {
      let defects = 0;
      for (let bit = 0; bit < n; bit += 1) {
        if (mask & (1 << bit)) defects += 1;
      }
      for (const severity of ['minor', 'major', 'critical']) {
        const ctx = { batch_size: 10, sampled: n, defects, severity };
        const fromVm = run(program, ctx);
        const fromRef = evaluate(ast, ctx);
        assert.equal(fromVm, fromRef, `mismatch at sampled=${n} defects=${defects} severity=${severity}`);
        cases += 1;
      }
    }
  }
  assert.equal(cases, 3 * (2 ** 11 - 1));
});

test('VM matches reference across batch sizes and multi-defect samples', () => {
  for (let batch = 0; batch <= 10; batch += 1) {
    for (let sampled = 0; sampled <= 10; sampled += 1) {
      for (let defects = 0; defects <= 10; defects += 1) {
        const ctx = { batch_size: batch, sampled, defects, severity: 'major' };
        assert.equal(run(program, ctx), evaluate(ast, ctx));
      }
    }
  }
});

test('reference implementation itself is checked against the type system', () => {
  const ast2 = parse(tokenize(SOURCE, 'enum.dsl'), 'enum.dsl');
  checkRule(ast2, 'enum.dsl');
  assert.equal(ast2.clauses.length, 3);
});
