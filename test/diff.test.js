import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateClaim } from '../src/verify.js';
import { refEvaluate } from './reference.mjs';
import { memStore, rng } from './helpers.mjs';

// Acceptance 1: differential test against a brute-force reference that
// enumerates all subsets of uncertain rows. Pack size: 500 evidence rows.

const N_ROWS = 500;
const N_CATS = 25; // 20 rows per category keeps the uncertain subset small
const N_CLAIMS = 400;

function genPack(rand) {
  const rows = [];
  for (let i = 0; i < N_ROWS; i++) {
    const roll = rand();
    const state = roll < 0.78 ? 'asserted' : roll < 0.9 ? 'unknown' : 'retracted';
    rows.push({
      key: `e${i}`,
      state,
      attrs: {
        cat: `c${i % N_CATS}`,
        grp: `g${Math.floor(rand() * 4)}`,
        amount: Math.floor(rand() * 21) - 5, // -5..15, includes negatives
        score: rand() < 0.12 ? null : Math.floor(rand() * 100),
      },
    });
  }
  const rules = [];
  for (let i = 0; i < 8; i++) {
    const kind = i % 3;
    rules.push({
      id: `rule-${i}`,
      priority: [1, 5, 5, 9][i % 4],
      where:
        kind === 0
          ? [{ field: 'grp', op: 'eq', value: `g${i % 4}` }]
          : kind === 1
            ? [{ field: 'amount', op: 'lt', value: -3 }]
            : [{ field: 'cat', op: 'eq', value: `c${(i * 7) % N_CATS}` }],
    });
  }
  return { rows, rules };
}

function genClaim(rand) {
  const where = [{ field: 'cat', op: 'eq', value: `c${Math.floor(rand() * N_CATS)}` }];
  if (rand() < 0.4) where.push({ field: 'amount', op: 'gte', value: Math.floor(rand() * 6) - 2 });
  const aggKind = Math.floor(rand() * 5);
  const aggregate =
    aggKind === 0
      ? { op: 'count', field: '*' }
      : aggKind === 1
        ? { op: 'count', field: 'score' }
        : { op: ['sum', 'min', 'max'][aggKind - 2], field: rand() < 0.5 ? 'amount' : 'score' };
  const expect = {
    op: ['lt', 'lte', 'gt', 'gte'][Math.floor(rand() * 4)],
    value: Math.floor(rand() * 31) - 5,
  };
  return { where, aggregate, expect };
}

test(`diff: ${N_ROWS} evidence rows x ${N_CLAIMS} random claims vs subset-enumeration reference`, () => {
  const rand = rng(20261002);
  const { rows, rules } = genPack(rand);
  const store = memStore(rows, rules);
  const tally = { pass: 0, fail: 0, undecided: 0 };
  for (let i = 0; i < N_CLAIMS; i++) {
    const claim = genClaim(rand);
    const actual = evaluateClaim(store, claim);
    const expected = refEvaluate(rows, rules, claim);
    assert.equal(
      actual.conclusion,
      expected.conclusion,
      `claim #${i} ${JSON.stringify(claim)}: lib=${actual.conclusion} ref=${expected.conclusion}`
    );
    assert.deepEqual(actual.hits, expected.hits, `claim #${i} hits`);
    assert.deepEqual(actual.undecided, expected.undecided, `claim #${i} undecided keys`);
    assert.deepEqual(actual.retracted, expected.retracted, `claim #${i} retracted keys`);
    tally[actual.conclusion]++;
  }
  // The corpus must exercise all three outcomes to be a meaningful diff test.
  assert.ok(tally.pass > 0, `no pass outcomes: ${JSON.stringify(tally)}`);
  assert.ok(tally.fail > 0, `no fail outcomes: ${JSON.stringify(tally)}`);
  assert.ok(tally.undecided > 0, `no undecided outcomes: ${JSON.stringify(tally)}`);
});

test('diff: retraction storm stays consistent with reference (incremental path)', () => {
  const rand = rng(777);
  const { rows, rules } = genPack(rand);
  const store = memStore(rows, rules);
  const claims = Array.from({ length: 20 }, () => genClaim(rand));
  // Retract 60 random asserted/unknown rows one by one; after each batch,
  // conclusions must match the reference over the mutated row set.
  const mutable = rows.map((r) => ({ ...r }));
  for (let step = 0; step < 60; step++) {
    const idx = Math.floor(rand() * mutable.length);
    if (mutable[idx].state === 'retracted') continue;
    mutable[idx] = { ...mutable[idx], state: 'retracted' };
    store.retract(mutable[idx].key);
    if (step % 10 === 9) {
      for (const claim of claims) {
        const actual = evaluateClaim(store, claim);
        const expected = refEvaluate(mutable, rules, claim);
        assert.equal(actual.conclusion, expected.conclusion, `step ${step} ${JSON.stringify(claim)}`);
      }
    }
  }
});
