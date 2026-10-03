'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { WalWriter, replayWal } = require('./wal');
const { TypeIndex, DateIndex, serializeIndex, deserializeIndex } = require('./indexes');

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function validateSample(fields, partial = false) {
  if (!partial || fields.id !== undefined) {
    if (typeof fields.id !== 'string' || fields.id.length === 0) {
      throw new StoreError('INVALID', 'sample id must be a non-empty string');
    }
  }
  if (fields.type !== undefined && (typeof fields.type !== 'string' || fields.type.length === 0)) {
    throw new StoreError('INVALID', 'type must be a non-empty string');
  }
  if (fields.date !== undefined && (typeof fields.date !== 'string' || !DATE_RE.test(fields.date))) {
    throw new StoreError('INVALID', 'date must be YYYY-MM-DD');
  }
  for (const key of ['location', 'status']) {
    if (fields[key] !== undefined && typeof fields[key] !== 'string') {
      throw new StoreError('INVALID', `${key} must be a string`);
    }
  }
}

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } catch { /* best effort */ }
  fs.closeSync(fd);
}

function writeFileAtomic(filePath, data) {
  const tmp = filePath + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  fs.writeSync(fd, data);
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(tmp, filePath);
}

class BiobankStore {
  // Layout inside dir:
  //   manifest.json            { generation }
  //   data-<gen>.json          { walOffset, records: [...] }
  //   wal-<gen>.log            append-only WAL
  //   indexes-<gen>/by_type.json, by_date.json
  constructor(dir, opts = {}) {
    this.dir = dir;
    this._crashHook = opts.crashHook || null; // test-only: called inside compact
    this.records = new Map(); // id -> sample
    this.typeIndex = new TypeIndex();
    this.dateIndex = new DateIndex();
    this._queue = Promise.resolve();
    this._closed = false;
    this._open();
  }

  _paths(gen) {
    return {
      manifest: path.join(this.dir, 'manifest.json'),
      data: path.join(this.dir, `data-${gen}.json`),
      wal: path.join(this.dir, `wal-${gen}.log`),
      indexDir: path.join(this.dir, `indexes-${gen}`),
      typeIdx: path.join(this.dir, `indexes-${gen}`, 'by_type.json'),
      dateIdx: path.join(this.dir, `indexes-${gen}`, 'by_date.json'),
    };
  }

  _open() {
    fs.mkdirSync(this.dir, { recursive: true });
    const manifestPath = path.join(this.dir, 'manifest.json');

    let generation = 0;
    try {
      generation = JSON.parse(fs.readFileSync(manifestPath, 'utf8')).generation;
    } catch {
      generation = 0;
    }
    if (!Number.isInteger(generation) || generation < 1) {
      generation = 1;
      writeFileAtomic(manifestPath, JSON.stringify({ generation }));
      fsyncDir(this.dir);
    }
    this.generation = generation;
    this._cleanupStaleGenerations(generation);

    const p = this._paths(generation);

    // 1. Load main-store snapshot.
    let snapshotOffset = 0;
    try {
      const snap = JSON.parse(fs.readFileSync(p.data, 'utf8'));
      if (Number.isInteger(snap.walOffset) && Array.isArray(snap.records)) {
        snapshotOffset = snap.walOffset;
        for (const s of snap.records) this.records.set(s.id, s);
      }
    } catch {
      this.records.clear();
      snapshotOffset = 0;
    }

    // 2. Replay WAL from the snapshot position (single source of truth
    //    for everything committed after the last checkpoint).
    const { transactions, endOffset } = replayWal(p.wal, snapshotOffset);
    for (const ops of transactions) {
      for (const op of ops) this._applyOp(op);
    }
    this.walOffset = endOffset;

    // 3. Validate persisted indexes against checksum + WAL position;
    //    rebuild from the recovered state when missing/stale/corrupt.
    const loaded = this._loadIndexes(p, endOffset);
    if (loaded) {
      this.typeIndex = loaded.typeIndex;
      this.dateIndex = loaded.dateIndex;
    } else {
      this._rebuildIndexesInMemory();
      this._writeIndexes(p, endOffset);
    }

    this.wal = new WalWriter(p.wal);
    if (this.wal.offset !== endOffset) {
      // WAL was truncated during replay; writer offset follows the clean tail.
      this.wal.close();
      this.wal = new WalWriter(p.wal);
    }
  }

