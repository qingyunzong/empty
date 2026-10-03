'use strict';

// MVCC alarm store with snapshot isolation.
//
// - Every alarm row carries a version chain: { state, begin, end, txn }.
//   A version is committed when txn === null; [begin, end) is the commit-seq
//   range in which the version is visible. Uncommitted versions carry the
//   owning transaction id and are visible only to that transaction.
// - A predicate index on (deviceId, alarmTime, state) mirrors the versioned
//   state: index entries are versioned exactly like row versions, so both
//   snapshot scans and commit-time phantom checks are served by the index.
// - Each transaction records an undo log (撤销清单) of its mutations;
//   rollback replays it in reverse and restores every alarm's prior state.

const STATE_UNACKED = 'unacked';
const STATE_ACKED = 'acked';
const STATES = new Set([STATE_UNACKED, STATE_ACKED]);

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function isNonEmptyString(v) {
  return typeof v === 'string' && v.length > 0;
}

function isFiniteNumber(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

function byId(a, b) {
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function compareEntries(a, b) {
  if (a.alarmTime !== b.alarmTime) return a.alarmTime - b.alarmTime;
  return byId(a, b);
}

function committedLiveVersion(row) {
  for (const v of row.versions) {
    if (v.txn === null && v.end === Infinity) return v;
  }
  return null;
}

function visibleVersion(row, txn) {
  let mine = null;
  let committed = null;
  for (const v of row.versions) {
    if (v.txn !== null) {
      if (v.txn === txn.id) mine = v;
    } else if (v.begin <= txn.startSeq && txn.startSeq < v.end) {
      committed = v;
    }
  }
  return mine || committed;
}

function entryVisibleTo(e, txn) {
  if (e.txn !== null) return e.txn === txn.id;
  return e.begin <= txn.startSeq && txn.startSeq < e.end;
}

function validateAlarmFields(a) {
  if (!a || typeof a !== 'object') {
    throw new StoreError('E_VALIDATION', 'alarm must be an object');
  }
  if (!isNonEmptyString(a.id)) {
    throw new StoreError('E_VALIDATION', 'alarm.id must be a non-empty string');
  }
  if (!isNonEmptyString(a.deviceId)) {
    throw new StoreError('E_VALIDATION', 'alarm.deviceId must be a non-empty string');
  }
  if (!isFiniteNumber(a.alarmTime)) {
    throw new StoreError('E_VALIDATION', 'alarm.alarmTime must be a finite number');
  }
  if (a.state !== undefined && !STATES.has(a.state)) {
    throw new StoreError('E_VALIDATION', `alarm.state must be one of: ${[...STATES].join(', ')}`);
  }
}

function validateWindowFields(w) {
  if (!w || typeof w !== 'object') {
    throw new StoreError('E_VALIDATION', 'window must be an object');
  }
  if (!isNonEmptyString(w.deviceId)) {
    throw new StoreError('E_VALIDATION', 'deviceId must be a non-empty string');
  }
  if (!isFiniteNumber(w.from) || !isFiniteNumber(w.to)) {
    throw new StoreError('E_VALIDATION', 'from and to must be finite numbers');
  }
  if (w.from > w.to) {
    throw new StoreError('E_VALIDATION', 'from must be <= to');
  }
  if (!isNonEmptyString(w.by)) {
    throw new StoreError('E_VALIDATION', 'by (confirmer) must be a non-empty string');
  }
  if (!isFiniteNumber(w.at)) {
    throw new StoreError('E_VALIDATION', 'at (confirm time) must be a finite number');
  }
  if (w.note !== undefined && typeof w.note !== 'string') {
    throw new StoreError('E_VALIDATION', 'note must be a string');
  }
}

class Store {
  constructor() {
    this.seq = 0; // commit sequence, also the snapshot clock
    this.txCounter = 0;
    this.alarms = new Map(); // id -> { id, deviceId, alarmTime, versions: [] }
    this.index = new Map(); // deviceId -> Map(state -> sorted [entry])
    this.acks = []; // committed acknowledgement records
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object') {
      throw new StoreError('E_VALIDATION', 'state file must contain a JSON object');
    }
    const store = new Store();
    store.seq = Number.isInteger(data.seq) && data.seq >= 0 ? data.seq : 0;
    for (const a of data.alarms || []) {
      validateAlarmFields(a);
      const row = {
        id: a.id,
        deviceId: a.deviceId,
        alarmTime: a.alarmTime,
        versions: [{ state: a.state, begin: 0, end: Infinity, txn: null }],
      };
      store.alarms.set(a.id, row);
      store._insertEntry({
        deviceId: a.deviceId,
        alarmTime: a.alarmTime,
        id: a.id,
        state: a.state,
        begin: 0,
        end: Infinity,
        txn: null,
      });
    }
    store.acks = (data.acks || []).map((a) => ({ ...a }));
    return store;
  }

  toJSON() {
    return { seq: this.seq, alarms: this.listAlarms(), acks: this.listAcks() };
  }

  begin() {
    return new Txn(this, ++this.txCounter, this.seq);
  }

  // Committed, currently-live alarms sorted by id.
  listAlarms() {
    const out = [];
    for (const row of this.alarms.values()) {
      const v = committedLiveVersion(row);
      if (v) {
        out.push({ id: row.id, deviceId: row.deviceId, alarmTime: row.alarmTime, state: v.state });
      }
    }
    out.sort(byId);
    return out;
  }

  listAcks() {
    return this.acks.map((a) => ({ ...a }));
  }

  _bucket(deviceId, state, create) {
    let byState = this.index.get(deviceId);
    if (!byState) {
      if (!create) return null;
      byState = new Map();
      this.index.set(deviceId, byState);
    }
    let bucket = byState.get(state);
    if (!bucket) {
      if (!create) return null;
      bucket = [];
      byState.set(state, bucket);
    }
    return bucket;
  }

  _insertEntry(entry) {
    const bucket = this._bucket(entry.deviceId, entry.state, true);
    let lo = 0;
    let hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (compareEntries(bucket[mid], entry) < 0) lo = mid + 1;
      else hi = mid;
    }
    bucket.splice(lo, 0, entry);
  }

  _removeEntry(entry) {
    const bucket = this._bucket(entry.deviceId, entry.state, false);
    if (!bucket) return;
    const i = bucket.indexOf(entry);
    if (i >= 0) bucket.splice(i, 1);
  }

  _findLiveCommittedEntry(deviceId, state, id) {
    const bucket = this._bucket(deviceId, state, false);
    if (!bucket) return null;
    for (const e of bucket) {
      if (e.id === id && e.txn === null && e.end === Infinity) return e;
    }
    return null;
  }

  // Index range lookup on (deviceId, state) for from <= alarmTime <= to.
  _entriesInRange(deviceId, state, from, to) {
    const bucket = this._bucket(deviceId, state, false);
    if (!bucket) return [];
    const out = [];
    let lo = 0;
    let hi = bucket.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (bucket[mid].alarmTime < from) lo = mid + 1;
      else hi = mid;
    }
    for (let i = lo; i < bucket.length && bucket[i].alarmTime <= to; i++) {
      out.push(bucket[i]);
    }
    return out;
  }

  // Unacked alarms in the window as visible to `txn` (its snapshot + own writes).
  _scanVisibleUnacked(deviceId, from, to, txn) {
    const out = [];
    for (const e of this._entriesInRange(deviceId, STATE_UNACKED, from, to)) {
      if (!entryVisibleTo(e, txn)) continue;
      const row = this.alarms.get(e.id);
      const v = visibleVersion(row, txn);
      if (v && v.state === STATE_UNACKED) out.push(e.id);
    }
    return out;
  }

  // Unacked alarms in the window in the latest committed state (no txn writes).
  _committedLiveUnacked(deviceId, from, to) {
    const out = [];
    for (const e of this._entriesInRange(deviceId, STATE_UNACKED, from, to)) {
      if (e.txn === null && e.end === Infinity) out.push(e.id);
    }
    return out;
  }
}

