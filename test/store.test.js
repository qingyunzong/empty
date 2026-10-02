import test from 'node:test';
import assert from 'node:assert/strict';
import { MvccStore, StoreError } from '../src/store.js';

test('acceptance 1: correction appends a version; old snapshot reads alarm, new snapshot reads reset; both indexes agree', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'dev-1', validAt: 100, data: { state: 'alarm' } });
  const oldSnap = s.snapshot();
  s.correct('A', { data: { state: 'reset' } });
  const newSnap = s.snapshot();

  assert.equal(oldSnap.get('A').data.state, 'alarm');
  assert.equal(newSnap.get('A').data.state, 'reset');

  const oldRange = oldSnap.range('dev-1', 0, 1000);
  const newRange = newSnap.range('dev-1', 0, 1000);
  assert.equal(oldRange.length, 1);
  assert.equal(newRange.length, 1);
  assert.equal(oldRange[0].data.state, 'alarm');
  assert.equal(newRange[0].data.state, 'reset');

  assert.equal(oldRange[0].txAt, oldSnap.get('A').txAt);
  assert.equal(newRange[0].txAt, newSnap.get('A').txAt);
  assert.ok(oldSnap.get('A').txAt < newSnap.get('A').txAt);
});

test('correction never overwrites history: full chain stays readable via snapshots', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 10, data: { n: 1 } });
  const s1 = s.snapshot();
  s.correct('A', { data: { n: 2 } });
  const s2 = s.snapshot();
  s.correct('A', { data: { n: 3 } });
  const s3 = s.snapshot();

  assert.equal(s1.get('A').data.n, 1);
  assert.equal(s2.get('A').data.n, 2);
  assert.equal(s3.get('A').data.n, 3);
});

test('index migration: validAt moved to a new time moves the event between ranges', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 100, data: { state: 'alarm' } });
  const oldSnap = s.snapshot();
  s.correct('A', { validAt: 500 });
  const newSnap = s.snapshot();

  assert.equal(newSnap.range('d1', 0, 200).length, 0);
  assert.equal(newSnap.range('d1', 400, 600).length, 1);
  assert.equal(newSnap.range('d1', 400, 600)[0].validAt, 500);

  assert.equal(oldSnap.range('d1', 0, 200).length, 1);
  assert.equal(oldSnap.range('d1', 400, 600).length, 0);
});

test('index migration: deviceId change moves the event between device indexes', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 100 });
  const oldSnap = s.snapshot();
  s.correct('A', { deviceId: 'd2' });
  const newSnap = s.snapshot();

  assert.equal(newSnap.range('d1', 0, 1000).length, 0);
  assert.equal(newSnap.range('d2', 0, 1000).length, 1);
  assert.equal(oldSnap.range('d1', 0, 1000).length, 1);
  assert.equal(oldSnap.range('d2', 0, 1000).length, 0);
});

test('acceptance 2: tombstone delete; old snapshot still reads history by eventId, new snapshot range excludes it; duplicate create returns E_DUP', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 100, data: { state: 'alarm' } });

  assert.throws(() => s.insert({ eventId: 'A', deviceId: 'd1', validAt: 200 }), (err) => {
    assert.ok(err instanceof StoreError);
    assert.equal(err.code, 'E_DUP');
    return true;
  });

  const oldSnap = s.snapshot();
  s.delete('A');
  const newSnap = s.snapshot();

  const historical = oldSnap.get('A');
  assert.ok(historical);
  assert.equal(historical.data.state, 'alarm');
  assert.equal(oldSnap.range('d1', 0, 1000).length, 1);

  assert.equal(newSnap.get('A'), null);
  assert.deepEqual(newSnap.range('d1', 0, 1000), []);

  assert.throws(() => s.delete('A'), (err) => err.code === 'E_NOENT');
  assert.throws(() => s.correct('A', { data: 1 }), (err) => err.code === 'E_NOENT');
  assert.throws(() => s.delete('missing'), (err) => err.code === 'E_NOENT');
});

test('re-create after delete is allowed and appends a new version', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 100, data: { n: 1 } });
  const s1 = s.snapshot();
  s.delete('A');
  const s2 = s.snapshot();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 300, data: { n: 2 } });
  const s3 = s.snapshot();

  assert.equal(s1.get('A').data.n, 1);
  assert.equal(s2.get('A'), null);
  assert.equal(s3.get('A').data.n, 2);
  assert.equal(s3.range('d1', 0, 200).length, 0);
  assert.equal(s3.range('d1', 200, 400).length, 1);
  assert.equal(s1.range('d1', 0, 200).length, 1);
});

test('empty range returns an empty array', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'A', deviceId: 'd1', validAt: 100 });
  assert.deepEqual(s.range('d1', 200, 100), []);
  assert.deepEqual(s.range('d1', 101, 100), []);
  assert.deepEqual(s.range('unknown-device', 0, 1000), []);
  assert.equal(s.range('d1', 100, 100).length, 1);
});

test('out-of-order arrival: commit order (txAt), not validAt, drives visibility', () => {
  const s = new MvccStore();
  s.insert({ eventId: 'late', deviceId: 'd1', validAt: 10, data: { n: 'committed-1st' } });
  const snap = s.snapshot();
  s.insert({ eventId: 'early', deviceId: 'd1', validAt: 5, data: { n: 'committed-2nd' } });

  assert.deepEqual(snap.range('d1', 0, 100).map((e) => e.eventId), ['late']);
  assert.deepEqual(s.range('d1', 0, 100).map((e) => e.eventId), ['early', 'late']);
});

test('input validation raises E_INVAL', () => {
  const s = new MvccStore();
  assert.throws(() => s.insert({ eventId: '', deviceId: 'd1', validAt: 1 }), (e) => e.code === 'E_INVAL');
  assert.throws(() => s.insert({ eventId: 'A', deviceId: 'd1', validAt: NaN }), (e) => e.code === 'E_INVAL');
  assert.throws(() => s.insert(null), (e) => e.code === 'E_INVAL');
});
