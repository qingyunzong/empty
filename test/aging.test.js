import test from 'node:test';
import assert from 'node:assert/strict';
import { planSchedule, validateRounds } from '../src/scheduler.js';

function scenario(agingLimit) {
  return {
    capacity: 10,
    agingLimit,
    institutions: { A: { quota: 10 }, B: { quota: 10 } },
    batches: [
      { id: 'a1', institution: 'A', priority: 5, amount: 100, arrivalRound: 1 },
      { id: 'b1', institution: 'B', priority: 1, amount: 10, arrivalRound: 2 },
    ],
  };
}

function completionRound(rounds, batchId) {
  return rounds.find((r) => r.allocations.some((a) => a.batch === batchId)).round;
}

test('fair aging bounds the wait of a low priority batch', () => {
  const aged = planSchedule(scenario(2));
  const unaged = planSchedule(scenario(null));
  const agedRound = completionRound(aged.rounds, 'b1');
  const unagedRound = completionRound(unaged.rounds, 'b1');
  assert.equal(unagedRound, 11);
  assert.equal(agedRound, 9);
  assert.ok(agedRound < unagedRound);
});

test('aging never breaks hard capacity or quota', () => {
  const { scenario: sc, rounds } = planSchedule(scenario(2));
  validateRounds(sc, rounds);
  for (const r of rounds) assert.ok(r.used <= 10);
});

test('no starvation under quota: every batch drains', () => {
  const { rounds, waits } = planSchedule({
    capacity: 6,
    agingLimit: 1,
    institutions: { A: { quota: 4 }, B: { quota: 4 } },
    batches: [
      { id: 'a1', institution: 'A', priority: 9, amount: 40 },
      { id: 'b1', institution: 'B', priority: 0, amount: 3 },
      { id: 'b2', institution: 'B', priority: 0, amount: 3 },
    ],
  });
  const totals = new Map();
  for (const r of rounds) for (const a of r.allocations) totals.set(a.batch, (totals.get(a.batch) ?? 0) + a.amount);
  assert.equal(totals.get('a1'), 40);
  assert.equal(totals.get('b1'), 3);
  assert.equal(totals.get('b2'), 3);
  assert.ok(Number.isInteger(waits.b1));
});
