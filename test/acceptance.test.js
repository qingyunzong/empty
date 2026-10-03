import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { Engine } from '../src/engine.js';

const baseConfig = {
  capacity: 10,
  runTime: 4,
  cleanTime: 2,
  dayLength: 24,
  compensationSlots: 3,
  agingRate: 1,
  supportedGroups: ['A', 'B'],
  recipes: {
    R1: { group: 'A', dailyQuota: 12 },
    R2: { group: 'A', dailyQuota: 6 },
    R3: { group: 'B', dailyQuota: 10 },
  },
};

describe('acceptance: mixed runs and quota feasibility', () => {
  it('mixes compatible orders in one run and respects daily quotas', () => {
    const engine = new Engine();
    const result = engine.plan({
      config: baseConfig,
      orders: [
        { id: 'W1', recipe: 'R1', batches: 2, batchSize: 3, due: 30 },
        { id: 'W2', recipe: 'R2', batches: 1, batchSize: 3, due: 10 },
        { id: 'W3', recipe: 'R3', batches: 1, batchSize: 5, due: 40 },
      ],
    });
    assert.equal(result.ok, true);
    assert.equal(result.runs.length, 2);

    // Mixed run: W1 (R1) and W2 (R2) share group A and fit capacity (6+3 <= 10).
    const run1 = result.runs[0];
    assert.equal(run1.group, 'A');
    const run1Orders = run1.loads.map((l) => l.order).sort();
    assert.deepEqual(run1Orders, ['W1', 'W2']);
    const run1Units = run1.loads.reduce((s, l) => s + l.units, 0);
    assert.ok(run1Units <= baseConfig.capacity);

    // Group change A -> B triggers cleaning on run 2.
    const run2 = result.runs[1];
    assert.equal(run2.group, 'B');
    assert.equal(run2.cleanBefore, baseConfig.cleanTime);
    assert.equal(run2.start, run1.end + baseConfig.cleanTime);
    assert.equal(result.objective.cleaning, baseConfig.cleanTime);

    // Quota feasibility: usage never exceeds the daily quota.
    for (const q of result.quotaUsage) {
      assert.ok(q.used <= q.quota, `quota exceeded for ${q.recipe} on day ${q.day}`);
    }
    const r1Day0 = result.quotaUsage.find((q) => q.recipe === 'R1' && q.day === 0);
    assert.equal(r1Day0.used, 6);

    // Output shape: composition, quota, freeze boundary, diff.
    assert.ok(Array.isArray(result.freezeBoundary.frozenRuns));
    assert.deepEqual(result.diff.addedRuns, [1, 2]);
    assert.equal(result.objective.total,
      result.objective.tardiness + result.objective.cleaning + result.objective.compensation);
  });
});

describe('acceptance: urgent preemption at batch boundary, remainder continues', () => {
  const config = {
    capacity: 6,
    runTime: 4,
    cleanTime: 1,
    dayLength: 24,
    compensationSlots: 3,
    agingRate: 1,
    supportedGroups: ['A'],
    recipes: { R1: { group: 'A', dailyQuota: 100 } },
  };

  it('urgent order takes the next run; unloaded remainder requeues, ages, and continues', () => {
    const engine = new Engine();
    const first = engine.plan({
      config,
      orders: [
        { id: 'N1', recipe: 'R1', batches: 2, batchSize: 3, due: 100 },
        { id: 'N2', recipe: 'R1', batches: 2, batchSize: 3, due: 100 },
      ],
    });
    assert.equal(first.ok, true);
    assert.deepEqual(first.runs.map((r) => r.loads.map((l) => l.order)), [['N1'], ['N2']]);
    const frozenRun1 = structuredClone(first.runs[0]);

    const second = engine.replan({
      now: 4,
      freezeHorizon: 4,
      add: [
        { id: 'U1', recipe: 'R1', batches: 2, batchSize: 3, due: 6, priority: 'urgent' },
        { id: 'N3', recipe: 'R1', batches: 1, batchSize: 3, due: 100 },
      ],
    });
    assert.equal(second.ok, true);

    // Frozen history is untouched (loaded part of the plan is kept).
    assert.deepEqual(second.runs[0], { ...frozenRun1, frozen: true });
    assert.deepEqual(second.freezeBoundary, { time: 4, frozenRuns: [1] });

    // Urgent batch preempts at the run boundary: it gets run 2.
    assert.deepEqual(second.runs[1].loads.map((l) => l.order), ['U1']);
    assert.equal(second.runs[1].start, 4);

    // N2's unloaded remainder requeues and continues in run 3.
    assert.deepEqual(second.runs[2].loads.map((l) => l.order), ['N2']);
    assert.equal(second.runs[2].loads[0].batches, 2);

    // Aging: N2 (arrived at 0, waited 4, effective due 96) beats N3 (due 100)
    // even though both have the same nominal due date.
    assert.deepEqual(second.runs[3].loads.map((l) => l.order), ['N3']);

    // Incremental diff: old run 2 dissolved, runs 2..4 newly added.
    assert.deepEqual(second.diff.keptRuns, [1]);
    assert.deepEqual(second.diff.removedRuns, [2]);
    assert.deepEqual(second.diff.addedRuns, [2, 3, 4]);

    // Everyone still completes.
    const n2 = second.orders.find((o) => o.id === 'N2');
    assert.equal(n2.status, 'scheduled');
    assert.equal(n2.scheduledBatches, 2);
  });
});

