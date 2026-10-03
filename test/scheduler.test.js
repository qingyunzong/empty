import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveSite, Scheduler } from '../src/scheduler.js';
import { siteOf } from './helpers.js';
import { DENOM } from '../src/checker.js';

const yuan = (num) => num / DENOM;

test('feasible plan: flat tariff, tie broken by lower peak then task id order', () => {
  const site = siteOf(`
    site S {
      slots 3
      slotMinutes 15
      tariff 1
      task a { power 4 kW duration 15 min window 00:00 .. 00:45 }
      task b { power 2 kW duration 15 min window 00:00 .. 00:45 }
    }
  `);
  const res = solveSite(site);
  assert.equal(res.status, 'OK');
  assert.equal(yuan(res.optimum.costNum), 1.5);
  assert.equal(res.optimum.peakW, 4000);
  const [a, b] = res.optimum.slotLists;
  assert.deepEqual(a, [0]);
  assert.deepEqual(b, [1]);
});

test('equal cost and peak: lexicographically smaller task id sequence wins', () => {
  const site = siteOf(`
    site S {
      slots 2
      slotMinutes 15
      tariff 1
      peakLimit 1 kW
      task z { power 1 kW duration 15 min window 00:00 .. 00:30 }
      task a { power 1 kW duration 15 min window 00:00 .. 00:30 }
    }
  `);
  const res = solveSite(site);
  assert.equal(res.status, 'OK');
  assert.equal(res.optimum.signature, 'a,z');
  const [z, a] = res.optimum.slotLists;
  assert.deepEqual(a, [0]);
  assert.deepEqual(z, [1]);
});

test('cheaper tariff slots are preferred', () => {
  const site = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff { 00:00 .. 00:30 -> 2 00:30 .. 01:00 -> 0.5 }
      task a { power 4 kW duration 15 min window 00:00 .. 01:00 }
    }
  `);
  const res = solveSite(site);
  assert.equal(res.status, 'OK');
  assert.deepEqual(res.optimum.slotLists[0], [2]);
  assert.equal(yuan(res.optimum.costNum), 0.5);
});

test('budget exactly met is OK; one unit less is OVER_BUDGET with minimum cost listed', () => {
  const base = (extra) => `
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      carbon 0.5
      ${extra}
      task a { power 4 kW duration 60 min window 00:00 .. 01:00 }
    }
  `;
  const exact = solveSite(siteOf(base('costBudget 4 carbonBudget 2')));
  assert.equal(exact.status, 'OK');
  assert.equal(yuan(exact.optimum.costNum), 4);
  assert.equal(yuan(exact.optimum.carbonNum), 2);

  const shortCost = solveSite(siteOf(base('costBudget 3')));
  assert.equal(shortCost.status, 'OVER_BUDGET');
  assert.deepEqual(shortCost.budgetsExceeded, ['cost']);
  assert.equal(yuan(shortCost.minCostNum), 4);

  const shortCarbon = solveSite(siteOf(base('carbonBudget 1')));
  assert.equal(shortCarbon.status, 'OVER_BUDGET');
  assert.deepEqual(shortCarbon.budgetsExceeded, ['carbon']);

  const shortBoth = solveSite(siteOf(base('costBudget 3 carbonBudget 1')));
  assert.equal(shortBoth.status, 'OVER_BUDGET');
  assert.deepEqual(shortBoth.budgetsExceeded, ['cost', 'carbon']);
});

test('maintenance window makes the only placements impossible: INFEASIBLE', () => {
  const site = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      maintenance 00:15 .. 00:45
      task a { power 1 kW duration 30 min window 00:00 .. 01:00 }
    }
  `);
  const res = solveSite(site);
  assert.equal(res.status, 'INFEASIBLE');
  assert.equal(res.optimum, null);
});

test('interruptible task routes around maintenance within maxInterrupts', () => {
  const site = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      maintenance 00:15 .. 00:30
      task c { power 1 kW duration 30 min interruptible true maxInterrupts 1 window 00:00 .. 01:00 }
    }
  `);
  const res = solveSite(site);
  assert.equal(res.status, 'OK');
  const slots = res.optimum.slotLists[0];
  assert.equal(slots.length, 2);
  assert.ok(!slots.includes(1));
});

test('interruptible task with maxInterrupts 0 cannot cross maintenance: INFEASIBLE', () => {
  const site = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      maintenance 00:15 .. 00:45
      task c { power 1 kW duration 30 min interruptible true maxInterrupts 0 window 00:00 .. 01:00 }
    }
  `);
  assert.equal(solveSite(site).status, 'INFEASIBLE');
});

