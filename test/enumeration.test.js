'use strict';

// Acceptance D: the incremental engine must agree with a from-scratch
// reference evaluation for every subset (size <= 8) of an 8-event pool,
// and the emitted patches must reconstruct the same eligible sets.

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Engine, XborderError } = require('../src/engine');

const ACCOUNT = {
  type: 'account', budget: 100, quoteTtl: 10, worstRate: { USD: 2, EUR: 3 }, frozen: { USD: 5 },
};

// Event pool (order preserved within each subset). Deliberately mixes
// pending payments, quotes (incl. a stale one), freezes, reverses and
// references to possibly-undeclared payments to exercise error paths.
const POOL = [
  { type: 'payment', id: 'p1', amount: 10, ccy: 'USD', rate: null, ts: 1 },
  { type: 'payment', id: 'p2', amount: 30, ccy: 'EUR', rate: 1.5, ts: 2 },
  { type: 'quote', paymentId: 'p1', rate: 2, ts: 3 },
  { type: 'freeze', paymentId: 'p1', ts: 4 },
  { type: 'freeze', paymentId: 'p2', ts: 5 },
  { type: 'reverse', paymentId: 'p1', ts: 6 },
  { type: 'quote', paymentId: 'p1', rate: 1, ts: 2 }, // stale if quote@3 applied
  { type: 'payment', id: 'p3', amount: 5, ccy: 'USD', rate: null, ts: 7 },
];

// --- Independent reference: replay prefixes from scratch, no carried state ---
// Returns { sets, error }: sets[i] is the eligible set after events[0..i];
// error is the XborderError code raised by the first failing event, if any.

function referenceRun(events) {
  const account = { budget: 0, quoteTtl: Infinity, worstRate: {}, frozen: {} };
  const payments = new Map();
  let now = 0;
  const sets = [];

  const confirmed = () => {
    let total = 0;
    for (const v of Object.values(account.frozen)) total += v;
    for (const p of payments.values()) if (p.frozen) total += p.amount * p.rate;
    return total;
  };
  const pendingWorst = () => {
    let total = 0;
    for (const p of payments.values()) {
      if (!p.frozen && p.rate === null) {
        const cap = account.worstRate[p.ccy];
        total += p.amount * (cap === undefined ? Infinity : cap);
      }
    }
    return total;
  };

  for (const event of events) {
    try {
      if (typeof event.ts === 'number' && event.ts > now) now = event.ts;
      if (event.type === 'account') {
        if (event.budget !== undefined) account.budget = event.budget;
        if (event.quoteTtl !== undefined) account.quoteTtl = event.quoteTtl;
        Object.assign(account.worstRate, event.worstRate || {});
        Object.assign(account.frozen, event.frozen || {});
      } else if (event.type === 'payment') {
        if (payments.has(event.id)) throw new XborderError('E_INVALID', 'dup');
        payments.set(event.id, {
          amount: event.amount,
          ccy: event.ccy,
          rate: event.rate === undefined ? null : event.rate,
          quoteTs: event.rate == null ? null : (typeof event.ts === 'number' ? event.ts : now),
          frozen: false,
        });
      } else if (event.type === 'quote') {
        const p = payments.get(event.paymentId);
        if (!p || p.frozen) throw new XborderError('E_INVALID', 'bad quote');
        const ts = typeof event.ts === 'number' ? event.ts : now;
        if (p.quoteTs !== null && ts < p.quoteTs) throw new XborderError('E_RATE_STALE', 'old quote');
        p.rate = event.rate;
        p.quoteTs = ts;
      } else if (event.type === 'freeze') {
        const p = payments.get(event.paymentId);
        if (!p || p.frozen || p.rate === null) throw new XborderError('E_INVALID', 'bad freeze');
        if (now - p.quoteTs > account.quoteTtl) throw new XborderError('E_RATE_STALE', 'stale');
        if (confirmed() + pendingWorst() + p.amount * p.rate > account.budget) {
          throw new XborderError('E_BUDGET', 'over budget');
        }
        p.frozen = true;
      } else if (event.type === 'reverse') {
        const p = payments.get(event.paymentId);
        if (!p || !p.frozen) throw new XborderError('E_INVALID', 'bad reverse');
        p.frozen = false;
      } else {
        throw new XborderError('E_INVALID', 'unknown');
      }
    } catch (err) {
      return { sets, error: err.code };
    }

    const eligible = new Set();
    for (const [id, p] of payments) {
      if (p.frozen || p.rate === null) continue;
      if (now - p.quoteTs > account.quoteTtl) continue;
      if (confirmed() + pendingWorst() + p.amount * p.rate > account.budget) continue;
      eligible.add(id);
    }
    sets.push(eligible);
  }
  return { sets, error: null };
}

function* subsets(pool) {
  const n = pool.length;
  for (let mask = 0; mask < (1 << n); mask++) {
    const picked = [];
    for (let i = 0; i < n; i++) if (mask & (1 << i)) picked.push(pool[i]);
    yield picked;
  }
}

test('D: incremental engine matches from-scratch reference on all 2^8 subsets', () => {
  let subsetCount = 0;
  let checked = 0;
  let erroring = 0;
  for (const picked of subsets(POOL)) {
    subsetCount++;
    assert.ok(picked.length <= 8);
    const events = [ACCOUNT, ...picked];
    const ref = referenceRun(events);

    const engine = new Engine();
    const shadow = new Set();
    let engineError = null;
    let step = 0;
    try {
      for (step = 0; step < events.length; step++) {
        const { add, remove } = engine.apply(events[step]);
        for (const id of add) shadow.add(id);
        for (const id of remove) shadow.delete(id);
        // 1) incremental state equals the from-scratch reference for this prefix
        const expected = [...ref.sets[step]].sort();
        assert.deepEqual([...engine.eligible].sort(), expected,
          `eligibleSet mismatch at step ${step} of ${JSON.stringify(picked)}`);
        // 2) the patch stream reconstructs the same set
        assert.deepEqual([...shadow].sort(), expected,
          `patch reconstruction mismatch at step ${step} of ${JSON.stringify(picked)}`);
        checked++;
      }
    } catch (err) {
      assert.ok(err instanceof XborderError, `unexpected error: ${err.stack}`);
      engineError = err.code;
      assert.equal(step, ref.sets.length,
        `engine errored at step ${step} but reference processed ${ref.sets.length} events`);
    }

    assert.equal(engineError, ref.error,
      `error mismatch (engine=${engineError} ref=${ref.error}) for ${JSON.stringify(picked)}`);
    if (engineError !== null) erroring++;
  }
  assert.equal(subsetCount, 256);
  console.log(`    subsets verified: ${subsetCount}, prefix steps compared: ${checked}, subsets ending in error: ${erroring}`);
});