describe('acceptance: canceling a prepared order costs compensation, history stays', () => {
  const config = {
    capacity: 10,
    runTime: 4,
    cleanTime: 2,
    dayLength: 24,
    compensationSlots: 3,
    agingRate: 0,
    supportedGroups: ['A'],
    recipes: { R1: { group: 'A', dailyQuota: 100 } },
  };
  const orders = [
    { id: 'W1', recipe: 'R1', batches: 1, batchSize: 4, due: 20 },
    { id: 'W2', recipe: 'R1', batches: 1, batchSize: 4, due: 24 },
    { id: 'W3', recipe: 'R1', batches: 1, batchSize: 4, due: 28 },
  ];

  it('compensation is charged and frozen runs are unchanged', () => {
    const engine = new Engine();
    const first = engine.plan({ config, orders });
    assert.equal(first.ok, true);
    const frozenRun1 = structuredClone(first.runs[0]);

    const second = engine.replan({ now: 4, freezeHorizon: 4, cancel: ['W3'] });
    assert.equal(second.ok, true);

    // Fixed compensation slot deducted for the prepared order W3.
    assert.equal(second.objective.compensation, 3);
    assert.deepEqual(second.diff.compensationEvents, [{ order: 'W3', slots: 3 }]);
    assert.deepEqual(second.diff.canceled, ['W3']);

    // History frozen: run 1 identical, only flagged frozen.
    assert.deepEqual(second.runs[0], { ...frozenRun1, frozen: true });
    assert.equal(second.runs.length, 1);

    // W3 reported canceled; quota released (day 0 usage drops from 12 to 8).
    assert.equal(second.orders.find((o) => o.id === 'W3').status, 'canceled');
    const day0 = second.quotaUsage.find((q) => q.day === 0 && q.recipe === 'R1');
    assert.equal(day0.used, 8);
  });

  it('released quota lets a waiting order move into the freed slot', () => {
    const tight = { ...config, recipes: { R1: { group: 'A', dailyQuota: 8 } } };
    const engine = new Engine();
    const first = engine.plan({ config: tight, orders });
    assert.equal(first.ok, true);
    // Quota 8/day: W1+W2 fill day 0, W3 is pushed to day 1.
    const w3run = first.runs.find((r) => r.loads.some((l) => l.order === 'W3'));
    assert.equal(w3run.day, 1);

    const second = engine.replan({ now: 0, freezeHorizon: 0, cancel: ['W2'] });
    assert.equal(second.ok, true);
    // W2's quota released: W3 moves back to day 0.
    const w3runAfter = second.runs.find((r) => r.loads.some((l) => l.order === 'W3'));
    assert.equal(w3runAfter.day, 0);
    assert.equal(second.objective.compensation, 3);
  });

  it('canceling a fully frozen order is rejected', () => {
    const engine = new Engine();
    engine.plan({ config, orders });
    const result = engine.replan({ now: 4, freezeHorizon: 4, cancel: ['W1'] });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /fully frozen/);
  });
});

describe('acceptance: infeasible inputs fail', () => {
  it('rejects a batch larger than furnace capacity', () => {
    const engine = new Engine();
    const result = engine.plan({
      config: baseConfig,
      orders: [{ id: 'BIG', recipe: 'R1', batches: 1, batchSize: 11, due: 10 }],
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /exceeds furnace capacity/);
  });

  it('rejects a recipe group the furnace does not support', () => {
    const engine = new Engine();
    const result = engine.plan({
      config: baseConfig,
      orders: [{ id: 'X1', recipe: 'R3', batches: 1, batchSize: 2, due: 10 }],
      // R3 is group B; restrict furnace to group A only.
      ...{ config: { ...baseConfig, supportedGroups: ['A'] } },
    });
    assert.equal(result.ok, false);
    assert.match(result.errors[0], /not compatible/);
  });

  it('rejects unknown recipes and duplicate ids', () => {
    const engine = new Engine();
    const result = engine.plan({
      config: baseConfig,
      orders: [
        { id: 'D', recipe: 'NOPE', batches: 1, batchSize: 1, due: 1 },
        { id: 'D', recipe: 'R1', batches: 1, batchSize: 1, due: 1 },
      ],
    });
    assert.equal(result.ok, false);
    assert.equal(result.errors.length, 2);
  });
});
