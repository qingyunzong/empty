import test from 'node:test';
import assert from 'node:assert/strict';
import {ok, tempStateDir, writeJson} from './helpers.js';

const scenario = {
  stations: [
    {
      id: 'SA', link: 'LA', battery: 5,
      windows: [
        {id: 'WA1', start: 0, end: 2, cost: 1},
        {id: 'WA2', start: 2, end: 4, cost: 1},
      ],
    },
    {
      id: 'SB', link: 'LB', battery: 5,
      windows: [
        {id: 'WB1', start: 0, end: 2, cost: 1},
        {id: 'WB2', start: 2, end: 4, cost: 1},
      ],
    },
  ],
  contracts: [
    {id: 'CA', station: 'SA', min: 1, floor: 0, period: 10, quota: 2},
    {id: 'CB', station: 'SB', min: 1, floor: 0, period: 10, quota: 2},
  ],
};

test('acceptance 3: closing a window reschedules locally, remote hash unchanged', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', scenario);
  const before = ok(['ingest', sc, '--state', dir]).plan;
  assert.equal(before.stationHashes.SB.length, 64);
  const saBefore = before.entries.filter((e) => e.station === 'SA');
  assert.deepEqual(saBefore.map((e) => e.window), ['WA1']);

  const patch = writeJson(dir, 'patch.json', {close: {SA: ['WA1']}});
  const after = ok(['correct', patch, '--state', dir]);
  assert.deepEqual(after.affected, ['SA']);

  // Local reschedule: SA moved to WA2.
  const saAfter = after.plan.entries.filter((e) => e.station === 'SA');
  assert.deepEqual(saAfter.map((e) => e.window), ['WA2']);

  // Remote station untouched: identical entries and identical plan hash.
  const sbBefore = before.entries.filter((e) => e.station === 'SB');
  const sbAfter = after.plan.entries.filter((e) => e.station === 'SB');
  assert.deepEqual(sbAfter, sbBefore);
  assert.equal(after.plan.stationHashes.SB, before.stationHashes.SB);
});

test('correct can add windows and newly satisfy a contract', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', {
    stations: [{id: 'S1', link: 'L', battery: 5, windows: [{id: 'W1', start: 0, end: 1, cost: 1}]}],
    contracts: [{id: 'C1', station: 'S1', min: 2, floor: 0, period: 10, quota: 3}],
  });
  const before = ok(['ingest', sc, '--state', dir]).plan;
  assert.equal(before.served.C1, 1);
  assert.equal(before.unmet[0].reason, 'insufficient-windows');

  const patch = writeJson(dir, 'patch.json', {
    add: {S1: [{id: 'W2', start: 1, end: 2, cost: 1}]},
  });
  const after = ok(['correct', patch, '--state', dir]).plan;
  assert.equal(after.served.C1, 2);
  assert.equal(after.unmet.length, 0);
});
