import test from 'node:test';
import assert from 'node:assert/strict';
import { AlarmStore } from '../src/store.js';

// ---------------------------------------------------------------------------
// Naive reference model: plain arrays, no MVCC. A txn copies the committed
// array at begin; at commit time it re-checks its predicates against the
// current committed array (and concurrent committed txns' predicates against
// its own inserts). This is the specification oracle for acceptance 3.
// ---------------------------------------------------------------------------
class RefStore {
  constructor() {
    this.alarms = []; // committed rows: {id, deviceId, alarmTime, state, ackedBy, ackedAt, note, commitOrder}
    this.ackLog = [];
    this.committedTxns = [];
    this.clock = 0;
    this.nextAlarmId = 1;
    this.nextRecordId = 1;
  }

  begin() {
    return new RefTxn(this);
  }

  insertAlarm(data) {
    const txn = this.begin();
    const id = txn.insertAlarm(data);
    txn.commit();
    return id;
  }
}

class RefTxn {
  constructor(store) {
    this.store = store;
    this.snapshotOrder = store.clock;
    this.snapshot = store.alarms.map((a) => ({ ...a }));
    this.locks = [];
    this.inserts = [];
    this.updates = new Map(); // alarmId -> fields
    this.records = [];
    this.state = 'active';
  }

  insertAlarm({ deviceId, alarmTime, state = 'unacked' }) {
    const alarm = { id: this.store.nextAlarmId++, deviceId, alarmTime, state, ackedBy: null, ackedAt: null, note: null };
    this.inserts.push(alarm);
    return alarm.id;
  }

  ackWindow(deviceId, start, end, { by = null, at = null, note = null } = {}) {
    this.locks.push({ deviceId, start, end });
    let count = 0;
    for (const a of [...this.snapshot, ...this.inserts]) {
      if (a.deviceId !== deviceId || a.alarmTime < start || a.alarmTime > end) continue;
      const cur = this.updates.has(a.id) ? { ...a, ...this.updates.get(a.id) } : a;
      if (cur.state !== 'unacked') continue;
      this.updates.set(a.id, { state: 'acked', ackedBy: by, ackedAt: at, note });
      this.records.push({
        recordId: this.store.nextRecordId++,
        alarmId: a.id,
        deviceId: a.deviceId,
        alarmTime: a.alarmTime,
        ackedBy: by,
        ackedAt: at,
        note,
      });
      count++;
    }
    return count;
  }

  commit() {
    const store = this.store;
    for (const other of store.committedTxns) {
      if (other.commitOrder <= this.snapshotOrder) continue;
      // (a) re-check my predicates against the committed array at commit point
      for (const lock of this.locks) {
        for (const a of store.alarms) {
          if (
            a.commitOrder > this.snapshotOrder &&
            a.state === 'unacked' &&
            a.deviceId === lock.deviceId &&
            a.alarmTime >= lock.start &&
            a.alarmTime <= lock.end
          ) {
            this.#fail('E_PHANTOM');
          }
        }
      }
      // (b) re-check my pending inserts against the other txn's predicates
      for (const ins of this.inserts) {
        const finalState = this.updates.get(ins.id)?.state ?? ins.state;
        if (finalState !== 'unacked') continue;
        for (const lock of other.locks) {
          if (ins.deviceId === lock.deviceId && ins.alarmTime >= lock.start && ins.alarmTime <= lock.end) {
            this.#fail('E_PHANTOM');
          }
        }
      }
      // (c) write-write conflict
      for (const id of this.updates.keys()) {
        if (this.inserts.some((i) => i.id === id)) continue;
        if (other.updateIds.includes(id)) this.#fail('E_CONFLICT');
      }
    }
    const order = ++store.clock;
    for (const ins of this.inserts) {
      const u = this.updates.get(ins.id);
      store.alarms.push({ ...ins, ...(u ?? {}), commitOrder: order });
    }
    for (const [id, u] of this.updates) {
      if (this.inserts.some((i) => i.id === id)) continue;
      Object.assign(store.alarms.find((a) => a.id === id), u);
    }
    for (const r of this.records) store.ackLog.push({ ...r, commitOrder: order });
    this.commitOrder = order;
    this.updateIds = [...this.updates.keys()].filter((id) => !this.inserts.some((i) => i.id === id));
    store.committedTxns.push(this);
    this.state = 'committed';
  }

  rollback() {
    this.state = 'rolledback';
  }

  #fail(code) {
    this.state = 'rolledback';
    const e = new Error(code);
    e.code = code;
    throw e;
  }
}

// ---------------------------------------------------------------------------
// History enumeration: <= 4 seeded alarms, 2 transactions, all interleavings.
// ---------------------------------------------------------------------------
const WINDOWS = {
  w0: { deviceId: 'A', start: 0, end: 10 },
  w1: { deviceId: 'A', start: 5, end: 15 },
  w2: { deviceId: 'B', start: 0, end: 10 },
  w3: { deviceId: 'A', start: 20, end: 30 }, // empty window
};

const SEEDS = [
  [],
  [{ d: 'A', t: 5 }],
  [{ d: 'A', t: 5 }, { d: 'A', t: 8 }],
  [{ d: 'A', t: 5 }, { d: 'B', t: 5 }],
  [{ d: 'A', t: 1 }, { d: 'A', t: 5 }, { d: 'A', t: 9 }, { d: 'B', t: 12 }],
  [{ d: 'A', t: 0 }, { d: 'A', t: 10 }, { d: 'B', t: 5 }, { d: 'B', t: 15 }],
];

