import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { validateEvent, validateVectorClock, InputError } from '../src/event.js';
import { tmpDir, runCli, writeJson } from '../testkit/helpers.js';

test('validateEvent rejects invalid vector clocks', () => {
  const base = { id: 'e1', device: 'd1', ts: 0, type: 'RUN' };
  for (const vc of [[1, 2], null, 'x', { d1: -1 }, { d1: 1.5 }, { d1: '1' }, { '': 1 }]) {
    assert.throws(() => validateEvent({ ...base, vc }), InputError, `vc=${JSON.stringify(vc)}`);
  }
  assert.deepEqual(validateEvent({ ...base, vc: { d1: 0 } }).vc, { d1: 0 });
});

test('validateEvent rejects malformed events', () => {
  assert.throws(() => validateEvent(null), InputError);
  assert.throws(() => validateEvent({ device: 'd', ts: 0, vc: {}, type: 'RUN' }), InputError);
  assert.throws(() => validateEvent({ id: 'e', device: 'd', ts: NaN, vc: {}, type: 'RUN' }), InputError);
  assert.throws(() => validateEvent({ id: 'e', device: 'd', ts: 0, vc: {}, type: '' }), InputError);
});

test('validateVectorClock accepts non-negative safe integers', () => {
  assert.deepEqual(validateVectorClock({ a: 0, b: 42 }), { a: 0, b: 42 });
  assert.throws(() => validateVectorClock({ a: Number.MAX_SAFE_INTEGER + 1 }), InputError);
});

test('CLI: bad JSON exits with code 2', () => {
  const dir = tmpDir();
  const file = writeJson(dir, 'bad.json', '{not json');
  const res = runCli(['add', file, '--db', join(dir, 'db.json')]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /bad JSON/);
});

test('CLI: duplicate id exits with code 2', () => {
  const dir = tmpDir();
  const db = join(dir, 'db.json');
  const file = writeJson(dir, 'e.json', JSON.stringify({ id: 'e1', device: 'd1', ts: 0, vc: { d1: 1 }, type: 'RUN' }));
  assert.equal(runCli(['add', file, '--db', db]).status, 0);
  const res = runCli(['add', file, '--db', db]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /duplicate event id: e1/);
});

test('CLI: invalid vector clock exits with code 2', () => {
  const dir = tmpDir();
  const db = join(dir, 'db.json');
  const file = writeJson(dir, 'e.json', JSON.stringify({ id: 'e1', device: 'd1', ts: 0, vc: { d1: -3 }, type: 'RUN' }));
  const res = runCli(['add', file, '--db', db]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /invalid vector clock/);
});

test('CLI: retract of unknown id exits with code 2', () => {
  const dir = tmpDir();
  const res = runCli(['retract', 'nope', '--db', join(dir, 'db.json')]);
  assert.equal(res.status, 2);
  assert.match(res.stderr, /unknown event id/);
});