test('after relation orders tasks; contradictory windows are INFEASIBLE', () => {
  const ok = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      task a { power 1 kW duration 15 min window 00:00 .. 01:00 }
      task b { power 1 kW duration 15 min window 00:00 .. 01:00 after a }
    }
  `);
  const res = solveSite(ok);
  assert.equal(res.status, 'OK');
  const [a, b] = res.optimum.slotLists;
  assert.ok(b[0] > a[a.length - 1]);

  const bad = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 1
      task a { power 1 kW duration 15 min window 00:30 .. 01:00 }
      task b { power 1 kW duration 15 min window 00:00 .. 00:30 after a }
    }
  `);
  assert.equal(solveSite(bad).status, 'INFEASIBLE');
});

test('objective expression can trade cost against peak', () => {
  const src = (objective) => `
    site S {
      slots 2
      slotMinutes 15
      tariff { 00:00 .. 00:15 -> 0.5 00:15 .. 00:30 -> 2 }
      task a { power 4 kW duration 15 min window 00:00 .. 00:30 }
      task b { power 2 kW duration 15 min window 00:00 .. 00:30 }
      objective minimize ${objective}
    }
  `;
  const costOnly = solveSite(siteOf(src('cost')));
  assert.equal(costOnly.optimum.peakW, 6000);

  const peakAware = solveSite(siteOf(src('cost + 100 * peak')));
  assert.equal(peakAware.optimum.peakW, 4000);
  assert.ok(peakAware.optimum.costNum > costOnly.optimum.costNum);
});

test('incremental add-task, savepoint rollback, and cache consistency', () => {
  const site = siteOf(`
    site S {
      slots 2
      slotMinutes 15
      tariff 1
      task a { power 1 kW duration 15 min window 00:00 .. 00:30 }
    }
  `);
  const sched = new Scheduler(site);
  const r1 = sched.solve();
  assert.equal(r1.status, 'OK');
  assert.equal(yuan(r1.optimum.costNum), 0.25);

  const cached = sched.solve();
  assert.strictEqual(cached, r1);

  sched.savepoint('sp1');
  sched.addTask({
    id: 'b',
    watts: 1000,
    durationSlots: 1,
    winStart: 0,
    winEnd: 2,
    interruptible: false,
    maxInterrupts: null,
    after: [],
    before: [],
  });
  const r2 = sched.solve();
  assert.equal(r2.status, 'OK');
  assert.equal(yuan(r2.optimum.costNum), 0.5);
  assert.notEqual(r2.optimum.detailKey, r1.optimum.detailKey);

  sched.rollback('sp1');
  const r3 = sched.solve();
  assert.strictEqual(r3, r1);
  assert.deepEqual(
    r3.optimum.slotLists.map((s) => s.slice()),
    r1.optimum.slotLists.map((s) => s.slice()),
  );

  const fresh = new Scheduler(site).solve();
  assert.equal(fresh.optimum.detailKey, r3.optimum.detailKey);
  assert.equal(fresh.optimum.costNum, r3.optimum.costNum);

  assert.throws(() => sched.rollback('nope'), /unknown savepoint/);
});

test('rollback then add a different task is not polluted by the cache', () => {
  const site = siteOf(`
    site S {
      slots 3
      slotMinutes 15
      tariff 1
      task a { power 1 kW duration 15 min window 00:00 .. 00:45 }
    }
  `);
  const sched = new Scheduler(site);
  sched.savepoint('base');
  const mk = (id) => ({
    id,
    watts: 1000,
    durationSlots: 1,
    winStart: 0,
    winEnd: 3,
    interruptible: false,
    maxInterrupts: null,
    after: [],
    before: [],
  });
  sched.addTask(mk('b'));
  const withB = sched.solve();
  sched.rollback('base');
  sched.addTask(mk('c'));
  const withC = sched.solve();
  assert.equal(withC.status, 'OK');
  assert.equal(withC.optimum.costNum, withB.optimum.costNum);
  assert.ok(withC.optimum.detailKey.includes('c'));
  assert.ok(!withC.optimum.detailKey.includes('b'));
});
