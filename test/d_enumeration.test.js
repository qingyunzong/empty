// Acceptance D: exhaustive enumeration of small ledgers (<= 8 events,
// 2 accounts, 2 currencies) cross-checked against an independent
// brute-force oracle and against the product automaton.
import test from 'node:test';
import assert from 'node:assert/strict';
import { diffLedgers, applyScript, isGoal, verifyCertificate, ProductAutomaton, internallyBalanced, multisetDiff } from '../src/index.js';
import { oracleMinCost } from './oracle.js';
import { rng } from './helpers.js';

const ACCOUNTS = ['A1', 'A2'];
const DIRECTIONS = ['debit', 'credit'];

// relId determines currency in this pool so generated ledgers never trip
// the CURRENCY_MIX input error (that error path is tested separately).
const FORMS_16 = [];
for (const account of ACCOUNTS) {
  for (const direction of DIRECTIONS) {
    for (const [relId, currency] of [['R1', 'USD'], ['R2', 'EUR']]) {
      for (const amount of [50, 100]) {
        FORMS_16.push({ account, amount, direction, currency, relId });
      }
    }
  }
}
const FORMS_8 = FORMS_16.filter((f) => f.amount === 50);

function ledger(forms, prefix) {
  return forms.map((f, i) => ({ ...f, id: `${prefix}${i}` }));
}

function allSequences(forms, maxLen) {
  const out = [[]];
  let frontier = [[]];
  for (let len = 1; len <= maxLen; len += 1) {
    const next = [];
    for (const seq of frontier) {
      for (const f of forms) next.push(seq.concat([f]));
    }
    out.push(...next);
    frontier = next;
  }
  return out;
}

const stats = {
  pairs: 0,
  balanced: 0,
  unbalanced: 0,
  searchBound: 0,
  minCostVerified: 0,
  minCostSkipped: 0,
  scriptsVerified: 0,
  certsVerified: 0,
  productChecked: 0,
};

function checkPair(L, R, opts = {}) {
  const {
    productCheck = false,
    productBudget = 100_000,
    budget = 50_000,
    oracleMaxDepth = 6,
    oracleCap = 400_000,
  } = opts;
  stats.pairs += 1;
  const res = diffLedgers(L, R, { k: 6, budget });
  const d = multisetDiff(L, R);
  const expectBalanced = d.lOnly.length === 0 && d.rOnly.length === 0
    && internallyBalanced(L) && internallyBalanced(R);
  assert.equal(res.balanced, expectBalanced, `balanced flag mismatch for ${JSON.stringify([L, R])}`);

  if (res.balanced) {
    stats.balanced += 1;
  } else if (res.error) {
    assert.equal(res.error.code, 'SEARCH_BOUND');
    stats.searchBound += 1;
    assert.ok(res.certificate.provenLowerBound >= 1);
    verifyCertificate(L, R, res.certificate);
    stats.certsVerified += 1;
  } else {
    stats.unbalanced += 1;
    const oracle = oracleMinCost(L, R, { maxDepth: oracleMaxDepth, stateCap: oracleCap });
    if (oracle !== null) {
      assert.equal(res.minCost, oracle, `minCost mismatch for ${JSON.stringify([L, R])}`);
      stats.minCostVerified += 1;
    } else {
      stats.minCostSkipped += 1;
    }
    for (const script of res.scripts) {
      const repaired = applyScript(L, R, script);
      assert.ok(isGoal(repaired.L, repaired.R), `script does not repair: ${JSON.stringify(script)}`);
      stats.scriptsVerified += 1;
    }
    verifyCertificate(L, R, res.certificate);
    stats.certsVerified += 1;
  }

  if (productCheck) {
    const found = new ProductAutomaton(L, R).findAcceptingPath(productBudget);
    if (found !== 'BOUND') {
      assert.equal(found !== null, res.balanced, 'product automaton disagrees with fast decision');
      stats.productChecked += 1;
    }
  }
}

test('D1: exhaustive pairs, |L|+|R| <= 2, 16 forms (2 accounts, 2 currencies)', () => {
  const before = stats.pairs;
  const ledgers = allSequences(FORMS_16, 2);
  for (const lf of ledgers) {
    for (const rf of ledgers) {
      if (lf.length + rf.length > 2) continue;
      checkPair(ledger(lf, 'l'), ledger(rf, 'r'), { productCheck: stats.pairs - before < 150 });
    }
  }
  stats.d1 = stats.pairs - before;
});

test('D2: exhaustive pairs, |L|+|R| <= 3, 8 forms', () => {
  const before2 = stats.pairs;
  const ledgers = allSequences(FORMS_8, 3);
  for (const lf of ledgers) {
    for (const rf of ledgers) {
      if (lf.length + rf.length > 3) continue;
      checkPair(ledger(lf, 'l'), ledger(rf, 'r'));
    }
  }
  stats.d2 = stats.pairs - before2;
});

test('D3: randomized mutation pairs up to 8 events, 16 forms', () => {
  const before3 = stats.pairs;
  const rand = rng(20261005);
  const pick = (arr) => arr[Math.floor(rand() * arr.length)];
  for (let iter = 0; iter < 200; iter += 1) {
    const baseLen = Math.floor(rand() * 5); // 0..4
    const base = Array.from({ length: baseLen }, () => pick(FORMS_16));
    const left = ledger(base, 'l');
    const rightForms = base.map((f) => ({ ...f }));
    const mutations = Math.floor(rand() * 5); // 0..4
    for (let m = 0; m < mutations; m += 1) {
      const kind = rand();
      if (kind < 0.35 && rightForms.length > 0) {
        rightForms.splice(Math.floor(rand() * rightForms.length), 1);
      } else if (kind < 0.7 && rightForms.length < 8) {
        rightForms.splice(Math.floor(rand() * (rightForms.length + 1)), 0, pick(FORMS_16));
      } else if (rightForms.length > 0) {
        const i = Math.floor(rand() * rightForms.length);
        const rel = rand() < 0.5 ? 'R1' : 'R2';
        rightForms[i] = { ...rightForms[i], relId: rel, currency: rel === 'R1' ? 'USD' : 'EUR' };
      }
    }
    const right = ledger(rightForms, 'r');
    checkPair(left, right, {
      productCheck: iter < 10,
      productBudget: 10_000,
      budget: 10_000,
      oracleMaxDepth: 5,
      oracleCap: 30_000,
    });
  }
  stats.d3 = stats.pairs - before3;
});

test('D4: enumeration coverage summary', () => {
  console.log(`[D] per-test pairs: D1=${stats.d1} D2=${stats.d2} D3=${stats.d3}`);
  assert.ok(stats.pairs > 3000, `expected broad coverage, got ${stats.pairs} pairs`);
  assert.ok(stats.balanced > 0 && stats.unbalanced > 0, 'need both balanced and unbalanced cases');
  assert.ok(stats.minCostVerified > 500, `oracle cross-check too thin: ${stats.minCostVerified}`);
  console.log(`[D] ${JSON.stringify(stats)}`);
});
