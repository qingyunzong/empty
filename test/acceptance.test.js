'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const { makeEngine, moldCfg, MON, TUE, WED, THU, FRI } = require('./helpers');
const { bruteForceBest } = require('./reference');
const { fullSchedule } = require('../src/engine');

// Acceptance 1: two molds trigger their own maintenance in parallel.
test('two molds trigger different maintenance in parallel', () => {
  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'M1', cycleMinutes: 240, maintenanceMinutes: 30, calendar: { workdays: [MON, TUE], start: '08:00', end: '17:00', shifts: [['12:00', '13:00']] } }) });
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'M2', cycleMinutes: 240, maintenanceMinutes: 30, calendar: { workdays: [MON, TUE], start: '08:00', end: '17:00', shifts: [['14:00', '15:00']] } }) });

  engine.execute({ cmd: 'book', order: { id: 'A1', minutes: 200, moldId: 'M1' } });
  engine.execute({ cmd: 'book', order: { id: 'A2', minutes: 100, moldId: 'M1' } });
  engine.execute({ cmd: 'book', order: { id: 'B1', minutes: 200, moldId: 'M2' } });
  engine.execute({ cmd: 'book', order: { id: 'B2', minutes: 100, moldId: 'M2' } });

  const state = engine.execute({ cmd: 'state' });
  const m1 = state.molds.M1.schedule;
  const m2 = state.molds.M2.schedule;

  const maint1 = m1.filter((i) => i.type === 'maintenance');
  const maint2 = m2.filter((i) => i.type === 'maintenance');
  assert.equal(maint1.length, 1);
  assert.equal(maint2.length, 1);
  // different maintenance windows per mold, both on the same day (parallel)
  assert.equal(maint1[0].start, `${MON}T12:00:00.000Z`);
  assert.equal(maint1[0].end, `${MON}T12:30:00.000Z`);
  assert.equal(maint2[0].start, `${MON}T14:00:00.000Z`);
  assert.equal(maint2[0].end, `${MON}T14:30:00.000Z`);

  // morning production on both molds overlaps -> truly parallel schedules
  const a1 = m1.find((i) => i.orderId === 'A1');
  const b1 = m2.find((i) => i.orderId === 'B1');
  assert.equal(a1.start, `${MON}T08:00:00.000Z`);
  assert.equal(b1.start, `${MON}T08:00:00.000Z`);

  // maintenance inserted exactly because cycle life would be exceeded
  const a2 = m1.find((i) => i.orderId === 'A2');
  assert.equal(a2.start, `${MON}T12:30:00.000Z`);
  assert.equal(state.molds.M1.derivedUsedMinutes, 100);
});

// Acceptance 2: maintenance hits a rest day and is delayed; order sequence kept.
test('maintenance is delayed over a rest day and order order is preserved', () => {
  const { engine } = makeEngine();
  // WED (2026-10-07) is a rest day: absent from workdays
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'M1', cycleMinutes: 300, maintenanceMinutes: 45, calendar: { workdays: [MON, TUE, THU, FRI], start: '08:00', end: '17:00', shifts: [['08:00', '09:00']] } }) });

  engine.execute({ cmd: 'book', order: { id: 'O1', minutes: 280 } });
  engine.execute({ cmd: 'book', order: { id: 'O2', minutes: 280 } });
  engine.execute({ cmd: 'book', order: { id: 'O3', minutes: 280 } });

  const state = engine.execute({ cmd: 'state' });
  const items = state.molds.M1.schedule;

  // queue order preserved in time
  const orderItems = items.filter((i) => i.type === 'order');
  assert.deepEqual(orderItems.map((i) => i.orderId), ['O1', 'O2', 'O3']);
  const starts = orderItems.map((i) => Date.parse(i.start));
  assert.ok(starts[0] < starts[1] && starts[1] < starts[2]);

  const maints = items.filter((i) => i.type === 'maintenance');
  assert.equal(maints.length, 2);
  // first maintenance: next shift after Mon 12:40 -> Tue 08:00 shift window
  assert.equal(maints[0].start, `${TUE}T08:00:00.000Z`);
  assert.equal(maints[0].end, `${TUE}T08:45:00.000Z`);
  // second maintenance would fall on the rest day (Wed); delayed to Thu shift
  assert.equal(maints[1].start, `${THU}T08:00:00.000Z`);
  assert.equal(maints[1].end, `${THU}T08:45:00.000Z`);
  // O3 only starts after the delayed maintenance
  assert.equal(orderItems[2].start, `${THU}T08:45:00.000Z`);
});