  _cleanupStaleGenerations(current) {
    const re = /^(data|wal)-(\d+)\.(json|log)$/;
    const idxRe = /^indexes-(\d+)$/;
    for (const name of fs.readdirSync(this.dir)) {
      const m = re.exec(name);
      if (m && Number(m[2]) !== current) {
        fs.rmSync(path.join(this.dir, name), { force: true });
        continue;
      }
      const im = idxRe.exec(name);
      if (im && Number(im[1]) !== current) {
        fs.rmSync(path.join(this.dir, name), { recursive: true, force: true });
      }
    }
  }

  _loadIndexes(p, walOffset) {
    let typeRaw;
    let dateRaw;
    try {
      typeRaw = fs.readFileSync(p.typeIdx, 'utf8');
      dateRaw = fs.readFileSync(p.dateIdx, 'utf8');
    } catch {
      return null;
    }
    const typeIndex = deserializeIndex(typeRaw, walOffset, TypeIndex);
    const dateIndex = deserializeIndex(dateRaw, walOffset, DateIndex);
    if (!typeIndex || !dateIndex) return null;
    return { typeIndex, dateIndex };
  }

  _rebuildIndexesInMemory() {
    this.typeIndex = new TypeIndex();
    this.dateIndex = new DateIndex();
    for (const s of this.records.values()) {
      this.typeIndex.add(s);
      this.dateIndex.add(s);
    }
  }

  _writeIndexes(p, walOffset) {
    fs.mkdirSync(p.indexDir, { recursive: true });
    writeFileAtomic(p.typeIdx, serializeIndex(this.typeIndex, walOffset));
    writeFileAtomic(p.dateIdx, serializeIndex(this.dateIndex, walOffset));
  }

  _applyOp(op) {
    if (op.t === 'put') {
      const old = this.records.get(op.sample.id);
      if (old) {
        this.typeIndex.update(old, op.sample);
        this.dateIndex.update(old, op.sample);
      } else {
        this.typeIndex.add(op.sample);
        this.dateIndex.add(op.sample);
      }
      this.records.set(op.sample.id, op.sample);
    } else if (op.t === 'del') {
      const old = this.records.get(op.id);
      if (old) {
        this.typeIndex.remove(old);
        this.dateIndex.remove(old);
        this.records.delete(op.id);
      }
    }
  }

  // Serializes all write transactions: a single writer at a time.
  _enqueue(fn) {
    if (this._closed) return Promise.reject(new StoreError('CLOSED', 'store is closed'));
    const run = this._queue.then(fn);
    this._queue = run.catch(() => {});
    return run;
  }

  // tx(ops => { ops.add(...); ops.update(...); ops.remove(...); })
  transaction(fn) {
    return this._enqueue(() => {
      const ops = [];
      const api = {
        add: (sample) => ops.push({ kind: 'add', sample }),
        update: (id, patch) => ops.push({ kind: 'update', id, patch }),
        remove: (id) => ops.push({ kind: 'remove', id }),
      };
      fn(api);
      this._commit(ops);
    });
  }

  _commit(ops) {
    if (ops.length === 0) return;
    const walRecords = [{ t: 'begin' }];
    const applied = [];
    // Validate against a transactional overlay (earlier ops in the same
    // transaction are visible to later ones) before touching the WAL,
    // so a failing transaction never reaches disk.
    const overlay = new Map(); // id -> sample | null (tombstone)
    const lookup = (id) => (overlay.has(id) ? overlay.get(id) : this.records.get(id));
    for (const op of ops) {
      if (op.kind === 'add') {
        validateSample(op.sample);
        const sample = {
          id: op.sample.id,
          type: op.sample.type,
          date: op.sample.date,
          location: op.sample.location ?? '',
          status: op.sample.status ?? '',
        };
        validateSample(sample);
        if (lookup(sample.id)) {
          throw new StoreError('DUP', `duplicate sample id: ${sample.id}`);
        }
        overlay.set(sample.id, sample);
        walRecords.push({ t: 'put', sample });
        applied.push({ t: 'put', sample });
      } else if (op.kind === 'update') {
        const old = lookup(op.id);
        if (!old) throw new StoreError('NOT_FOUND', `no such sample: ${op.id}`);
        validateSample(op.patch, true);
        const sample = { ...old, ...op.patch, id: old.id };
        overlay.set(sample.id, sample);
        walRecords.push({ t: 'put', sample });
        applied.push({ t: 'put', sample });
      } else if (op.kind === 'remove') {
        if (!lookup(op.id)) {
          throw new StoreError('NOT_FOUND', `no such sample: ${op.id}`);
        }
        overlay.set(op.id, null);
        walRecords.push({ t: 'del', id: op.id });
        applied.push({ t: 'del', id: op.id });
      }
    }
    walRecords.push({ t: 'commit' });

    // WAL first, fsync, then apply to main store + indexes.
    this.wal.append(walRecords);
    this.wal.fsync();
    for (const op of applied) this._applyOp(op);
  }

