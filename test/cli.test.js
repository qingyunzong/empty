'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { run } = require('../src/cli');
const { Engine } = require('../src/engine');

// Note: the bin/qctl.js entry point is a thin wrapper over run(): it prints
// each result as a JSON line and exits 1 when hadError is set. Sandboxed CI
// environments may forbid child processes, so the CLI is tested in-process.

const FLOW = [
  { cmd: 'configure', timezones: { 'Asia/Shanghai': 480 }, rules: [{ id: 'qc', kind: 'weekly', weekday: 1, start: '08:00', durationMinutes: 480, timezone: 'Asia/Shanghai' }], holidays: { cancel: [], add: [] } },
  { cmd: 'receive', batch: 'B1', qty: 10, expiry: '2026-06-01T00:00:00Z', lot: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] },
  { cmd: 'event', batch: 'B1', type: 'available' },
  { cmd: 'inspect', batch: 'B1', time: '2026-01-05T02:00:00Z', defects: [['2026-01-02T00:00:00Z', '2026-01-02T00:00:00Z']] },
  { cmd: 'issue', id: 'ORD-1', qty: 4, time: '2026-01-06T00:00:00Z' },
  { cmd: 'snapshot' },
];

test('CLI reads a JSON array and emits one result per command', () => {
  const { lines, hadError } = run(JSON.stringify(FLOW));
  assert.equal(hadError, false);
  assert.equal(lines.length, FLOW.length);
  assert.ok(lines.every((l) => l.ok));
  // Zero-length defect exactly on the lot boundary does not block issuing.
  assert.equal(lines[3].defectHit, false);
  assert.deepEqual(lines[4].allocations, [{ batch: 'B1', qty: 4 }]);
  assert.equal(lines[5].issuableTotal, 6);
});

test('CLI accepts a single JSON object and JSON Lines input', () => {
  const single = run(JSON.stringify({ cmd: 'snapshot' }));
  assert.equal(single.lines.length, 1);
  assert.equal(single.lines[0].type, 'snapshot');
  const jsonl = run(FLOW.map((c) => JSON.stringify(c)).join('\n'));
  assert.equal(jsonl.hadError, false);
  assert.equal(jsonl.lines.length, FLOW.length);
});

test('errors become JSON lines, hadError is set, processing continues', () => {
  const { lines, hadError } = run(JSON.stringify([
    { cmd: 'configure', timezones: { UTC: 0 }, rules: [{ id: 'bad', kind: 'weekly', weekday: 9, start: '08:00', durationMinutes: 60, timezone: 'UTC' }], holidays: {} },
    { cmd: 'event', batch: 'GHOST', type: 'available' },
    { cmd: 'receive', batch: 'B1', qty: 5, expiry: '2026-06-01T00:00:00Z', lot: ['2026-01-01T00:00:00Z', '2026-01-02T00:00:00Z'] },
    { cmd: 'event', batch: 'B1', type: 'available' },
    { cmd: 'issue', id: 'ORD-1', qty: 99, time: '2026-01-06T00:00:00Z' },
  ]));
  assert.equal(hadError, true);
  assert.equal(lines[0].error.code, 'ILLEGAL_PERIOD');
  assert.equal(lines[1].error.code, 'UNKNOWN_BATCH');
  assert.equal(lines[4].error.code, 'NEGATIVE_INVENTORY');
  assert.equal(lines[2].ok, true);
  assert.equal(lines[3].ok, true);
});

test('malformed input yields INVALID_INPUT', () => {
  const { lines, hadError } = run('[{"cmd":');
  assert.equal(hadError, true);
  assert.equal(lines[0].error.code, 'INVALID_INPUT');
});

test('engine: zero-length boundary defect keeps batch issuable end-to-end', () => {
  const e = new Engine();
  for (const cmd of FLOW.slice(0, 4)) e.execute(cmd);
  const issue = e.execute({ cmd: 'issue', id: 'ORD-1', qty: 10, time: '2026-01-06T00:00:00Z' });
  assert.deepEqual(issue.allocations, [{ batch: 'B1', qty: 10 }]);
});
