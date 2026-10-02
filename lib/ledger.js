'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { crc32 } = require('./crc32');
const { selectPayments } = require('./selection');

const GENESIS_HASH = '0'.repeat(64);

class BizError extends Error {}

// Deterministic JSON encoding (object keys sorted recursively).
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function atomicWrite(file, data) {
  const tmp = file + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (e) {
    if (e.code === 'ENOENT') return null;
    throw e;
  }
}

function blockFileName(batch) {
  return String(batch).padStart(6, '0') + '.blk';
}

// Block file layout: "CRC32:<8 hex>\n<canonical JSON body>".
// CRC32 and the chain hash are both computed over the body bytes.
function encodeBlock(body) {
  const bodyStr = canonical(body);
  const crc = crc32(Buffer.from(bodyStr, 'utf8')).toString(16).padStart(8, '0');
  return 'CRC32:' + crc + '\n' + bodyStr;
}

function decodeBlock(data) {
  const text = Buffer.isBuffer(data) ? data.toString('utf8') : String(data);
  const nl = text.indexOf('\n');
  if (nl < 0) throw new BizError('malformed block: missing CRC header');
  const header = text.slice(0, nl);
  const bodyStr = text.slice(nl + 1);
  const m = /^CRC32:([0-9a-f]{8})$/.exec(header);
  if (!m) throw new BizError('malformed block: bad CRC header');
  const actual = crc32(Buffer.from(bodyStr, 'utf8')).toString(16).padStart(8, '0');
  if (actual !== m[1]) {
    throw new BizError(`CRC32 mismatch: header ${m[1]}, computed ${actual}`);
  }
  return JSON.parse(bodyStr);
}

function hashBody(body) {
  return crypto.createHash('sha256').update(Buffer.from(canonical(body), 'utf8')).digest('hex');
}

