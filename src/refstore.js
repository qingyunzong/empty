'use strict';

// Naive reference implementation used as the executable specification in the
// enumeration tests: plain arrays, a deep-copied snapshot per transaction,
// and predicate re-checks against the committed array at the commit point.
// It mirrors the semantics of src/store.js without any MVCC machinery.

class RefError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'RefError';
    this.code = code;
  }
}

class RefStore {
  constructor() {
    this.seq = 0;
    this.txCounter = 0;
    this.alarms = []; // committed alarms: { id, deviceId, alarmTime, state }
    this.acks = []; // committed ack records
  }

  begin() {
    const snapshot = this.alarms.map((a) => ({ ...a }));
    return new RefTxn(this, ++this.txCounter, snapshot);
  }

  dumpAlarms() {
    return this.alarms
      .map((a) => ({ ...a }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  dumpAcks() {
    return this.acks.map((a) => ({ ...a }));
  }
}

class RefTxn {
  constructor(store, id, snapshot) {
    this.store = store;
    this.id = id;
    this.snapshot = snapshot;
    this.status = 'active';
    this.inserts = []; // my pending inserts
    this.ackedIds = new Set(); // alarms I acknowledged
    this.pendingAcks = [];
    this.predicates = [];
  }

  _assertActive() {
    if (this.status !== 'active') {
      throw new RefError('E_TXN_CLOSED', `transaction ${this.id} is ${this.status}`);
    }
  }

  _view() {
    const map = new Map();
    for (const a of this.snapshot) map.set(a.id, { ...a });
    for (const a of this.inserts) map.set(a.id, { ...a });
    for (const id of this.ackedIds) {
      const a = map.get(id);
      if (a) a.state = 'acked';
    }
    return [...map.values()];
  }

  insertAlarm(fields) {
    this._assertActive();
    const state = fields.state === undefined ? 'unacked' : fields.state;
    if (
      this.store.alarms.some((a) => a.id === fields.id) ||
      this.inserts.some((a) => a.id === fields.id)
    ) {
      throw new RefError('E_DUP_ID', `alarm id "${fields.id}" already exists`);
    }
    this.inserts.push({
      id: fields.id,
      deviceId: fields.deviceId,
      alarmTime: fields.alarmTime,
      state,
    });
    return { id: fields.id };
  }

  ackWindow({ deviceId, from, to, by, at, note = '' }) {
    this._assertActive();
    const ids = this._view()
      .filter(
        (a) =>
          a.deviceId === deviceId &&
          a.state === 'unacked' &&
          a.alarmTime >= from &&
          a.alarmTime <= to,
      )
      .map((a) => a.id)
      .sort();
    this.predicates.push({ deviceId, from, to, scannedIds: ids });
    const view = this._view();
    for (const id of ids) {
      this.ackedIds.add(id);
      const a = view.find((x) => x.id === id);
      this.pendingAcks.push({
        alarmId: id,
        deviceId: a.deviceId,
        alarmTime: a.alarmTime,
        by,
        at,
        note,
      });
    }
    return { count: ids.length };
  }

  commit() {
    this._assertActive();
    const myIds = new Set(this.inserts.map((a) => a.id));
    for (const p of this.predicates) {
      const nowIds = this.store.alarms
        .filter(
          (a) =>
            a.deviceId === p.deviceId &&
            a.state === 'unacked' &&
            a.alarmTime >= p.from &&
            a.alarmTime <= p.to,
        )
        .map((a) => a.id);
      const nowSet = new Set(nowIds);
      const scanned = new Set(p.scannedIds);
      let phantom = nowIds.some((id) => !scanned.has(id));
      if (!phantom) {
        phantom = p.scannedIds.some((id) => !myIds.has(id) && !nowSet.has(id));
      }
      if (phantom) {
        this.status = 'aborted';
        this.inserts.length = 0;
        this.pendingAcks.length = 0;
        throw new RefError(
          'E_PHANTOM',
          `concurrent change in window [${p.from}, ${p.to}] on device "${p.deviceId}"`,
        );
      }
    }
    const seq = ++this.store.seq;
    for (const a of this.inserts) this.store.alarms.push({ ...a });
    for (const id of this.ackedIds) {
      const a = this.store.alarms.find((x) => x.id === id);
      if (a) a.state = 'acked';
    }
    for (const ack of this.pendingAcks) this.store.acks.push({ ...ack, seq });
    this.status = 'committed';
    return { ok: true, seq };
  }

  rollback() {
    this._assertActive();
    this.inserts.length = 0;
    this.ackedIds.clear();
    this.pendingAcks.length = 0;
    this.status = 'aborted';
    return { ok: true };
  }
}

module.exports = { RefStore, RefTxn, RefError };
