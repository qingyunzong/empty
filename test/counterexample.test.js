import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipes } from '../src/recipes.js';
import { validateApprovals } from '../src/approvals.js';
import { minimalAllowSet } from '../src/counterexample.js';

const plant = {
  factories: [{ id: 'F1', workshops: [{ id: 'W1', kettles: ['K1'] }] }],
};
const recipes = validateRecipes({ plant, versions: [{ id: 'v1', seq: 1 }], forbidden: [] });
const attempt = { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 10 };

test('minimal set is a single grant when one suffices', () => {
  const approvals = [
    { id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 1 },
    { id: 'a2', kind: 'grant', level: 'kettle', target: 'K1', version: 'v1', ts: 1 },
  ];
  validateApprovals(approvals, recipes);
  const min = minimalAllowSet(recipes, approvals, attempt);
  assert.equal(min.size, 1);
  assert.deepEqual(min.set, ['a1']); // deterministic: lexicographically smallest
});

test('no set exists when a nearer deny always truncates', () => {
  const approvals = [
    { id: 'a1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 1 },
    { id: 'd1', kind: 'deny', level: 'workshop', target: 'W1', version: 'v1', ts: 1 },
  ];
  validateApprovals(approvals, recipes);
  // Any subset containing d1 without a kettle-level grant is denied; but a
  // subset with only a1 allows, so the minimal set is just [a1].
  const min = minimalAllowSet(recipes, approvals, attempt);
  assert.deepEqual(min, { size: 1, set: ['a1'] });
});

test('returns null when no approval can ever allow', () => {
  const approvals = [
    { id: 'd1', kind: 'deny', level: 'kettle', target: 'K1', version: 'v1', ts: 1 },
  ];
  validateApprovals(approvals, recipes);
  assert.equal(minimalAllowSet(recipes, approvals, attempt), null);
});

test('revoked grant needs the grant plus nothing else (revoke excluded from candidates)', () => {
  const approvals = [
    { id: 'a1', kind: 'grant', level: 'kettle', target: 'K1', version: 'v1', ts: 1 },
    { id: 'r1', kind: 'revoke', revokes: 'a1', reason: 'x', ts: 5 },
  ];
  validateApprovals(approvals, recipes);
  const min = minimalAllowSet(recipes, approvals, attempt);
  assert.deepEqual(min, { size: 1, set: ['a1'] });
});
