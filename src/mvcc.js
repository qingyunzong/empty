import fs from 'node:fs';
import path from 'node:path';

export class MvccError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MvccError';
    this.code = code;
  }
}

const WAL_NAME = 'wal.log';

function normalizeValue(value) {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return value;
  if (value instanceof Uint8Array) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

// Latest version with version.seq <= seq, or undefined.
function visibleAt(chain, seq) {
  let lo = 0;
  let hi = chain.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (chain[mid].seq <= seq) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans === -1 ? undefined : chain[ans];
}

export class ReadTxn {
  constructor(store, snapshotSeq) {
    this.store = store;
    this.snapshotSeq = snapshotSeq;
    this.closed = false;
    store._activeReads.add(this);
  }

  _check() {
    if (this.closed) throw new MvccError('TXN_CLOSED', 'read transaction is closed');
  }

  // Returns Buffer, or null when the key is absent/deleted at the snapshot.
  get(key) {
    this._check();
    const chain = this.store.versions.get(key);
    if (!chain) return null;
    const version = visibleAt(chain, this.snapshotSeq);
    if (!version || version.value === null) return null;
    return version.value;
  }

  // Yields [key, Buffer] pairs visible at the snapshot, sorted by key.
  *entries() {
    this._check();
    const keys = [...this.store.versions.keys()].sort();
    for (const key of keys) {
      const value = this.get(key);
      if (value !== null) yield [key, value];
    }
  }

  close() {
    if (!this.closed) {
      this.closed = true;
      this.store._activeReads.delete(this);
    }
  }
}

export class WriteTxn {
  constructor(store) {
    this.store = store;
    this.startSeq = store.seq;
    this.writes = new Map();
    this.done = false;
  }

  set(key, value) {
    if (this.done) throw new MvccError('TXN_CLOSED', 'write transaction already finished');
    this.writes.set(key, normalizeValue(value));
    return this;
  }

  delete(key) {
    if (this.done) throw new MvccError('TXN_CLOSED', 'write transaction already finished');
    this.writes.set(key, null);
    return this;
  }

  // First-writer-wins: if any key in the write set was committed by another
  // transaction after this one began, the commit fails with CONFLICT and
  // nothing is applied; the transaction may be retried safely.
  commit() {
    if (this.done) throw new MvccError('TXN_CLOSED', 'write transaction already finished');
    this.done = true;
    for (const key of this.writes.keys()) {
      const chain = this.store.versions.get(key);
      if (chain && chain[chain.length - 1].seq > this.startSeq) {
        throw new MvccError(
          'CONFLICT',
          `write conflict on key "${key}": a newer version was committed after this transaction began`,
        );
      }
    }
    const seq = ++this.store.seq;
    const writes = [...this.writes.entries()].map(([key, value]) => [
      key,
      value === null ? null : value.toString('base64'),
    ]);
    this.store._append({ t: 'commit', seq, writes });
    for (const [key, value] of this.writes) {
      let chain = this.store.versions.get(key);
      if (!chain) {
        chain = [];
        this.store.versions.set(key, chain);
      }
      chain.push({ seq, value });
    }
    return seq;
  }
}

export class MVCCStore {
  static open(dir) {
    return new MVCCStore(dir);
  }

  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.walPath = path.join(dir, WAL_NAME);
    this.versions = new Map(); // key -> [{seq, value: Buffer|null}], sorted by seq
    this.tags = new Map(); // name -> seq
    this.seq = 0;
    this._activeReads = new Set();
    this._recover();
    this._fd = fs.openSync(this.walPath, 'a');
  }

  _recover() {
    if (!fs.existsSync(this.walPath)) return;
    const data = fs.readFileSync(this.walPath);
    let end = data.length;
    // A record is only durable once its terminating newline is fsynced; a
    // trailing partial line is a torn write from a crash and is truncated.
    if (end > 0 && data[end - 1] !== 0x0a) {
      const lastNewline = data.lastIndexOf(0x0a);
      end = lastNewline === -1 ? 0 : lastNewline + 1;
      fs.truncateSync(this.walPath, end);
    }
    const text = data.subarray(0, end).toString('utf8');
    for (const line of text.split('\n')) {
      if (!line) continue;
      this._apply(JSON.parse(line));
    }
  }

  _apply(rec) {
    if (rec.t === 'commit') {
      this.seq = Math.max(this.seq, rec.seq);
      for (const [key, b64] of rec.writes) {
        const value = b64 === null ? null : Buffer.from(b64, 'base64');
        let chain = this.versions.get(key);
        if (!chain) {
          chain = [];
          this.versions.set(key, chain);
        }
        chain.push({ seq: rec.seq, value });
      }
    } else if (rec.t === 'tag') {
      this.tags.set(rec.name, rec.seq);
    } else if (rec.t === 'meta') {
      this.seq = Math.max(this.seq, rec.seq);
    }
  }

  _append(rec) {
    fs.writeSync(this._fd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this._fd);
  }

  // Rewrite the WAL as a compact checkpoint of the surviving versions.
  _checkpoint() {
    const tmpPath = this.walPath + '.tmp';
    const fd = fs.openSync(tmpPath, 'w');
    const all = [];
    for (const [key, chain] of this.versions) {
      for (const version of chain) all.push([version.seq, key, version.value]);
    }
    all.sort((a, b) => a[0] - b[0]);
    let i = 0;
    while (i < all.length) {
      const seq = all[i][0];
      const writes = [];
      while (i < all.length && all[i][0] === seq) {
        writes.push([all[i][1], all[i][2] === null ? null : all[i][2].toString('base64')]);
        i += 1;
      }
      fs.writeSync(fd, JSON.stringify({ t: 'commit', seq, writes }) + '\n');
    }
    for (const [name, seq] of this.tags) {
      fs.writeSync(fd, JSON.stringify({ t: 'tag', name, seq }) + '\n');
    }
    fs.writeSync(fd, JSON.stringify({ t: 'meta', seq: this.seq }) + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpPath, this.walPath);
    fs.closeSync(this._fd);
    this._fd = fs.openSync(this.walPath, 'a');
    const dirFd = fs.openSync(this.dir, 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  }

  // Open a read transaction pinned to the current sequence, or to the
  // sequence registered under `options.tag`. Unknown tags raise NO_TAG.
  beginRead(options = {}) {
    const { tag } = options;
    let snapshotSeq;
    if (tag !== undefined) {
      if (!this.tags.has(tag)) {
        throw new MvccError('NO_TAG', `no such snapshot tag: ${tag}`);
      }
      snapshotSeq = this.tags.get(tag);
    } else {
      snapshotSeq = this.seq;
    }
    return new ReadTxn(this, snapshotSeq);
  }

  beginWrite() {
    return new WriteTxn(this);
  }

  // Convenience helper: run fn(tx) in a write transaction, retrying on
  // CONFLICT up to maxRetries times.
  transact(fn, maxRetries = 16) {
    for (let attempt = 0; ; attempt += 1) {
      const tx = this.beginWrite();
      try {
        fn(tx);
        return tx.commit();
      } catch (err) {
        if (err instanceof MvccError && err.code === 'CONFLICT' && attempt < maxRetries) {
          continue;
        }
        throw err;
      }
    }
  }

  // Register the current sequence as a named, reproducible snapshot.
  snapshot(name) {
    if (!name || typeof name !== 'string') {
      throw new MvccError('BAD_TAG', 'snapshot tag name must be a non-empty string');
    }
    const seq = this.seq;
    this._append({ t: 'tag', name, seq });
    this.tags.set(name, seq);
    return seq;
  }

  _protectedSeqs() {
    const seqs = [...this.tags.values()];
    for (const tx of this._activeReads) seqs.push(tx.snapshotSeq);
    return seqs;
  }

  // Remove versions no longer visible to the current state, any tag, or any
  // active read transaction. If beforeSeq would reach into the oldest
  // protected snapshot, the request is refused with GC_REFUSED.
  gc(beforeSeq = this.seq) {
    const protectedSeqs = this._protectedSeqs();
    if (protectedSeqs.length > 0 && beforeSeq > Math.min(...protectedSeqs)) {
      throw new MvccError(
        'GC_REFUSED',
        `gc horizon ${beforeSeq} would reclaim versions referenced by a tag or active read transaction (oldest protected seq ${Math.min(...protectedSeqs)})`,
      );
    }
    const keepSnapshots = [...protectedSeqs, this.seq];
    let collected = 0;
    for (const [key, chain] of this.versions) {
      const keep = new Set();
      for (const snapshotSeq of keepSnapshots) {
        const version = visibleAt(chain, snapshotSeq);
        if (version) keep.add(version);
      }
      const survivors = chain.filter((version) => keep.has(version) || version.seq > beforeSeq);
      collected += chain.length - survivors.length;
      if (survivors.length === 0) {
        this.versions.delete(key);
      } else {
        this.versions.set(key, survivors);
      }
    }
    this._checkpoint();
    return collected;
  }

  close() {
    if (this._fd !== undefined) {
      fs.fsyncSync(this._fd);
      fs.closeSync(this._fd);
      this._fd = undefined;
    }
  }
}
