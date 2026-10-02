import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execute } from '../src/cli.js';

// The sandbox forbids child processes, so the CLI is exercised through its
// programmatic entry point `execute(argv)` — identical code path to the bin
// wrapper, including DqError error codes.

let dir;

function write(name, obj) {
  const p = join(dir, name);
  writeFileSync(p, JSON.stringify(obj));
  return p;
}

before(() => { dir = mkdtempSync(join(tmpdir(), 'dq-cli-')); });
after(() => { rmSync(dir, { recursive: true, force: true }); });

test('check reports violations as JSON', () => {
  const data = write('d.json', { data: { x: 9 }, domains: { x: [0, 10] } });
  const rules = write('r.json', [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }]);
  const out = execute(['check', '--data', data, '--rules', rules]);
  assert.equal(out.ok, false);
  assert.deepEqual(out.violations, [{ rule: 'r1', type: 'range' }]);
});

test('check with cyclic rules fails with RULE_CYCLE', () => {
  const data = write('d2.json', { data: { x: 1 }, domains: { x: [0, 10] } });
  const rules = write('r2.json', [
    { id: 'a', type: 'range', var: 'x', min: 0, max: 5, dependsOn: ['b'] },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 5, dependsOn: ['a'] },
  ]);
  assert.throws(() => execute(['check', '--data', data, '--rules', rules]),
    (e) => e.code === 'RULE_CYCLE');
});

test('repair emits a versioned causal successor; explain replays it', () => {
  const data = write('d3.json', { data: { x: 9 }, domains: { x: [0, 10] }, costs: { x: 1 } });
  const rules = write('r3.json', [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }]);
  const out = execute(['repair', '--data', data, '--rules', rules, '--budget', '10', '--node', 'n1']);
  assert.equal(out.cost, 4);
  assert.deepEqual(out.version.data, { x: 5 });
  assert.deepEqual(out.version.vector, { n1: 1 });
  const v1 = write('v1.json', out.version);
  const trace = execute(['explain', '--version', v1]);
  assert.equal(trace.ok, true);
  assert.deepEqual(trace.replayed.data, { x: 5 });
});

test('repair returns NO_FEASIBLE only when budget is provably too small', () => {
  const data = write('d4.json', { data: { x: 9 }, domains: { x: [0, 10] } });
  const rules = write('r4.json', [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }]);
  assert.throws(() => execute(['repair', '--data', data, '--rules', rules, '--budget', '3']),
    (e) => e.code === 'NO_FEASIBLE');
  const exact = execute(['repair', '--data', data, '--rules', rules, '--budget', '4']);
  assert.equal(exact.cost, 4);
});

test('plan lists ranked candidates', () => {
  const data = write('d5.json', { data: { x: 9 }, domains: { x: [0, 10] } });
  const rules = write('r5.json', [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }]);
  const out = execute(['plan', '--data', data, '--rules', rules, '--budget', '4', '--limit', '3']);
  assert.equal(out.plans.length, 3);
  assert.equal(out.plans[0].cost, 4);
  assert.equal(out.plans[0].fixedViolations, 1);
  assert.ok(out.complete);
});

test('merge of two concurrent CLI repairs commutes and explains', () => {
  const data = write('d6.json', { data: { x: 9, y: 0 }, domains: { x: [0, 10], y: [0, 10] } });
  const rules = write('r6.json', [
    { id: 'rx', type: 'range', var: 'x', min: 0, max: 5 },
    { id: 'ry', type: 'range', var: 'y', min: 3, max: 10 },
  ]);
  const ra = execute(['repair', '--data', data, '--rules', rules, '--budget', '10', '--node', 'A']);
  const rb = execute(['repair', '--data', data, '--rules', rules, '--budget', '10', '--node', 'B']);
  const va = write('va.json', ra.version);
  const vb = write('vb.json', rb.version);
  const v1 = execute(['merge', '--left', va, '--right', vb]).version;
  const v2 = execute(['merge', '--left', vb, '--right', va]).version;
  assert.deepEqual(v1, v2, 'merge must commute');
  assert.deepEqual(v1.data, { x: 5, y: 3 });
  const vf = write('vm.json', v1);
  const trace = execute(['explain', '--version', vf]);
  assert.equal(trace.verified, true);
});

test('merge of forged history fails with HISTORY_CONFLICT', () => {
  const data = write('d7.json', { data: { x: 9 }, domains: { x: [0, 10] } });
  const rules = write('r7.json', [{ id: 'r1', type: 'range', var: 'x', min: 0, max: 5 }]);
  const r = execute(['repair', '--data', data, '--rules', rules, '--budget', '10', '--node', 'A']);
  const forged = { ...r.version, data: { x: 1 } };
  const p1 = write('orig.json', r.version);
  const p2 = write('forged.json', forged);
  assert.throws(() => execute(['merge', '--left', p1, '--right', p2]),
    (e) => e.code === 'HISTORY_CONFLICT');
});
