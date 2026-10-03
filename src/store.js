// Embedded sample store: single-writer transactional model.
//
// On-disk layout under the data directory:
//   POINTER              plain text generation number, switched atomically by compact
//   gen-<N>/main.json    main-store snapshot { walOffset, lastTxId, records }
//   gen-<N>/wal.log      write-ahead log (BEGIN/PUT/DEL/COMMIT frames with CRC-32)
//   gen-<N>/idx/type.json  persisted type index  { walOffset, lastTxId, checksum, data }
//   gen-<N>/idx/date.json  persisted date index  { walOffset, lastTxId, checksum, data }
//
// Commit path: append WAL frames + fsync -> apply to in-memory main store and
// both indexes. Snapshots and index files are written on flush() (every
// AUTO_FLUSH commits, on close(), compact(), rebuildIndex()). Recovery loads
// the snapshot, replays committed transactions from the WAL, truncates any
// torn tail, and rebuilds an index from the recovered state whenever its file
// is missing, corrupt, or its recorded WAL position/checksum does not match.
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from './crc32.js';
import { encodeTransaction, parseFrames, replayCommitted } from './wal.js';
import { TypeIndex, DateIndex } from './index.js';

export class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

const AUTO_FLUSH_COMMITS = 256;
const DATE_RE = /^\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/;
const openStores = new Set(); // in-process single-writer registry

function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function writeFileAtomic(file, data) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function validateRecord(rec) {
  if (rec == null || typeof rec !== 'object') throw new StoreError('INVALID', 'record must be an object');
  if (rec.id === undefined || rec.id === null || rec.id === '') throw new StoreError('INVALID', 'record.id is required');
  for (const field of ['type', 'location', 'status']) {
    if (typeof rec[field] !== 'string' || rec[field] === '') {
      throw new StoreError('INVALID', `record.${field} must be a non-empty string`);
    }
  }
  if (typeof rec.date !== 'string' || !DATE_RE.test(rec.date)) {
    throw new StoreError('INVALID', 'record.date must be YYYY-MM-DD');
  }
}

function normalizeRecord(rec) {
  validateRecord(rec);
  return {
    id: String(rec.id),
    type: rec.type,
    date: rec.date,
    location: rec.location,
    status: rec.status,
  };
}

export class Tx {
  constructor(store, id) {
    this.store = store;
    this.id = id;
    this.ops = [];
    this.done = false;
  }
  #guard() {
    if (this.done) throw new StoreError('TX_CLOSED', 'transaction already finished');
  }
  add(record) {
    this.#guard();
    this.ops.push({ kind: 'put', record: normalizeRecord(record), isAdd: true });
    return this;
  }
  update(id, patch) {
    this.#guard();
    this.ops.push({ kind: 'update', id: String(id), patch: { ...patch } });
    return this;
  }
  remove(id) {
    this.#guard();
    this.ops.push({ kind: 'del', id: String(id) });
    return this;
  }
  commit() {
    this.store.commit(this);
  }
}

export class Store {
  static open(dir, opts = {}) {
    const store = new Store(dir, opts);
    store.#open();
    return store;
  }

  constructor(dir, opts = {}) {
    this.dir = path.resolve(dir);
    this.opts = opts;
    this.records = new Map();
    this.typeIndex = new TypeIndex();
    this.dateIndex = new DateIndex();
    this.lastTxId = 0;
    this.walOffset = 0;
    this.commitsSinceFlush = 0;
    this.closed = false;
  }

  #open() {
    if (openStores.has(this.dir)) throw new StoreError('LOCKED', `store already open: ${this.dir}`);
    fs.mkdirSync(this.dir, { recursive: true });

    // Resolve current generation via POINTER; clean up leftovers of an
    // interrupted compact (any gen directory the POINTER does not name).
    const gens = fs
      .readdirSync(this.dir)
      .filter((n) => /^gen-\d+$/.test(n))
      .map((n) => Number(n.slice(4)))
      .sort((a, b) => a - b);
    let gen = null;
    const pointerFile = path.join(this.dir, 'POINTER');
    if (fs.existsSync(pointerFile)) {
      const n = Number(fs.readFileSync(pointerFile, 'utf8').trim());
      if (Number.isInteger(n) && gens.includes(n)) gen = n;
    }
    if (gen === null) gen = gens.length ? gens[gens.length - 1] : 1;
    for (const g of gens) {
      if (g !== gen) fs.rmSync(path.join(this.dir, `gen-${g}`), { recursive: true, force: true });
    }
    this.gen = gen;
    this.genDir = path.join(this.dir, `gen-${gen}`);
    fs.mkdirSync(path.join(this.genDir, 'idx'), { recursive: true });
    if (!fs.existsSync(pointerFile)) writeFileAtomic(pointerFile, String(gen));

