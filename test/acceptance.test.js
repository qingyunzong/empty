import test from 'node:test';
import assert from 'node:assert/strict';
import {
  AlarmStore,
  E_PHANTOM,
  E_CONFLICT,
  E_TXN_STATE,
  E_VALIDATION,
} from '../src/store.js';

const AT = '2026-10-04T00:00:00.000Z';

function seedThree() {
  const store = new AlarmStore();
  store.insertAlarm({ deviceId: 'dev-1', alarmTime: 10 });
  store.insertAlarm({ deviceId: 'dev-1', alarmTime: 20 });
  store.insertAlarm({ deviceId: 'dev-1', alarmTime: 30 });
  return store;
}

test('acceptance 1: window ack confirms 3 alarms with operator/time/note', () => {
  const store = seedThree();
  const txn = store.begin();
  const count = txn.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT, note: 'night-shift batch' });
  assert.equal(count, 3);
  txn.commit();

  const alarms = store.list('dev-1');
  assert.equal(alarms.length, 3);
  for (const a of alarms) {
    assert.equal(a.state, 'acked');
    assert.equal(a.ackedBy, 'alice');
    assert.equal(a.ackedAt, AT);
    assert.equal(a.note, 'night-shift batch');
  }
  const records = store.ackRecords();
  assert.equal(records.length, 3);
  assert.deepEqual(
    records.map((r) => [r.alarmId, r.ackedBy, r.ackedAt, r.note]),
    [[1, 'alice', AT, 'night-shift batch'], [2, 'alice', AT, 'night-shift batch'], [3, 'alice', AT, 'night-shift batch']],
  );
});

test('acceptance 1: repeated ack returns 0 and creates no duplicate records', () => {
  const store = seedThree();
  const t1 = store.begin();
  assert.equal(t1.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT }), 3);
  t1.commit();

  const t2 = store.begin();
  assert.equal(t2.ackWindow('dev-1', 0, 100, { by: 'bob', at: AT }), 0);
  t2.commit();

  assert.equal(store.ackRecords().length, 3);
  const ids = store.ackRecords().map((r) => r.alarmId);
  assert.equal(new Set(ids).size, ids.length);
  assert.equal(store.list().every((a) => a.ackedBy === 'alice'), true);
});

test('acceptance 1: empty window ack is a legal no-op returning count=0', () => {
  const store = seedThree();
  const txn = store.begin();
  assert.equal(txn.ackWindow('dev-1', 1000, 2000, { by: 'alice', at: AT }), 0);
  txn.commit();
  assert.equal(store.list().every((a) => a.state === 'unacked'), true);
  assert.equal(store.ackRecords().length, 0);
});

test('acceptance 2: concurrent insert into scanned window -> exactly one committer gets E_PHANTOM', () => {
  for (const order of ['scanner-first', 'inserter-first']) {
    const store = seedThree();
    const scanner = store.begin();
    assert.equal(scanner.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT }), 3);
    const inserter = store.begin();
    inserter.insertAlarm({ deviceId: 'dev-1', alarmTime: 50 });

    const outcome = {};
    const commit = (name, txn) => {
      try {
        txn.commit();
        outcome[name] = 'ok';
      } catch (e) {
        outcome[name] = e.code;
      }
    };
    if (order === 'scanner-first') {
      commit('scanner', scanner);
      commit('inserter', inserter);
    } else {
      commit('inserter', inserter);
      commit('scanner', scanner);
    }
    assert.deepEqual(Object.values(outcome).sort(), [E_PHANTOM, 'ok'], `order=${order}`);
  }
});

test('acceptance 2: different device does not conflict', () => {
  const store = seedThree();
  const scanner = store.begin();
  scanner.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT });
  const inserter = store.begin();
  inserter.insertAlarm({ deviceId: 'dev-2', alarmTime: 50 });
  scanner.commit();
  inserter.commit();
  assert.equal(store.list().length, 4);
});

test('acceptance 2: disjoint window does not conflict', () => {
  const store = seedThree();
  const scanner = store.begin();
  scanner.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT });
  const inserter = store.begin();
  inserter.insertAlarm({ deviceId: 'dev-1', alarmTime: 500 });
  scanner.commit();
  inserter.commit();
  assert.equal(store.list().length, 4);
});

test('acceptance 2: phantom abort rolls back the loser cleanly', () => {
  const store = seedThree();
  const scanner = store.begin();
  scanner.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT });
  const inserter = store.begin();
  inserter.insertAlarm({ deviceId: 'dev-1', alarmTime: 50 });
  scanner.commit();
  assert.throws(() => inserter.commit(), (e) => e.code === E_PHANTOM);
  // inserter rolled back: its alarm is gone, no stray records
  assert.equal(store.list().length, 3);
  assert.equal(store.ackRecords().length, 3);
  assert.equal(store.list().every((a) => a.state === 'acked'), true);
});

test('rollback restores original alarm states and leaves no ack records', () => {
  const store = seedThree();
  const txn = store.begin();
  assert.equal(txn.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT }), 3);
  assert.equal(txn.undoLog.length, 6); // 3 updates + 3 ack records
  txn.rollback();
  assert.equal(txn.undoLog.length, 0);
  assert.equal(store.list().every((a) => a.state === 'unacked'), true);
  assert.equal(store.ackRecords().length, 0);

  const t2 = store.begin();
  t2.insertAlarm({ deviceId: 'dev-1', alarmTime: 40 });
  t2.rollback();
  assert.equal(store.list().length, 3);

  assert.throws(() => txn.rollback(), (e) => e.code === E_TXN_STATE);
  assert.throws(() => txn.commit(), (e) => e.code === E_TXN_STATE);
});

test('concurrent ack of the same alarm -> E_CONFLICT for the second committer', () => {
  const store = seedThree();
  const t1 = store.begin();
  t1.ackWindow('dev-1', 0, 15, { by: 'a', at: AT });
  const t2 = store.begin();
  t2.ackWindow('dev-1', 0, 15, { by: 'b', at: AT });
  t1.commit();
  assert.throws(() => t2.commit(), (e) => e.code === E_CONFLICT);
  assert.equal(store.ackRecords().length, 1);
  assert.equal(store.list()[0].ackedBy, 'a');
});

test('snapshot isolation: txn does not see alarms committed after its begin', () => {
  const store = seedThree();
  const t1 = store.begin();
  store.insertAlarm({ deviceId: 'dev-1', alarmTime: 40 }); // autocommit after t1 began
  assert.equal(t1.ackWindow('dev-1', 0, 100, { by: 'alice', at: AT }), 3);
  assert.throws(() => t1.commit(), (e) => e.code === E_PHANTOM);
  // the concurrently inserted alarm is still unacked and visible to fresh txns
  const t2 = store.begin();
  assert.equal(t2.ackWindow('dev-1', 0, 100, { by: 'bob', at: AT }), 4);
  t2.commit();
  assert.equal(store.ackRecords().length, 4);
});

test('validation rejects bad input', () => {
  const store = new AlarmStore();
  assert.throws(() => store.insertAlarm({ deviceId: '', alarmTime: 1 }), (e) => e.code === E_VALIDATION);
  assert.throws(() => store.insertAlarm({ deviceId: 'd', alarmTime: NaN }), (e) => e.code === E_VALIDATION);
  const txn = store.begin();
  assert.throws(() => txn.ackWindow('d', 10, 5), (e) => e.code === E_VALIDATION);
  txn.rollback();
});
