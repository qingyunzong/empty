'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/cli');

// The CLI front-end (stdin/file -> JSON) is thin; the JSON transaction
// semantics are exercised here through the same `run()` entry point.
function runCli(input) {
  return JSON.parse(JSON.stringify(run(input)));
}

test('cli: JSON transaction stream in, JSON results out', () => {
  const input = {
    timezones: { UTC: [{ from: 0, offsetMinutes: 0 }] },
    calendar: {
      shifts: [{ id: 's', tz: 'UTC', freq: 'daily', timeOfDay: '01:00', durationMinutes: 60 }],
    },
    ops: [
      { op: 'expand', shift: { tz: 'UTC', freq: 'daily', timeOfDay: '01:00', durationMinutes: 60 }, window: { start: 0, end: 172800000 } },
      { op: 'command', command: { id: 'c1', kind: 'occupy', resource: 'dev-A', start: 0, end: 1000, baseVersion: 0 } },
      { op: 'command', command: { id: 'c2', kind: 'occupy', resource: 'dev-A', start: 500, end: 1500, baseVersion: 0 } },
      { op: 'command', command: { id: 'c3', kind: 'occupy', resource: 'dev-A', start: 1000, end: 2000, baseVersion: 0 } },
      { op: 'command', command: { id: 'bad', kind: 'occupy', resource: 'dev-A', start: 5, end: 5, baseVersion: 0 } },
    ],
  };
  const out = runCli(input);
  assert.equal(out.results[0].ok, true);
  assert.equal(out.results[0].intervals.length, 2);
  assert.deepEqual(out.results[0].intervals[0], { start: 3600000, end: 7200000, shiftId: null, kind: 'shift' });
  assert.equal(out.results[1].ok, true);
  assert.equal(out.results[1].version, 1);
  assert.equal(out.results[2].ok, false);
  assert.equal(out.results[2].error.code, 'REVISION');
  assert.deepEqual(out.results[2].error.certificate, {
    commandId: 'c2',
    conflictCommandId: 'c1',
    resource: 'dev-A',
    firstOverlapMs: 500,
  });
  assert.equal(out.results[3].ok, true); // adjacent, half-open
  assert.equal(out.results[4].error.code, 'ZERO_DURATION');
  assert.equal(out.version, 2);
});

test('cli: transaction with savepoint rollback and unknown savepoint error', () => {
  const input = {
    ops: [
      { op: 'begin', tx: 't1' },
      { op: 'command', command: { id: 'a', kind: 'occupy', resource: 'r', start: 0, end: 10, baseVersion: 0 } },
      { op: 'savepoint', name: 'sp' },
      { op: 'command', command: { id: 'b', kind: 'occupy', resource: 'r', start: 10, end: 20, baseVersion: 0 } },
      { op: 'rollbackTo', name: 'sp' },
      { op: 'rollbackTo', name: 'ghost' },
      { op: 'commit' },
    ],
  };
  const out = runCli(input);
  assert.equal(out.results[4].ok, true);
  assert.equal(out.results[5].error.code, 'UNKNOWN_SAVEPOINT');
  assert.equal(out.results[6].ok, true);
  assert.deepEqual(out.results[6].versions, [{ commandId: 'a', version: 1 }]);
});
