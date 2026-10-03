import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { enumerateOptimal } from '../src/enumerate.js';
import { normalizeConfig, normalizeOrder, validateOrders } from '../src/model.js';
import { greedySchedule } from '../src/scheduler.js';

// For instances with <= 5 work orders the greedy plan is cross-checked against
// an exhaustive enumeration of every batch partition and run ordering.
const scenarios = {
  'single group, capacity forces two runs': {
    config: {
      capacity: 6, runTime: 2, cleanTime: 1, dayLength: 100,
      recipes: { R1: { group: 'A', dailyQuota: 100 } },
    },
    orders: [
      { id: 'A1', recipe: 'R1', batches: 2, batchSize: 2, due: 4 },
      { id: 'A2', recipe: 'R1', batches: 2, batchSize: 2, due: 6 },
      { id: 'A3', recipe: 'R1', batches: 1, batchSize: 2, due: 3 },
    ],
  },
  'two groups, cleaning trade-off': {
    config: {
      capacity: 6, runTime: 2, cleanTime: 2, dayLength: 100,
      recipes: {
        R1: { group: 'A', dailyQuota: 100 },
        R2: { group: 'B', dailyQuota: 100 },
      },
    },
    orders: [
      { id: 'B1', recipe: 'R1', batches: 2, batchSize: 2, due: 8 },
      { id: 'B2', recipe: 'R2', batches: 1, batchSize: 2, due: 4 },
      { id: 'B3', recipe: 'R1', batches: 1, batchSize: 3, due: 12 },
    ],
  },
  'daily quota forces a day shift': {
    config: {
      capacity: 6, runTime: 3, cleanTime: 1, dayLength: 10,
      recipes: { R1: { group: 'A', dailyQuota: 4 } },
    },
    orders: [
      { id: 'C1', recipe: 'R1', batches: 2, batchSize: 2, due: 20 },
      { id: 'C2', recipe: 'R1', batches: 2, batchSize: 2, due: 30 },
    ],
  },
  'five orders across two groups': {
    config: {
      capacity: 4, runTime: 2, cleanTime: 2, dayLength: 100,
      recipes: {
        R1: { group: 'A', dailyQuota: 100 },
        R2: { group: 'B', dailyQuota: 100 },
      },
    },
    orders: [
      { id: 'D1', recipe: 'R1', batches: 1, batchSize: 2, due: 6 },
      { id: 'D2', recipe: 'R2', batches: 1, batchSize: 2, due: 5 },
      { id: 'D3', recipe: 'R1', batches: 1, batchSize: 2, due: 8 },
      { id: 'D4', recipe: 'R2', batches: 1, batchSize: 2, due: 7 },
      { id: 'D5', recipe: 'R1', batches: 1, batchSize: 1, due: 9 },
    ],
  },
  'urgent first, mixed batch sizes': {
    config: {
      capacity: 5, runTime: 2, cleanTime: 1, dayLength: 100,
      recipes: {
        R1: { group: 'A', dailyQuota: 100 },
        R2: { group: 'A', dailyQuota: 100 },
      },
    },
    orders: [
      { id: 'E1', recipe: 'R1', batches: 1, batchSize: 3, due: 10 },
      { id: 'E2', recipe: 'R2', batches: 2, batchSize: 2, due: 4, priority: 'urgent' },
      { id: 'E3', recipe: 'R1', batches: 1, batchSize: 2, due: 6 },
    ],
  },
};

describe('enumeration cross-check (<= 5 work orders)', () => {
  for (const [name, sc] of Object.entries(scenarios)) {
    it(`greedy matches exhaustive optimum: ${name}`, () => {
      const cfg = normalizeConfig(sc.config);
      const orders = sc.orders.map((o) => normalizeOrder(o, 0));
      assert.ok(orders.length <= 5);
      assert.deepEqual(validateOrders(cfg, orders), []);

      const greedy = greedySchedule(cfg, orders.map((o) => ({ ...o })), { now: 0 });
      const optimal = enumerateOptimal(cfg, orders);
      const greedyTotal = greedy.tardiness + greedy.cleaning;
      assert.equal(
        greedyTotal,
        optimal.total,
        `greedy ${greedyTotal} != enumerated optimum ${optimal.total} (explored ${optimal.explored} nodes)`
      );
    });
  }

  it('enumerator finds the true optimum on a hand-computable case', () => {
    // One group, capacity 4, two orders of 2 batches x 2 units, runTime 2.
    // Best: two runs [0,2) and [2,4); tardiness = 2*max(0,2-3) + 2*max(0,4-10) = 0.
    const cfg = normalizeConfig({
      capacity: 4, runTime: 2, cleanTime: 5, dayLength: 100,
      recipes: { R1: { group: 'A', dailyQuota: 100 } },
    });
    const orders = [
      normalizeOrder({ id: 'P', recipe: 'R1', batches: 2, batchSize: 2, due: 3 }),
      normalizeOrder({ id: 'Q', recipe: 'R1', batches: 2, batchSize: 2, due: 10 }),
    ];
    const optimal = enumerateOptimal(cfg, orders);
    assert.equal(optimal.total, 0);
    assert.equal(optimal.cleaning, 0); // same group: no cleaning between runs
    assert.equal(optimal.runs.length, 2);
  });
});
