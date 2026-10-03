import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { BudgetService } from '../src/budget.js';
import { BUDGET_EXCEEDED } from '../src/errors.js';

const tmpdir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'conc-'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Deterministic PRNG so failures are reproducible.
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Acceptance scenario (1): balance 100, two concurrent transactions each
// debit 80 -> exactly one succeeds; balance and usage records agree.
test('two concurrent debits of 80 on balance 100: exactly one succeeds', async () => {
  const svc = new BudgetService(tmpdir());
  await svc.createAccount('a', 100);

  const attempt = (note) =>
    svc.debit('a', 80, note, { retries: 10 }).then(
      () => 'ok',
      (e) => e.code,
    );
  const results = await Promise.all([attempt('t1'), attempt('t2')]);

  assert.deepEqual([...results].sort(), [BUDGET_EXCEEDED, 'ok'],
    'one wins, the other ultimately finds insufficient budget');
  assert.equal(svc.balance('a'), 20);

  const usage = svc.usage('a');
  assert.equal(usage.length, 1, 'exactly one usage record');
  assert.equal(usage[0].amount, 80);
  assert.equal(100 - svc.balance('a'), usage.reduce((s, r) => s + r.amount, 0),
    'balance and usage records are consistent');
});

// Acceptance scenario (3): random concurrent debit sequences; the final
// balance must belong to the set of balances reachable by some serial
// schedule of the same debits (serializability), and usage records must
// account exactly for the spent budget (no overdraft, no lost updates).
test('random concurrent debits match serial-enumeration reference', async (t) => {
  const TRIALS = 30;
  for (let trial = 0; trial < TRIALS; trial++) {
    const rand = mulberry32(0xbeef + trial);
    const initial = 100;
    const n = 6;
    const amounts = Array.from({ length: n }, () => 10 + Math.floor(rand() * 51)); // 10..60

    // Reference: enumerate all serial schedules of this debit multiset.
    // Under each schedule a debit succeeds iff the remaining balance covers
    // it; collect the set of reachable final balances.
    const reachable = new Set();
    const permute = (prefix, rest, balance) => {
      if (rest.length === 0) {
        reachable.add(balance);
        return;
      }
      for (let i = 0; i < rest.length; i++) {
        if (i > 0 && rest[i] === rest[i - 1]) continue; // dedupe equal amounts
        const next = [...rest.slice(0, i), ...rest.slice(i + 1)];
        const amt = rest[i];
        permute([...prefix, amt], next, balance >= amt ? balance - amt : balance);
        // Note: a failed debit leaves the balance unchanged; both branches
        // are captured because success is forced when affordable. To also
        // cover schedules where the debit fails, the balance>=amt branch
        // above is the only serial outcome (debits retry until terminal),
        // so no extra branch is needed.
      }
    };
    permute([], [...amounts].sort((a, b) => a - b), initial);

    // Concurrent execution with random interleaving; retry on CONFLICT
    // until each debit reaches a terminal state (ok or BUDGET_EXCEEDED).
    const svc = new BudgetService(tmpdir());
    await svc.createAccount('a', initial);
    const outcomes = await Promise.all(
      amounts.map((amt, i) =>
        sleep(Math.floor(rand() * 5)).then(() =>
          svc.debit('a', amt, `d${i}`, { retries: 50 }).then(
            () => ({ amt, ok: true }),
            (e) => {
              assert.equal(e.code, BUDGET_EXCEEDED, `unexpected error ${e.code}`);
              return { amt, ok: false };
            },
          ),
        ),
      ),
    );

    const finalBalance = svc.balance('a');
    const spent = outcomes.filter((o) => o.ok).reduce((s, o) => s + o.amt, 0);
    const usage = svc.usage('a');

    assert.ok(finalBalance >= 0, `trial ${trial}: never overdrawn`);
    assert.equal(finalBalance, initial - spent, `trial ${trial}: balance matches committed debits`);
    assert.equal(usage.length, outcomes.filter((o) => o.ok).length,
      `trial ${trial}: one usage record per successful debit`);
    assert.equal(usage.reduce((s, r) => s + r.amount, 0), spent,
      `trial ${trial}: usage records sum to spent budget`);
    assert.ok(reachable.has(finalBalance),
      `trial ${trial}: final balance ${finalBalance} must be a serially reachable outcome (set: ${[...reachable].sort((x, y) => x - y)})`);
  }
});
