import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createBaseVersion,
  repair,
  merge,
  explain,
  compareClocks,
  HISTORY_CONFLICT,
} from '../src/index.js';

const schema = {
  temp: { domain: [0, 1, 2, 3], costPerUnit: 1 },
  pres: { domain: [0, 1, 2, 3], costPerUnit: 1 },
};
const rules = [
  { id: 'temp_ok', type: 'range', var: 'temp', min: 1, max: 3 },
  { id: 'pres_ok', type: 'range', var: 'pres', min: 1, max: 3 },
];

function repairedPair() {
  const base = createBaseVersion({ temp: 0, pres: 0 }, 'base');
  // Two concurrent repairs from the same base on different nodes.
  const a = repair({ version: base, schema, rules: [rules[0]], budget: 5, node: 'nodeA' }).version;
  const b = repair({ version: base, schema, rules: [rules[1]], budget: 5, node: 'nodeB' }).version;
  return { base, a, b };
}

test('repair produces a new causal successor (vector clock dominates parent)', () => {
  const base = createBaseVersion({ temp: 0, pres: 2 }, 'base');
  const { version: child } = repair({ version: base, schema, rules, budget: 5, node: 'nodeA' });
  assert.deepEqual(child.parents, [base.id]);
  assert.equal(compareClocks(child.clock, base.clock), 'gt');
  assert.equal(child.data.temp, 1); // cheapest fix: clamp to min
  assert.equal(child.data.pres, 2); // untouched
  assert.notEqual(child.id, base.id);
});

test('concurrent repairs merge commutatively', () => {
  const { base, a, b } = repairedPair();
  assert.equal(compareClocks(a.clock, b.clock), 'concurrent');
  const m1 = merge({ base, a, b, node: 'm' });
  const m2 = merge({ base, a: b, b: a, node: 'm' });
  assert.equal(m1.relation, 'merged');
  assert.deepEqual(m1.version, m2.version, 'merge(a,b) === merge(b,a)');
  assert.deepEqual(m1.version.data, { temp: 1, pres: 1 });
  assert.deepEqual(m1.version.parents, [a.id, b.id].sort());
  assert.equal(compareClocks(m1.version.clock, a.clock), 'gt');
  assert.equal(compareClocks(m1.version.clock, b.clock), 'gt');
});

test('merge fast-forwards when one version dominates', () => {
  const { base, a } = repairedPair();
  const out = merge({ base, a, b: base, node: 'm' });
  assert.equal(out.relation, 'fast-forward');
  assert.equal(out.version.id, a.id);
});

test('conflicting concurrent changes raise HISTORY_CONFLICT', () => {
  const base = createBaseVersion({ temp: 0, pres: 2 }, 'base');
  const a = repair({ version: base, schema, rules: [rules[0]], budget: 5, node: 'nodeA' }).version;
  // Force a different value for the same variable on the other branch.
  const b = repair({
    version: base,
    schema: { ...schema, temp: { domain: [2, 3], costPerUnit: 1 } },
    rules: [{ id: 't2', type: 'range', var: 'temp', min: 2, max: 3 }],
    budget: 5,
    node: 'nodeB',
  }).version;
  assert.notEqual(a.data.temp, b.data.temp);
  assert.throws(() => merge({ base, a, b }), (err) => {
    assert.equal(err.code, HISTORY_CONFLICT);
    assert.equal(err.details.conflicts[0].var, 'temp');
    return true;
  });
});

test('explain replays merged history deterministically and reaches the same state', () => {
  const { base, a, b } = repairedPair();
  const { version: merged } = merge({ base, a, b, node: 'm' });
  const versions = [base, a, b, merged];
  const first = explain(versions, merged.id);
  const second = explain(versions, merged.id);
  assert.deepEqual(first, second, 'replay is deterministic');
  assert.equal(first.matches, true);
  assert.deepEqual(first.final, merged.data);
  assert.deepEqual(first.final, { temp: 1, pres: 1 });
  // Trace contains base, both concurrent repairs, and the merge step.
  assert.deepEqual(first.steps.map((s) => s.kind), ['base', 'repair', 'repair', 'merge']);
  // Every replayed op is recorded with from/to.
  const mergeStep = first.steps.at(-1);
  assert.equal(mergeStep.ops.length, 2);
  assert.deepEqual(mergeStep.ops.map((o) => o.var).sort(), ['pres', 'temp']);
});
