import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';

export const WAL_FILE = 'wal.log';
export const GENESIS_HASH = '0'.repeat(64);

export function sha256hex(input) {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export class StoreError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

const OP_TYPES = new Set(['payment', 'settlement', 'reversal']);

// Digest covers exactly the five certificate fields, canonically serialized.
export function certificateDigest(cert) {
  return sha256hex(
    canonicalize({
      version: cert.version,
      parentVersion: cert.parentVersion,
      snapshotVersion: cert.snapshotVersion,
      opHash: cert.opHash,
      prevHash: cert.prevHash,
    }),
  );
}

export function opDigest(op) {
  return sha256hex(canonicalize(op));
}

export class Store {
  static open(dir) {
    const store = new Store(dir);
    store._load();
    return store;
  }

  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, WAL_FILE);
    this.head = 0;
    this.headDigest = GENESIS_HASH;
    // id -> [{ version, record }] ascending by version (MVCC history, never deleted)
    this.history = new Map();
    // party -> Set of txn ids (secondary index)
    this.partyIndex = new Map();
    this._queue = Promise.resolve();
    this._fd = null;
  }

  _load() {
    fs.mkdirSync(this.dir, { recursive: true });
    const result = verify(this.dir);
    if (!result.ok) {
      throw new StoreError(result.code, `WAL verification failed at seq ${result.seq} (${result.field})`, result);
    }
    let lines = [];
    try {
      lines = fs.readFileSync(this.walPath, 'utf8').split('\n').filter((l) => l.length > 0);
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    for (const line of lines) this._apply(JSON.parse(line));
    this._fd = fs.openSync(this.walPath, 'a');
  }

  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }

  // Optimistic-concurrency snapshot handle for commit().
  begin() {
    return { store: this, version: this.head };
  }

  commit(opInput, snapshot = null) {
    const snap = snapshot ?? this.begin();
    const run = this._queue.then(() => this._commitNow(opInput, snap));
    // Keep the queue alive regardless of individual commit failures.
    this._queue = run.then(() => undefined, () => undefined);
    return run;
  }

  _commitNow(opInput, snap) {
    if (!snap || snap.store !== this || snap.version !== this.head) {
      throw new StoreError(
        'E_CONFLICT',
        `stale snapshot: expected version ${snap ? snap.version : '?'}, head is ${this.head}`,
      );
    }
    const op = this._normalize(opInput);
    const version = this.head + 1;
    const cert = {
      version,
      parentVersion: this.head,
      snapshotVersion: snap.version,
      opHash: opDigest(op),
      prevHash: this.headDigest,
    };
    cert.digest = certificateDigest(cert);
    const record = { seq: version, ...cert, op };
    // Append-only WAL: one JSON record per line, fsync before acknowledging.
    const bytes = Buffer.from(JSON.stringify(record) + '\n', 'utf8');
    fs.writeSync(this._fd, bytes, 0, bytes.length);
    fs.fsyncSync(this._fd);
    this._apply(record);
    return cert;
  }

  _normalize(op) {
    if (!op || typeof op !== 'object') {
      throw new StoreError('E_INVALID', 'op must be an object');
    }
    if (!OP_TYPES.has(op.type)) {
      throw new StoreError('E_INVALID', `unknown op type: ${op.type}`);
    }
    if (op.type === 'reversal') {
      if (typeof op.ref !== 'string' || op.ref.length === 0) {
        throw new StoreError('E_INVALID', 'reversal requires a ref id');
      }
      const original = this._latest(op.ref);
      if (!original) {
        throw new StoreError('E_NOT_FOUND', `no such transaction: ${op.ref}`);
      }
      if (original.status === 'reversed') {
        throw new StoreError('E_STATE', `transaction ${op.ref} is already reversed`);
      }
      const id = op.id ?? `rev:${op.ref}`;
      if (this._latest(id)) {
        throw new StoreError('E_DUPLICATE', `duplicate transaction id: ${id}`);
      }
      // Reverse entry: mirror the original with negated amount.
      return {
        type: 'reversal',
        id,
        ref: op.ref,
        party: original.party,
        amount: -original.amount,
        currency: original.currency,
      };
    }
    if (typeof op.id !== 'string' || op.id.length === 0) {
      throw new StoreError('E_INVALID', 'op requires a string id');
    }
    if (this._latest(op.id)) {
      throw new StoreError('E_DUPLICATE', `duplicate transaction id: ${op.id}`);
    }
    if (typeof op.party !== 'string' || op.party.length === 0) {
      throw new StoreError('E_INVALID', 'op requires a string party');
    }
    if (typeof op.amount !== 'number' || !Number.isFinite(op.amount) || op.amount === 0) {
      throw new StoreError('E_INVALID', 'op requires a non-zero finite amount');
    }
    if (typeof op.currency !== 'string' || op.currency.length === 0) {
      throw new StoreError('E_INVALID', 'op requires a currency');
    }
    return {
      type: op.type,
      id: op.id,
      party: op.party,
      amount: op.amount,
      currency: op.currency,
    };
  }

  _apply(record) {
    const { op, version } = record;
    if (op.type === 'reversal') {
      const original = this._latest(op.ref);
      this._pushVersion(op.ref, { ...original, status: 'reversed', reversedBy: op.id }, version);
      this._pushVersion(
        op.id,
        {
          id: op.id,
          type: 'reversal',
          ref: op.ref,
          party: op.party,
          amount: op.amount,
          currency: op.currency,
          status: 'active',
        },
        version,
      );
      this._indexParty(op.party, op.id);
    } else {
      this._pushVersion(
        op.id,
        {
          id: op.id,
          type: op.type,
          party: op.party,
          amount: op.amount,
          currency: op.currency,
          status: 'active',
        },
        version,
      );
      this._indexParty(op.party, op.id);
    }
    this.head = version;
    this.headDigest = record.digest;
  }

  _pushVersion(id, record, version) {
    let list = this.history.get(id);
    if (!list) {
      list = [];
      this.history.set(id, list);
    }
    list.push({ version, record });
  }

  _indexParty(party, id) {
    let set = this.partyIndex.get(party);
    if (!set) {
      set = new Set();
      this.partyIndex.set(party, set);
    }
    set.add(id);
  }

  _latest(id) {
    return this.getAt(id, this.head);
  }

  // As-of query: state of txn `id` visible at `version` (defaults to head).
  getAt(id, version = this.head) {
    const list = this.history.get(id);
    if (!list) return null;
    let found = null;
    for (const entry of list) {
      if (entry.version > version) break;
      found = entry.record;
    }
    return found;
  }

  // Secondary-index query: all records of `party` visible at `version`.
  auditParty(party, version = this.head) {
    const ids = this.partyIndex.get(party);
    if (!ids) return [];
    const out = [];
    for (const id of ids) {
      const record = this.getAt(id, version);
      if (record) out.push(record);
    }
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    return out;
  }
}

