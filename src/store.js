import fs from 'node:fs';
import path from 'node:path';

export const CONFLICT = 'CONFLICT';
export const NO_TAG = 'NO_TAG';
export const GC_REFUSED = 'GC_REFUSED';

export class MvccError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'MvccError';
    this.code = code;
  }
}

const WAL_FILE = 'wal.log';
const WAL_TMP = 'wal.tmp';

function toBuffer(value) {
  if (value === null) return null;
  if (Buffer.isBuffer(value)) return Buffer.from(value);
  return Buffer.from(String(value), 'utf8');
}

export class MvccStore {
  constructor(dir) {
    this._dir = dir;
    this._walFd = -1;
    this._commitSeq = 0;
    // key -> [{ seq, value: Buffer|null }] ascending by seq; null value = tombstone
    this._versions = new Map();
    this._tags = new Map();
    // snapshotSeq -> open read-transaction count
    this._pinned = new Map();
  }

  static open(dir) {
    fs.mkdirSync(dir, { recursive: true });
    const store = new MvccStore(dir);
    const walPath = path.join(dir, WAL_FILE);
    if (fs.existsSync(walPath)) {
      const content = fs.readFileSync(walPath, 'utf8');
      for (const line of content.split('\n')) {
        if (!line) continue;
        let rec;
        try {
          rec = JSON.parse(line);
        } catch {
          break; // tolerate a torn tail record after a crash
        }
        store._apply(rec);
      }
    }
    store._walFd = fs.openSync(walPath, 'a');
    return store;
  }

  get commitSeq() {
    return this._commitSeq;
  }

  _apply(rec) {
    switch (rec.t) {
      case 'checkpoint':
        this._commitSeq = rec.seq;
        this._versions = new Map(
          rec.versions.map(([key, arr]) => [
            key,
            arr.map(([seq, b64]) => ({
              seq,
              value: b64 === null ? null : Buffer.from(b64, 'base64'),
            })),
          ])
        );
        this._tags = new Map(rec.tags);
        break;
      case 'commit': {
        this._commitSeq = rec.seq;
        for (const [key, b64] of rec.writes) {
          const value = b64 === null ? null : Buffer.from(b64, 'base64');
          let arr = this._versions.get(key);
          if (!arr) {
            arr = [];
            this._versions.set(key, arr);
          }
          arr.push({ seq: rec.seq, value });
        }
        break;
      }
      case 'tag':
        this._tags.set(rec.name, rec.seq);
        break;
      case 'untag':
        this._tags.delete(rec.name);
        break;
    }
  }

