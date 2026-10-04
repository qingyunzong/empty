export const E_PHANTOM = 'E_PHANTOM';
export const E_CONFLICT = 'E_CONFLICT';
export const E_TXN_STATE = 'E_TXN_STATE';
export const E_VALIDATION = 'E_VALIDATION';

export const UNACKED = 'unacked';
export const ACKED = 'acked';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

function validateDeviceId(deviceId) {
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    throw new StoreError(E_VALIDATION, 'deviceId must be a non-empty string');
  }
}

function validateAlarmTime(alarmTime) {
  if (!isFiniteNumber(alarmTime)) {
    throw new StoreError(E_VALIDATION, 'alarmTime must be a finite number');
  }
}

function validateWindow(start, end) {
  if (!isFiniteNumber(start) || !isFiniteNumber(end) || start > end) {
    throw new StoreError(E_VALIDATION, `invalid window [${String(start)}, ${String(end)}]`);
  }
}

function inWindow(alarmTime, start, end) {
  return alarmTime >= start && alarmTime <= end;
}

export class AlarmStore {
  constructor() {
    this.commitSeq = 0;
    this.nextAlarmId = 1;
    this.nextTxnId = 1;
    this.nextRecordId = 1;
    this.alarms = new Map(); // id -> { id, deviceId, alarmTime, versions: [{commitSeq, state, ackedBy, ackedAt, note}] }
    this.predicateIndex = new Map(); // deviceId -> sorted [{alarmTime, alarmId, state}] on committed rows
    this.ackLog = []; // committed acknowledgment records
    this.committedTxns = []; // { txnId, commitSeq, inserts, predicateLocks, updates }
    this.activeTxns = new Map();
  }

  begin() {
    const txn = new Txn(this);
    this.activeTxns.set(txn.txnId, txn);
    return txn;
  }

  insertAlarm(data) {
    const txn = this.begin();
    const id = txn.insertAlarm(data);
    txn.commit();
    return id;
  }

  ackWindow(deviceId, start, end, opts) {
    const txn = this.begin();
    const count = txn.ackWindow(deviceId, start, end, opts);
    txn.commit();
    return count;
  }

  scanIndex(deviceId, start, end) {
    const entries = this.predicateIndex.get(deviceId) ?? [];
    const matched = [];
    for (const entry of entries) {
      if (inWindow(entry.alarmTime, start, end)) matched.push(entry);
    }
    return matched;
  }

  list(deviceId = null) {
    const rows = [];
    for (const alarm of this.alarms.values()) {
      if (deviceId !== null && alarm.deviceId !== deviceId) continue;
      const v = alarm.versions[alarm.versions.length - 1];
      rows.push({
        id: alarm.id,
        deviceId: alarm.deviceId,
        alarmTime: alarm.alarmTime,
        state: v.state,
        ackedBy: v.ackedBy,
        ackedAt: v.ackedAt,
        note: v.note,
      });
    }
    rows.sort((a, b) => a.id - b.id);
    return rows;
  }

  ackRecords() {
    return this.ackLog.map((r) => ({ ...r }));
  }

  _indexInsert(alarm, state) {
    let entries = this.predicateIndex.get(alarm.deviceId);
    if (!entries) {
      entries = [];
      this.predicateIndex.set(alarm.deviceId, entries);
    }
    let lo = 0;
    let hi = entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      const e = entries[mid];
      if (e.alarmTime < alarm.alarmTime || (e.alarmTime === alarm.alarmTime && e.alarmId < alarm.id)) lo = mid + 1;
      else hi = mid;
    }
    entries.splice(lo, 0, { alarmTime: alarm.alarmTime, alarmId: alarm.id, state });
  }

  _indexUpdateState(alarmId, deviceId, state) {
    const entries = this.predicateIndex.get(deviceId);
    if (!entries) return;
    const entry = entries.find((e) => e.alarmId === alarmId);
    if (entry) entry.state = state;
  }
}

export class Txn {
  constructor(store) {
    this.store = store;
    this.txnId = store.nextTxnId++;
    this.snapshotSeq = store.commitSeq;
    this.state = 'active';
    this.localUpdates = new Map(); // alarmId -> pending version {state, ackedBy, ackedAt, note}
    this.insertedAlarms = new Map(); // alarmId -> uncommitted alarm owned by this txn
    this.inserts = []; // { alarmId, deviceId, alarmTime, state }
    this.predicateLocks = []; // SIREAD locks: { deviceId, start, end } on state=unacked
    this.pendingAckRecords = [];
    this.undoLog = [];
  }

  insertAlarm({ deviceId, alarmTime, state = UNACKED }) {
    this.#assertActive();
    validateDeviceId(deviceId);
    validateAlarmTime(alarmTime);
    if (state !== UNACKED && state !== ACKED) {
      throw new StoreError(E_VALIDATION, `invalid state: ${String(state)}`);
    }
    const id = this.store.nextAlarmId++;
    const alarm = {
      id,
      deviceId,
      alarmTime,
      versions: [{ commitSeq: null, state, ackedBy: null, ackedAt: null, note: null }],
    };
    this.insertedAlarms.set(id, alarm);
    this.inserts.push({ alarmId: id, deviceId, alarmTime, state });
    this.undoLog.push({ type: 'insert', alarmId: id });
    return id;
  }