// Full offline verification of a data directory: parse every WAL record,
// recompute canonical op hashes and certificate digests, check chain links.
// Returns { ok: true, versions, head } or { ok: false, code: 'E_TAMPER', seq, field }.
export function verify(dir) {
  const walPath = path.join(dir, WAL_FILE);
  let lines;
  try {
    lines = fs.readFileSync(walPath, 'utf8').split('\n').filter((l) => l.length > 0);
  } catch (err) {
    if (err.code === 'ENOENT') return { ok: true, versions: 0, head: GENESIS_HASH };
    throw err;
  }
  let prevHash = GENESIS_HASH;
  for (let i = 0; i < lines.length; i++) {
    const seq = i + 1;
    let rec;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      return { ok: false, code: 'E_TAMPER', seq, field: 'parse' };
    }
    const checks = [
      ['seq', rec.seq === seq],
      ['version', rec.version === seq],
      ['parentVersion', rec.parentVersion === seq - 1],
      ['snapshotVersion', rec.snapshotVersion === seq - 1],
      ['prevHash', rec.prevHash === prevHash],
      ['opHash', typeof rec.op === 'object' && rec.op !== null && rec.opHash === opDigest(rec.op)],
      ['digest', rec.digest === certificateDigest(rec)],
    ];
    for (const [field, pass] of checks) {
      if (!pass) return { ok: false, code: 'E_TAMPER', seq, field };
    }
    prevHash = rec.digest;
  }
  return { ok: true, versions: lines.length, head: prevHash };
}
