import test from 'node:test';
import assert from 'node:assert/strict';
import { parseInput, runLines } from '../src/cli.js';

const INPUT = [
  { cmd: 'config', timezones: { 'Etc/UTC': [{ from: null, offsetMinutes: 0 }] }, window: { zone: 'Etc/UTC', weekly: [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '17:00' }] } },
  { cmd: 'receive', batch: 'B1', qty: 10, expiry: '2026-07-01T00:00:00Z', span: ['2026-01-01T00:00:00Z', '2026-01-05T00:00:00Z'] },
  { cmd: 'available', batch: 'B1' },
  { cmd: 'inspect', batch: 'B1', inspectedAt: '2026-06-01T10:00:00Z', passed: true },
  { cmd: 'issue', orderId: 'O1', qty: 4, at: '2026-06-02T10:00:00Z' },
  { cmd: 'issue', orderId: 'O2', qty: 100, at: '2026-06-02T11:00:00Z' },
  { cmd: 'quarantine', batch: 'GHOST' },
];

test('CLI pipeline emits one JSON result per input line', () => {
  const commands = parseInput(INPUT.map((c) => JSON.stringify(c)).join('\n'));
  assert.equal(commands.length, INPUT.length);
  const { outputs, failed } = runLines(commands);
  assert.equal(outputs.length, INPUT.length);
  assert.equal(failed, true);
  assert.equal(outputs[0].ok, true);
  assert.deepEqual(outputs[4].allocations, [{ batch: 'B1', qty: 4 }]);
  assert.equal(outputs[5].error.code, 'NEGATIVE_INVENTORY');
  assert.equal(outputs[6].error.code, 'UNKNOWN_BATCH');
  for (const out of outputs) JSON.parse(JSON.stringify(out));
});

test('CLI input parser accepts a single JSON array or object', () => {
  const fromArray = parseInput(JSON.stringify(INPUT.slice(0, 5)));
  assert.equal(fromArray.length, 5);
  const { outputs, failed } = runLines(fromArray);
  assert.ok(outputs.every((o) => o.ok));
  assert.equal(failed, false);
  assert.equal(parseInput(JSON.stringify(INPUT[0])).length, 1);
  assert.deepEqual(parseInput('  \n '), []);
});
