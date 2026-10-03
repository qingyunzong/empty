import test from 'node:test';
import assert from 'node:assert/strict';
import {
  effectiveWeight,
  validateInput,
  planRound,
  simulate,
  buildItems,
} from '../src/scheduler.js';
import { initialState } from '../src/store.js';

const base = (over = {}) => ({
  capacity: 10,
  agingLimit: 2,
  agingBonus: 1,
  institutions: { A: { quota: 100 }, B: { quota: 100 } },
  batches: [],
  ...over,
});

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('aging boosts weight only after agingLimit', () => {
  const cfg = { agingLimit: 2, agingBonus: 1 };
  assert.equal(effectiveWeight(4, 0, cfg), 4);
  assert.equal(effectiveWeight(4, 2, cfg), 4);
  assert.equal(effectiveWeight(4, 3, cfg), 8);
  assert.equal(effectiveWeight(4, 5, cfg), 16);
});

test('validateInput maps unschedulable inputs to error codes', () => {
  const tooBigGroup = base({
    batches: [
      { id: 'g1a', institution: 'A', amount: 6, priority: 1, group: 'g1' },
      { id: 'g1b', institution: 'B', amount: 6, priority: 1, group: 'g1' },
    ],
  });
  assert.equal(validateInput(tooBigGroup).code, 'ATOMIC_SPLIT');

  const tooBigBatch = base({ batches: [{ id: 'x', institution: 'A', amount: 11, priority: 1 }] });
  assert.equal(validateInput(tooBigBatch).code, 'WINDOW_FULL');

  const noQuota = base({
    institutions: { A: { quota: 0 } },
    batches: [{ id: 'x', institution: 'A', amount: 1, priority: 1 }],
  });
  assert.equal(validateInput(noQuota).code, 'QUOTA');

  const groupOverQuota = base({
    institutions: { A: { quota: 5 }, B: { quota: 100 } },
    batches: [
      { id: 'g1a', institution: 'A', amount: 4, priority: 1, group: 'g1' },
      { id: 'g1b', institution: 'A', amount: 4, priority: 1, group: 'g1' },
    ],
  });
  assert.equal(validateInput(groupOverQuota).code, 'QUOTA');

  const ok = base({ batches: [{ id: 'x', institution: 'A', amount: 50, priority: 1, splittable: true }] });
  assert.equal(validateInput(ok), null);
});

test('atomic group settles all members in the same round or waits entirely', () => {
  const input = base({
    batches: [
      { id: 'g1a', institution: 'A', amount: 6, priority: 10, group: 'g1' },
      { id: 'g1b', institution: 'B', amount: 4, priority: 10, group: 'g1' },
      { id: 's1', institution: 'A', amount: 8, priority: 1 },
    ],
  });
  const state = initialState(input);
  const r = planRound(input, state.remaining, state.waits);
  const settled = new Set(r.allocations.map((a) => a.batch));
  assert.ok(settled.has('g1a') && settled.has('g1b'), 'group wins together');
  assert.ok(!settled.has('s1'));

  // Now make the single batch outrank the group: group must wait unsplit.
  const input2 = base({
    batches: [
      { id: 'g1a', institution: 'A', amount: 6, priority: 1, group: 'g1' },
      { id: 'g1b', institution: 'B', amount: 4, priority: 1, group: 'g1' },
      { id: 's1', institution: 'A', amount: 8, priority: 5 },
    ],
  });
  const state2 = initialState(input2);
  const r2 = planRound(input2, state2.remaining, state2.waits);
  const settled2 = new Set(r2.allocations.map((a) => a.batch));
  assert.ok(settled2.has('s1'));
  assert.ok(!settled2.has('g1a') && !settled2.has('g1b'), 'group is never split');
});

test('high priority batch preempts low priority splittable remainder', () => {
  const input = base({
    batches: [
      { id: 'low', institution: 'A', amount: 10, priority: 1, splittable: true },
      { id: 'high', institution: 'B', amount: 6, priority: 5 },
    ],
  });
  const state = initialState(input);
  const r = planRound(input, state.remaining, state.waits);
  const byBatch = Object.fromEntries(r.allocations.map((a) => [a.batch, a.amount]));
  assert.equal(byBatch.high, 6);
  assert.equal(byBatch.low, 4, 'splittable remainder rolled back to make room');
  assert.equal(r.used, 10);
});

test('confirmed atomic group is never evicted by higher priority batch', () => {
  const input = base({
    batches: [
      { id: 'g1a', institution: 'A', amount: 4, priority: 50, group: 'g1' },
      { id: 'g1b', institution: 'B', amount: 2, priority: 50, group: 'g1' },
      { id: 'h', institution: 'A', amount: 8, priority: 90 },
    ],
  });
  const state = initialState(input);
  const r = planRound(input, state.remaining, state.waits);
  const settled = new Set(r.allocations.map((a) => a.batch));
  assert.ok(settled.has('g1a') && settled.has('g1b'), 'atomic group stays intact');
  assert.ok(!settled.has('h'));
});

test('fair aging lets a waited batch outrank a fresher higher-priority one', () => {
  const mk = (agingLimit) =>
    base({
      agingLimit,
      agingBonus: 1,
      batches: [
        { id: 'A', institution: 'A', amount: 10, priority: 5, arrival: 1 },
        { id: 'B', institution: 'A', amount: 10, priority: 4, arrival: 1 },
        { id: 'C', institution: 'A', amount: 10, priority: 4.5, arrival: 2 },
      ],
    });
  const order = (input) =>
    simulate(input, initialState(input)).rounds.map((r) => r.allocations[0].batch);
  assert.deepEqual(order(mk(0)), ['A', 'B', 'C'], 'aged B beats newly arrived C');
  assert.deepEqual(order(mk(99)), ['A', 'C', 'B'], 'without aging C beats B');
});