class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.blocksDir = path.join(dir, 'blocks');
    this.stateFile = path.join(dir, 'state.json');
    this.indexFile = path.join(dir, 'index.json');
    fs.mkdirSync(this.blocksDir, { recursive: true });
    this.state = readJson(this.stateFile) || { accounts: {}, payments: {}, queue: [], appliedBatch: 0 };
    this.index = readJson(this.indexFile) || { batches: [] };
    this._catchUp();
  }

  _saveState() {
    atomicWrite(this.stateFile, JSON.stringify(this.state, null, 2));
  }

  _saveIndex() {
    atomicWrite(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  _listBlockFiles() {
    return fs
      .readdirSync(this.blocksDir)
      .filter((f) => /^\d{6}\.blk$/.test(f))
      .map((f) => ({ file: f, batch: parseInt(f.slice(0, 6), 10) }))
      .sort((a, b) => a.batch - b.batch);
  }

  // Block files whose batch number is beyond the confirmed index.
  _orphans() {
    const confirmed = this.index.batches.length;
    return this._listBlockFiles().filter((b) => b.batch > confirmed);
  }

  _readBlock(batch) {
    return decodeBlock(fs.readFileSync(path.join(this.blocksDir, blockFileName(batch))));
  }

  // Incremental decoding: given a reader cursor { nextBatch, prevHash },
  // decode and validate the next block, returning its body, hash and the
  // cursor advanced to the following batch.
  decodeNext(reader) {
    const body = this._readBlock(reader.nextBatch);
    if (body.batch !== reader.nextBatch) {
      throw new BizError(`batch number mismatch: expected ${reader.nextBatch}, body says ${body.batch}`);
    }
    if (body.prevHash !== reader.prevHash) {
      throw new BizError(`prevHash mismatch at batch ${reader.nextBatch}`);
    }
    const hash = hashBody(body);
    return { body, hash, next: { nextBatch: reader.nextBatch + 1, prevHash: hash } };
  }

  // Apply confirmed (indexed) batches whose effects are not yet reflected in
  // the state file. This is the incremental catch-up path after a crash that
  // happened between the index update and the state update.
  _catchUp() {
    let advanced = false;
    while (this.state.appliedBatch < this.index.batches.length) {
      const entry = this.index.batches[this.state.appliedBatch];
      if (entry.batch !== this.state.appliedBatch + 1) {
        throw new BizError(`index batch sequence gap at position ${this.state.appliedBatch}`);
      }
      const prevHash = this.state.appliedBatch === 0
        ? GENESIS_HASH
        : this.index.batches[this.state.appliedBatch - 1].hash;
      const { body, hash } = this.decodeNext({ nextBatch: entry.batch, prevHash });
      if (hash !== entry.hash) {
        throw new BizError(`index hash mismatch at batch ${entry.batch}`);
      }
      this._applyBlock(body, hash);
      this.state.appliedBatch = entry.batch;
      advanced = true;
    }
    if (advanced) this._saveState();
  }

  _applyBlock(body, hash) {
    if (body.type === 'settle') {
      for (const d of body.deltas) {
        const p = this.state.payments[d.id];
        if (!p) throw new BizError(`block ${body.batch} references unknown payment ${d.id}`);
        if (p.status === 'settled' && p.settleHash === hash) continue; // idempotent
        const acct = this.state.accounts[p.account];
        acct.frozen -= p.amount;
        acct.budget -= p.amount;
        p.status = 'settled';
        p.settleBatch = body.batch;
        p.settleHash = hash;
        this.state.queue = this.state.queue.filter((x) => x !== d.id);
      }
    } else if (body.type === 'refund') {
      for (const d of body.deltas) {
        const p = this.state.payments[d.id];
        if (!p) throw new BizError(`block ${body.batch} references unknown payment ${d.id}`);
        if (p.status === 'refunded') continue; // idempotent
        p.status = 'refunded';
        p.refundBatch = body.batch;
        this.state.accounts[p.account].budget += p.amount;
      }
    } else {
      throw new BizError(`unknown block type: ${body.type}`);
    }
  }

  _accountView(account) {
    const acct = this.state.accounts[account];
    if (!acct) return null;
    return { account, budget: acct.budget, frozen: acct.frozen, available: acct.budget - acct.frozen };
  }

  snapshot() {
    const accounts = {};
    for (const id of Object.keys(this.state.accounts)) accounts[id] = this._accountView(id);
    return {
      accounts,
      queue: this.state.queue.slice(),
      appliedBatch: this.state.appliedBatch,
      confirmedBatches: this.index.batches.length,
    };
  }

  // Create an account or set its total budget. Freezing only affects the
  // available budget: lowering the budget below the frozen amount is allowed
  // and simply drives the available budget negative.
  freeze(account, budget) {
    if (!Number.isSafeInteger(budget) || budget < 0) {
      throw new BizError('budget must be a non-negative integer');
    }
    const acct = this.state.accounts[account] || { budget: 0, frozen: 0 };
    acct.budget = budget;
    this.state.accounts[account] = acct;
    this._saveState();
    return this._accountView(account);
  }

  // Queue a payment and freeze its amount against the account budget.
  // Re-enqueueing an existing payment ID is an idempotent no-op.
  enqueue(id, account, amount) {
    if (!Number.isSafeInteger(amount) || amount <= 0) {
      throw new BizError('amount must be a positive integer');
    }
    const existing = this.state.payments[id];
    if (existing) {
      return { id, status: existing.status, idempotent: true, account: this._accountView(existing.account) };
    }
    const acct = this.state.accounts[account];
    if (!acct) throw new BizError(`unknown account: ${account} (set a budget via freeze first)`);
    const available = acct.budget - acct.frozen;
    if (amount > available) {
      throw new BizError(`insufficient available budget on ${account}: need ${amount}, available ${available}`);
    }
    this.state.payments[id] = { id, account, amount, status: 'queued' };
    this.state.queue.push(id);
    acct.frozen += amount;
    this._saveState();
    return { id, status: 'queued', idempotent: false, account: this._accountView(account) };
  }

  // Cancel a queued payment, immediately releasing its freeze. Cancelling an
  // already-cancelled payment is a no-op; settled payments must be refunded.
  cancel(id) {
    const p = this.state.payments[id];
    if (!p) throw new BizError(`unknown payment: ${id}`);
    if (p.status === 'cancelled') {
      return { id, status: 'cancelled', idempotent: true, account: this._accountView(p.account) };
    }
    if (p.status === 'settled') {
      throw new BizError(`payment ${id} already settled in batch ${p.settleBatch}; use refund`);
    }
    if (p.status === 'refunded') {
      throw new BizError(`payment ${id} already refunded; cannot cancel`);
    }
    this.state.accounts[p.account].frozen -= p.amount;
    p.status = 'cancelled';
    this.state.queue = this.state.queue.filter((x) => x !== id);
    this._saveState();
    return { id, status: 'cancelled', idempotent: false, account: this._accountView(p.account) };
  }

  _assertNoOrphans() {
    const orphans = this._orphans();
    if (orphans.length) {
      throw new BizError(
        `unconfirmed block files present (${orphans.map((o) => o.file).join(', ')}); run recover first`
      );
    }
  }

  // Select the maximal fully-settlable set of queued payments (per-account
  // capacity = current budget) and commit a settlement block.
  settle() {
    this._assertNoOrphans();
    const queued = this.state.queue.map((id) => this.state.payments[id]);
    if (!queued.length) throw new BizError('no queued payments to settle');
    const capacities = new Map();
    for (const p of queued) {
      if (!capacities.has(p.account)) capacities.set(p.account, this.state.accounts[p.account].budget);
    }
    const { selected, rejected } = selectPayments(queued, capacities);
    if (!selected.length) throw new BizError('no queued payment fits the current budgets');
    const byId = new Map(queued.map((p) => [p.id, p]));
    const deltas = selected.map((id) => {
      const p = byId.get(id);
      return { id: p.id, account: p.account, amount: p.amount };
    });
    return this._commitBlock({ type: 'settle', deltas, rejected });
  }

  // Refund a settled payment: commits a reverse block referencing the hash of
  // the original settlement block and restores the account budget.
  refund(id) {
    this._assertNoOrphans();
    const p = this.state.payments[id];
    if (!p) throw new BizError(`unknown payment: ${id}`);
    if (p.status === 'refunded') {
      return { id, status: 'refunded', idempotent: true, account: this._accountView(p.account) };
    }
    if (p.status !== 'settled') {
      throw new BizError(`payment ${id} is ${p.status}; only settled payments can be refunded`);
    }
    const committed = this._commitBlock({
      type: 'refund',
      ref: p.settleHash,
      deltas: [{ id: p.id, account: p.account, amount: p.amount }],
      rejected: [],
    });
    return { ...committed, id, status: 'refunded', idempotent: false, account: this._accountView(p.account) };
  }

  // Commit order: block body file -> index -> state. A crash after the body
  // write leaves an orphan block that recover() can admit; a crash after the
  // index write is healed by the incremental catch-up on next open.
  _commitBlock(fields) {
    const batch = this.index.batches.length + 1;
    const prevHash = batch === 1 ? GENESIS_HASH : this.index.batches[batch - 2].hash;
    const file = blockFileName(batch);
    const body = {
      batch,
      prevHash,
      ...fields,
      index: { file, next: blockFileName(batch + 1) },
    };
    fs.writeFileSync(path.join(this.blocksDir, file), encodeBlock(body));
    const hash = hashBody(body);
    this.index.batches.push({ batch, hash, file });
    this._saveIndex();
    this._applyBlock(body, hash);
    this.state.appliedBatch = batch;
    this._saveState();
    return { batch, hash, body };
  }

  // Admit orphan block bodies (written before a crash, never indexed) after
  // validating CRC32, batch sequence and chain linkage. Stops at the first
  // invalid block: that batch and everything after it stays unavailable and
  // the confirmed prefix (budgets included) is left untouched.
  recover() {
    const admitted = [];
    let failed = null;
    let prevHash = this.index.batches.length === 0
      ? GENESIS_HASH
      : this.index.batches[this.index.batches.length - 1].hash;
    for (const orphan of this._orphans()) {
      const expected = this.index.batches.length + 1;
      try {
        if (orphan.batch !== expected) {
          throw new BizError(`unexpected batch number: ${orphan.file}, expected ${blockFileName(expected)}`);
        }
        const body = this._readBlock(orphan.batch); // CRC32 verified here
        if (body.prevHash !== prevHash) {
          throw new BizError(`prevHash mismatch at batch ${orphan.batch}`);
        }
        const hash = hashBody(body);
        this.index.batches.push({ batch: orphan.batch, hash, file: orphan.file });
        this._saveIndex();
        this._applyBlock(body, hash);
        this.state.appliedBatch = orphan.batch;
        this._saveState();
        prevHash = hash;
        admitted.push({ batch: orphan.batch, hash });
      } catch (e) {
        failed = { batch: orphan.batch, file: orphan.file, reason: e.message };
        break;
      }
    }
    return { admitted, failed, confirmed: this.index.batches.length };
  }

  // Verify the confirmed chain: CRC32 of every block, batch sequence,
  // prevHash linkage and index hashes. Unconfirmed orphan files make the
  // ledger fail verification until recover() runs.
  verify() {
    const errors = [];
    let prevHash = GENESIS_HASH;
    this.index.batches.forEach((entry, i) => {
      const expectedBatch = i + 1;
      if (entry.batch !== expectedBatch) {
        errors.push(`index entry ${i}: batch ${entry.batch}, expected ${expectedBatch}`);
        return;
      }
      if (entry.file !== blockFileName(entry.batch)) {
        errors.push(`index entry ${i}: unexpected file name ${entry.file}`);
        return;
      }
      let body;
      try {
        body = this._readBlock(entry.batch);
      } catch (e) {
        errors.push(`batch ${entry.batch}: ${e.message}`);
        return;
      }
      if (body.prevHash !== prevHash) errors.push(`batch ${entry.batch}: prevHash mismatch`);
      if (hashBody(body) !== entry.hash) errors.push(`batch ${entry.batch}: hash mismatch with index`);
      prevHash = entry.hash;
    });
    const orphans = this._orphans();
    if (orphans.length) {
      errors.push(`unconfirmed block files present: ${orphans.map((o) => o.file).join(', ')} (run recover)`);
    }
    return {
      ok: errors.length === 0,
      batches: this.index.batches.length,
      orphans: orphans.map((o) => o.file),
      errors,
    };
  }

  getBatch(n) {
    if (!Number.isSafeInteger(n) || n < 1 || n > this.index.batches.length) {
      throw new BizError(`batch ${n} not in confirmed chain (1..${this.index.batches.length})`);
    }
    const body = this._readBlock(n);
    if (hashBody(body) !== this.index.batches[n - 1].hash) {
      throw new BizError(`batch ${n}: hash mismatch with index`);
    }
    return body;
  }
}

module.exports = {
  Ledger,
  BizError,
  GENESIS_HASH,
  canonical,
  atomicWrite,
  blockFileName,
  encodeBlock,
  decodeBlock,
  hashBody,
};
