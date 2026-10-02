import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createState, applyFlows, computeNets, PENDING_CALENDAR_HORIZON } from '../src/settle.js';
import { buildReport, replay, verifyReport } from '../src/certificate.js';
import { freshInputs } from './helpers.js';

function flow(overrides) {
  return {
    id: 't1', seq: 1, account: 'A', calendar: 'US-NY', type: 'post',
    amount: 100, currency: 'USD', localTime: '2024-06-10T10:00', ...overrides,
  };
}

test('E_ORDER: seq must strictly increase across batches', () => {
  const { tzTable, calendars } = freshInputs();
  const state = createState();
  applyFlows({ tzTable, calendars, flows: [flow({ seq: 7 })], state });
  assert.throws(
    () => applyFlows({ tzTable, calendars, flows: [flow({ id: 't2', seq: 7 })], state }),
    { code: 'E_ORDER' },
  );
  assert.throws(
    () => applyFlows({ tzTable, calendars, flows: [flow({ id: 't2', seq: 3 })], state }),
    { code: 'E_ORDER' },
  );
});

test('E_ORDER: duplicate ids and dangling reversal refs are rejected', () => {
  const { tzTable, calendars } = freshInputs();
  assert.throws(
    () => applyFlows({ tzTable, calendars, flows: [flow(), flow({ id: 't1', seq: 2 })], state: createState() }),
    { code: 'E_ORDER' },
  );
  assert.throws(
    () => applyFlows({
      tzTable, calendars, state: createState(),
      flows: [flow({ id: 'r1', type: 'reversal', amount: -100, ref: 'ghost' })],
    }),
    { code: 'E_ORDER' },
  );
});

test('pending: flows beyond the calendar horizon are parked with a reason', () => {
  const { tzTable, calendars } = freshInputs();
  const state = createState();
  const { pending } = applyFlows({
    tzTable, calendars, state,
    flows: [flow({ localTime: '2025-12-31T18:00' })],
  });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].reason, PENDING_CALENDAR_HORIZON);
  assert.equal(computeNets(state).length, 0);
});

test('acceptance 3: reversal recomputes only affected days; certificate replays', () => {
  const { tzTable, calendars, inputHashes } = freshInputs();
  const state = createState();

  const batch1 = [
    flow({ id: 'd1-a', seq: 1, amount: 1000, localTime: '2024-06-10T10:00' }),
    flow({ id: 'd1-b', seq: 2, amount: 500, localTime: '2024-06-10T14:00' }),
    flow({ id: 'd2-a', seq: 3, amount: 777, localTime: '2024-06-11T09:00' }),
  ];
  const r1 = applyFlows({ tzTable, calendars, flows: batch1, state });
  assert.deepEqual(r1.affectedDays, [
    { calendar: 'US-NY', date: '2024-06-10' },
    { calendar: 'US-NY', date: '2024-06-11' },
  ]);
  const report1 = buildReport({ tzTable, calendars, state, inputHashes, affectedDays: r1.affectedDays });
  const day2Before = structuredClone(state.days['US-NY']['2024-06-11']);

  // Correction: append a reversal for d1-a. History is kept, day 2 untouched.
  const batch2 = [flow({ id: 'd1-a-rev', seq: 4, type: 'reversal', amount: -1000, localTime: '2024-06-12T08:30', ref: 'd1-a' })];
  const r2 = applyFlows({ tzTable, calendars, flows: batch2, state });
  assert.deepEqual(r2.affectedDays, [{ calendar: 'US-NY', date: '2024-06-12' }]);

  // The reversal lands on its own local day (2024-06-12); day 2 is untouched...
  assert.deepEqual(state.days['US-NY']['2024-06-11'], day2Before);
  // ...and the original day-1 entries are still intact (append-only history).
  assert.equal(state.days['US-NY']['2024-06-10'].entries.length, 2);
  assert.equal(state.days['US-NY']['2024-06-10'].nets['A|USD'], 1500);
  assert.equal(state.days['US-NY']['2024-06-12'].nets['A|USD'], -1000);

  // Same-day correction: reverse d1-b with a timestamp on 2024-06-10 and only
  // that day is recomputed.
  const batch3 = [flow({ id: 'd1-b-rev', seq: 5, type: 'reversal', amount: -500, localTime: '2024-06-10T16:00', ref: 'd1-b' })];
  const r3 = applyFlows({ tzTable, calendars, flows: batch3, state });
  assert.deepEqual(r3.affectedDays, [{ calendar: 'US-NY', date: '2024-06-10' }]);
  assert.equal(state.days['US-NY']['2024-06-10'].nets['A|USD'], 1000);
  assert.equal(state.days['US-NY']['2024-06-10'].entries.length, 3); // history kept

  const report2 = buildReport({ tzTable, calendars, state, inputHashes, affectedDays: r3.affectedDays });
  assert.notEqual(report2.certificate.resultsHash, report1.certificate.resultsHash);
  assert.deepEqual(report2.certificate.affectedDays, [{ calendar: 'US-NY', date: '2024-06-10' }]);

  // Certificate is replayable: full re-execution from the raw inputs matches.
  const allFlows = [...batch1, ...batch2, ...batch3];
  const replayed = replay({ tzTable, calendars, flows: allFlows, inputHashes });
  assert.deepEqual(verifyReport(report2, replayed), []);
  assert.equal(replayed.certificate.inputHash, report2.certificate.inputHash);
});

test('boundary hit: exactly at cutoff belongs to the later day (half-open)', () => {
  const { tzTable, calendars } = freshInputs();
  const state = createState();
  applyFlows({ tzTable, calendars, flows: [flow({ localTime: '2024-06-10T17:00' })], state });
  assert.equal(state.boundaryHits.length, 1);
  assert.equal(state.boundaryHits[0].date, '2024-06-11');
  assert.equal(state.boundaryHits[0].utc, '2024-06-10T21:00Z');
  assert.deepEqual(computeNets(state), [
    { calendar: 'US-NY', date: '2024-06-11', account: 'A', currency: 'USD', net: 100 },
  ]);
});
