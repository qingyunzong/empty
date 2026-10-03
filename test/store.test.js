import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventStore, StoreError } from '../src/store.js';

function tmpWal() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-store-'));
  return path.join(dir, 'events.wal');
}

const sample = [
  { eventId: 'e1', deviceId: 'dev-A', seq: 1, type: 'start' },
  { eventId: 'e2', deviceId: 'dev-A', seq: 2, type: 'count', value: 41 },
  { eventId: 'e3', deviceId: 'dev-A', seq: 3, type: 'alarm', level: 'high' },
];

test('append three events, reopen, query by deviceId+seq is consistent', () => {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  for (const event of sample) store.append(event);
  store.close();

  store = EventStore.open(wal);
  assert.deepEqual(store.all(), sample);
  assert.deepEqual(store.query('dev-A', 2), [sample[1]]);
  assert.deepEqual(store.query('dev-A'), sample);
  assert.deepEqual(store.get('e3'), sample[2]);
  assert.equal(store.get('nope'), null);
  store.close();
});

test('duplicate eventId rejected with E_DUP, also after reopen', () => {
  const wal = tmpWal();
  let store = EventStore.open(wal);
  store.append(sample[0]);
  assert.throws(() => store.append(sample[0]), (err) => err instanceof StoreError && err.code === 'E_DUP');
  store.close();

  store = EventStore.open(wal);
  assert.throws(() => store.append({ ...sample[0], type: 'stop' }), (err) => err.code === 'E_DUP');
  store.close();
});

test('query orders by seq and isolates devices', () => {
  const wal = tmpWal();
  const store = EventStore.open(wal);
  store.append({ eventId: 'a3', deviceId: 'A', seq: 3 });
  store.append({ eventId: 'a1', deviceId: 'A', seq: 1 });
  store.append({ eventId: 'b1', deviceId: 'B', seq: 1 });
  store.append({ eventId: 'a2', deviceId: 'A', seq: 2 });
  assert.deepEqual(store.query('A').map((e) => e.eventId), ['a1', 'a2', 'a3']);
  assert.deepEqual(store.query('B').map((e) => e.eventId), ['b1']);
  assert.deepEqual(store.query('C'), []);
  assert.deepEqual(store.query('A', 9), []);
  store.close();
});

test('validation errors use E_VALIDATION', () => {
  const wal = tmpWal();
  const store = EventStore.open(wal);
  const bad = [
    null,
    'x',
    { deviceId: 'A', seq: 1 },
    { eventId: '', deviceId: 'A', seq: 1 },
    { eventId: 'x', deviceId: 'A', seq: -1 },
    { eventId: 'x', deviceId: 'A', seq: 1.5 },
  ];
  for (const event of bad) {
    assert.throws(() => store.append(event), (err) => err.code === 'E_VALIDATION');
  }
  assert.throws(() => store.query(''), (err) => err.code === 'E_VALIDATION');
  store.close();
});
