import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkData, topoSort } from '../src/rules.js';
import { RULE_CYCLE } from '../src/errors.js';

test('rule dependency cycle raises RULE_CYCLE', () => {
  const rules = [
    { id: 'a', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['b'] },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['c'] },
    { id: 'c', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['a'] },
  ];
  assert.throws(() => checkData(rules, { x: 0 }), (e) => {
    assert.equal(e.code, RULE_CYCLE);
    assert.match(e.message, /cycle/);
    return true;
  });
});

test('self-dependency is a cycle', () => {
  const rules = [{ id: 'a', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['a'] }];
  assert.throws(() => topoSort(rules), (e) => e.code === RULE_CYCLE);
});

test('acyclic rules topologically sort with dependencies first', () => {
  const rules = [
    { id: 'c', type: 'range', var: 'x', min: 0, max: 9, dependsOn: ['a', 'b'] },
    { id: 'a', type: 'range', var: 'x', min: 0, max: 9 },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 9, dependsOn: ['a'] },
  ];
  const order = topoSort(rules);
  assert.ok(order.indexOf('a') < order.indexOf('b'));
  assert.ok(order.indexOf('b') < order.indexOf('c'));
});

test('checkData reports violations in dependency order', () => {
  const rules = [
    { id: 'r1', type: 'range', var: 'x', min: 0, max: 5 },
    { id: 'r2', type: 'leq', a: 'x', b: 'y', dependsOn: ['r1'] },
  ];
  const { violations, order } = checkData(rules, { x: 9, y: 1 });
  assert.deepEqual(order, ['r1', 'r2']);
  assert.deepEqual(violations.map((v) => v.rule), ['r1', 'r2']);
  const ok = checkData(rules, { x: 1, y: 2 });
  assert.deepEqual(ok.violations, []);
});
