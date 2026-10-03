import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { Wal } from './wal.js';
import { LedgerError, CrashError, E_WAL, E_RECOVER, E_INVARIANT, E_IO } from './errors.js';

const OPS = new Set(['freeze', 'debit', 'release', 'reverse']);

/**
 * Persistent frozen-hold ledger.
 *
 * Transaction protocol (per idempotency key):
 *   1. append `intent`  (full tx descriptor) + fsync   -> crash: PENDING, retryable
 *   2. apply to state, append `applied` + fsync        -> crash: auto-rollback on recovery
 *   3. append `commit` (with result) + fsync           -> crash: effective, replay idempotent
 *
 * Recovery replays committed txs in commit order; applied-but-uncommitted txs
 * are rolled back (abort record appended); intent-only txs stay PENDING and
 * are never judged as failed.
 */
export class Ledger {
  constructor(dir, options = {}) {
    if (!dir) throw new TypeError('Ledger requires a directory');
    this.dir = dir;
    this.faultAfter = options.faultAfter ?? null; // 'intent' | 'applied' | 'commit' (one-shot)
    this.initBalances = options.initBalances ?? null; // genesis credits, only on a fresh WAL
    this.wal = new Wal(path.join(dir, 'wal.log'));
    this.accounts = new Map(); // name -> { balance, frozen }
    this.txs = new Map(); // idempotency key -> tx
    this.isOpen = false;
    this.crashed = false;
  }

