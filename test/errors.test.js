import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main } from '../src/cli.js';
import { Store, DomainError } from '../src/store.js';

function runCli(events) {
  const dir = mkdtempSync(join(tmpdir(), 'obs-sched-err-'));
  const eventsPath = join(dir, 'events.jsonl');
  writeFileSync(eventsPath, events.map((e) => JSON.stringify(e)).join('\n') + '\n');
  let stderr = '';
  const io = { stdout: { write() {} }, stderr: { write(s) { stderr += s; } } };
  const status = main(['--events', eventsPath, '--checkpoint-file', join(dir, 'cp.json')], io);
  return { status, stderr };
}

test('overlapping observation windows are illegal (exit 3)', () => {
  const { status, stderr } = runCli([
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 1, clock: 1 },
    { type: 'plan', target: 'B', pi: 'p2', window: [5, 15], value: 1, clock: 2 },
    { type: 'observe', target: 'A', obs: 'O1', window: [0, 10], clock: 3 },
    { type: 'observe', target: 'B', obs: 'O2', window: [5, 15], clock: 4 },
  ]);
  assert.equal(status, 3);
  assert.match(stderr, /WINDOW_OVERLAP/);
});

test('negative duration is illegal (exit 3)', () => {
  const { status, stderr } = runCli([
    { type: 'plan', target: 'A', pi: 'p1', window: [10, 5], value: 1, clock: 1 },
  ]);
  assert.equal(status, 3);
  assert.match(stderr, /NEGATIVE_DURATION/);
});

test('revoke of unknown observation exits 3', () => {
  const { status, stderr } = runCli([{ type: 'revoke', obs: 'NOPE', clock: 1 }]);
  assert.equal(status, 3);
  assert.match(stderr, /UNKNOWN_OBSERVATION/);
});

test('window expansion via correction is illegal (exit 3)', () => {
  const { status, stderr } = runCli([
    { type: 'plan', target: 'A', pi: 'p1', window: [0, 10], value: 1, clock: 1 },
    { type: 'correct', target: 'A', window: [0, 20], clock: 2 },
  ]);
  assert.equal(status, 3);
  assert.match(stderr, /WINDOW_EXPANSION/);
});

test('domain errors are also raised by the library API', () => {
  const store = new Store();
  assert.throws(
    () => store.applyAll([{ type: 'plan', target: 'A', window: [3, 3], clock: 1 }]),
    (err) => err instanceof DomainError && err.code === 'NEGATIVE_DURATION',
  );
});
