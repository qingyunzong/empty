import fs from 'node:fs';
import path from 'node:path';

export const CHECKPOINT_INTERVAL = 64;

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function stateError(message) {
  return new LedgerError('E_STATE', message);
}

function policyError(message) {
  return new LedgerError('E_POLICY', message);
}

// Append-only ledger.
//
// Persistence protocol (fault points, in order):
//   1. append entry line to data.log        -> hook afterWrite
//   2. fsync(data.log)                      -> hook afterFsync
//   3. write commit marker (commit.tmp -> rename commit), fsync
//                                             -> hook afterCommit
// Recovery keeps only the committed prefix: entries with seq <= commit marker,
// and truncates any uncommitted / torn tail of data.log.
export class Ledger {
  constructor(dir, opts = {}) {
    this.dir = dir;
    this.allowNegative = opts.allowNegative ?? true;
    this.hooks = opts.hooks ?? {};
    this.logPath = path.join(dir, 'data.log');
    this.commitPath = path.join(dir, 'commit');
    this.commitTmpPath = path.join(dir, 'commit.tmp');
    fs.mkdirSync(dir, { recursive: true });

    this.entries = []; // committed entries, index = seq - 1
    this.balances = new Map(); // account -> balance at lastSeq
    this.postIndex = new Map(); // id -> post entry
    this.reversals = new Map(); // id -> compensation entry
    this.settledUpTo = 0;
    this.checkpoints = []; // sparse index: [{seq, balances: Map}]
    this.stats = { scanned: 0 }; // entries scanned by the last balance() call

    this._recover();
  }

  get lastSeq() {
    return this.entries.length;
  }

  _readCommittedSeq() {
    try {
      const raw = fs.readFileSync(this.commitPath, 'utf8').trim();
      const n = Number(raw);
      return Number.isInteger(n) && n >= 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  _recover() {
    const committedSeq = this._readCommittedSeq();
    let buf;
    try {
      buf = fs.readFileSync(this.logPath);
    } catch {
      buf = Buffer.alloc(0);
    }
    let offset = 0;
    let committedEnd = 0;
    while (offset < buf.length) {
      const nl = buf.indexOf(0x0a, offset);
      if (nl === -1) break; // torn tail: no terminating newline
      const line = buf.subarray(offset, nl).toString('utf8');
      let entry;
      try {
        entry = JSON.parse(line);
      } catch {
        break; // torn tail: unparseable line
      }
      if (!Number.isInteger(entry.seq) || entry.seq !== this.entries.length + 1) break;
      if (entry.seq > committedSeq) break; // written but never committed
      this.entries.push(entry);
      committedEnd = nl + 1;
      offset = nl + 1;
    }
    if (buf.length !== committedEnd) {
      fs.truncateSync(this.logPath, committedEnd);
    }
    for (const entry of this.entries) this._applyCommitted(entry);
  }

  _applyCommitted(entry) {
    if (entry.type === 'post') {
      this.postIndex.set(entry.id, entry);
      this._addBalance(entry.account, entry.amount);
    } else if (entry.type === 'reverse') {
      this.reversals.set(entry.refId, entry);
      this._addBalance(entry.account, entry.amount);
    } else if (entry.type === 'settle') {
      this.settledUpTo = entry.upTo;
    }
    if (entry.seq % CHECKPOINT_INTERVAL === 0) {
      this.checkpoints.push({ seq: entry.seq, balances: new Map(this.balances) });
    }
  }

  _addBalance(account, delta) {
    this.balances.set(account, (this.balances.get(account) ?? 0) + delta);
  }

  _balanceOf(account) {
    return this.balances.get(account) ?? 0;
  }

  _append(entry) {
    const line = Buffer.from(JSON.stringify(entry) + '\n', 'utf8');
    const fd = fs.openSync(this.logPath, 'a');
    try {
      fs.writeSync(fd, line);
      this.hooks.afterWrite?.(entry); // fault point 1: crash before fsync
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    this.hooks.afterFsync?.(entry); // fault point 2: crash after fsync, before commit
    const tmp = Buffer.from(String(entry.seq) + '\n', 'utf8');
    fs.writeFileSync(this.commitTmpPath, tmp);
    const cfd = fs.openSync(this.commitTmpPath, 'r');
    try {
      fs.fsyncSync(cfd);
    } finally {
      fs.closeSync(cfd);
    }
    fs.renameSync(this.commitTmpPath, this.commitPath);
    this.hooks.afterCommit?.(entry); // fault point 3: crash after commit
    this.entries.push(entry);
    this._applyCommitted(entry);
    return entry;
  }

  _checkBalancePolicy(account, delta) {
    if (!this.allowNegative && this._balanceOf(account) + delta < 0) {
      throw policyError(`negative balance not allowed for account ${account}`);
    }
  }

  post(id, account, amount, meta = null) {
    if (typeof id !== 'string' || id.length === 0) throw stateError('post requires a non-empty string id');
    if (typeof account !== 'string' || account.length === 0) throw stateError('post requires a non-empty account');
    if (typeof amount !== 'number' || !Number.isFinite(amount)) throw stateError('post requires a finite numeric amount');
    if (this.postIndex.has(id)) throw stateError(`duplicate post id ${id}`);
    this._checkBalancePolicy(account, amount);
    const entry = { seq: this.lastSeq + 1, type: 'post', id, account, amount, meta };
    this._append(entry);
    return entry.seq;
  }

  reverse(id, reason = null) {
    const existing = this.reversals.get(id);
    if (existing) return existing.seq; // idempotent: return original compensation seq
    const orig = this.postIndex.get(id);
    if (!orig) throw stateError(`cannot reverse unknown id ${id}`);
    if (orig.seq <= this.settledUpTo) {
      throw stateError(`cannot reverse ${id}: period up to seq ${this.settledUpTo} is settled`);
    }
    this._checkBalancePolicy(orig.account, -orig.amount);
    const entry = {
      seq: this.lastSeq + 1,
      type: 'reverse',
      refId: id,
      account: orig.account,
      amount: -orig.amount,
      reason,
    };
    this._append(entry);
    return entry.seq;
  }

  settle(upTo) {
    if (!Number.isInteger(upTo) || upTo <= this.settledUpTo || upTo > this.lastSeq) {
      throw stateError(`invalid settle point ${upTo}`);
    }
    const entry = { seq: this.lastSeq + 1, type: 'settle', upTo };
    this._append(entry);
    return entry.seq;
  }

  // Sparse-index + incremental aggregation: start from the newest checkpoint
  // with seq <= asOfSeq, then aggregate only the tail entries. Never scans
  // the full log; scans at most CHECKPOINT_INTERVAL entries.
  balance(account, asOfSeq = null) {
    const target = asOfSeq ?? this.lastSeq;
    if (!Number.isInteger(target) || target < 0 || target > this.lastSeq) {
      throw stateError(`asOfSeq ${target} out of range [0, ${this.lastSeq}]`);
    }
    let lo = 0;
    let hi = this.checkpoints.length; // binary search: last checkpoint with seq <= target
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.checkpoints[mid].seq <= target) lo = mid + 1;
      else hi = mid;
    }
    const cp = lo > 0 ? this.checkpoints[lo - 1] : null;
    let bal = cp ? (cp.balances.get(account) ?? 0) : 0;
    const from = cp ? cp.seq : 0;
    this.stats.scanned = 0;
    for (let seq = from + 1; seq <= target; seq++) {
      const e = this.entries[seq - 1];
      this.stats.scanned++;
      if ((e.type === 'post' || e.type === 'reverse') && e.account === account) {
        bal += e.amount;
      }
    }
    return bal;
  }
}
