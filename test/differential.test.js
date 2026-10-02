// Acceptance 1: differential test ("对拍") of the incremental engine against
// a naive reference that enumerates all subsets of pending evidence, on
// randomized packs of 500 evidence rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Store } from '../src/store.js';
import { Engine } from '../src/engine.js';
import { referenceEvaluate, rng } from './helpers/reference.js';
import { evalPred, aggregateRows } from '../src/algebra.js';

const REGIONS = ['EU', 'US', 'APAC', null];
const KINDS = ['invoice', 'estimate', 'audit', null];

function genPack(rand, n = 500) {
  const rows = [];
  for (let i = 0; i < n; i += 1) {
    const roll = rand();
    const status = roll < 0.994 ? 'asserted' : roll < 0.9975 ? 'unknown' : 'retracted';
    let amount = rand() < 0.1 ? null : Math.floor(rand() * 400) - 100;
    if (status !== 'asserted' && amount !== null) {
      // pending rows carry large magnitudes so completions can flip outcomes
      amount = (rand() < 0.5 ? -1 : 1) * (50000 + Math.floor(rand() * 100000));
    }
    rows.push({
      key: `e${i}`,
      status,
      fields: {
        amount,
        region: REGIONS[Math.floor(rand() * REGIONS.length)],
        kind: KINDS[Math.floor(rand() * KINDS.length)],
      },
    });
  }
  return rows;
}

function genRules(rand) {
  const rules = [];
  const m = 2 + Math.floor(rand() * 4);
  for (let i = 0; i < m; i += 1) {
    rules.push({
      id: `rule-${i}`,
      priority: Math.floor(rand() * 3), // small range to force ties
      when: rand() < 0.5
        ? { op: 'eq', field: 'kind', value: KINDS[Math.floor(rand() * 3)] }
        : { op: 'lt', field: 'amount', value: Math.floor(rand() * 100) - 50 },
    });
  }
  return rules;
}

function genClaim(rand, rows) {
  const ops = ['count', 'sum', 'min', 'max'];
  const op = ops[Math.floor(rand() * ops.length)];
  const select = rand() < 0.5
    ? { op: 'eq', field: 'region', value: REGIONS[Math.floor(rand() * 3)] }
    : { op: 'and', args: [
        { op: 'notnull', field: 'amount' },
        { op: 'gte', field: 'amount', value: Math.floor(rand() * 100) - 50 },
      ] };
  const aggregate = op === 'count' && rand() < 0.5
    ? { op: 'count', field: '*' }
    : { op, field: 'amount' };
  // Threshold straddles the asserted-only base value so that pending
  // completions can flip the outcome in either direction.
  const assertedBase = rows.filter(
    (r) => r.status === 'asserted' && evalPred(select, r.fields) === true,
  );
  const base = aggregateRows(aggregate, assertedBase);
  const spread = aggregate.op === 'count' ? 6 : aggregate.op === 'sum' ? 160000 : 120000;
  const threshold = Math.round((base ?? 0) + (rand() * 2 - 1) * spread);
  return { select, aggregate, cmp: { op: rand() < 0.5 ? 'gte' : 'lt', value: threshold } };
}

test('engine matches subset-enumerating reference on 500-evidence packs', () => {
  const conclusionsSeen = new Set();
  const iterations = 30;
  for (let iter = 0; iter < iterations; iter += 1) {
    const rand = rng(0xe9ac1 ^ (iter * 7919));
    const rows = genPack(rand, 500);
    const rules = genRules(rand);
    const claim = genClaim(rand, rows);

    const store = new Store();
    for (const r of rows) store.addEvidence(r);
    for (const rule of rules) store.addRule(rule);
    const engine = new Engine(store);
    const got = engine.evaluate(claim);

    const want = referenceEvaluate(rows, rules, claim);
    assert.ok(
      want.undecided.length <= 20,
      `iter ${iter}: reference pending set too large (${want.undecided.length})`,
    );
    assert.equal(got.conclusion, want.conclusion, `iter ${iter} conclusion`);
    assert.deepEqual(got.hitEvidenceKeys, want.hitEvidenceKeys, `iter ${iter} hits`);
    assert.deepEqual(got.undecided, want.undecided, `iter ${iter} undecided`);
    assert.deepEqual(got.appliedRules, want.appliedRules, `iter ${iter} appliedRules`);
    assert.deepEqual(got.excludedByRule, want.excludedByRule, `iter ${iter} excludedByRule`);
    conclusionsSeen.add(got.conclusion);
  }
  assert.ok(conclusionsSeen.has('pass'), 'expected some pass conclusions');
  assert.ok(conclusionsSeen.has('undecided'), 'expected some undecided conclusions');
});
