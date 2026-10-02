'use strict';

const fs = require('node:fs');
const path = require('node:path');

class LedgerError extends Error {
  constructor(code, message, options) {
    super(message, options);
    this.name = 'LedgerError';
    this.code = code; // E_WAL | E_RECOVER | E_INVARIANT | E_IO
  }
}

// Thrown by fault injection to simulate a process crash. Not a ledger failure.
class CrashError extends Error {
  constructor(point) {
    super(`simulated crash after ${point} became durable`);
    this.name = 'CrashError';
    this.point = point;
  }
}

const RECORD_TYPES = new Set(['intent', 'apply', 'commit', 'abort', 'rollback']);
const CRASH_POINTS = new Set(['intent', 'apply', 'commit']);
const REVERSIBLE_OPS = new Set(['freeze', 'debit', 'release', 'reverse']);

function intentId(key, seq) {
  return `${key}@${seq}`;
}

function assertKey(key) {
  if (typeof key !== 'string' || key.length === 0) {
    throw new LedgerError('E_INVARIANT', 'idempotency key must be a non-empty string');
  }
}

function assertAmount(amount) {
  if (!Number.isSafeInteger(amount) || amount <= 0) {
    throw new LedgerError('E_INVARIANT', 'amount must be a positive safe integer');
  }
}

class Ledger {
  // Opens (or creates) a ledger in `dir` and runs recovery.
  // options.crashAfter: 'intent' | 'apply' | 'commit' — fault injection point.
  constructor(dir, options = {}) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.crashAfter = options.crashAfter || null;
    if (this.crashAfter !== null && !CRASH_POINTS.has(this.crashAfter)) {
      throw new LedgerError('E_INVARIANT', `unknown crash point: ${this.crashAfter}`);
    }
    this.crashed = false;
    this.seq = 0;
    this.accounts = new Map(); // name -> {balance, frozen}
    this.committed = new Map(); // key -> {seq, result}
    this.committedDeltas = new Map(); // key -> {account, before, after, op}
    this.reversed = new Set(); // keys already reversed
    this.pendingKeys = new Set();