    // Main-store snapshot, then WAL replay from the snapshot position.
    this.mainFile = path.join(this.genDir, 'main.json');
    this.walFile = path.join(this.genDir, 'wal.log');
    if (fs.existsSync(this.mainFile)) {
      try {
        const snap = JSON.parse(fs.readFileSync(this.mainFile, 'utf8'));
        for (const [id, rec] of Object.entries(snap.records || {})) this.records.set(id, rec);
        this.walOffset = snap.walOffset || 0;
        this.lastTxId = snap.lastTxId || 0;
      } catch {
        // Corrupt snapshot: fall back to replaying the whole WAL.
        this.records.clear();
        this.walOffset = 0;
        this.lastTxId = 0;
      }
    }
    if (!fs.existsSync(this.walFile)) fs.writeFileSync(this.walFile, '');
    const walBuf = fs.readFileSync(this.walFile);
    const base = Math.min(this.walOffset, walBuf.length);
    const { frames, goodEnd } = parseFrames(walBuf, base);
    replayCommitted(frames, (op) => this.#apply(op));
    const walEnd = goodEnd;
    if (walEnd < walBuf.length) fs.truncateSync(this.walFile, walEnd); // drop torn tail
    const maxTx = frames.reduce((m, f) => Math.max(m, f.txId), this.lastTxId);
    this.lastTxId = maxTx;
    this.walOffset = walEnd;
    this.walFd = fs.openSync(this.walFile, 'a');

    // Secondary indexes: trust files only when checksum and WAL position match.
    this.typeIndex = this.#loadIndex('type', TypeIndex, walEnd) || this.#rebuildIndex('type', walEnd);
    this.dateIndex = this.#loadIndex('date', DateIndex, walEnd) || this.#rebuildIndex('date', walEnd);

    openStores.add(this.dir);
  }

