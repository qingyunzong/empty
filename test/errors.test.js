import test from 'node:test';
import assert from 'node:assert/strict';
import {cli, ok, tempStateDir, writeJson} from './helpers.js';

test('mutex overlap in preassigned windows exits 6', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', {
    stations: [
      {id: 'S1', link: 'L', battery: 10, windows: [{id: 'W1', start: 0, end: 3, cost: 1}]},
      {id: 'S2', link: 'L', battery: 10, windows: [{id: 'W2', start: 1, end: 2, cost: 1}]},
    ],
    contracts: [
      {id: 'C1', station: 'S1', min: 1, floor: 0, period: 10, quota: 1},
      {id: 'C2', station: 'S2', min: 1, floor: 0, period: 10, quota: 1},
    ],
    preassigned: [
      {station: 'S1', window: 'W1', contract: 'C1'},
      {station: 'S2', window: 'W2', contract: 'C2'},
    ],
  });
  const r = cli(['ingest', sc, '--state', dir]);
  assert.equal(r.status, 6);
  assert.equal(JSON.parse(r.stderr).error, 'mutex-overlap');
});

test('negative battery exits 6', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', {
    stations: [{id: 'S1', link: 'L', battery: -1, windows: []}],
    contracts: [],
  });
  const r = cli(['ingest', sc, '--state', dir]);
  assert.equal(r.status, 6);
  assert.equal(JSON.parse(r.stderr).error, 'battery-negative');
});

test('preassigned energy exceeding battery exits 6', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', {
    stations: [{id: 'S1', link: 'L', battery: 1, windows: [{id: 'W1', start: 0, end: 1, cost: 2}]}],
    contracts: [{id: 'C1', station: 'S1', min: 1, floor: 0, period: 10, quota: 1}],
    preassigned: [{station: 'S1', window: 'W1', contract: 'C1'}],
  });
  const r = cli(['ingest', sc, '--state', dir]);
  assert.equal(r.status, 6);
  assert.equal(JSON.parse(r.stderr).error, 'battery-negative');
});

test('restore of unknown failure exits 6', () => {
  const dir = tempStateDir();
  const sc = writeJson(dir, 'scenario.json', {
    stations: [{id: 'S1', link: 'L', battery: 5, windows: [{id: 'W1', start: 0, end: 1, cost: 1}]}],
    contracts: [{id: 'C1', station: 'S1', min: 1, floor: 0, period: 10, quota: 1}],
  });
  ok(['ingest', sc, '--state', dir]);
  const r = cli(['restore', '--failure', 'F99', '--state', dir]);
  assert.equal(r.status, 6);
  assert.equal(JSON.parse(r.stderr).error, 'unknown-failure');
});

test('usage errors exit 2', () => {
  const r = cli([]);
  assert.equal(r.status, 2);
});