class Txn {
  constructor(store, id, startSeq) {
    this.store = store;
    this.id = id;
    this.startSeq = startSeq;
    this.status = 'active';
    this.undo = []; // 撤销清单: LIFO entries { kind, id, version, entry }
    this.predicates = []; // window scans: { deviceId, from, to, scannedIds }
    this.pendingAcks = []; // ack records, appended to the store at commit
    this.touched = new Map(); // alarm id -> { oldVersion, oldEntry, myVersions, myEntries }
    this.myInsertIds = new Set();
  }

  _assertActive() {
    if (this.status !== 'active') {
      throw new StoreError('E_TXN_CLOSED', `transaction ${this.id} is ${this.status}`);
    }
  }

  _touch(id) {
    let t = this.touched.get(id);
    if (!t) {
      t = { oldVersion: null, oldEntry: null, myVersions: [], myEntries: [] };
      this.touched.set(id, t);
    }
    return t;
  }

  insertAlarm(fields) {
    this._assertActive();
    validateAlarmFields(fields);
    const { id, deviceId, alarmTime } = fields;
    const state = fields.state === undefined ? STATE_UNACKED : fields.state;
    const store = this.store;
    // Conservative uniqueness: any existing row (committed or uncommitted)
    // with this id rejects the insert.
    if (store.alarms.has(id)) {
      throw new StoreError('E_DUP_ID', `alarm id "${id}" already exists`);
    }
    const row = { id, deviceId, alarmTime, versions: [] };
    const version = { state, begin: Infinity, end: Infinity, txn: this.id };
    row.versions.push(version);
    const entry = { deviceId, alarmTime, id, state, begin: Infinity, end: Infinity, txn: this.id };
    store.alarms.set(id, row);
    store._insertEntry(entry);
    this.undo.push({ kind: 'insert', id, version, entry });
    this.myInsertIds.add(id);
    const t = this._touch(id);
    t.myVersions.push(version);
    t.myEntries.push(entry);
    return { id };
  }