  #indexFile(kind) {
    return path.join(this.genDir, 'idx', `${kind}.json`);
  }

  #loadIndex(kind, Klass, walEnd) {
    const file = this.#indexFile(kind);
    if (!fs.existsSync(file)) return null;
    try {
      const doc = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (doc.walOffset !== walEnd || doc.lastTxId !== this.lastTxId) return null;
      if (crc32(Buffer.from(JSON.stringify(doc.data), 'utf8')) !== doc.checksum) return null;
      return Klass.fromJSON(doc.data);
    } catch {
      return null;
    }
  }

  #rebuildIndex(kind, walEnd) {
    const idx = kind === 'type' ? new TypeIndex() : new DateIndex();
    for (const rec of this.records.values()) {
      if (kind === 'type') idx.add(rec.type, rec.id);
      else idx.add(rec.date, rec.id);
    }
    this.#writeIndexFile(kind, idx, walEnd);
    return idx;
  }

  #writeIndexFile(kind, idx, walEnd) {
    const data = idx.toJSON();
    const doc = {
      walOffset: walEnd ?? this.walOffset,
      lastTxId: this.lastTxId,
      checksum: crc32(Buffer.from(JSON.stringify(data), 'utf8')),
      data,
    };
    writeFileAtomic(this.#indexFile(kind), JSON.stringify(doc));
  }

  #apply(op) {
    if (op.kind === 'put') {
      const rec = op.record;
      const old = this.records.get(rec.id);
      if (old) {
        this.typeIndex.remove(old.type, old.id);
        this.dateIndex.remove(old.date, old.id);
      }
      this.records.set(rec.id, rec);
      this.typeIndex.add(rec.type, rec.id);
      this.dateIndex.add(rec.date, rec.id);
    } else {
      const old = this.records.get(op.id);
      if (old) {
        this.records.delete(op.id);
        this.typeIndex.remove(old.type, old.id);
        this.dateIndex.remove(old.date, old.id);
      }
    }
  }

  // Resolve a tx's ops against current state: validates DUP / NOT_FOUND and
  // turns updates into concrete puts. Returns plain put/del ops.
  #resolve(tx) {
    const view = new Map(); // id -> record | null (overlay on this.records)
    const lookup = (id) => (view.has(id) ? view.get(id) : this.records.get(id) ?? null);
    const out = [];
    for (const op of tx.ops) {
      if (op.kind === 'put' && op.isAdd) {
        if (lookup(op.record.id)) throw new StoreError('DUP', `duplicate sample id: ${op.record.id}`);
        view.set(op.record.id, op.record);
        out.push({ kind: 'put', record: op.record });
      } else if (op.kind === 'update') {
        const cur = lookup(op.id);
        if (!cur) throw new StoreError('NOT_FOUND', `no such sample: ${op.id}`);
        const next = normalizeRecord({ ...cur, ...op.patch, id: op.id });
        view.set(op.id, next);
        out.push({ kind: 'put', record: next });
      } else {
        if (!lookup(op.id)) throw new StoreError('NOT_FOUND', `no such sample: ${op.id}`);
        view.set(op.id, null);
        out.push({ kind: 'del', id: op.id });
      }
    }
    return out;
  }

  begin() {
    this.#guardOpen();
    return new Tx(this, this.lastTxId + 1);
  }

  commit(tx) {
    this.#guardOpen();
    if (tx.done) throw new StoreError('TX_CLOSED', 'transaction already finished');
    tx.done = true;
    if (tx.store !== this) throw new StoreError('TX_FOREIGN', 'transaction belongs to another store');
    const ops = this.#resolve(tx);
    if (ops.length === 0) return;
    const txId = ++this.lastTxId;
    const buf = encodeTransaction(txId, ops);
    fs.writeSync(this.walFd, buf);
    fs.fsyncSync(this.walFd); // durable before applying
    this.walOffset += buf.length;
    for (const op of ops) this.#apply(op);
    if (++this.commitsSinceFlush >= AUTO_FLUSH_COMMITS) this.flush();
  }

  #withTx(fn) {
    const tx = this.begin();
    fn(tx);
    this.commit(tx);
  }

  add(record) {
    this.#withTx((tx) => tx.add(record));
  }

  update(id, patch) {
    this.#withTx((tx) => tx.update(id, patch));
  }

  remove(id) {
    this.#withTx((tx) => tx.remove(id));
  }

  find(id) {
    this.#guardOpen();
    return this.records.get(String(id)) ?? null;
  }

  #sorted(ids) {
    return ids
      .map((id) => this.records.get(id))
      .filter(Boolean)
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  scanByType(type) {
    this.#guardOpen();
    return this.#sorted(this.typeIndex.ids(type));
  }

  scanByDateRange(from = null, to = null) {
    this.#guardOpen();
    return this.#sorted(this.dateIndex.idsInRange(from, to));
  }

  scan({ type = null, from = null, to = null } = {}) {
    this.#guardOpen();
    let rows;
    if (type != null) rows = this.scanByType(type);
    else if (from != null || to != null) rows = this.scanByDateRange(from, to);
    else rows = this.#sorted([...this.records.keys()]);
    if (type != null && (from != null || to != null)) {
      rows = rows.filter((r) => (from == null || r.date >= from) && (to == null || r.date <= to));
    }
    return rows;
  }

  flush() {
    this.#guardOpen();
    const records = {};
    for (const [id, rec] of this.records) records[id] = rec;
    writeFileAtomic(
      this.mainFile,
      JSON.stringify({ walOffset: this.walOffset, lastTxId: this.lastTxId, records }),
    );
    this.#writeIndexFile('type', this.typeIndex);
    this.#writeIndexFile('date', this.dateIndex);
    this.commitsSinceFlush = 0;
  }

  rebuildIndex() {
    this.#guardOpen();
    this.typeIndex = this.#rebuildIndex('type');
    this.dateIndex = this.#rebuildIndex('date');
  }

  // Merge the WAL into a fresh generation and rewrite both indexes.
  // Crash-safe: the new generation is fully written and fsynced before the
  // POINTER is switched with an atomic rename; a crash before the switch
  // leaves the old generation untouched and the partial one is discarded on
  // next open.
  compact() {
    this.#guardOpen();
    this.flush();
    const newGen = this.gen + 1;
    const newDir = path.join(this.dir, `gen-${newGen}`);
    fs.rmSync(newDir, { recursive: true, force: true });
    fs.mkdirSync(path.join(newDir, 'idx'), { recursive: true });

    const records = {};
    for (const [id, rec] of this.records) records[id] = rec;
    writeFileAtomic(path.join(newDir, 'main.json'), JSON.stringify({ walOffset: 0, lastTxId: this.lastTxId, records }));
    fs.writeFileSync(path.join(newDir, 'wal.log'), '');
    const walFd = fs.openSync(path.join(newDir, 'wal.log'), 'r+');
    fs.fsyncSync(walFd);
    fs.closeSync(walFd);
    for (const [kind, idx] of [['type', this.typeIndex], ['date', this.dateIndex]]) {
      const data = idx.toJSON();
      const doc = { walOffset: 0, lastTxId: this.lastTxId, checksum: crc32(Buffer.from(JSON.stringify(data), 'utf8')), data };
      writeFileAtomic(path.join(newDir, 'idx', `${kind}.json`), JSON.stringify(doc));
    }
    fsyncDir(newDir);

    // Test hook: simulate a crash after the new files are written but before
    // the pointer switch.
    if (process.env.BIOSPEC_CRASH_BEFORE_POINTER_SWITCH) process.exit(1);
    if (this.opts.beforePointerSwitch) this.opts.beforePointerSwitch();

    writeFileAtomic(path.join(this.dir, 'POINTER'), String(newGen));

    const oldDir = this.genDir;
    fs.closeSync(this.walFd);
    this.gen = newGen;
    this.genDir = newDir;
    this.mainFile = path.join(newDir, 'main.json');
    this.walFile = path.join(newDir, 'wal.log');
    this.walOffset = 0;
    this.walFd = fs.openSync(this.walFile, 'a');
    fs.rmSync(oldDir, { recursive: true, force: true });
    this.commitsSinceFlush = 0;
  }

  #guardOpen() {
    if (this.closed) throw new StoreError('CLOSED', 'store is closed');
  }

  close() {
    if (this.closed) return;
    try {
      this.flush();
    } finally {
      fs.closeSync(this.walFd);
      openStores.delete(this.dir);
      this.closed = true;
    }
  }
}
