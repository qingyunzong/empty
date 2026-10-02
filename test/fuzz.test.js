import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFile } from '../src/parser.js';
import { compileRuleset } from '../src/compiler.js';
import { evaluateRuleset } from '../src/evaluate.js';
import { referenceDecide } from './reference.js';
import { mulberry32, genRulesetSource, genEvent } from './fuzzgen.js';

// Acceptance 4: random rules + events, VM cross-checked against an
// independent AST-walking reference implementation.
test('fuzz: VM matches independent reference on random rules and events', () => {
  const SEEDS = 300;
  const EVENTS_PER_SEED = 8;
  let checks = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const rand = mulberry32(seed);
    const src = genRulesetSource(rand);
    let ast;
    let ruleset;
    try {
      [ast] = parseFile(src);
      ruleset = compileRuleset(ast);
    } catch (err) {
      assert.fail(`seed ${seed}: generated rules failed to compile: ${err.message}\n${src}`);
    }
    for (let i = 0; i < EVENTS_PER_SEED; i++) {
      const event = genEvent(rand, i);
      const vm = evaluateRuleset(ruleset, event);
      const ref = referenceDecide(ast, event);
      const simplify = (r) => ({
        decision: r.decision,
        outcome: r.outcome,
        matched: r.matched.map((m) => [m.rule, m.statement, m.decision]),
      });
      assert.deepEqual(simplify(vm), simplify(ref),
        `seed ${seed} event ${JSON.stringify(event)}\n${src}`);
      checks++;
    }
  }
  assert.ok(checks >= SEEDS * EVENTS_PER_SEED);
});

test('fuzz: generated override-loosening rules are traced in the log', () => {
  let sawOverride = 0;
  for (let seed = 1; seed <= 60; seed++) {
    const rand = mulberry32(seed * 7919);
    const [ast] = parseFile(genRulesetSource(rand));
    const rs = compileRuleset(ast);
    for (const entry of rs.overrideLog) {
      sawOverride++;
      assert.ok(entry.rule && entry.outerRule && entry.outer && entry.inner);
    }
  }
  assert.ok(sawOverride > 0, 'expected the generator to exercise override paths');
});
