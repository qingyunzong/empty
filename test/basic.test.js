'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store, StoreError } = require('../src/store');

function seed(store, alarms) {
  const txn = store.begin();
  for (const a of alarms) txn.insertAlarm(a);
  txn.commit();
}

test('window confirm acks all unacked alarms with operator, time and note', () => {
  const store = new Store();
  seed(store, [
    { id: 'a1', deviceId: 'd1', alarmTime: 5 },
    { id: 'a2', deviceId: 'd1', alarmTime: 10 },
    { id: 'a3', deviceId: 'd1', alarmTime: 15 },
  ]);

  const txn = store.begin();
  const { count } = txn.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100, note: 'shift change' });
  txn.commit();

  assert.equal(count, 3);
  assert.deepEqual(
    store.listAlarms().map((a) => a.state),
    ['acked', 'acked', 'acked'],
  );
  const acks = store.listAcks();
  assert.equal(acks.length, 3);
  for (const ack of acks) {
    assert.equal(ack.by, 'op1');
    assert.equal(ack.at, 100);
    assert.equal(ack.note, 'shift change');
  }
  assert.deepEqual(
    acks.map((a) => a.alarmId).sort(),
    ['a1', 'a2', 'a3'],
  );
});

test('repeated confirm returns 0 and creates no duplicate ack records', () => {
  const store = new Store();
  seed(store, [
    { id: 'a1', deviceId: 'd1', alarmTime: 5 },
    { id: 'a2', deviceId: 'd1', alarmTime: 10 },
    { id: 'a3', deviceId: 'd1', alarmTime: 15 },
  ]);

  const first = store.begin();
  assert.equal(first.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100 }).count, 3);
  first.commit();

  const second = store.begin();
  assert.equal(second.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op2', at: 200 }).count, 0);
  second.commit();

  assert.equal(store.listAcks().length, 3);
  assert.ok(store.listAcks().every((a) => a.by === 'op1'));
});

test('empty window confirm is a legal no-op returning count 0', () => {
  const store = new Store();
  seed(store, [{ id: 'a1', deviceId: 'd1', alarmTime: 5 }]);

  // window covers no alarms
  const t1 = store.begin();
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 100, to: 200, by: 'op', at: 1 }).count, 0);
  t1.commit();

  // device with no alarms at all
  const t2 = store.begin();
  assert.equal(t2.ackWindow({ deviceId: 'nope', from: 0, to: 100, by: 'op', at: 2 }).count, 0);
  t2.commit();

  assert.equal(store.listAcks().length, 0);
  assert.equal(store.listAlarms()[0].state, 'unacked');
});

test('window bounds are inclusive and per-device', () => {
  const store = new Store();
  seed(store, [
    { id: 'a1', deviceId: 'd1', alarmTime: 10 },
    { id: 'a2', deviceId: 'd1', alarmTime: 20 },
    { id: 'a3', deviceId: 'd2', alarmTime: 10 },
  ]);
  const txn = store.begin();
  assert.equal(txn.ackWindow({ deviceId: 'd1', from: 10, to: 20, by: 'op', at: 1 }).count, 2);
  txn.commit();
  const byId = Object.fromEntries(store.listAlarms().map((a) => [a.id, a.state]));
  assert.deepEqual(byId, { a1: 'acked', a2: 'acked', a3: 'unacked' });
});

test('rollback restores every alarm state and leaves no ack records', () => {
  const store = new Store();
  seed(store, [
    { id: 'a1', deviceId: 'd1', alarmTime: 5 },
    { id: 'a2', deviceId: 'd1', alarmTime: 10 },
  ]);
  const before = store.listAlarms();

  const txn = store.begin();
  txn.insertAlarm({ id: 'a3', deviceId: 'd1', alarmTime: 15 });
  assert.equal(txn.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op', at: 1 }).count, 3);
  txn.rollback();

  assert.deepEqual(store.listAlarms(), before);
  assert.equal(store.listAcks().length, 0);

  // state is really usable again: a fresh confirm works on the same alarms
  const t2 = store.begin();
  assert.equal(t2.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op', at: 2 }).count, 2);
  t2.commit();
  assert.equal(store.listAcks().length, 2);
});

test('duplicate alarm id is rejected with E_DUP_ID', () => {
  const store = new Store();
  seed(store, [{ id: 'a1', deviceId: 'd1', alarmTime: 5 }]);
  const txn = store.begin();
  assert.throws(() => txn.insertAlarm({ id: 'a1', deviceId: 'd2', alarmTime: 1 }), (e) => {
    assert.equal(e.code, 'E_DUP_ID');
    return true;
  });
  txn.rollback();
});

test('operations on a closed transaction fail with E_TXN_CLOSED', () => {
  const store = new Store();
  const txn = store.begin();
  txn.commit();
  assert.throws(() => txn.insertAlarm({ id: 'x', deviceId: 'd1', alarmTime: 1 }), StoreError);
  assert.throws(() => txn.commit(), (e) => e.code === 'E_TXN_CLOSED');
  assert.throws(() => txn.rollback(), (e) => e.code === 'E_TXN_CLOSED');
});

test('invalid arguments fail with E_VALIDATION', () => {
  const store = new Store();
  const txn = store.begin();
  assert.throws(() => txn.insertAlarm({ id: '', deviceId: 'd1', alarmTime: 1 }), (e) => e.code === 'E_VALIDATION');
  assert.throws(() => txn.insertAlarm({ id: 'a', deviceId: 'd1', alarmTime: NaN }), (e) => e.code === 'E_VALIDATION');
  assert.throws(() => txn.ackWindow({ deviceId: 'd1', from: 10, to: 5, by: 'op', at: 1 }), (e) => e.code === 'E_VALIDATION');
  assert.throws(() => txn.ackWindow({ deviceId: 'd1', from: 0, to: 5, by: '', at: 1 }), (e) => e.code === 'E_VALIDATION');
  txn.rollback();
});

test('state round-trips through toJSON/fromJSON', () => {
  const store = new Store();
  seed(store, [
    { id: 'a1', deviceId: 'd1', alarmTime: 5 },
    { id: 'a2', deviceId: 'd1', alarmTime: 10 },
  ]);
  const t1 = store.begin();
  t1.ackWindow({ deviceId: 'd1', from: 0, to: 6, by: 'op', at: 1, note: 'n' });
  t1.commit();

  const restored = Store.fromJSON(JSON.parse(JSON.stringify(store)));
  assert.deepEqual(restored.toJSON(), store.toJSON());

  // the restored store keeps working: confirm the remaining alarm
  const t2 = restored.begin();
  assert.equal(t2.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op', at: 2 }).count, 1);
  t2.commit();
  assert.equal(restored.listAcks().length, 2);
});
