import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonicalize, canonicalPlan, comparePlan, hashPlan } from '../src/canon.js';

test('canonicalize sorts object keys recursively', () => {
  assert.equal(canonicalize({ b: 1, a: { d: 2, c: 3 } }), '{"a":{"c":3,"d":2},"b":1}');
});

test('canonicalPlan is order-insensitive over allocations', () => {
  const a1 = { machine: 'm1', day: 1, material: 'steel', amount: 10 };
  const a2 = { machine: 'm2', day: 2, material: 'hours', amount: 5 };
  assert.equal(canonicalPlan([a1, a2]), canonicalPlan([a2, a1]));
});

test('plan ordering is deterministic and lexicographic on canonical JSON', () => {
  const a = [{ machine: 'm1', day: 1, material: 'steel', amount: 80 }];
  const b = [{ machine: 'm2', day: 1, material: 'steel', amount: 80 }];
  assert.ok(comparePlan(a, b) < 0);
  assert.ok(comparePlan(b, a) > 0);
  assert.equal(comparePlan(a, a), 0);
});

test('hashPlan is stable for equivalent plans', () => {
  const p1 = [{ amount: 80, material: 'steel', day: 1, machine: 'm1', extra: 'ignored' }];
  const p2 = [{ machine: 'm1', day: 1, material: 'steel', amount: 80 }];
  assert.equal(hashPlan(p1), hashPlan(p2));
  assert.match(hashPlan(p1), /^[0-9a-f]{64}$/);
});
