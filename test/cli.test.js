import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runCommand, COMMANDS, USAGE } from '../src/cli.js';

// The CLI dispatch layer is tested in-process (the sandbox forbids spawning
// child node processes); bin/dq.js is a thin IO wrapper around runCommand.

test('cli exposes all required commands', () => {
  for (const cmd of ['check', 'plan', 'repair', 'merge', 'explain']) {
    assert.ok(COMMANDS.includes(cmd), `missing command ${cmd}`);
    assert.match(USAGE, new RegExp(cmd));
  }
});

test('cli check reports violations in topological order', () => {
  const out = runCommand('check', {
    data: { x: 9 },
    rules: [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }],
  });
  assert.equal(out.ok, false);
  assert.deepEqual(out.violations.map((v) => v.rule), ['r1']);
});

test('cli repair emits a new causal successor version', () => {
  const init = runCommand('init', { data: { x: 9 }, node: 'n1' }).version;
  const out = runCommand('repair', {
    version: init,
    schema: { x: { domain: [0, 1, 2, 9], costPerUnit: 1 } },
    rules: [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 2 }],
    budget: 10,
    node: 'n1',
  });
  assert.equal(out.version.data.x, 2);
  assert.deepEqual(out.version.parents, [init.id]);
  assert.equal(out.version.clock.n1, init.clock.n1 + 1);
  assert.equal(out.plan.cost, 7);
});

test('cli surfaces RULE_CYCLE and NO_FEASIBLE with stable error codes', () => {
  assert.throws(
    () => runCommand('check', {
      data: { x: 1 },
      rules: [
        { id: 'a', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['b'] },
        { id: 'b', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['a'] },
      ],
    }),
    (err) => err.code === 'RULE_CYCLE'
  );
  const init = runCommand('init', { data: { x: 5 }, node: 'n1' }).version;
  assert.throws(
    () => runCommand('repair', {
      version: init,
      schema: { x: { domain: [0, 5], changeCost: 3 } },
      rules: [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 0 }],
      budget: 2,
    }),
    (err) => err.code === 'NO_FEASIBLE'
  );
});

test('cli merge + explain round-trip replays concurrent history', () => {
  const base = runCommand('init', { data: { t: 0, p: 0 }, node: 'n1' }).version;
  const schema = { t: { domain: [0, 1] }, p: { domain: [0, 1] } };
  const a = runCommand('repair', {
    version: base, schema, rules: [{ id: 'rt', type: 'range', var: 't', min: 1, max: 1 }], node: 'nA',
  }).version;
  const b = runCommand('repair', {
    version: base, schema, rules: [{ id: 'rp', type: 'range', var: 'p', min: 1, max: 1 }], node: 'nB',
  }).version;
  const merged = runCommand('merge', { base, a, b, node: 'm' });
  assert.equal(merged.relation, 'merged');
  assert.deepEqual(merged.version.data, { t: 1, p: 1 });
  const explained = runCommand('explain', {
    versions: [base, a, b, merged.version],
    target: merged.version.id,
  });
  assert.equal(explained.matches, true);
  assert.deepEqual(explained.final, { t: 1, p: 1 });
});

test('cli merge is commutative and reports HISTORY_CONFLICT', () => {
  const base = runCommand('init', { data: { t: 0 }, node: 'n1' }).version;
  const a = runCommand('repair', {
    version: base,
    schema: { t: { domain: [0, 1] } },
    rules: [{ id: 'ra', type: 'range', var: 't', min: 1, max: 1 }],
    node: 'nA',
  }).version;
  const b = runCommand('repair', {
    version: base,
    schema: { t: { domain: [0, 1, 2] } },
    rules: [{ id: 'rb', type: 'range', var: 't', min: 2, max: 2 }],
    node: 'nB',
  }).version;
  assert.equal(a.data.t, 1);
  assert.equal(b.data.t, 2);
  assert.throws(() => runCommand('merge', { base, a, b }), (err) => err.code === 'HISTORY_CONFLICT');
  // Disjoint concurrent changes commute.
  const wide = { t: { domain: [0, 1] }, p: { domain: [0, 1] } };
  const base2 = runCommand('init', { data: { t: 0, p: 0 }, node: 'n1' }).version;
  const c = runCommand('repair', {
    version: base2, schema: wide, rules: [{ id: 'rc', type: 'range', var: 't', min: 1, max: 1 }], node: 'nC',
  }).version;
  const d = runCommand('repair', {
    version: base2, schema: wide, rules: [{ id: 'rd', type: 'range', var: 'p', min: 1, max: 1 }], node: 'nD',
  }).version;
  const m1 = runCommand('merge', { base: base2, a: c, b: d, node: 'm' }).version;
  const m2 = runCommand('merge', { base: base2, a: d, b: c, node: 'm' }).version;
  assert.deepEqual(m1, m2);
});

test('cli rejects unknown commands with BAD_INPUT', () => {
  assert.throws(() => runCommand('frobnicate', {}), (err) => err.code === 'BAD_INPUT');
});