  // Acknowledge every unacked alarm of `deviceId` with from <= alarmTime <= to,
  // as determined by this transaction's begin snapshot. Returns { count }.
  ackWindow(window) {
    this._assertActive();
    validateWindowFields(window);
    const { deviceId, from, to, by, at } = window;
    const note = window.note === undefined ? '' : window.note;
    const store = this.store;
    const ids = store._scanVisibleUnacked(deviceId, from, to, this);
    ids.sort();
    this.predicates.push({ deviceId, from, to, scannedIds: ids });
    for (const id of ids) {
      const row = store.alarms.get(id);
      const t = this._touch(id);
      if (!t.oldVersion) {
        // Remember the committed version/entry this write supersedes, so the
        // commit can close them. Null when acking our own uncommitted insert.
        t.oldVersion = committedLiveVersion(row);
        t.oldEntry = t.oldVersion
          ? store._findLiveCommittedEntry(row.deviceId, t.oldVersion.state, id)
          : null;
      }
      const version = { state: STATE_ACKED, begin: Infinity, end: Infinity, txn: this.id };
      row.versions.push(version);
      const entry = {
        deviceId: row.deviceId,
        alarmTime: row.alarmTime,
        id,
        state: STATE_ACKED,
        begin: Infinity,
        end: Infinity,
        txn: this.id,
      };
      store._insertEntry(entry);
      this.undo.push({ kind: 'ack', id, version, entry });
      t.myVersions.push(version);
      t.myEntries.push(entry);
      this.pendingAcks.push({
        alarmId: id,
        deviceId: row.deviceId,
        alarmTime: row.alarmTime,
        by,
        at,
        note,
      });
    }
    return { count: ids.length };
  }

  commit() {
    this._assertActive();
    const store = this.store;
    // Phantom validation: re-check every scanned window against the latest
    // committed state. Other transactions' inserts/acks inside a scanned
    // window since our begin abort us with E_PHANTOM. Our own writes never
    // count as phantoms.
    for (const p of this.predicates) {
      const nowIds = store._committedLiveUnacked(p.deviceId, p.from, p.to);
      const nowSet = new Set(nowIds);
      const scanned = new Set(p.scannedIds);
      let phantom = false;
      for (const id of nowIds) {
        if (!scanned.has(id)) {
          phantom = true;
          break;
        }
      }
      if (!phantom) {
        for (const id of p.scannedIds) {
          if (!this.myInsertIds.has(id) && !nowSet.has(id)) {
            phantom = true;
            break;
          }
        }
      }
      if (phantom) {
        this._abort();
        throw new StoreError(
          'E_PHANTOM',
          `concurrent change in window [${p.from}, ${p.to}] on device "${p.deviceId}"`,
        );
      }
    }
    const seq = ++store.seq;
    for (const t of this.touched.values()) {
      if (t.oldVersion) t.oldVersion.end = seq;
      if (t.oldEntry) t.oldEntry.end = seq;
      t.myVersions.forEach((v, i) => {
        v.txn = null;
        v.begin = seq;
        v.end = i === t.myVersions.length - 1 ? Infinity : seq;
      });
      t.myEntries.forEach((e, i) => {
        e.txn = null;
        e.begin = seq;
        e.end = i === t.myEntries.length - 1 ? Infinity : seq;
      });
    }
    for (const ack of this.pendingAcks) {
      store.acks.push({ ...ack, seq });
    }
    this.undo.length = 0;
    this.status = 'committed';
    return { ok: true, seq };
  }

  rollback() {
    this._assertActive();
    this._abort();
    return { ok: true };
  }

  // Replay the undo log in reverse, restoring every alarm's prior state and
  // dropping all pending ack records.
  _abort() {
    const store = this.store;
    for (let i = this.undo.length - 1; i >= 0; i--) {
      const u = this.undo[i];
      store._removeEntry(u.entry);
      const row = store.alarms.get(u.id);
      row.versions = row.versions.filter((v) => v !== u.version);
      if (u.kind === 'insert') {
        store.alarms.delete(u.id);
      }
    }
    this.undo.length = 0;
    this.pendingAcks.length = 0;
    this.status = 'aborted';
  }
}

module.exports = {
  Store,
  Txn,
  StoreError,
  STATE_UNACKED,
  STATE_ACKED,
};
