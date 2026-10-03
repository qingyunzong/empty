import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { BusinessError, CorruptionError } from './errors.js';
import { certificateFor, certificatesForAll } from './certificate.js';

export const STATUSES = Object.freeze(['pending', 'passed', 'failed', 'quarantined', 'released']);

const WAL_FILE = 'wal.log';

function sha256hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function cloneState(state) {
  return structuredClone(state);
}

function emptyState() {
  return { batches: new Map() };
}

function assertWeight(weight, what) {
  if (typeof weight !== 'number' || !Number.isFinite(weight) || weight <= 0) {
    throw new BusinessError(`${what} must be a positive finite number`);
  }
}

export function effectiveWeight(batch) {
  return batch.weight - batch.consumed;
}

export function collectAncestors(state, id) {
  const out = new Set();
  const start = state.batches.get(id);
  const stack = start ? [...start.parents] : [];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    const b = state.batches.get(cur);
    if (b) for (const p of b.parents) stack.push(p);
  }
  return [...out].sort();
}

export function collectDescendants(state, id) {
  const out = new Set();
  const start = state.batches.get(id);
  const stack = start ? [...start.children] : [];
  while (stack.length) {
    const cur = stack.pop();
    if (out.has(cur)) continue;
    out.add(cur);
    const b = state.batches.get(cur);
    if (b) for (const c of b.children) stack.push(c);
  }
  return [...out].sort();
}

// Validate-then-mutate: a failed op leaves the state untouched.
export function applyOp(state, op) {
  switch (op.type) {
    case 'create': {
      if (!op.id || typeof op.id !== 'string') {
        throw new BusinessError('create: id must be a non-empty string');
      }
      if (state.batches.has(op.id)) throw new BusinessError(`batch already exists: ${op.id}`);
      assertWeight(op.weight, 'create: weight');
      state.batches.set(op.id, {
        id: op.id, weight: op.weight, consumed: 0, status: 'pending', parents: [], children: [],
      });
      return;
    }
    case 'split': {
      const { parents, children } = op;
      if (!Array.isArray(parents) || parents.length === 0) {
        throw new BusinessError('split: parents must be a non-empty array');
      }
      if (!Array.isArray(children) || children.length === 0) {
        throw new BusinessError('split: children must be a non-empty array');
      }
      const parentBatches = parents.map((p) => {
        const b = state.batches.get(p);
        if (!b) throw new BusinessError(`split: unknown parent batch: ${p}`);
        return b;
      });
      const childIds = new Set();
      for (const c of children) {
        if (!c || typeof c.id !== 'string' || !c.id) {
          throw new BusinessError('split: child id must be a non-empty string');
        }
        if (childIds.has(c.id)) throw new BusinessError(`split: duplicate child id: ${c.id}`);
        childIds.add(c.id);
        if (state.batches.has(c.id)) throw new BusinessError(`split: child batch already exists: ${c.id}`);
        assertWeight(c.weight, `split: weight of ${c.id}`);
      }
      // Cyclic ancestry is forbidden: no child may be an ancestor of any parent.
      for (const p of parents) {
        for (const anc of collectAncestors(state, p)) {
          if (childIds.has(anc)) {
            throw new BusinessError(`split: cyclic ancestry forbidden (${anc} is an ancestor of ${p})`);
          }
        }
      }
      // Weight conservation: total output must not exceed total effective parent weight.
      const totalOut = children.reduce((s, c) => s + c.weight, 0);
      const available = parentBatches.reduce((s, b) => s + effectiveWeight(b), 0);
      if (totalOut > available) {
        throw new BusinessError(
          `split: total output weight ${totalOut} exceeds effective parent weight ${available}`,
        );
      }
      let remaining = totalOut;
      for (const b of parentBatches) {
        const take = Math.min(remaining, effectiveWeight(b));
        b.consumed += take;
        remaining -= take;
      }
      for (const c of children) {
        state.batches.set(c.id, {
          id: c.id, weight: c.weight, consumed: 0, status: 'pending', parents: [...parents], children: [],
        });
      }
      for (const b of parentBatches) {
        for (const c of children) b.children.push(c.id);
      }
      return;
    }
    case 'status': {
      const b = state.batches.get(op.id);
      if (!b) throw new BusinessError(`status: unknown batch: ${op.id}`);
      if (!STATUSES.includes(op.status)) throw new BusinessError(`status: invalid status: ${op.status}`);
      b.status = op.status;
      return;
    }
    default:
      throw new BusinessError(`unknown op type: ${op.type}`);
  }
}

