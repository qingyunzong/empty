'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Store } = require('../src/store');

function seed(store, alarms) {
  const txn = store.begin();
  for (const a of alarms) txn.insertAlarm(a);
  txn.commit();
}

const THREE = [
  { id: 'a1', deviceId: 'd1', alarmTime: 5 },
  { id: 'a2', deviceId: 'd1', alarmTime: 10 },
  { id: 'a3', deviceId: 'd1', alarmTime: 15 },
];

test('concurrent insert into the scanned window aborts the confirmer with E_PHANTOM', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100 }).count, 3);

  const t2 = store.begin();
  t2.insertAlarm({ id: 'a4', deviceId: 'd1', alarmTime: 12 });
  t2.commit();

  assert.throws(() => t1.commit(), (e) => {
    assert.equal(e.code, 'E_PHANTOM');
    return true;
  });

  // t1 was rolled back: nothing acked, no ack records, t2's insert survives.
  assert.deepEqual(
    store.listAlarms().map((a) => [a.id, a.state]),
    [['a1', 'unacked'], ['a2', 'unacked'], ['a3', 'unacked'], ['a4', 'unacked']],
  );
  assert.equal(store.listAcks().length, 0);

  // a retry sees all four alarms and succeeds
  const t3 = store.begin();
  assert.equal(t3.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 101 }).count, 4);
  t3.commit();
  assert.equal(store.listAcks().length, 4);
});

test('insert on a different device does not conflict', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100 });

  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd2', alarmTime: 12 });
  t2.commit();

  assert.doesNotThrow(() => t1.commit());
  assert.equal(store.listAcks().length, 3);
});

test('insert outside the window does not conflict', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100 });

  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 50 });
  t2.commit();

  assert.doesNotThrow(() => t1.commit());
  assert.equal(store.listAcks().length, 3);
});

test('insert of an already-acked alarm inside the window does not conflict', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 100 });

  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 12, state: 'acked' });
  t2.commit();

  assert.doesNotThrow(() => t1.commit());
  assert.equal(store.listAcks().length, 3);
});

test('two confirmers of the same window: first commits, second gets E_PHANTOM', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  const t2 = store.begin();
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 }).count, 3);
  assert.equal(t2.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op2', at: 2 }).count, 3);

  t1.commit();
  assert.throws(() => t2.commit(), (e) => e.code === 'E_PHANTOM');

  // exactly one set of ack records, no duplicates
  assert.equal(store.listAcks().length, 3);
  assert.ok(store.listAcks().every((a) => a.by === 'op1'));
});

test('concurrent insert into an empty scanned window is still a phantom', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  // empty window: legal no-op scan
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 100, to: 200, by: 'op1', at: 1 }).count, 0);

  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 150 });
  t2.commit();

  assert.throws(() => t1.commit(), (e) => e.code === 'E_PHANTOM');
  assert.equal(store.listAcks().length, 0);
});

test('rolled-back inserter causes no phantom', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 });

  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 12 });
  t2.rollback();

  assert.doesNotThrow(() => t1.commit());
  assert.equal(store.listAlarms().length, 3);
});

test('own insert after the scan is not a phantom', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 }).count, 3);
  t1.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 12 });
  assert.doesNotThrow(() => t1.commit());
  // b1 remains unacked: it was not part of the scanned set
  const states = Object.fromEntries(store.listAlarms().map((a) => [a.id, a.state]));
  assert.equal(states.b1, 'unacked');
  assert.equal(store.listAcks().length, 3);
});

test('own insert before the scan is confirmed by it', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 12 });
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 }).count, 4);
  t1.commit();
  assert.equal(store.listAcks().length, 4);
});

test('own out-of-window insert plus an ack commits cleanly', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  t1.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 99 });
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 }).count, 3);
  assert.doesNotThrow(() => t1.commit());
  const states = Object.fromEntries(store.listAlarms().map((a) => [a.id, a.state]));
  assert.equal(states.b1, 'unacked');
  assert.equal(store.listAcks().length, 3);
});

test('snapshot isolation: a transaction does not see later committed inserts', () => {
  const store = new Store();
  seed(store, THREE);

  const t1 = store.begin();
  const t2 = store.begin();
  t2.insertAlarm({ id: 'b1', deviceId: 'd1', alarmTime: 12 });
  t2.commit();

  // t1's snapshot was taken before t2 committed: it scans only the original 3,
  // but its commit must fail rather than silently miss the new alarm.
  assert.equal(t1.ackWindow({ deviceId: 'd1', from: 0, to: 20, by: 'op1', at: 1 }).count, 3);
  assert.throws(() => t1.commit(), (e) => e.code === 'E_PHANTOM');
});
