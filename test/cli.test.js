import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runLines } from '../src/cliCore.js';

test('CLI processes JSON lines and emits JSON lines', () => {
  const lines = [
    { type: 'defineZone', zone: 'PLANT_A', rules: [{ atUtc: 0, offsetMinutes: 480 }] },
    { type: 'event', id: 'e1', device: 'd1', zone: 'PLANT_A', state: 'ON', local: '2026-01-01T08:00:01.000', version: 1 },
    { type: 'event', id: 'e2', device: 'd1', device: 'd1', zone: 'PLANT_A', state: 'OFF', local: '2026-01-01T08:00:03.500', version: 2 },
    { type: 'query', device: 'd1', from: 0, to: 1767225606000 },
  ];
  const out = runLines(lines.map(l => JSON.stringify(l)).join('\n') + '\n');
  assert.equal(out.length, 4);
  assert.deepEqual(out[0], { ok: true, type: 'zoneDefined', zone: 'PLANT_A', ruleCount: 1 });
  assert.equal(out[1].type, 'eventAccepted');
  // local 2026-01-01T08:00:01 at UTC+8 -> 2026-01-01T00:00:01Z
  assert.equal(out[1].utcMs, Date.parse('2026-01-01T00:00:01.000Z'));
  assert.equal(out[3].type, 'queryResult');
  assert.deepEqual(out[3].intervals.map(i => [i.state, i.status]),
    [['ON', 'CLOSED'], ['OFF', 'UNCLOSED']]);
});

test('CLI reports per-line errors and keeps processing', () => {
  const lines = [
    '{"type":"defineZone","zone":"Z","rules":[{"atUtc":0,"offsetMinutes":0},{"atUtc":0,"offsetMinutes":60}]}',
    'not json at all',
    JSON.stringify({ type: 'event', id: 'x', device: 'd', zone: 'GHOST', state: 'ON', local: '2026-01-01T00:00:00' }),
    JSON.stringify({ type: 'query', device: 'd', from: 0, to: 10 }),
  ];
  const out = runLines(lines.join('\n') + '\n');
  assert.equal(out[0].ok, false);
  assert.equal(out[0].code, 'OFFSET_TABLE_CONFLICT');
  assert.equal(out[1].ok, false);
  assert.equal(out[1].code, 'BAD_COMMAND');
  assert.equal(out[2].ok, false);
  assert.equal(out[2].code, 'UNKNOWN_TIMEZONE');
  assert.equal(out[3].ok, true, 'engine still answers after errors');
});

test('CLI flags period inversion as an error line', () => {
  const lines = [
    JSON.stringify({ type: 'defineZone', zone: 'Z', rules: [{ atUtc: 0, offsetMinutes: 0 }] }),
    JSON.stringify({ type: 'query', device: 'd', from: 0, to: 100, period: { start: 50, durationMs: 10, end: 50 } }),
  ];
  const out = runLines(lines.join('\n') + '\n');
  assert.equal(out[1].ok, false);
  assert.equal(out[1].code, 'PERIOD_INVERSION');
});