// Acceptance 3: crash before rename -> old file intact, no partial tx,
// then recovery; schedule cross-checked against exhaustive enumeration.
test('pre-rename crash leaves old state intact; recovery commits cleanly', () => {
  const hooks = {};
  const { engine, store, file } = makeEngine(hooks);
  engine.execute({ cmd: 'addMold', mold: moldCfg({ id: 'M1', cycleMinutes: 120, maintenanceMinutes: 20, calendar: { workdays: [MON, TUE, THU, FRI], start: '06:00', end: '20:00', shifts: [['07:00', '09:00'], ['12:00', '13:00'], ['16:00', '18:00']] } }) });
  engine.execute({ cmd: 'book', order: { id: 'O1', minutes: 50 } });

  const committed = fs.readFileSync(file, 'utf8');
  const committedState = JSON.parse(committed);

  // simulate crash at the explicit fault point: after tmp write, before rename
  hooks.beforeRename = () => { throw new Error('simulated crash before rename'); };
  assert.throws(() => engine.execute({ cmd: 'book', order: { id: 'O2', minutes: 80 } }), /simulated crash/);

  // old state file still opens and is byte-identical: no partial transaction
  assert.equal(fs.readFileSync(file, 'utf8'), committed);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), committedState);
  // in-memory state also rolled back
  assert.equal(engine.state.orders.O2, undefined);
  assert.deepEqual(engine.state.queues.M1, ['O1']);

  // recover: remove the fault, retry the same command
  delete hooks.beforeRename;
  const ok = engine.execute({ cmd: 'book', order: { id: 'O2', minutes: 80 } });
  assert.equal(ok.mold, 'M1');
  const reloaded = store.load();
  assert.ok(reloaded.orders.O2);
  assert.deepEqual(reloaded.queues.M1, ['O1', 'O2']);
});

test('greedy schedule matches exhaustive maintenance-position enumeration', () => {
  const mold = moldCfg({
    id: 'M1',
    cycleMinutes: 120,
    maintenanceMinutes: 20,
    calendar: { workdays: [MON, TUE, THU, FRI], start: '06:00', end: '20:00', shifts: [['07:00', '09:00'], ['12:00', '13:00'], ['16:00', '18:00']] },
  });
  const durations = [50, 80, 40, 90, 30, 70];

  const { engine } = makeEngine();
  engine.execute({ cmd: 'addMold', mold });
  durations.forEach((d, i) => engine.execute({ cmd: 'book', order: { id: `O${i}`, minutes: d } }));

  const sched = fullSchedule(engine.state).byMold.M1;
  const best = bruteForceBest(mold, durations.map((d, i) => ({ id: `O${i}`, minutes: d })));

  assert.ok(best, 'brute force found a feasible plan');
  assert.equal(sched.maintenances.length, best.count);
  assert.equal(sched.end, best.completion);
});

test('randomized small cases match brute force enumeration', () => {
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed / 2147483648; };
  for (let iter = 0; iter < 20; iter++) {
    const cycle = 60 + Math.floor(rand() * 120);
    const mold = moldCfg({
      id: 'M1',
      cycleMinutes: cycle,
      maintenanceMinutes: 15 + Math.floor(rand() * 20),
      calendar: { workdays: [MON, TUE, WED, THU, FRI], start: '06:00', end: '20:00', shifts: [['07:00', '09:00'], ['12:00', '13:00']] },
    });
    const n = 3 + Math.floor(rand() * 4);
    const durations = Array.from({ length: n }, () => 20 + Math.floor(rand() * (cycle - 20)));

    const { engine } = makeEngine();
    engine.execute({ cmd: 'addMold', mold });
    durations.forEach((d, i) => engine.execute({ cmd: 'book', order: { id: `O${i}`, minutes: d } }));

    const sched = fullSchedule(engine.state).byMold.M1;
    const best = bruteForceBest(mold, durations.map((d, i) => ({ id: `O${i}`, minutes: d })));
    assert.ok(best);
    assert.equal(sched.maintenances.length, best.count, `iter ${iter} count`);
    assert.equal(sched.end, best.completion, `iter ${iter} completion`);
  }
});