  _append(rec) {
    fs.writeSync(this._walFd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(this._walFd);
  }

  _visibleAt(key, seq) {
    const arr = this._versions.get(key);
    if (!arr) return undefined;
    for (let i = arr.length - 1; i >= 0; i--) {
      if (arr[i].seq <= seq) return arr[i].value === null ? undefined : arr[i].value;
    }
    return undefined;
  }

  _keysAt(seq) {
    const out = [];
    for (const key of this._versions.keys()) {
      if (this._visibleAt(key, seq) !== undefined) out.push(key);
    }
    return out.sort();
  }

  _beginAt(seq) {
    this._pinned.set(seq, (this._pinned.get(seq) || 0) + 1);
    let closed = false;
    return {
      snapshotSeq: seq,
      get: (key) => this._visibleAt(key, seq),
      keys: () => this._keysAt(seq),
      close: () => {
        if (closed) return;
        closed = true;
        const n = (this._pinned.get(seq) || 0) - 1;
        if (n <= 0) this._pinned.delete(seq);
        else this._pinned.set(seq, n);
      },
    };
  }

  begin() {
    return this._beginAt(this._commitSeq);
  }

  beginTag(name) {
    if (!this._tags.has(name)) {
      throw new MvccError(NO_TAG, `no such tag: ${name}`);
    }
    return this._beginAt(this._tags.get(name));
  }

  beginWrite() {
    const store = this;
    const snapshotSeq = this._commitSeq;
    const writes = new Map();
    let done = false;
    return {
      snapshotSeq,
      get(key) {
        if (writes.has(key)) {
          const v = writes.get(key);
          return v === null ? undefined : v;
        }
        return store._visibleAt(key, snapshotSeq);
      },
      set(key, value) {
        writes.set(key, toBuffer(value));
      },
      delete(key) {
        writes.set(key, null);
      },
      commit() {
        if (done) throw new MvccError('TX_CLOSED', 'transaction already finished');
        done = true;
        // First-writer-wins: abort if any key we write was committed after our snapshot.
        for (const key of writes.keys()) {
          const arr = store._versions.get(key);
          if (arr && arr[arr.length - 1].seq > snapshotSeq) {
            throw new MvccError(
              CONFLICT,
              `key "${key}" was modified after this transaction began`
            );
          }
        }
        const seq = ++store._commitSeq;
        store._append({
          t: 'commit',
          seq,
          writes: [...writes].map(([k, v]) => [k, v === null ? null : v.toString('base64')]),
        });
        for (const [k, v] of writes) {
          let arr = store._versions.get(k);
          if (!arr) {
            arr = [];
            store._versions.set(k, arr);
          }
          arr.push({ seq, value: v });
        }
        return seq;
      },
      rollback() {
        done = true;
      },
    };
  }

  commit(writes) {
    const tx = this.beginWrite();
    const entries = writes instanceof Map ? writes : Object.entries(writes);
    for (const [k, v] of entries) {
      if (v === null || v === undefined) tx.delete(k);
      else tx.set(k, v);
    }
    return tx.commit();
  }

  tag(name, seq = this._commitSeq) {
    if (!Number.isInteger(seq) || seq < 0 || seq > this._commitSeq) {
      throw new MvccError('BAD_SEQ', `invalid snapshot seq: ${seq}`);
    }
    this._append({ t: 'tag', name, seq });
    this._tags.set(name, seq);
    return seq;
  }

  untag(name) {
    if (!this._tags.has(name)) {
      throw new MvccError(NO_TAG, `no such tag: ${name}`);
    }
    this._append({ t: 'untag', name });
    this._tags.delete(name);
  }

  tags() {
    return new Map(this._tags);
  }

  gc(beforeSeq = null) {
    const referenced = [];
    for (const seq of this._tags.values()) referenced.push(seq);
    for (const [seq, count] of this._pinned) if (count > 0) referenced.push(seq);
    const minRef = referenced.length ? Math.min(...referenced) : this._commitSeq;
    if (beforeSeq === null) {
      // Safe default: collect only versions no tag or active transaction can see.
      beforeSeq = minRef;
    } else if (beforeSeq > minRef) {
      throw new MvccError(
        GC_REFUSED,
        `refusing to collect versions up to seq ${beforeSeq}: ` +
          `snapshot seq ${minRef} is still referenced by a tag or active transaction`
      );
    }
    let collected = 0;
    for (const [key, arr] of this._versions) {
      const keep = [];
      let floor = null; // newest version with seq <= beforeSeq
      for (const v of arr) {
        if (v.seq <= beforeSeq) floor = v;
        else keep.push(v);
      }
      let next = floor ? [floor, ...keep] : keep;
      // A lone tombstone floor carries no information for seq >= beforeSeq.
      if (next.length === 1 && next[0].value === null) next = [];
      collected += arr.length - next.length;
      if (next.length === 0) this._versions.delete(key);
      else this._versions.set(key, next);
    }
    this._checkpoint();
    return collected;
  }

  _checkpoint() {
    const rec = {
      t: 'checkpoint',
      seq: this._commitSeq,
      versions: [...this._versions].map(([k, arr]) => [
        k,
        arr.map((v) => [v.seq, v.value === null ? null : v.value.toString('base64')]),
      ]),
      tags: [...this._tags],
    };
    const tmpPath = path.join(this._dir, WAL_TMP);
    const tmpFd = fs.openSync(tmpPath, 'w');
    fs.writeSync(tmpFd, JSON.stringify(rec) + '\n');
    fs.fsyncSync(tmpFd);
    fs.closeSync(tmpFd);
    fs.closeSync(this._walFd);
    fs.renameSync(tmpPath, path.join(this._dir, WAL_FILE));
    this._walFd = fs.openSync(path.join(this._dir, WAL_FILE), 'a');
    const dirFd = fs.openSync(this._dir, 'r');
    fs.fsyncSync(dirFd);
    fs.closeSync(dirFd);
  }

  close() {
    if (this._walFd >= 0) {
      fs.fsyncSync(this._walFd);
      fs.closeSync(this._walFd);
      this._walFd = -1;
    }
  }
}
