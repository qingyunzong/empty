'use strict';
const fs = require('fs');
const path = require('path');
const { tick, mergeClocks, leq } = require('./clock');
const wal = require('./wal');
const history = require('./history');

// A Store is a directory holding:
//   wal.log   - JSONL commit records (local + imported), the source of truth
//   meta.json - {node, seq, clock}
// State is rebuilt from the WAL on open (crash recovery).
class Store {
  constructor(dir, node) {
    this.dir = dir;
    this.node = node;
    this.seq = 0;
    this.clock = {};
    this.txns = new Map();
    this.state = {};
    this.versions = new Map(); // key -> [{clock, value, txn}] in merged order
    this.corrupt = 0; // corrupt WAL lines skipped during open()
  }

  static open(dir, opts = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const metaPath = path.join(dir, 'meta.json');
    let meta = {};
    if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
    const store = new Store(dir, opts.node || meta.node || 'default');
    store.seq = meta.seq || 0;
    store.clock = meta.clock || {};
    const walPath = path.join(dir, 'wal.log');
    if (fs.existsSync(walPath)) {
      const { records, errors } = wal.decodeSegment(fs.readFileSync(walPath, 'utf8'));
      store.corrupt = errors.length;
      for (const rec of records) {
        if (!store.txns.has(rec.id)) store.txns.set(rec.id, rec);
      }
      for (const rec of store.txns.values()) {
        store.clock = mergeClocks(store.clock, rec.clock);
        if (rec.node === store.node && rec.seq > store.seq) store.seq = rec.seq;
      }
    }
    store._rebuild();
    return store;
  }

  _persistMeta() {
    fs.writeFileSync(
      path.join(this.dir, 'meta.json'),
      JSON.stringify({ node: this.node, seq: this.seq, clock: this.clock })
    );
  }

  _rebuild() {
    const order = history.mergedOrder([...this.txns.values()]);
    this.state = {};
    this.versions = new Map();
    for (const t of order) {
      for (const [k, v] of Object.entries(t.writes)) {
        this.state[k] = v;
        if (!this.versions.has(k)) this.versions.set(k, []);
        this.versions.get(k).push({ clock: t.clock, value: v, txn: t.id });
      }
    }
  }

  // Commit a transaction. reads: array of keys (pre-images recorded against
  // current state); writes: {key: value}. Returns the WAL record.
  commit({ reads = [], writes = {} }) {
    const readSet = {};
    for (const k of reads) readSet[k] = this.state[k] === undefined ? null : this.state[k];
    this.clock = tick(this.clock, this.node);
    this.seq += 1;
    const rec = {
      id: `${this.node}:${this.seq}`,
      node: this.node,
      seq: this.seq,
      clock: { ...this.clock },
      reads: readSet,
      writes,
    };
    fs.appendFileSync(path.join(this.dir, 'wal.log'), wal.encodeRecord(rec) + '\n');
    this.txns.set(rec.id, rec);
    this._rebuild();
    this._persistMeta();
    return rec;
  }

  // Point read, or snapshot read at a vector clock (opts.at).
  read(key, opts = {}) {
    if (!opts.at) return this.state[key] === undefined ? null : this.state[key];
    const chain = this.versions.get(key) || [];
    for (let i = chain.length - 1; i >= 0; i--) {
      if (leq(chain[i].clock, opts.at)) return chain[i].value;
    }
    return null;
  }

  snapshot(clock) {
    return { clock, read: (k) => this.read(k, { at: clock }) };
  }

  // Export a log segment. With opts.since, only local commits with seq > since.
  exportSegment(opts = {}) {
    const since = opts.since || 0;
    const recs = [...this.txns.values()]
      .filter((r) => (since ? r.node === this.node && r.seq > since : true))
      .sort((a, b) => (a.node < b.node ? -1 : a.node > b.node ? 1 : a.seq - b.seq));
    return recs.map((r) => wal.encodeRecord(r)).join('\n') + (recs.length ? '\n' : '');
  }

  // Merge an external segment. Idempotent (dedup by txn id). Corrupt lines
  // are skipped and reported via status CORRUPT.
  importSegment(text) {
    const { records, errors } = wal.decodeSegment(text);
    let imported = 0;
    let duplicates = 0;
    const lines = [];
    for (const rec of records) {
      if (this.txns.has(rec.id)) {
        duplicates++;
        continue;
      }
      this.txns.set(rec.id, rec);
      lines.push(wal.encodeRecord(rec));
      imported++;
      this.clock = mergeClocks(this.clock, rec.clock);
      if (rec.node === this.node && rec.seq > this.seq) this.seq = rec.seq;
    }
    if (lines.length) {
      fs.appendFileSync(path.join(this.dir, 'wal.log'), lines.join('\n') + '\n');
    }
    this._rebuild();
    this._persistMeta();
    return {
      status: errors.length ? 'CORRUPT' : 'OK',
      imported,
      duplicates,
      skipped: errors.length,
      errors,
    };
  }

  check() {
    return history.check([...this.txns.values()]);
  }
}

module.exports = { Store };
