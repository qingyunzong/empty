'use strict';

const path = require('node:path');
const { Wal } = require('./wal');
const { NameIndex, TimeIndex, IndexStore } = require('./indexes');

class EngineError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

// Error codes (stable contract):
//   NO_TARGET  - correction points at a record that does not exist
//   CYCLE      - correction would create (or traverses) a cyclic reference
//   DUP_ID     - record id already committed
//   NOT_FOUND  - resolve/chain/view-at target unknown
//   WAL_CORRUPT- WAL contains an entry that is not a valid commit

class Engine {
  constructor(dir) {
    this.dir = dir;
    this.wal = new Wal(path.join(dir, 'wal.log'));
    this.indexStore = new IndexStore(dir);
    this.records = new Map(); // id -> record
    this.correctedBy = new Map(); // id -> id of latest record correcting it
    this.nameIndex = new NameIndex();
    this.timeIndex = new TimeIndex();
    this.seq = 0; // wal sequence == number of committed records
    this.lastTs = 0;
    this.open = false;
  }

  static open(dir) {
    const e = new Engine(dir);
    e._open();
    return e;
  }

  _open() {
    this.wal.open();
    // WAL is authoritative: replay it fully into memory.
    for (const entry of this.wal.readAll()) {
      if (!entry || entry.type !== 'commit' || !entry.record) {
        throw new EngineError('WAL_CORRUPT', 'unexpected WAL entry');
      }
      this._apply(entry.record);
    }
    // Reconcile disk indexes with the WAL: reuse only if present, intact and current.
    const disk = this.indexStore.load();
    if (!disk || disk.walSeq !== this.seq) {
      this._persistIndexes();
    }
    this.open = true;
  }

  _apply(rec) {
    this.records.set(rec.id, rec);
    if (rec.corrects !== null) {
      const prev = this.correctedBy.get(rec.corrects);
      // If a record is corrected more than once, the chain follows the
      // most recent (max ts) corrector.
      if (prev === undefined || rec.ts >= this.records.get(prev).ts) {
        this.correctedBy.set(rec.corrects, rec.id);
      }
    }
    this.nameIndex.add(rec);
    this.timeIndex.add(rec);
    this.seq = rec.seq;
    this.lastTs = Math.max(this.lastTs, rec.ts);
  }

  _persistIndexes() {
    this.indexStore.persist(this.seq, this.nameIndex, this.timeIndex);
  }

  commit({ id, target, value, corrects = null, ts = undefined }) {
    if (!this.open) throw new EngineError('CLOSED', 'engine not open');
    if (id === undefined || id === null) id = `r${this.seq + 1}`;
    if (this.records.has(id)) {
      throw new EngineError('DUP_ID', `record id already exists: ${id}`);
    }
    if (corrects !== null) {
      if (corrects === id) {
        throw new EngineError('CYCLE', `cyclic correction reference via: ${id}`);
      }
      const target0 = this.records.get(corrects);
      if (!target0) {
        throw new EngineError('NO_TARGET', `cannot correct unknown record: ${corrects}`);
      }
      // Cycle check: walk the corrects chain from the corrected record;
      // hitting the new id or revisiting a node means a cycle.
      const visited = new Set();
      let cur = corrects;
      while (cur !== null) {
        if (cur === id || visited.has(cur)) {
          throw new EngineError('CYCLE', `cyclic correction reference via: ${cur}`);
        }
        visited.add(cur);
        cur = this.records.get(cur).corrects;
      }
    }
    // Commit timestamps are monotonic; a caller-supplied ts is clamped.
    let commitTs = ts === undefined ? Date.now() : ts;
    commitTs = Math.max(commitTs, this.lastTs + 1);
    const rec = { id, target, value, corrects, ts: commitTs, seq: this.seq + 1 };

    // 1. WAL first, fsync'd.
    this.wal.append({ type: 'commit', record: rec });

    // Crash-injection hook for recovery tests: die after the WAL is durable
    // but before the disk indexes are persisted.
    if (process.env.OBS_CRASH_AFTER_WAL === '1') {
      process.exit(42);
    }

    // 2. Then memory + disk secondary indexes.
    this._apply(rec);
    this._persistIndexes();
    return rec;
  }

