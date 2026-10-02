import test from 'node:test';
import assert from 'node:assert/strict';
import { EventStore, StoreError, E_DUP, E_NOTFOUND, E_INVALID } from '../src/store.js';

const T = (s) => Date.parse(s);

test('acceptance 1: correction appends a version; old snapshot reads alarm, new snapshot reads reset; both index directions agree', () => {
  const store = new EventStore();
  store.create({ eventId: 'A', deviceId: 'pump-1', validAt: '2026-01-01T00:00:00Z', data: { status: 'alarm' } });
  const s1 = store.snapshot();
  store.correct({ eventId: 'A', data: { status: 'reset' } });
  const s2 = store.snapshot();

  // by (eventId) index
  assert.equal(s1.get('A').data.status, 'alarm');
  assert.equal(s2.get('A').data.status, 'reset');

  // by (deviceId, validAt) index
  const t = T('2026-01-01T00:00:00Z');
  const r1 = s1.range('pump-1', t, t);
  const r2 = s2.range('pump-1', t, t);
  assert.equal(r1.length, 1);
  assert.equal(r1[0].data.status, 'alarm');
  assert.equal(r2.length, 1);
  assert.equal(r2[0].data.status, 'reset');

  // the two index directions are consistent with each other in every snapshot
  for (const snap of [s1, s2]) {
    const viaRange = snap.range('pump-1', undefined, undefined);
    for (const ev of viaRange) {
      assert.deepEqual(snap.get(ev.eventId), ev);
    }
    assert.deepEqual(viaRange.map((e) => e.eventId), ['A']);
  }
});

test('acceptance 2: tombstone delete; old snapshot still reads history by eventId; new snapshot range excludes it; duplicate create -> E_DUP', () => {
  const store = new EventStore();
  store.create({ eventId: 'B', deviceId: 'pump-1', validAt: 1000, data: { status: 'alarm' } });
  const s1 = store.snapshot();
  store.delete('B');
  const s2 = store.snapshot();

  // old snapshot: history still readable via the (eventId) index
  assert.equal(s1.get('B').data.status, 'alarm');
  assert.deepEqual(s1.range('pump-1', 0, 2000).map((e) => e.eventId), ['B']);

  // new snapshot: excluded from both index directions
  assert.equal(s2.get('B'), null);
  assert.deepEqual(s2.range('pump-1', 0, 2000), []);

  // duplicate create of a live eventId -> E_DUP
  store.create({ eventId: 'C', deviceId: 'pump-1', validAt: 1500, data: null });
  assert.throws(
    () => store.create({ eventId: 'C', deviceId: 'pump-1', validAt: 1600 }),
    (err) => err instanceof StoreError && err.code === E_DUP,
  );

  // re-create after delete is allowed (tombstone semantics) and does not disturb old snapshots
  const recreated = store.create({ eventId: 'B', deviceId: 'pump-1', validAt: 3000, data: { status: 'alarm' } });
  assert.equal(recreated.eventId, 'B');
  assert.equal(store.snapshot().range('pump-1', 2500, 3500).length, 1);
  assert.equal(s1.get('B').validAt, 1000);
  assert.equal(s2.get('B'), null);
});

test('correct/delete of a missing or deleted event -> E_NOTFOUND', () => {
  const store = new EventStore();
  assert.throws(() => store.correct({ eventId: 'nope', data: 1 }), (err) => err.code === E_NOTFOUND);
  assert.throws(() => store.delete('nope'), (err) => err.code === E_NOTFOUND);
  store.create({ eventId: 'D', deviceId: 'd1', validAt: 10, data: null });
  store.delete('D');
  assert.throws(() => store.correct({ eventId: 'D', data: 1 }), (err) => err.code === E_NOTFOUND);
  assert.throws(() => store.delete('D'), (err) => err.code === E_NOTFOUND);
});

test('validAt correction migrates the (deviceId, validAt) index; each snapshot keeps its own view', () => {
  const store = new EventStore();
  store.create({ eventId: 'E', deviceId: 'd1', validAt: 100, data: { v: 1 } });
  const s1 = store.snapshot();
  store.correct({ eventId: 'E', validAt: 900, data: { v: 2 } });
  const s2 = store.snapshot();

  assert.deepEqual(s1.range('d1', 0, 500).map((e) => e.eventId), ['E']);
  assert.deepEqual(s1.range('d1', 500, 1000), []);
  assert.deepEqual(s2.range('d1', 0, 500), []);
  assert.deepEqual(s2.range('d1', 500, 1000).map((e) => e.eventId), ['E']);
  assert.equal(s1.get('E').validAt, 100);
  assert.equal(s2.get('E').validAt, 900);
});

test('deviceId correction migrates the event between device indexes', () => {
  const store = new EventStore();
  store.create({ eventId: 'F', deviceId: 'dev-a', validAt: 100, data: null });
  const s1 = store.snapshot();
  store.correct({ eventId: 'F', deviceId: 'dev-b' });
  const s2 = store.snapshot();

  assert.deepEqual(s1.range('dev-a', 0, 200).map((e) => e.eventId), ['F']);
  assert.deepEqual(s1.range('dev-b', 0, 200), []);
  assert.deepEqual(s2.range('dev-a', 0, 200), []);
  assert.deepEqual(s2.range('dev-b', 0, 200).map((e) => e.eventId), ['F']);
});

test('empty range returns an empty array', () => {
  const store = new EventStore();
  store.create({ eventId: 'X', deviceId: 'd1', validAt: 100, data: null });
  assert.deepEqual(store.range('d1', 200, 100), []); // from > to
  assert.deepEqual(store.range('d1', 0, 50), []); // no hits
  assert.deepEqual(store.range('unknown-device', 0, 1000), []);
  assert.deepEqual(new EventStore().range('d1', 0, 1000), []); // empty store
});

test('snapshot isolation: writes after begin are invisible to the snapshot', () => {
  const store = new EventStore();
  store.create({ eventId: 'G', deviceId: 'd1', validAt: 10, data: { v: 1 } });
  const snap = store.snapshot();
  store.correct({ eventId: 'G', data: { v: 2 } });
  store.create({ eventId: 'H', deviceId: 'd1', validAt: 20, data: null });
  store.delete('G');

  assert.equal(snap.get('G').data.v, 1);
  assert.equal(snap.get('H'), null);
  assert.deepEqual(snap.range('d1', 0, 100).map((e) => e.eventId), ['G']);
});

test('invalid input -> E_INVALID', () => {
  const store = new EventStore();
  assert.throws(() => store.create({ eventId: 'x', deviceId: 'd1', validAt: 'not-a-date' }), (err) => err.code === E_INVALID);
  assert.throws(() => store.create({ eventId: '', deviceId: 'd1', validAt: 1 }), (err) => err.code === E_INVALID);
  assert.throws(() => store.range('d1', 'junk', 10), (err) => err.code === E_INVALID);
});
