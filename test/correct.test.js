'use strict';
// Acceptance 2: correcting one inspection only changes nodes inside the
// downstream closure of the inspected batch, and the incremental result
// equals a full recompute.
const test = require('node:test');
const assert = require('node:assert/strict');
const lineage = require('../src/lineage');
const { randomEvents } = require('../testlib/helpers');

const EVENTS = [
  { type: 'intake', batch: 'RM-1' },
  { type: 'intake', batch: 'RM-2' },
  { type: 'mix', output: 'B-1', inputs: ['RM-1', 'RM-2'] },
  { type: 'mix', output: 'B-2', inputs: ['RM-2'] },
  { type: 'split', input: 'B-1', outputs: ['P-1', 'P-2'] },
  { type: 'split', input: 'B-2', outputs: ['P-3'] },
  { type: 'inspect', id: 'IN-1', batch: 'B-1', test: 'micro', status: 'pass' },
];

test('correction only mutates the downstream closure', () => {
  const state = lineage.buildState(EVENTS);
  assert.deepEqual([...state.contaminated], []);

  const delta = lineage.correctInspection(state, 'IN-1', 'fail', 'lab retest');
  assert.deepEqual(delta.added, ['B-1', 'P-1', 'P-2']);
  assert.deepEqual(delta.removed, []);
  // Every changed node lies inside the closure of B-1.
  for (const id of [...delta.added, ...delta.removed]) {
    assert.ok(delta.closure.includes(id), `${id} outside closure`);
  }
  // Nodes outside the closure are untouched.
  assert.ok(!state.contaminated.has('B-2'));
  assert.ok(!state.contaminated.has('P-3'));
  assert.ok(!state.contaminated.has('RM-1'));

  // Incremental result equals a full recompute from the event log.
  const fresh = lineage.buildState(state.events);
  assert.deepEqual([...state.contaminated].sort(), [...fresh.contaminated].sort());

  // Correcting back to pass shrinks the closure again.
  const back = lineage.correctInspection(state, 'IN-1', 'pass', 'false alarm');
  assert.deepEqual(back.added, []);
  assert.deepEqual(back.removed, ['B-1', 'P-1', 'P-2']);
  assert.deepEqual([...state.contaminated], []);
});

test('incremental correction matches full recompute on random graphs', () => {
  for (let seed = 1000; seed < 1100; seed += 1) {
    const events = randomEvents(seed);
    const inspectEvents = events.filter((e) => e.type === 'inspect');
    if (inspectEvents.length === 0) continue;
    const state = lineage.buildState(events);
    const target = inspectEvents[seed % inspectEvents.length];
    const delta = lineage.correctInspection(state, target.id, seed % 2 ? 'fail' : 'pass');
    for (const id of [...delta.added, ...delta.removed]) {
      assert.ok(delta.closure.includes(id), `seed ${seed}: ${id} changed outside closure`);
    }
    const fresh = lineage.buildState(state.events);
    assert.deepEqual(
      [...state.contaminated].sort(),
      [...fresh.contaminated].sort(),
      `seed ${seed}: incremental != full recompute`,
    );
  }
});

test('history is preserved: compensation node appended, original kept', () => {
  const state = lineage.buildState(EVENTS);
  lineage.correctInspection(state, 'IN-1', 'fail');
  const inspection = state.inspections.get('IN-1');
  assert.equal(inspection.status, 'pass'); // original untouched
  assert.equal(inspection.correction.status, 'fail'); // compensation node
  assert.equal(state.events.filter((e) => e.type === 'correct').length, 1);
});