const T1_SCRIPTS = [
  [{ op: 'ack', w: 'w0' }, { op: 'commit' }],
  [{ op: 'ack', w: 'w1' }, { op: 'commit' }],
  [{ op: 'ack', w: 'w0' }, { op: 'ack', w: 'w0' }, { op: 'commit' }],
  [{ op: 'ack', w: 'w0' }, { op: 'rollback' }],
  [{ op: 'ack', w: 'w2' }, { op: 'commit' }],
  [{ op: 'ack', w: 'w0' }, { op: 'ack', w: 'w3' }, { op: 'commit' }],
];

const T2_SCRIPTS = [
  [{ op: 'insert', d: 'A', t: 5 }, { op: 'commit' }],
  [{ op: 'insert', d: 'A', t: 12 }, { op: 'commit' }],
  [{ op: 'insert', d: 'B', t: 5 }, { op: 'commit' }],
  [{ op: 'ack', w: 'w0' }, { op: 'commit' }],
  [{ op: 'insert', d: 'A', t: 5 }, { op: 'rollback' }],
  [{ op: 'insert', d: 'A', t: 5 }, { op: 'insert', d: 'B', t: 7 }, { op: 'commit' }],
  [{ op: 'insert', d: 'A', t: 6 }, { op: 'ack', w: 'w1' }, { op: 'commit' }],
];

function* interleavings(a, b) {
  if (a.length === 0) {
    yield [...b];
    return;
  }
  if (b.length === 0) {
    yield [...a];
    return;
  }
  for (const rest of interleavings(a.slice(1), b)) yield [a[0], ...rest];
  for (const rest of interleavings(a, b.slice(1))) yield [b[0], ...rest];
}

function runHistory(StoreClass, seeds, history) {
  const store = new StoreClass();
  for (const s of seeds) store.insertAlarm({ deviceId: s.d, alarmTime: s.t });
  const handles = [null, null];
  const results = [];
  for (const step of history) {
    let r;
    try {
      switch (step.op) {
        case 'begin':
          handles[step.txn] = store.begin();
          r = { ok: true };
          break;
        case 'ack': {
          const w = WINDOWS[step.w];
          const count = handles[step.txn].ackWindow(w.deviceId, w.start, w.end, {
            by: `user-${step.txn}`,
            at: `2026-10-04T00:00:0${step.txn}.000Z`,
            note: `note-${step.txn}`,
          });
          r = { ok: true, count };
          break;
        }
        case 'insert':
          handles[step.txn].insertAlarm({ deviceId: step.d, alarmTime: step.t });
          r = { ok: true };
          break;
        case 'commit':
          handles[step.txn].commit();
          r = { ok: true };
          break;
        case 'rollback':
          handles[step.txn].rollback();
          r = { ok: true };
          break;
        default:
          throw new Error(`bad step ${step.op}`);
      }
    } catch (e) {
      r = { ok: false, code: e.code };
    }
    results.push(r);
  }
  return { store, results };
}

function realState(store) {
  return {
    alarms: store.list(),
    records: store.ackRecords().map((r) => ({
      recordId: r.recordId,
      alarmId: r.alarmId,
      deviceId: r.deviceId,
      alarmTime: r.alarmTime,
      ackedBy: r.ackedBy,
      ackedAt: r.ackedAt,
      note: r.note,
    })),
  };
}

function refState(store) {
  return {
    alarms: store.alarms
      .map((a) => ({
        id: a.id,
        deviceId: a.deviceId,
        alarmTime: a.alarmTime,
        state: a.state,
        ackedBy: a.ackedBy,
        ackedAt: a.ackedAt,
        note: a.note,
      }))
      .sort((x, y) => x.id - y.id),
    records: store.ackLog.map((r) => ({
      recordId: r.recordId,
      alarmId: r.alarmId,
      deviceId: r.deviceId,
      alarmTime: r.alarmTime,
      ackedBy: r.ackedBy,
      ackedAt: r.ackedAt,
      note: r.note,
    })),
  };
}

function checkInvariants(store) {
  const records = store.ackRecords();
  const ids = records.map((r) => r.alarmId);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ack records in ack log');
  const alarms = store.list();
  for (const a of alarms) {
    if (a.state === 'acked') {
      assert.equal(ids.filter((id) => id === a.id).length, 1, `acked alarm ${a.id} must have exactly one record`);
    }
  }
  for (const r of records) {
    const alarm = alarms.find((a) => a.id === r.alarmId);
    assert.ok(alarm, `record ${r.recordId} references missing alarm ${r.alarmId}`);
    assert.equal(alarm.state, 'acked');
  }
}

test('acceptance 3: exhaustive 2-transaction histories match the naive reference', (t) => {
  let runs = 0;
  for (const seeds of SEEDS) {
    for (const s1 of T1_SCRIPTS) {
      for (const s2 of T2_SCRIPTS) {
        const a = [{ op: 'begin', txn: 0 }, ...s1.map((o) => ({ ...o, txn: 0 }))];
        const b = [{ op: 'begin', txn: 1 }, ...s2.map((o) => ({ ...o, txn: 1 }))];
        for (const history of interleavings(a, b)) {
          runs++;
          const real = runHistory(AlarmStore, seeds, history);
          const ref = runHistory(RefStore, seeds, history);
          const ctx = JSON.stringify({ seeds, history });
          assert.deepStrictEqual(real.results, ref.results, `op results diverge: ${ctx}`);
          assert.deepStrictEqual(realState(real.store), refState(ref.store), `final state diverges: ${ctx}`);
          checkInvariants(real.store);
        }
      }
    }
  }
  t.diagnostic(`executed ${runs} enumerated histories`);
  assert.ok(runs > 1000, `expected substantial enumeration, got ${runs}`);
});