function formatRecord(record) {
  const json = JSON.stringify(record);
  return `${sha256hex(json)} ${json}\n`;
}

function parseRecordLine(line) {
  const sp = line.indexOf(' ');
  if (sp <= 0) return null;
  const sum = line.slice(0, sp);
  const json = line.slice(sp + 1);
  if (sha256hex(json) !== sum) return null;
  let record;
  try {
    record = JSON.parse(json);
  } catch {
    return null;
  }
  if (!record || typeof record.txid !== 'number' || typeof record.type !== 'string') return null;
  return record;
}

export class Database {
  // opts.hooks.beforeCommitMarker / afterCommitMarker: test-only crash injection.
  constructor(dir = null, opts = {}) {
    this.dir = dir;
    this.walPath = dir ? path.join(dir, WAL_FILE) : null;
    this.hooks = opts.hooks ?? {};
    this.committed = emptyState();
    this.pending = null;
    this.nextTxid = 1;
    this.fd = null;
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.#recover();
      this.fd = fs.openSync(this.walPath, 'a');
      const dirFd = fs.openSync(dir, 'r');
      fs.fsyncSync(dirFd);
      fs.closeSync(dirFd);
    }
  }

  static open(dir, opts = {}) {
    return new Database(dir, opts);
  }

  static memory() {
    return new Database(null);
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  #recover() {
    if (!fs.existsSync(this.walPath)) return;
    const buf = fs.readFileSync(this.walPath, 'utf8');
    const lines = buf.split('\n');
    const records = [];
    let goodBytes = 0;
    let offset = 0;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const isLast = i === lines.length - 1;
      if (isLast && line === '') {
        goodBytes = offset;
        break;
      }
      const record = parseRecordLine(line);
      if (!record) {
        if (isLast) break; // torn tail from a crashed write: truncate below
        throw new CorruptionError(`wal: malformed record at line ${i + 1}`);
      }
      records.push(record);
      offset += Buffer.byteLength(line) + 1;
      goodBytes = offset;
    }
    if (goodBytes < Buffer.byteLength(buf)) fs.truncateSync(this.walPath, goodBytes);

    const txns = new Map();
    const order = [];
    for (const rec of records) {
      let t = txns.get(rec.txid);
      if (!t) {
        t = { ops: [], committed: false };
        txns.set(rec.txid, t);
        order.push(rec.txid);
      }
      if (rec.type === 'op') {
        if (t.committed) throw new CorruptionError(`wal: op record after commit for txid ${rec.txid}`);
        t.ops.push(rec.op);
      } else if (rec.type === 'commit') {
        if (t.committed) throw new CorruptionError(`wal: duplicate commit for txid ${rec.txid}`);
        t.committed = true;
      } else {
        throw new CorruptionError(`wal: unknown record type: ${rec.type}`);
      }
    }
    for (const txid of order) {
      const t = txns.get(txid);
      this.nextTxid = Math.max(this.nextTxid, txid + 1);
      if (!t.committed) continue; // no commit marker: tentative changes stay invisible
      for (const op of t.ops) {
        try {
          applyOp(this.committed, op);
        } catch (err) {
          throw new CorruptionError(`wal: redo failed for txid ${txid}: ${err.message}`);
        }
      }
    }
  }

  get inTransaction() {
    return this.pending !== null;
  }

  begin() {
    if (this.pending) throw new BusinessError('transaction already active');
    this.pending = {
      txid: this.nextTxid,
      state: cloneState(this.committed),
      savepoints: [],
      ops: [],
    };
  }

  #requireTxn() {
    if (!this.pending) throw new BusinessError('no active transaction');
    return this.pending;
  }

  #mutate(op) {
    const p = this.#requireTxn();
    applyOp(p.state, op);
    p.ops.push(op);
  }

  create({ id, weight }) {
    this.#mutate({ type: 'create', id, weight });
  }

  split({ parents, children }) {
    this.#mutate({
      type: 'split',
      parents,
      children: children?.map((c) => ({ id: c.id, weight: c.weight })),
    });
  }

  setStatus({ id, status }) {
    this.#mutate({ type: 'status', id, status });
  }

  savepoint(name) {
    const p = this.#requireTxn();
    if (!name || typeof name !== 'string') throw new BusinessError('savepoint: name must be a non-empty string');
    p.savepoints.push({ name, snapshot: cloneState(p.state), opsLength: p.ops.length });
  }

  #findSavepoint(p, name) {
    for (let i = p.savepoints.length - 1; i >= 0; i--) {
      if (p.savepoints[i].name === name) return i;
    }
    return -1;
  }

  // RELEASE drops the savepoint boundary (and any savepoints nested after it)
  // but keeps all modifications made since it.
  release(name) {
    const p = this.#requireTxn();
    const idx = this.#findSavepoint(p, name);
    if (idx < 0) throw new BusinessError(`release: unknown savepoint: ${name}`);
    p.savepoints.splice(idx);
  }

  // ROLLBACK TO undoes every split, index and status change made after the
  // savepoint. The named savepoint itself survives and can be reused.
  rollbackTo(name) {
    const p = this.#requireTxn();
    const idx = this.#findSavepoint(p, name);
    if (idx < 0) throw new BusinessError(`rollback: unknown savepoint: ${name}`);
    const sp = p.savepoints[idx];
    p.state = cloneState(sp.snapshot);
    p.ops.length = sp.opsLength;
    p.savepoints.splice(idx + 1);
  }

  commit() {
    const p = this.#requireTxn();
    if (this.fd !== null) {
      let payload = '';
      for (const op of p.ops) payload += formatRecord({ txid: p.txid, type: 'op', op });
      if (payload) {
        fs.writeSync(this.fd, payload);
        fs.fsyncSync(this.fd);
      }
      this.hooks.beforeCommitMarker?.();
      fs.writeSync(this.fd, formatRecord({ txid: p.txid, type: 'commit' }));
      fs.fsyncSync(this.fd);
      this.hooks.afterCommitMarker?.();
    }
    this.committed = p.state;
    this.pending = null;
    this.nextTxid = p.txid + 1;
    return { txid: p.txid, certificates: certificatesForAll(this.committed) };
  }

  abort() {
    this.#requireTxn();
    this.pending = null;
  }

  #visible() {
    return this.pending ? this.pending.state : this.committed;
  }

  #batch(id) {
    const b = this.#visible().batches.get(id);
    if (!b) throw new BusinessError(`unknown batch: ${id}`);
    return b;
  }

  #public(b) {
    return {
      id: b.id,
      weight: b.weight,
      consumed: b.consumed,
      effective: effectiveWeight(b),
      status: b.status,
      parents: [...b.parents],
      children: [...b.children],
    };
  }

  get(id) {
    return this.#public(this.#batch(id));
  }

  children(id) {
    return [...this.#batch(id).children];
  }

  parents(id) {
    return [...this.#batch(id).parents];
  }

  ancestors(id) {
    this.#batch(id);
    return collectAncestors(this.#visible(), id);
  }

  descendants(id) {
    this.#batch(id);
    return collectDescendants(this.#visible(), id);
  }

  certificate(id) {
    this.#batch(id);
    return certificateFor(this.#visible(), id);
  }

  snapshot() {
    return [...this.#visible().batches.values()].map((b) => this.#public(b));
  }
}
