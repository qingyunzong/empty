import test from 'node:test';
import assert from 'node:assert/strict';
import { validateRecipes } from '../src/recipes.js';
import { validateApprovals } from '../src/approvals.js';
import { runAll } from '../src/audit.js';
import { bruteRunAll } from '../src/brute.js';

// Acceptance D: cross-check interpreter vs brute-force reference over every
// subset of an 8-approval pool and every subset of 3 forbidden pairs.

const plant = {
  factories: [{ id: 'F1', workshops: [{ id: 'W1', kettles: ['K1', 'K2'] }] }],
};
const versions = [
  { id: 'v1', seq: 1 },
  { id: 'v2', seq: 1 },
  { id: 'v3', seq: 1 },
];
const approvalPool = [
  { id: 'g1', kind: 'grant', level: 'factory', target: 'F1', version: '*', ts: 0 },
  { id: 'g2', kind: 'grant', level: 'workshop', target: 'W1', version: 'v1', ts: 0 },
  { id: 'g3', kind: 'grant', level: 'kettle', target: 'K1', version: 'v2', ts: 1 },
  { id: 'g4', kind: 'grant', level: 'factory', target: 'F1', version: 'v3', ts: 1 },
  { id: 'd1', kind: 'deny', level: 'workshop', target: 'W1', version: 'v1', ts: 0 },
  { id: 'd2', kind: 'deny', level: 'factory', target: 'F1', version: 'v3', ts: 2 },
  { id: 'd3', kind: 'deny', level: 'kettle', target: 'K2', version: '*', ts: 0 },
  { id: 'r1', kind: 'revoke', revokes: 'g1', reason: 'x', ts: 3 },
];
const pairPool = [['v1', 'v2'], ['v2', 'v3'], ['v1', 'v3']];
const attempts = [
  { id: 't1', kettle: 'K1', version: 'v1', operator: 'op1', ts: 1 },
  { id: 't2', kettle: 'K1', version: 'v2', operator: 'op1', ts: 2 },
  { id: 't3', kettle: 'K2', version: 'v3', operator: 'op1', ts: 4 },
  { id: 't4', kettle: 'K1', version: 'v3', operator: 'op1', ts: 5 },
];

const simplify = (results) =>
  results.map((r) => ({ decision: r.decision, approval: r.approval, conflictWith: r.conflictWith ?? null }));

test('D: interpreter matches brute force for all <=8 approvals / <=8 forbidden pairs', () => {
  let worlds = 0;
  for (let mask = 0; mask < 1 << 8; mask++) {
    const approvals = approvalPool.filter((_, i) => (mask >> i) & 1);
    const ids = new Set(approvals.map((a) => a.id));
    if (ids.has('r1') && !ids.has('g1')) continue; // keep approval chain valid
    for (let fmask = 0; fmask < 1 << 3; fmask++) {
      const forbidden = pairPool.filter((_, i) => (fmask >> i) & 1).map((pair) => ({ pair }));
      const recipes = validateRecipes({ plant, versions, forbidden });
      validateApprovals(approvals, recipes);
      const interp = runAll(recipes, approvals, attempts);
      const brute = bruteRunAll(recipes, approvals, attempts);
      assert.deepStrictEqual(
        simplify(interp.results),
        simplify(brute.results),
        `mismatch mask=${mask.toString(2)} fmask=${fmask.toString(2)}`,
      );
      worlds++;
    }
  }
  assert.equal(worlds, 1536);
});
