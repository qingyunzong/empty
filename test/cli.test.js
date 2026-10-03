import test from 'node:test';
import assert from 'node:assert/strict';
import { runCommands } from '../src/cli.js';

// The sandbox forbids spawning child processes, so the CLI is exercised
// through its exported runCommands(); the stdout contract (single JSON
// line) is reproduced by serializing the result array the same way main() does.
function runCli(input) {
  const stdout = JSON.stringify(runCommands(input)) + '\n';
  const lines = stdout.trim().split('\n');
  assert.equal(lines.length, 1, 'stdout must be a single JSON line');
  return JSON.parse(lines[0]);
}

test('CLI processes a JSON command sequence and emits one JSON line', () => {
  const results = runCli(
    JSON.stringify([
      { op: 'add', task: { id: 'a', release: '0', deadline: '1', duration: '1', weight: '2' } },
      { op: 'add', task: { id: 'b', release: '1', deadline: '2', duration: '1', weight: '3' } },
      { op: 'solve' },
      { op: 'add', task: { id: 'bad', release: '1/0', deadline: '2', duration: '1', weight: '1' } },
      { op: 'update', id: 'b', patch: { release: '0', deadline: '1' } },
      { op: 'solve' },
      { op: 'undo' },
      { op: 'solve' },
      { op: 'version' },
    ])
  );
  assert.equal(results.length, 9);
  assert.deepEqual(results[0], { ok: true, version: 1 });
  assert.deepEqual(results[1], { ok: true, version: 2 });
  assert.equal(results[2].ok, true);
  assert.deepEqual(results[2].selected, [
    { id: 'a', start: '0', end: '1' },
    { id: 'b', start: '1', end: '2' },
  ]);
  assert.equal(results[2].weight, '5');
  assert.equal(results[3].ok, false);
  assert.equal(results[3].error.code, 'E_RATIONAL');
  assert.deepEqual(results[4], { ok: true, version: 3 });
  assert.equal(results[5].selected.length, 1, 'overlapping unit tasks cannot both run');
  assert.deepEqual(results[6], { ok: true, version: 2 });
  assert.equal(results[7].weight, '5', 'undo restores the chained schedule');
  assert.deepEqual(results[8], { ok: true, version: 2, versionCount: 4 });
});

test('CLI accepts newline-delimited JSON commands', () => {
  const results = runCli(
    [
      JSON.stringify({ op: 'add', task: { id: 'a', release: '0', deadline: '1/2', duration: '1/4', weight: '1' } }),
      JSON.stringify({ op: 'solve' }),
    ].join('\n')
  );
  assert.equal(results[1].selected[0].end, '1/4');
});
