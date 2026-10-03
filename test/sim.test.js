import test from 'node:test';
import assert from 'node:assert/strict';
import { createSimulation, runSimulation, compareExitOrder } from '../src/sim.js';

const ev = {
  assign: (task_id) => ({ type: 'assign', task_id }),
  start: (task_id) => ({ type: 'start', task_id }),
  finish: (task_id) => ({ type: 'finish', task_id }),
  cancel: (task_id) => ({ type: 'cancel', task_id }),
  safePoint: (task_id) => ({ type: 'safe_point', task_id }),
  block: (aisle) => ({ type: 'block_aisle', aisle }),
  unblock: (aisle) => ({ type: 'unblock_aisle', aisle }),
};

test('happy path: inbound occupies target, outbound frees source, move relocates', () => {
  const { finalSlots, errors } = runSimulation(
    {
      tasks: [
        { task_id: 'IN1', type: 'inbound', target: 'S1', aisle: 'A1' },
        { task_id: 'OUT1', type: 'outbound', source: 'S2', aisle: 'A1' },
        { task_id: 'MV1', type: 'move', source: 'S3', target: 'S4', aisle: 'A2' },
      ],
    },
    [
      ev.assign('IN1'), ev.start('IN1'), ev.finish('IN1'),
      ev.assign('OUT1'), ev.start('OUT1'), ev.finish('OUT1'),
      ev.assign('MV1'), ev.start('MV1'), ev.finish('MV1'),
    ],
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(finalSlots.slots.S1, { occupied: true, goods: 'goods:IN1', reserved_by: null });
  assert.deepEqual(finalSlots.slots.S2, { occupied: false, goods: null, reserved_by: null });
  assert.deepEqual(finalSlots.slots.S3, { occupied: false, goods: null, reserved_by: null });
  assert.deepEqual(finalSlots.slots.S4, { occupied: true, goods: 'initial:S3', reserved_by: null });
  assert.deepEqual(finalSlots.tasks, { IN1: 'done', MV1: 'done', OUT1: 'done' });
});

test('acceptance 2: cancel of started task keeps target reserved until safe_point', () => {
  const sim = createSimulation({
    tasks: [
      { task_id: 'T1', type: 'inbound', target: 'S1', aisle: 'A1' },
      { task_id: 'T2', type: 'inbound', target: 'S1', aisle: 'A1' },
    ],
  });
  sim.apply(ev.assign('T1'));
  sim.apply(ev.start('T1'));
  const cancelResult = sim.apply(ev.cancel('T1'));
  assert.deepEqual(cancelResult, { ok: true, result: 'cancel_pending' });

  // target slot must NOT be released before safe_point
  let snap = sim.snapshot();
  assert.equal(snap.finalSlots.slots.S1.reserved_by, 'T1');
  assert.equal(snap.finalSlots.tasks.T1, 'cancelling');

  // another task still cannot take the slot
  const conflict = sim.apply(ev.assign('T2'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'SLOT_CONFLICT');

  // safe_point triggers compensation and releases the slot
  const compensated = sim.apply(ev.safePoint('T1'));
  assert.deepEqual(compensated, { ok: true, result: 'compensated' });
  snap = sim.snapshot();
  assert.equal(snap.finalSlots.slots.S1.reserved_by, null);
  assert.equal(snap.finalSlots.slots.S1.occupied, false);
  assert.equal(snap.finalSlots.tasks.T1, 'cancelled');

  // now the slot is free for T2
  assert.equal(sim.apply(ev.assign('T2')).ok, true);
});

test('cancel of started outbound compensates goods back to source at safe_point', () => {
  const sim = createSimulation({
    tasks: [{ task_id: 'O1', type: 'outbound', source: 'S9', aisle: 'A1' }],
  });
  sim.apply(ev.assign('O1'));
  sim.apply(ev.start('O1'));
  let snap = sim.snapshot();
  assert.equal(snap.finalSlots.slots.S9.occupied, false); // goods on the crane
  assert.equal(snap.finalSlots.slots.S9.reserved_by, 'O1');

  sim.apply(ev.cancel('O1'));
  snap = sim.snapshot();
  assert.equal(snap.finalSlots.slots.S9.occupied, false); // not yet compensated

  sim.apply(ev.safePoint('O1'));
  snap = sim.snapshot();
  assert.deepEqual(snap.finalSlots.slots.S9, { occupied: true, goods: 'initial:S9', reserved_by: null });
  assert.equal(snap.finalSlots.tasks.O1, 'cancelled');
});

test('idempotency: repeated cancel returns the same result, ledger written once', () => {
  const sim = createSimulation({
    tasks: [{ task_id: 'T1', type: 'inbound', target: 'S1', aisle: 'A1' }],
  });
  sim.apply(ev.assign('T1'));
  const first = sim.apply(ev.cancel('T1'));
  const second = sim.apply(ev.cancel('T1'));
  const third = sim.apply(ev.cancel('T1'));
  assert.deepEqual(first, { ok: true, result: 'cancelled' });
  assert.equal(second.result, first.result);
  assert.equal(third.result, first.result);
  assert.equal(second.duplicate, true);
  assert.equal(third.duplicate, true);
  const { ledger, errors } = sim.snapshot();
  assert.equal(ledger.filter((e) => e.event === 'cancel').length, 1);
  assert.deepEqual(errors, []);
});

test('idempotency: duplicate assign/start/finish are no-ops with cached result', () => {
  const sim = createSimulation({
    tasks: [{ task_id: 'T1', type: 'inbound', target: 'S1', aisle: 'A1' }],
  });
  sim.apply(ev.assign('T1'));
  sim.apply(ev.assign('T1'));
  sim.apply(ev.start('T1'));
  sim.apply(ev.start('T1'));
  sim.apply(ev.finish('T1'));
  const dup = sim.apply(ev.finish('T1'));
  assert.equal(dup.duplicate, true);
  const { ledger, errors } = sim.snapshot();
  assert.equal(ledger.length, 3);
  assert.deepEqual(errors, []);
});

test('acceptance 4: cancel of done task -> INVALID_STATE recorded, run continues', () => {
  const sim = createSimulation({
    tasks: [
      { task_id: 'T1', type: 'inbound', target: 'S1', aisle: 'A1' },
      { task_id: 'T2', type: 'inbound', target: 'S2', aisle: 'A1' },
    ],
  });
  sim.apply(ev.assign('T1'));
  sim.apply(ev.start('T1'));
  sim.apply(ev.finish('T1'));
  const bad = sim.apply(ev.cancel('T1'));
  assert.equal(bad.ok, false);
  assert.equal(bad.code, 'INVALID_STATE');

  // repeated cancel of the done task returns the same INVALID_STATE, no extra error
  const again = sim.apply(ev.cancel('T1'));
  assert.equal(again.code, 'INVALID_STATE');
  assert.equal(again.duplicate, true);

  // processing is not interrupted
  assert.equal(sim.apply(ev.assign('T2')).ok, true);

  const { ledger, errors, finalSlots } = sim.snapshot();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'INVALID_STATE');
  assert.equal(errors[0].task_id, 'T1');
  assert.equal(ledger.at(-1).event, 'assign');
  assert.equal(ledger.at(-1).task_id, 'T2');
  assert.equal(finalSlots.tasks.T1, 'done');
  assert.equal(finalSlots.tasks.T2, 'assigned');
});

test('acceptance 3: blocked aisle defers finishes; unblock drains by priority then arrival, reproducibly', () => {
  const config = {
    tasks: [
      { task_id: 'LO', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' },
      { task_id: 'HI', type: 'inbound', target: 'S2', priority: 5, aisle: 'A1' },
    ],
  };
  const events = [
    ev.assign('LO'), ev.assign('HI'),
    ev.start('LO'), ev.start('HI'),
    ev.block('A1'),
    ev.finish('LO'), // arrives first, lower priority
    ev.finish('HI'), // arrives second, higher priority
    ev.unblock('A1'),
  ];

  const run = () => runSimulation(config, events);
  const first = run();
  const second = run();

  const unblockEntry = first.ledger.find((e) => e.event === 'unblock_aisle');
  assert.deepEqual(unblockEntry.exit_order, ['HI', 'LO']); // priority beats arrival

  const drainedFinishes = first.ledger.filter((e) => e.event === 'finish' && e.via === 'unblock_aisle');
  assert.deepEqual(drainedFinishes.map((e) => e.task_id), ['HI', 'LO']);
  assert.deepEqual(first.errors, []);
  assert.equal(first.finalSlots.tasks.HI, 'done');
  assert.equal(first.finalSlots.tasks.LO, 'done');

  // reproducible: identical ledger byte-for-byte
  assert.equal(JSON.stringify(second.ledger), JSON.stringify(first.ledger));
  assert.equal(JSON.stringify(second.finalSlots), JSON.stringify(first.finalSlots));
});

test('acceptance 3b: equal priority falls back to arrival order', () => {
  const { ledger } = runSimulation(
    {
      tasks: [
        { task_id: 'T1', type: 'inbound', target: 'S1', priority: 3, aisle: 'A1' },
        { task_id: 'T2', type: 'inbound', target: 'S2', priority: 3, aisle: 'A1' },
      ],
    },
    [
      ev.assign('T1'), ev.assign('T2'), ev.start('T1'), ev.start('T2'),
      ev.block('A1'), ev.finish('T1'), ev.finish('T2'), ev.unblock('A1'),
    ],
  );
  const unblockEntry = ledger.find((e) => e.event === 'unblock_aisle');
  assert.deepEqual(unblockEntry.exit_order, ['T1', 'T2']); // arrival order
});

test('exit-order comparator: full tie broken by task_id', () => {
  const a = { task_id: 'T9', priority: 2, exitSeq: 4 };
  const b = { task_id: 'T3', priority: 2, exitSeq: 4 };
  assert.ok(compareExitOrder(a, b) > 0);
  assert.ok(compareExitOrder(b, a) < 0);
  assert.equal(compareExitOrder(a, a), 0);
});

test('acceptance 1: enumerate interleavings of 3 tasks / 2 aisles, slots stay consistent', () => {
  const config = {
    tasks: [
      { task_id: 'T1', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' },
      { task_id: 'T2', type: 'move', source: 'S2', target: 'S1', priority: 2, aisle: 'A1' },
      { task_id: 'T3', type: 'outbound', source: 'S3', priority: 3, aisle: 'A2' },
    ],
  };
  const perTask = ['T1', 'T2', 'T3'].map((id) => [ev.assign(id), ev.start(id), ev.finish(id)]);

  function* interleavings(lists) {
    if (lists.every((list) => list.length === 0)) {
      yield [];
      return;
    }
    for (let i = 0; i < lists.length; i += 1) {
      if (lists[i].length === 0) continue;
      const [head, ...rest] = lists[i];
      const remaining = [...lists.slice(0, i), rest, ...lists.slice(i + 1)];
      for (const tail of interleavings(remaining)) yield [head, ...tail];
    }
  }

  const checkRun = (events) => {
    const sim = createSimulation(config);
    for (const event of events) {
      sim.apply(event);
      assert.deepEqual(sim.validateInvariants(), [], `invariant violated after ${JSON.stringify(event)}`);
    }
    const { finalSlots } = sim.snapshot();
    // no two goods in the same slot: goods ids must be unique across slots
    const goods = Object.values(finalSlots.slots)
      .filter((slot) => slot.goods !== null)
      .map((slot) => slot.goods);
    assert.equal(new Set(goods).size, goods.length, 'two goods share a slot');
    // no slot reserved by a finished/cancelled task
    for (const [id, slot] of Object.entries(finalSlots.slots)) {
      if (slot.reserved_by !== null) {
        const state = finalSlots.tasks[slot.reserved_by];
        assert.ok(['assigned', 'started', 'cancelling'].includes(state), `slot ${id} held by ${state} task`);
      }
    }
  };

  let count = 0;
  for (const perm of interleavings(perTask)) {
    checkRun(perm);
    count += 1;
  }
  assert.equal(count, 1680); // 9! / (3!)^3 interleavings preserving per-task order

  // same enumeration with a block/unblock window injected into aisle A1
  let blockedCount = 0;
  for (const perm of interleavings(perTask)) {
    const events = [
      ...perm.slice(0, 3),
      ev.block('A1'),
      ...perm.slice(3, 7),
      ev.unblock('A1'),
      ...perm.slice(7),
    ];
    checkRun(events);
    blockedCount += 1;
  }
  assert.equal(blockedCount, 1680);
});

test('slot conflict: two tasks cannot reserve the same target', () => {
  const sim = createSimulation({
    tasks: [
      { task_id: 'A', type: 'inbound', target: 'S1', aisle: 'A1' },
      { task_id: 'B', type: 'inbound', target: 'S1', aisle: 'A1' },
    ],
  });
  assert.equal(sim.apply(ev.assign('A')).ok, true);
  const conflict = sim.apply(ev.assign('B'));
  assert.equal(conflict.ok, false);
  assert.equal(conflict.code, 'SLOT_CONFLICT');
  const { errors } = sim.snapshot();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].code, 'SLOT_CONFLICT');
});

test('cancel of queued (blocked exit) task is compensated at safe_point and skipped on unblock', () => {
  const sim = createSimulation({
    tasks: [{ task_id: 'T1', type: 'inbound', target: 'S1', priority: 1, aisle: 'A1' }],
  });
  sim.apply(ev.assign('T1'));
  sim.apply(ev.start('T1'));
  sim.apply(ev.block('A1'));
  assert.deepEqual(sim.apply(ev.finish('T1')), { ok: true, result: 'deferred' });
  sim.apply(ev.cancel('T1'));
  sim.apply(ev.safePoint('T1'));
  const unblockResult = sim.apply(ev.unblock('A1'));
  assert.deepEqual(unblockResult.exit_order, []);
  const { finalSlots } = sim.snapshot();
  assert.equal(finalSlots.tasks.T1, 'cancelled');
  assert.equal(finalSlots.slots.S1.occupied, false);
  assert.equal(finalSlots.slots.S1.reserved_by, null);
});
