import { test } from 'node:test';
import assert from 'node:assert/strict';
import { check, topoOrder, DqError, RULE_CYCLE } from '../src/index.js';

test('rule dependency cycle is rejected with RULE_CYCLE', () => {
  const rules = [
    { id: 'a', type: 'range', var: 'x', min: 0, max: 10, dependsOn: ['c'] },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 10, dependsOn: ['a'] },
    { id: 'c', type: 'range', var: 'x', min: 0, max: 10, dependsOn: ['b'] },
  ];
  assert.throws(() => topoOrder(rules), (err) => {
    assert.ok(err instanceof DqError);
    assert.equal(err.code, RULE_CYCLE);
    assert.match(err.message, /cycle/);
    return true;
  });
  assert.throws(() => check({ data: { x: 5 }, rules }), (err) => err.code === RULE_CYCLE);
});

test('self-dependency is a cycle', () => {
  const rules = [{ id: 'a', type: 'range', var: 'x', min: 0, max: 1, dependsOn: ['a'] }];
  assert.throws(() => topoOrder(rules), (err) => err.code === RULE_CYCLE);
});

test('acyclic rules produce a deterministic topological order', () => {
  const rules = [
    { id: 'c', type: 'range', var: 'x', min: 0, max: 9, dependsOn: ['a', 'b'] },
    { id: 'a', type: 'range', var: 'x', min: 0, max: 9 },
    { id: 'b', type: 'range', var: 'x', min: 0, max: 9, dependsOn: ['a'] },
  ];
  assert.deepEqual(topoOrder(rules), ['a', 'b', 'c']);
});

test('check reports violations in dependency order', () => {
  const rules = [
    { id: 'r1', type: 'range', var: 'x', min: 0, max: 5 },
    { id: 'r2', type: 'eq', vars: ['x', 'y'], dependsOn: ['r1'] },
  ];
  const result = check({ data: { x: 9, y: 1 }, rules });
  assert.equal(result.ok, false);
  assert.deepEqual(result.violations.map((v) => v.rule), ['r1', 'r2']);
});
