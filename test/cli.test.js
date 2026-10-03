'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { runCommands } = require('../src/cli');

// The CLI entry point is exercised in-process because this offline sandbox
// forbids spawning child processes; src/cli.js#main is a thin wrapper around
// runCommands (stdin/file in, JSON lines out, exit code from hadError).
test('CLI maps JSON command lines to JSON result lines', () => {
  const lines = [
    { cmd: 'defineZone', zone: 'utc', offsets: [{ effectiveFromUtc: '2020-01-01T00:00:00.000Z', offsetMinutes: 0 }] },
    { cmd: 'event', event: { id: 'c1', deviceId: 'dev-cli', state: 'ON', zone: 'utc', localTime: '2026-01-01T00:00:01.000' } },
    { cmd: 'event', event: { id: 'c2', deviceId: 'dev-cli', state: 'OFF', zone: 'utc', localTime: '2026-01-01T00:00:05.000' } },
    { cmd: 'merge', deviceId: 'dev-cli', observation: { startUtc: '2026-01-01T00:00:00.000Z', cutoffUtc: '2026-01-01T00:00:10.000Z' } },
    { cmd: 'event', event: { id: 'c3', deviceId: 'dev-cli', state: 'ON', zone: 'ghost', localTime: '2026-01-01T00:00:02.000' } },
    '{not json',
  ];
  const input = lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n';
  const { results, hadError } = runCommands(input);

  assert.equal(hadError, true, 'hadError drives the non-zero exit code');
  assert.equal(results.length, 6);
  assert.equal(results[0].type, 'ok');
  assert.equal(results[1].type, 'ok');
  assert.equal(results[3].type, 'mergeResult');
  assert.deepEqual(
    results[3].intervals.map((iv) => [iv.state, iv.startUtcMs, iv.endUtcMs, iv.unclosed]),
    [
      ['ON', Date.UTC(2026, 0, 1, 0, 0, 1), Date.UTC(2026, 0, 1, 0, 0, 5), false],
      ['OFF', Date.UTC(2026, 0, 1, 0, 0, 5), Date.UTC(2026, 0, 1, 0, 0, 10), true],
    ]
  );
  assert.deepEqual(
    [results[4].type, results[4].code],
    ['error', 'UNKNOWN_ZONE']
  );
  assert.deepEqual(
    [results[5].type, results[5].code],
    ['error', 'INVALID_JSON']
  );
});