test('batches are not eligible before their arrival round', () => {
  const input = base({
    batches: [
      { id: 'now', institution: 'A', amount: 5, priority: 1, arrival: 1 },
      { id: 'later', institution: 'A', amount: 5, priority: 9, arrival: 3 },
    ],
  });
  const sim = simulate(input, initialState(input));
  assert.equal(sim.rounds[0].allocations[0].batch, 'now');
  const settledRound = sim.rounds.find((r) => r.allocations.some((a) => a.batch === 'later'));
  assert.ok(settledRound.index >= 3);
});

test('no starvation under quota: every batch settles within bounded rounds', () => {
  const input = base({
    capacity: 10,
    institutions: { A: { quota: 10 }, B: { quota: 10 } },
    batches: [
      { id: 'a1', institution: 'A', amount: 10, priority: 9 },
      { id: 'a2', institution: 'A', amount: 10, priority: 8 },
      { id: 'a3', institution: 'A', amount: 10, priority: 7 },
      { id: 'b1', institution: 'B', amount: 10, priority: 1 },
      { id: 'b2', institution: 'B', amount: 10, priority: 1 },
    ],
  });
  const sim = simulate(input, initialState(input));
  assert.equal(sim.rounds.length, 5);
  assert.equal(Object.keys(sim.remaining).length, 0);
  const settledBy = {};
  for (const r of sim.rounds) for (const a of r.allocations) settledBy[a.batch] = r.index;
  assert.deepEqual(Object.keys(settledBy).sort(), ['a1', 'a2', 'a3', 'b1', 'b2']);
});

test('property: random instances never split groups, exceed capacity or quotas', () => {
  const rand = mulberry32(42);
  for (let iter = 0; iter < 100; iter++) {
    const nInst = 1 + Math.floor(rand() * 3);
    const institutions = {};
    for (let i = 0; i < nInst; i++) institutions[`I${i}`] = { quota: 5 + Math.floor(rand() * 30) };
    const capacity = 10 + Math.floor(rand() * 30);
    const nBatches = 1 + Math.floor(rand() * 12);
    const batches = [];
    for (let i = 0; i < nBatches; i++) {
      const inst = `I${Math.floor(rand() * nInst)}`;
      const b = { id: `b${i}`, institution: inst, amount: 1 + Math.floor(rand() * 8), priority: 1 + Math.floor(rand() * 9) };
      const roll = rand();
      if (roll < 0.3) b.group = `g${Math.floor(i / 2)}`;
      else if (roll < 0.5) b.splittable = true;
      batches.push(b);
    }
    // keep groups schedulable: shrink members so group total fits capacity
    const input = { capacity, agingLimit: 1, agingBonus: 1, institutions, batches };
    if (validateInput(input)) continue;
    const sim = simulate(input, initialState(input));
    assert.equal(Object.keys(sim.remaining).length, 0, 'all settle eventually');
    const groupRound = new Map();
    for (const r of sim.rounds) {
      assert.ok(r.used <= capacity + 1e-9, `capacity respected (iter ${iter})`);
      const perInst = {};
      for (const a of r.allocations) {
        perInst[a.institution] = (perInst[a.institution] ?? 0) + a.amount;
        const b = batches.find((x) => x.id === a.batch);
        if (b.group) {
          if (!groupRound.has(b.group)) groupRound.set(b.group, { round: r.index, members: new Set() });
          const g = groupRound.get(b.group);
          assert.equal(g.round, r.index, `group ${b.group} in one round (iter ${iter})`);
          g.members.add(a.batch);
        }
      }
      for (const [inst, amt] of Object.entries(perInst)) {
        assert.ok(amt <= institutions[inst].quota + 1e-9, `quota respected (iter ${iter})`);
      }
    }
    for (const b of batches) {
      if (b.group) {
        const members = batches.filter((x) => x.group === b.group).map((x) => x.id);
        assert.equal(groupRound.get(b.group).members.size, members.length, 'group complete');
      }
    }
  }
});

test('greedy path (n > 9) settles everything and respects hard limits', () => {
  const rand = mulberry32(7);
  const institutions = { A: { quota: 40 }, B: { quota: 40 }, C: { quota: 40 } };
  const batches = [];
  for (let i = 0; i < 15; i++) {
    batches.push({
      id: `b${i}`,
      institution: ['A', 'B', 'C'][i % 3],
      amount: 3 + Math.floor(rand() * 8),
      priority: 1 + Math.floor(rand() * 9),
      splittable: i % 4 === 0,
    });
  }
  const input = { capacity: 25, agingLimit: 1, agingBonus: 1, institutions, batches };
  assert.equal(validateInput(input), null);
  const sim = simulate(input, initialState(input));
  assert.equal(Object.keys(sim.remaining).length, 0);
  for (const r of sim.rounds) assert.ok(r.used <= 25 + 1e-9);
});

test('buildItems collapses group members into one atomic item', () => {
  const input = base({
    batches: [
      { id: 'g1a', institution: 'A', amount: 3, priority: 2, group: 'g1' },
      { id: 'g1b', institution: 'B', amount: 2, priority: 4, group: 'g1' },
      { id: 's', institution: 'A', amount: 5, priority: 1, splittable: true },
    ],
  });
  const state = initialState(input);
  const { discrete, splittable } = buildItems(input, state.remaining, state.waits);
  assert.equal(discrete.length, 1);
  assert.equal(discrete[0].amount, 5);
  assert.equal(discrete[0].weight, 6);
  assert.equal(discrete[0].atomic, true);
  assert.equal(splittable.length, 1);
});
