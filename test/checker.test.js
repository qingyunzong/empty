import { test } from 'node:test';
import assert from 'node:assert/strict';
import { modelOf, siteOf } from './helpers.js';

test('type error when power is given in kWh', () => {
  assert.throws(
    () => siteOf('site S {\n  slots 8\n  tariff 1\n  task a { power 5 kWh duration 15 min }\n}'),
    (e) => /type error: 'power'/.test(e.message) && e.line === 4 && /kWh/.test(e.message),
  );
});

test('type error when power has no unit', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 task a { power 5 duration 15 min } }'),
    /type error: 'power'.*bare number/,
  );
});

test('energy must be consistent with power and duration', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 task a { power 2 kW duration 60 min energy 3 kWh } }'),
    /inconsistent/,
  );
});

test('duration can be derived from energy and power', () => {
  const site = siteOf('site S { slots 8 tariff 1 task a { power 2 kW energy 1 kWh } }');
  assert.equal(site.tasks[0].durationSlots, 2);
  assert.equal(site.tasks[0].watts, 2000);
});

test('window must align to slot boundaries', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 task a { power 1 kW duration 15 min window 00:07 .. 01:00 } }'),
    /not aligned to 15-minute slots/,
  );
});

test('templates have lexical scope: site template shadows global', () => {
  const model = modelOf(`
    template T { power 1 kW duration 15 min }
    site A {
      slots 8
      tariff 1
      template T { power 9 kW duration 15 min }
      task x : T {}
    }
    site B {
      slots 8
      tariff 1
      task y : T {}
    }
  `);
  assert.equal(model.sites[0].tasks[0].watts, 9000);
  assert.equal(model.sites[1].tasks[0].watts, 1000);
});

test('unknown template reference is an error', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 task a : Nope {} }'),
    /unknown template 'Nope'/,
  );
});

test('duplicate task id is an error with position', () => {
  assert.throws(
    () => siteOf('site S {\n  slots 8\n  tariff 1\n  task a { power 1 kW duration 15 min }\n  task a { power 1 kW duration 15 min }\n}'),
    (e) => /duplicate task id 'a'/.test(e.message) && e.line === 5,
  );
});

test('tariff blocks must cover the whole horizon', () => {
  assert.throws(
    () => siteOf('site S { slots 4 tariff { 00:00 .. 00:30 -> 0.5 } }'),
    /do not cover the whole horizon/,
  );
});

test('tariff blocks with gaps are rejected', () => {
  assert.throws(
    () => siteOf('site S { slots 4 tariff { 00:00 .. 00:15 -> 0.5 00:30 .. 01:00 -> 0.7 } }'),
    /gaps or overlaps/,
  );
});

test('unknown task in after relation is an error', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 task a { power 1 kW duration 15 min after ghost } }'),
    /unknown task 'ghost'/,
  );
});

test('division by zero in objective is an error', () => {
  assert.throws(
    () => siteOf('site S { slots 8 tariff 1 objective minimize cost / 0 }'),
    /division by zero/,
  );
});

test('budgets, peak limit and maintenance are collected', () => {
  const site = siteOf(`
    site S {
      slots 4
      slotMinutes 15
      tariff 0.8
      carbon 0.5
      costBudget 100
      carbonBudget 50
      peakLimit 400 kW
      maintenance 00:15 .. 00:30
      task a { power 1 kW duration 15 min }
    }
  `);
  assert.equal(site.costBudget, 100);
  assert.equal(site.carbonBudget, 50);
  assert.equal(site.peakLimitW, 400000);
  assert.deepEqual(Array.from(site.blocked), [0, 1, 0, 0]);
  assert.deepEqual(site.maintenanceRanges, [[1, 2]]);
});