  ackWindow(deviceId, start, end, { by = null, at = null, note = null } = {}) {
    this.#assertActive();
    validateDeviceId(deviceId);
    validateWindow(start, end);
    this.predicateLocks.push({ deviceId, start, end });
    const ackedAt = at ?? new Date().toISOString();
    const candidates = [];
    for (const alarm of this.insertedAlarms.values()) {
      if (alarm.deviceId === deviceId && inWindow(alarm.alarmTime, start, end)) candidates.push(alarm);
    }
    for (const entry of this.store.scanIndex(deviceId, start, end)) {
      candidates.push(this.store.alarms.get(entry.alarmId));
    }
    candidates.sort((a, b) => a.id - b.id);
    let count = 0;
    for (const alarm of candidates) {
      const visible = this.#visibleVersion(alarm);
      if (!visible || visible.state !== UNACKED) continue;
      this.localUpdates.set(alarm.id, { state: ACKED, ackedBy: by, ackedAt, note });
      const record = {
        recordId: this.store.nextRecordId++,
        alarmId: alarm.id,
        deviceId: alarm.deviceId,
        alarmTime: alarm.alarmTime,
        ackedBy: by,
        ackedAt,
        note,
        txnId: this.txnId,
      };
      this.pendingAckRecords.push(record);
      this.undoLog.push({ type: 'update', alarmId: alarm.id });
      this.undoLog.push({ type: 'ackRecord', recordId: record.recordId });
      count++;
    }
    return count;
  }

  commit() {
    this.#assertActive();
    const store = this.store;
    for (const other of store.committedTxns) {
      if (other.commitSeq <= this.snapshotSeq) continue; // visible in our snapshot
      // (a) rows committed after our snapshot must not match our predicate locks
      for (const ins of other.inserts) {
        const alarm = store.alarms.get(ins.alarmId);
        const current = alarm.versions[alarm.versions.length - 1];
        if (current.state !== UNACKED) continue;
        for (const lock of this.predicateLocks) {
          if (ins.deviceId === lock.deviceId && inWindow(ins.alarmTime, lock.start, lock.end)) {
            this.#abortWith(E_PHANTOM, `phantom: alarm ${ins.alarmId} (committed by txn ${other.txnId}) matches predicate (${lock.deviceId}, [${lock.start}, ${lock.end}], unacked) read by txn ${this.txnId}`);
          }
        }
      }
      // (b) our own unacked inserts must not match predicate locks of a concurrent committed txn
      for (const ins of this.inserts) {
        const override = this.localUpdates.get(ins.alarmId);
        const finalState = override ? override.state : ins.state;
        if (finalState !== UNACKED) continue;
        for (const lock of other.predicateLocks) {
          if (ins.deviceId === lock.deviceId && inWindow(ins.alarmTime, lock.start, lock.end)) {
            this.#abortWith(E_PHANTOM, `phantom: alarm ${ins.alarmId} inserted by txn ${this.txnId} matches predicate (${lock.deviceId}, [${lock.start}, ${lock.end}], unacked) of committed txn ${other.txnId}`);
          }
        }
      }
      // (c) write-write conflict on the same alarm
      for (const id of this.localUpdates.keys()) {
        if (this.insertedAlarms.has(id)) continue;
        if (other.updates.includes(id)) {
          this.#abortWith(E_CONFLICT, `write-write conflict on alarm ${id} with committed txn ${other.txnId}`);
        }
      }
    }
    const seq = ++store.commitSeq;
    for (const ins of this.inserts) {
      const alarm = this.insertedAlarms.get(ins.alarmId);
      const override = this.localUpdates.get(ins.alarmId);
      if (override) this.localUpdates.delete(ins.alarmId);
      const base = override ?? alarm.versions[0];
      alarm.versions = [{ ...base, commitSeq: seq }];
      store.alarms.set(alarm.id, alarm);
      store._indexInsert(alarm, base.state);
    }
    const updatedIds = [];
    for (const [id, v] of this.localUpdates) {
      const alarm = store.alarms.get(id);
      alarm.versions.push({ ...v, commitSeq: seq });
      store._indexUpdateState(id, alarm.deviceId, v.state);
      updatedIds.push(id);
    }
    for (const record of this.pendingAckRecords) {
      store.ackLog.push({ ...record, commitSeq: seq });
    }
    store.committedTxns.push({
      txnId: this.txnId,
      commitSeq: seq,
      inserts: this.inserts.map((i) => ({ ...i })),
      predicateLocks: this.predicateLocks.map((l) => ({ ...l })),
      updates: updatedIds,
    });
    this.state = 'committed';
    store.activeTxns.delete(this.txnId);
    return { txnId: this.txnId, commitSeq: seq };
  }

  rollback() {
    this.#assertActive();
    this.#runUndo();
    this.state = 'rolledback';
    this.store.activeTxns.delete(this.txnId);
  }

  #visibleVersion(alarm) {
    const local = this.localUpdates.get(alarm.id);
    if (local) return local;
    for (let i = alarm.versions.length - 1; i >= 0; i--) {
      const v = alarm.versions[i];
      if (v.commitSeq === null) return this.insertedAlarms.has(alarm.id) ? v : null;
      if (v.commitSeq <= this.snapshotSeq) return v;
    }
    return null;
  }

  #assertActive() {
    if (this.state !== 'active') {
      throw new StoreError(E_TXN_STATE, `txn ${this.txnId} is ${this.state}`);
    }
  }

  #abortWith(code, message) {
    this.#runUndo();
    this.state = 'rolledback';
    this.store.activeTxns.delete(this.txnId);
    throw new StoreError(code, message);
  }

  #runUndo() {
    while (this.undoLog.length > 0) {
      const entry = this.undoLog.pop();
      if (entry.type === 'insert') {
        this.insertedAlarms.delete(entry.alarmId);
        this.inserts = this.inserts.filter((i) => i.alarmId !== entry.alarmId);
      } else if (entry.type === 'update') {
        this.localUpdates.delete(entry.alarmId);
      } else if (entry.type === 'ackRecord') {
        this.pendingAckRecords = this.pendingAckRecords.filter((r) => r.recordId !== entry.recordId);
      }
    }
  }
}