  _get(id) {
    const rec = this.records.get(id);
    if (!rec) throw new EngineError('NOT_FOUND', `unknown record: ${id}`);
    return rec;
  }

  // Follow correctedBy links to the chain tail, optionally restricted to
  // records committed at or before `at`.
  _tail(id, at = null) {
    const visited = new Set();
    let cur = this._get(id);
    while (true) {
      if (visited.has(cur.id)) {
        throw new EngineError('CYCLE', `cycle detected in stored data at: ${cur.id}`);
      }
      visited.add(cur.id);
      const nextId = this.correctedBy.get(cur.id);
      if (nextId === undefined) return cur;
      const next = this.records.get(nextId);
      if (at !== null && next.ts > at) return cur;
      cur = next;
    }
  }

  _tailForTarget(name, at = null) {
    const ids = this.nameIndex.ids(name).filter((id) => {
      const r = this.records.get(id);
      return at === null || r.ts <= at;
    });
    if (ids.length === 0) {
      throw new EngineError('NOT_FOUND', `unknown target: ${name}`);
    }
    // The latest record of the chain head-ward walk gives the live tail;
    // walk from the newest record of this target to its chain tail.
    const newest = this.records.get(ids[ids.length - 1]);
    return this._tail(newest.id, at);
  }

  // Latest effective value: chain tail for a record id or a target name.
  resolve({ id = null, target = null } = {}) {
    if (id !== null) return this._tail(id);
    return this._tailForTarget(target);
  }

  // View as it was at time `at`: corrections committed after `at` are ignored.
  viewAt({ id = null, target = null, at }) {
    if (id !== null) return this._tail(id, at);
    return this._tailForTarget(target, at);
  }

  // The correction chain starting at `id`, following to the tail.
  chain(id) {
    const out = [];
    const visited = new Set();
    let cur = this._get(id);
    while (true) {
      if (visited.has(cur.id)) {
        throw new EngineError('CYCLE', `cycle detected in stored data at: ${cur.id}`);
      }
      visited.add(cur.id);
      out.push(cur);
      const nextId = this.correctedBy.get(cur.id);
      if (nextId === undefined) return out;
      cur = this.records.get(nextId);
    }
  }

  // Time-range query backed by the time index.
  range(from = null, to = null) {
    return this.timeIndex.range(from, to).map((id) => this.records.get(id));
  }

  // Rebuild reference indexes purely from the WAL and compare with the
  // persisted disk indexes. Repair (rewrite) on any divergence.
  verify() {
    const refName = new NameIndex();
    const refTime = new TimeIndex();
    for (const entry of this.wal.readAll()) {
      if (!entry || entry.type !== 'commit' || !entry.record) {
        throw new EngineError('WAL_CORRUPT', 'unexpected WAL entry');
      }
      refName.add(entry.record);
      refTime.add(entry.record);
    }
    const problems = [];
    const disk = this.indexStore.load();
    if (!disk) {
      problems.push('index files missing or corrupt');
    } else {
      if (disk.walSeq !== this.seq) {
        problems.push(`index walSeq ${disk.walSeq} != wal seq ${this.seq}`);
      }
      if (JSON.stringify(disk.nameIndex.toData()) !== JSON.stringify(refName.toData())) {
        problems.push('name index diverges from WAL');
      }
      if (JSON.stringify(disk.timeIndex.toData()) !== JSON.stringify(refTime.toData())) {
        problems.push('time index diverges from WAL');
      }
    }
    if (problems.length > 0) {
      this.indexStore.persist(this.seq, refName, refTime);
      this.nameIndex = refName;
      this.timeIndex = refTime;
      return { ok: true, repaired: true, problems };
    }
    return { ok: true, repaired: false, problems: [] };
  }

  close() {
    this.wal.close();
    this.open = false;
  }
}

module.exports = { Engine, EngineError };