  open() {
    if (this.isOpen) return this;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
    } catch (err) {
      throw new LedgerError(E_IO, `cannot create ledger dir ${this.dir}: ${err.message}`, { cause: err });
    }
    const records = this.wal.open();
    if (records.length === 0 && this.initBalances) {
      for (const [account, amount] of Object.entries(this.initBalances)) {
        if (!Number.isSafeInteger(amount) || amount <= 0) {
          throw new TypeError(`invalid genesis balance for ${account}`);
        }
        records.push(this.wal.append({ type: 'genesis', account, amount }));
      }
    }
    this._recover(records);
    this.isOpen = true;
    return this;
  }

  // ---------------------------------------------------------------- recovery

  _recover(records) {
    const byTx = new Map();
    const intents = [];
    const groupOf = (txId) => {
      let g = byTx.get(txId);
      if (!g) {
        g = { intent: null, applied: null, commit: null, abort: null };
        byTx.set(txId, g);
      }
      return g;
    };
    for (const rec of records) {
      if (rec.type === 'genesis') {
        if (!Number.isSafeInteger(rec.amount) || rec.amount <= 0 || typeof rec.account !== 'string') {
          throw new LedgerError(E_RECOVER, `invalid genesis record at seq ${rec.seq}`);
        }
        this._account(rec.account).balance += rec.amount;
        continue;
      }
      if (typeof rec.txId !== 'string' || rec.txId.length === 0) {
        throw new LedgerError(E_RECOVER, `WAL record seq ${rec.seq} missing txId`);
      }
      const g = groupOf(rec.txId);
      switch (rec.type) {
        case 'intent':
          if (g.intent) throw new LedgerError(E_RECOVER, `duplicate intent for tx ${rec.txId}`);
          g.intent = rec;
          intents.push(rec);
          break;
        case 'applied':
          if (!g.intent) throw new LedgerError(E_RECOVER, `applied without intent for tx ${rec.txId}`);
          if (g.applied) throw new LedgerError(E_RECOVER, `duplicate applied for tx ${rec.txId}`);
          g.applied = rec;
          break;
        case 'commit':
          if (!g.intent || !g.applied) {
            throw new LedgerError(E_RECOVER, `commit without intent/applied for tx ${rec.txId}`);
          }
          if (g.commit) throw new LedgerError(E_RECOVER, `duplicate commit for tx ${rec.txId}`);
          g.commit = rec;
          break;
        case 'abort':
          if (!g.intent) throw new LedgerError(E_RECOVER, `abort without intent for tx ${rec.txId}`);
          if (g.abort) throw new LedgerError(E_RECOVER, `duplicate abort for tx ${rec.txId}`);
          g.abort = rec;
          break;
        default:
          throw new LedgerError(E_RECOVER, `unknown WAL record type "${rec.type}" at seq ${rec.seq}`);
      }
    }
    for (const [txId, g] of byTx) {
      if (g.commit && g.abort) throw new LedgerError(E_RECOVER, `tx ${txId} both committed and aborted`);
    }

    for (const intent of intents) {
      if (this.txs.has(intent.key)) {
        throw new LedgerError(E_RECOVER, `duplicate idempotency key "${intent.key}" in WAL`);
      }
      if (!OPS.has(intent.op)) {
        throw new LedgerError(E_RECOVER, `unknown op "${intent.op}" in intent ${intent.txId}`);
      }
      this.txs.set(intent.key, {
        txId: intent.txId,
        key: intent.key,
        op: intent.op,
        account: intent.account ?? null,
        amount: intent.amount ?? null,
        target: intent.target ?? null,
        status: 'pending',
        reason: null,
        result: null,
        reversedBy: null,
      });
    }

    // Replay committed txs in commit order — the only source of durable state.
    const committed = intents
      .filter((i) => byTx.get(i.txId).commit)
      .sort((a, b) => byTx.get(a.txId).commit.seq - byTx.get(b.txId).commit.seq);
    for (const intent of committed) {
      const tx = this.txs.get(intent.key);
      try {
        this._applyCommitted(tx);
      } catch (err) {
        throw new LedgerError(E_RECOVER, `replay of committed tx ${intent.txId} failed: ${err.message}`, { cause: err });
      }
      const result = byTx.get(intent.txId).commit.result;
      if (!result || result.status !== 'committed') {
        throw new LedgerError(E_RECOVER, `commit record for tx ${intent.txId} missing result`);
      }
      tx.status = 'committed';
      tx.result = result;
    }

    // Classify the rest: abort recorded / auto-rollback / retryable PENDING.
    for (const intent of intents) {
      const g = byTx.get(intent.txId);
      const tx = this.txs.get(intent.key);
      if (tx.status === 'committed') continue;
      if (g.abort) {
        tx.status = 'aborted';
        tx.reason = g.abort.reason ?? 'aborted';
      } else if (g.applied) {
        // Applied but never committed: automatic rollback. Its effect is
        // excluded because state is rebuilt from committed txs only.
        tx.status = 'aborted';
        tx.reason = 'rolled-back: applied but not committed';
        this.wal.append({ type: 'abort', txId: tx.txId, reason: tx.reason });
      } else {
        // Intent only: retryable PENDING. Explicitly NOT a failure.
        tx.status = 'pending';
      }
    }

    const violation = this._findInvariantViolation();
    if (violation) {
      throw new LedgerError(E_RECOVER, `invariant violation after recovery on "${violation.account}": ${violation.message}`);
    }
    this._writeSnapshot();
  }

  // ------------------------------------------------------------------- submit

  submit(input) {
    this._assertUsable();
    const tx = this._validateInput(input);
    const existing = this.txs.get(tx.key);
    if (existing) {
      this._assertSameIntent(existing, tx);
      if (existing.status === 'committed') return { ...existing.result, deduplicated: true };
      if (existing.status === 'aborted') {
        return { status: 'aborted', key: existing.key, txId: existing.txId, reason: existing.reason, deduplicated: true };
      }
      return this._applyAndCommit(existing); // resume retryable PENDING
    }
    this.wal.append({
      type: 'intent',
      txId: tx.txId,
      key: tx.key,
      op: tx.op,
      account: tx.account ?? undefined,
      amount: tx.amount ?? undefined,
      target: tx.target ?? undefined,
    });
    this._crash('intent');
    this.txs.set(tx.key, tx);
    return this._applyAndCommit(tx);
  }

  _applyAndCommit(tx) {
    try {
      this._applyCommitted(tx); // plans, applies, verifies invariants on every commit
    } catch (err) {
      if (err instanceof LedgerError && err.code === E_INVARIANT) this._abort(tx, err.message);
      throw err;
    }
    this.wal.append({ type: 'applied', txId: tx.txId });
    this._crash('applied');
    const result = { status: 'committed', key: tx.key, txId: tx.txId, op: tx.op };
    this.wal.append({ type: 'commit', txId: tx.txId, result });
    this._crash('commit');
    tx.status = 'committed';
    tx.result = result;
    this._writeSnapshot();
    return result;
  }

  _abort(tx, reason) {
    this.wal.append({ type: 'abort', txId: tx.txId, reason });
    tx.status = 'aborted';
    tx.reason = reason;
  }

  // ------------------------------------------------------------------ semantics

  _plan(tx) {
    switch (tx.op) {
      case 'freeze':
        return { account: tx.account, balanceDelta: 0, frozenDelta: tx.amount };
      case 'debit':
        return { account: tx.account, balanceDelta: -tx.amount, frozenDelta: -tx.amount };
      case 'release':
        return { account: tx.account, balanceDelta: 0, frozenDelta: -tx.amount };
      case 'reverse': {
        const target = this.txs.get(tx.target);
        if (!target) throw new LedgerError(E_INVARIANT, `reversal target "${tx.target}" does not exist`);
        if (target.status !== 'committed') {
          throw new LedgerError(E_INVARIANT, `reversal target "${tx.target}" is not committed (status: ${target.status})`);
        }
        if (target.op === 'reverse') throw new LedgerError(E_INVARIANT, 'cannot reverse a reversal');
        if (target.reversedBy) {
          throw new LedgerError(E_INVARIANT, `tx "${tx.target}" already reversed by "${target.reversedBy}"`);
        }
        const p = this._plan(target);
        return { account: p.account, balanceDelta: -p.balanceDelta, frozenDelta: -p.frozenDelta };
      }
      default:
        throw new LedgerError(E_RECOVER, `unknown op "${tx.op}"`);
    }
  }

  _applyCommitted(tx) {
    const plan = this._plan(tx);
    this._applyPlan(plan);
    const violation = this._findInvariantViolation();
    if (violation) {
      this._unapplyPlan(plan);
      throw new LedgerError(E_INVARIANT, `invariant violation on account "${violation.account}": ${violation.message}`);
    }
    if (tx.op === 'reverse') this.txs.get(tx.target).reversedBy = tx.key;
  }

  _applyPlan(plan) {
    const a = this._account(plan.account);
    a.balance += plan.balanceDelta;
    a.frozen += plan.frozenDelta;
  }

  _unapplyPlan(plan) {
    const a = this._account(plan.account);
    a.balance -= plan.balanceDelta;
    a.frozen -= plan.frozenDelta;
  }

  _findInvariantViolation() {
    for (const [name, a] of this.accounts) {
      if (!Number.isSafeInteger(a.balance) || !Number.isSafeInteger(a.frozen)) {
        return { account: name, message: 'non-integer state' };
      }
      if (a.balance < 0) return { account: name, message: `balance ${a.balance} < 0` };
      if (a.frozen < 0) return { account: name, message: `frozen ${a.frozen} < 0` };
      if (a.balance - a.frozen < 0) {
        return { account: name, message: `available ${a.balance - a.frozen} < 0 (balance ${a.balance}, frozen ${a.frozen})` };
      }
    }
    return null;
  }

  // --------------------------------------------------------------------- misc

  _account(name) {
    let a = this.accounts.get(name);
    if (!a) {
      a = { balance: 0, frozen: 0 };
      this.accounts.set(name, a);
    }
    return a;
  }

  _validateInput(input) {
    if (!input || typeof input !== 'object') throw new TypeError('submit requires an object');
    const { key, op, account, amount, target } = input;
    if (typeof key !== 'string' || key.length === 0) throw new TypeError('key must be a non-empty string');
    if (!OPS.has(op)) throw new TypeError(`op must be one of ${[...OPS].join(', ')}`);
    if (op === 'reverse') {
      if (typeof target !== 'string' || target.length === 0) throw new TypeError('reverse requires a target key');
    } else {
      if (typeof account !== 'string' || account.length === 0) throw new TypeError('account must be a non-empty string');
      if (!Number.isSafeInteger(amount) || amount <= 0) throw new TypeError('amount must be a positive integer');
    }
    return {
      txId: randomUUID(),
      key,
      op,
      account: account ?? null,
      amount: amount ?? null,
      target: target ?? null,
      status: 'pending',
      reason: null,
      result: null,
      reversedBy: null,
    };
  }

  _assertSameIntent(existing, tx) {
    const same =
      existing.op === tx.op &&
      (existing.account ?? null) === (tx.account ?? null) &&
      (existing.amount ?? null) === (tx.amount ?? null) &&
      (existing.target ?? null) === (tx.target ?? null);
    if (!same) {
      throw new LedgerError(E_WAL, `idempotency key "${tx.key}" already recorded with different parameters`);
    }
  }

  _crash(point) {
    if (this.faultAfter !== point) return;
    this.faultAfter = null; // one-shot
    this.crashed = true;
    this.wal.close();
    throw new CrashError(point);
  }

  _assertUsable() {
    if (this.crashed) throw new Error('ledger instance crashed (fault injection); open a new Ledger on the same directory');
    if (!this.isOpen) throw new Error('ledger is not open');
  }

  _writeSnapshot() {
    const accounts = {};
    for (const [name, a] of [...this.accounts.entries()].sort()) {
      accounts[name] = { balance: a.balance, frozen: a.frozen, available: a.balance - a.frozen };
    }
    const tmp = path.join(this.dir, 'state.json.tmp');
    const dst = path.join(this.dir, 'state.json');
    try {
      fs.writeFileSync(tmp, JSON.stringify({ accounts }, null, 2) + '\n');
      const fd = fs.openSync(tmp, 'r');
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(tmp, dst);
    } catch (err) {
      throw new LedgerError(E_IO, `cannot write state snapshot: ${err.message}`, { cause: err });
    }
  }

  // ------------------------------------------------------------------ queries

  status(key) {
    const tx = this.txs.get(key);
    if (!tx) return { key, status: 'unknown' };
    const out = { key: tx.key, txId: tx.txId, op: tx.op, status: tx.status };
    if (tx.reason) out.reason = tx.reason;
    if (tx.reversedBy) out.reversedBy = tx.reversedBy;
    return out;
  }

  balance(account) {
    const a = this._account(account);
    return { account, balance: a.balance, frozen: a.frozen, available: a.balance - a.frozen };
  }

  list() {
    return [...this.txs.values()].map((tx) => this.status(tx.key));
  }

  close() {
    this.wal.close();
    this.isOpen = false;
  }
}

export { LedgerError, CrashError, E_WAL, E_RECOVER, E_INVARIANT, E_IO };