  add(sample) {
    return this.transaction((tx) => tx.add(sample));
  }

  update(id, patch) {
    return this.transaction((tx) => tx.update(id, patch));
  }

  remove(id) {
    return this.transaction((tx) => tx.remove(id));
  }

  find(id) {
    const s = this.records.get(id);
    return s ? { ...s } : null;
  }

  scanByType(type) {
    return this.typeIndex.lookup(type)
      .sort()
      .map((id) => ({ ...this.records.get(id) }));
  }

  scanByDateRange(from, to) {
    if (from !== undefined && !DATE_RE.test(from)) throw new StoreError('INVALID', 'from must be YYYY-MM-DD');
    if (to !== undefined && !DATE_RE.test(to)) throw new StoreError('INVALID', 'to must be YYYY-MM-DD');
    const lo = from ?? '0000-00-00';
    const hi = to ?? '9999-99-99';
    return this.dateIndex.range(lo, hi)
      .map((id) => ({ ...this.records.get(id) }))
      .sort((a, b) => a.date === b.date
        ? (a.id < b.id ? -1 : 1)
        : (a.date < b.date ? -1 : 1));
  }

  // Forces a rebuild of both indexes from current state and rewrites the
  // index files. Used by the rebuild-index command and on validation failure.
  rebuildIndex() {
    return this._enqueue(() => {
      this._rebuildIndexesInMemory();
      this._writeIndexes(this._paths(this.generation), this.walOffset);
      fsyncDir(this.dir);
    });
  }

  // Merges the WAL into a fresh snapshot + empty WAL + rewritten indexes,
  // all under a new generation. The manifest switch is the atomic commit
  // point: a crash before it leaves the old generation fully intact.
  compact() {
    return this._enqueue(() => {
      const oldGen = this.generation;
      const newGen = oldGen + 1;
      const np = this._paths(newGen);

      // 1. Write the new generation's files (snapshot, empty WAL, indexes).
      const snapshot = JSON.stringify({ walOffset: 0, records: [...this.records.values()] });
      writeFileAtomic(np.data, snapshot);
      fs.writeFileSync(np.wal, '');
      {
        const fd = fs.openSync(np.wal, 'r+');
        fs.fsyncSync(fd);
        fs.closeSync(fd);
      }
      this._writeIndexes(np, 0);
      fsyncDir(this.dir);

      // 2. Crash point: everything durable, manifest not yet switched.
      if (this._crashHook) this._crashHook('before-manifest-switch');

      // 3. Atomically switch the manifest to the new generation.
      writeFileAtomic(np.manifest, JSON.stringify({ generation: newGen }));
      fsyncDir(this.dir);

      // 4. Retire the old generation and move the writer over.
      this.wal.close();
      const op = this._paths(oldGen);
      fs.rmSync(op.data, { force: true });
      fs.rmSync(op.wal, { force: true });
      fs.rmSync(op.indexDir, { recursive: true, force: true });
      fsyncDir(this.dir);

      this.generation = newGen;
      this.walOffset = 0;
      this.wal = new WalWriter(np.wal);
    });
  }

  // Persists snapshot + indexes for the current WAL position so a clean
  // restart validates indexes without a rebuild.
  close() {
    if (this._closed) return Promise.resolve();
    return this._enqueue(() => {
      const p = this._paths(this.generation);
      const snapshot = JSON.stringify({ walOffset: this.walOffset, records: [...this.records.values()] });
      writeFileAtomic(p.data, snapshot);
      this._writeIndexes(p, this.walOffset);
      this.wal.close();
      fsyncDir(this.dir);
      this._closed = true;
    });
  }
}

module.exports = { BiobankStore, StoreError };