    try {
      fs.mkdirSync(dir, { recursive: true });
    } catch (err) {
      throw new LedgerError('E_IO', `cannot create ledger dir ${dir}: ${err.message}`, { cause: err });
    }
    try {
      this.fd = fs.openSync(this.walPath, 'a+');
    } catch (err) {
      throw new LedgerError('E_WAL', `cannot open WAL ${this.walPath}: ${err.message}`, { cause: err });
    }
    this.recoveryReport = this.#recover();
  }

  close() {
    if (this.fd !== null) {
      fs.closeSync(this.fd);
      this.fd = null;
    }
  }

  // ---- public API ----

  transact(request) {
    this.#assertUsable();
    const { key, op, account, amount, target } = request || {};
    assertKey(key);

    const prior = this.committed.get(key);
    if (prior) return Object.assign({ status: 'duplicate' }, prior.result);

    // Domain pre-validation: no WAL writes for requests that can never commit.
    const delta = this.#computeDelta({ op, account, amount, target });

    const intentSeq = ++this.seq;
    this.#append({ type: 'intent', seq: intentSeq, key, op, account, amount, target });
    this.#crash('intent');

    // Tentative apply, then the mandatory per-commit invariant check.
    this.#applyDelta(delta);
    try {
      this.#assertInvariants('E_INVARIANT');
    } catch (err) {
      this.#undoDelta(delta);
      this.#append({ type: 'abort', seq: ++this.seq, key, refSeq: intentSeq, reason: err.message });
      throw err;
    }

    this.#append({ type: 'apply', seq: ++this.seq, key, refSeq: intentSeq, delta });
    this.#crash('apply');

    const result = Object.assign({ key, op }, this.balanceOf(delta.account));
    this.#append({ type: 'commit', seq: ++this.seq, key, refSeq: intentSeq, result });
    this.#crash('commit');

    this.committed.set(key, { seq: intentSeq, result });
    this.committedDeltas.set(key, Object.assign({ op }, delta));
    if (op === 'reverse') this.reversed.add(target);
    this.pendingKeys.delete(key);
    return Object.assign({ status: 'committed' }, result);
  }

  balanceOf(account) {
    const acct = this.accounts.get(account);
    if (!acct) throw new LedgerError('E_INVARIANT', `unknown account: ${account}`);
    return { account, balance: acct.balance, frozen: acct.frozen, available: acct.balance - acct.frozen };
  }

  snapshot() {
    const out = {};
    for (const name of [...this.accounts.keys()].sort()) {
      const a = this.accounts.get(name);
      out[name] = { balance: a.balance, frozen: a.frozen, available: a.balance - a.frozen };
    }
    return out;
  }

  pending() {
    return [...this.pendingKeys].sort();
  }

  // ---- WAL ----

  #append(record) {
    try {
      fs.writeSync(this.fd, JSON.stringify(record) + '\n');
      fs.fsyncSync(this.fd);
    } catch (err) {
      throw new LedgerError('E_WAL', `WAL append failed: ${err.message}`, { cause: err });
    }
  }

  #crash(point) {
    if (this.crashAfter !== point) return;
    this.crashed = true;
    this.close();
    throw new CrashError(point);
  }

  #assertUsable() {
    if (this.crashed) throw new CrashError('instance is dead after simulated crash');
  }

  // ---- recovery ----

  #recover() {
    let raw;
    try {
      raw = fs.readFileSync(this.walPath, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') raw = '';
      else throw new LedgerError('E_IO', `cannot read WAL: ${err.message}`, { cause: err });
    }
    const lines = raw.split('\n').filter((line) => line.length > 0);
    const records = lines.map((line, index) => {
      let rec;
      try {
        rec = JSON.parse(line);
      } catch (err) {
        throw new LedgerError('E_RECOVER', `WAL record ${index + 1} is corrupt`, { cause: err });
      }
      if (!rec || !RECORD_TYPES.has(rec.type) || !Number.isSafeInteger(rec.seq)) {
        throw new LedgerError('E_RECOVER', `WAL record ${index + 1} is malformed`);
      }
      return rec;
    });

    const intents = [];
    const applies = new Map(); // intentId -> apply record
    const commits = new Map(); // intentId -> commit record
    const aborted = new Set();
    const rolledBack = new Set();

    for (const rec of records) {
      if (rec.seq > this.seq) this.seq = rec.seq;
      switch (rec.type) {
        case 'intent':
          intents.push(rec);
          break;
        case 'apply':
          applies.set(intentId(rec.key, rec.refSeq), rec);
          break;
        case 'commit':
          commits.set(intentId(rec.key, rec.refSeq), rec);
          break;
        case 'abort':
          aborted.add(intentId(rec.key, rec.refSeq));
          break;
        case 'rollback':
          rolledBack.add(intentId(rec.key, rec.refSeq));
          break;
      }
    }

    const report = { committed: [], rolledBack: [], aborted: [], pending: [] };
    intents.sort((a, b) => a.seq - b.seq);

    for (const intent of intents) {
      const id = intentId(intent.key, intent.seq);
      if (aborted.has(id)) {
        report.aborted.push(intent.key);
        continue;
      }
      const commit = commits.get(id);
      const apply = applies.get(id);
      if (commit) {
        if (!apply) {
          throw new LedgerError('E_RECOVER', `commit without apply for key ${intent.key}`);
        }
        this.#applyDelta(apply.delta);
        this.#assertInvariants('E_RECOVER');
        this.committed.set(intent.key, { seq: intent.seq, result: commit.result });
        this.committedDeltas.set(intent.key, Object.assign({ op: intent.op }, apply.delta));
        if (intent.op === 'reverse') this.reversed.add(intent.target);
        report.committed.push(intent.key);
        continue;
      }
      if (apply) {
        // Applied but never committed: auto-rollback. The delta is simply never
        // replayed; the rollback marker makes the decision durable.
        if (!rolledBack.has(id)) {
          this.#append({ type: 'rollback', seq: ++this.seq, key: intent.key, refSeq: intent.seq });
        }
        report.rolledBack.push(intent.key);
        continue;
      }
      // Bare intent: nothing was applied. This is PENDING — retryable, never a failure.
    }

    // A key is PENDING iff its latest intent was never applied, committed or aborted.
    const lastIntentByKey = new Map();
    for (const intent of intents) lastIntentByKey.set(intent.key, intent);
    for (const [key, intent] of lastIntentByKey) {
      const id = intentId(key, intent.seq);
      if (this.committed.has(key) || aborted.has(id) || applies.has(id)) continue;
      this.pendingKeys.add(key);
      report.pending.push(key);
    }
    report.pending.sort();
    return report;
  }

  // ---- state machine ----

  #computeDelta({ op, account, amount, target }) {
    switch (op) {
      case 'open': {
        if (typeof account !== 'string' || account.length === 0) {
          throw new LedgerError('E_INVARIANT', 'account name required');
        }
        if (this.accounts.has(account)) {
          throw new LedgerError('E_INVARIANT', `account already exists: ${account}`);
        }
        if (!Number.isSafeInteger(amount) || amount < 0) {
          throw new LedgerError('E_INVARIANT', 'initial balance must be a non-negative safe integer');
        }
        return { account, before: null, after: { balance: amount, frozen: 0 } };
      }
      case 'freeze': {
        const acct = this.#requireAccount(account);
        assertAmount(amount);
        if (acct.balance - acct.frozen < amount) {
          throw new LedgerError('E_INVARIANT', `insufficient available on ${account}`);
        }
        return { account, before: { ...acct }, after: { balance: acct.balance, frozen: acct.frozen + amount } };
      }
      case 'debit': {
        const acct = this.#requireAccount(account);
        assertAmount(amount);
        if (acct.frozen < amount) {
          throw new LedgerError('E_INVARIANT', `insufficient frozen on ${account}`);
        }
        return { account, before: { ...acct }, after: { balance: acct.balance - amount, frozen: acct.frozen - amount } };
      }
      case 'release': {
        const acct = this.#requireAccount(account);
        assertAmount(amount);
        if (acct.frozen < amount) {
          throw new LedgerError('E_INVARIANT', `insufficient frozen on ${account}`);
        }
        return { account, before: { ...acct }, after: { balance: acct.balance, frozen: acct.frozen - amount } };
      }
      case 'reverse': {
        assertKey(target);
        const committed = this.committedDeltas.get(target);
        if (!committed) {
          throw new LedgerError('E_INVARIANT', `cannot reverse ${target}: target is not committed`);
        }
        if (!REVERSIBLE_OPS.has(committed.op)) {
          throw new LedgerError('E_INVARIANT', `cannot reverse ${target}: op ${committed.op} is not reversible`);
        }
        if (this.reversed.has(target)) {
          throw new LedgerError('E_INVARIANT', `cannot reverse ${target}: already reversed`);
        }
        const cur = this.#requireAccount(committed.account);
        // Compensating delta: negate the target's effect on top of current state.
        const after = {
          balance: cur.balance + (committed.before.balance - committed.after.balance),
          frozen: cur.frozen + (committed.before.frozen - committed.after.frozen),
        };
        return { account: committed.account, before: { ...cur }, after };
      }
      default:
        throw new LedgerError('E_INVARIANT', `unknown op: ${op}`);
    }
  }

  #requireAccount(account) {
    const acct = this.accounts.get(account);
    if (!acct) throw new LedgerError('E_INVARIANT', `unknown account: ${account}`);
    return acct;
  }

  #applyDelta(delta) {
    this.accounts.set(delta.account, { balance: delta.after.balance, frozen: delta.after.frozen });
  }

  #undoDelta(delta) {
    if (delta.before === null) this.accounts.delete(delta.account);
    else this.accounts.set(delta.account, { balance: delta.before.balance, frozen: delta.before.frozen });
  }

  #assertInvariants(code) {
    for (const [name, acct] of this.accounts) {
      const ok =
        Number.isSafeInteger(acct.balance) &&
        Number.isSafeInteger(acct.frozen) &&
        acct.balance >= 0 &&
        acct.frozen >= 0 &&
        acct.frozen <= acct.balance;
      if (!ok) {
        throw new LedgerError(
          code,
          `invariant violated on ${name}: balance=${acct.balance} frozen=${acct.frozen} available=${acct.balance - acct.frozen}`,
        );
      }
    }
  }
}

module.exports = { Ledger, LedgerError, CrashError };
