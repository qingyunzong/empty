import fs from 'node:fs';
import path from 'node:path';

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

const LOG_FILE = 'data.log';
const COMMIT_FILE = 'data.commit';
const DEFAULT_CHECKPOINT_INTERVAL = 64;

function deltaOf(entry) {
  if (entry.type === 'post' || entry.type === 'reverse') return entry.amount;
  return 0;
}

export class Ledger {
  #dir;
  #logPath;
  #commitPath;
  #logFd;
  #allowNegative;
  #checkpointInterval;
  #hooks;
  #crashed = false;

  #entries = [];
  #balances = new Map();
  #checkpoints = [];
  #idIndex = new Map();
  #reversedBy = new Map();
  #settledUpTo = 0;

  constructor(dir, options = {}) {
    this.#dir = dir;
    this.#logPath = path.join(dir, LOG_FILE);
    this.#commitPath = path.join(dir, COMMIT_FILE);
    this.#allowNegative = options.allowNegative !== false;
    this.#checkpointInterval =
      Number.isInteger(options.checkpointInterval) && options.checkpointInterval > 0
        ? options.checkpointInterval
        : DEFAULT_CHECKPOINT_INTERVAL;
    this.#hooks = options.hooks ?? {};
  }

  static open(dir, options = {}) {
    fs.mkdirSync(dir, { recursive: true });
    const ledger = new Ledger(dir, options);
    ledger.#recover();
    return ledger;
  }

  get committedSeq() {
    return this.#entries.length;
  }

  get settledUpTo() {
    return this.#settledUpTo;
  }

  entries() {
    return this.#entries.map((entry) => ({ ...entry }));
  }

  #recover() {
    let committedSeq = 0;
    if (fs.existsSync(this.#commitPath)) {
      const raw = fs.readFileSync(this.#commitPath, 'utf8').trim();
      const parsed = Number(raw);
      if (Number.isInteger(parsed) && parsed >= 0) committedSeq = parsed;
    }

    if (fs.existsSync(this.#logPath)) {
      const buf = fs.readFileSync(this.#logPath);
      let lineStart = 0;
      let committedEnd = 0;
      for (let i = 0; i <= buf.length; i += 1) {
        if (i !== buf.length && buf[i] !== 0x0a) continue;
        const line = buf.subarray(lineStart, i).toString('utf8');
        lineStart = i + 1;
        if (line.trim() === '') continue;
        let entry;
        try {
          entry = JSON.parse(line);
        } catch {
          break; // torn tail: stop at first unparsable line
        }
        if (!Number.isInteger(entry.seq) || entry.seq > committedSeq) break;
        if (entry.seq !== this.#entries.length + 1) break; // gap: treat as tail garbage
        this.#apply(entry);
        committedEnd = i + 1;
      }
      if (committedEnd < buf.length) {
        fs.truncateSync(this.#logPath, committedEnd);
      }
    }

    this.#logFd = fs.openSync(this.#logPath, 'a');
  }

  #apply(entry) {
    this.#entries.push(entry);
    if (entry.type === 'post' || entry.type === 'reverse') {
      this.#balances.set(entry.account, (this.#balances.get(entry.account) ?? 0) + entry.amount);
      this.#idIndex.set(entry.id, entry.seq);
      if (entry.type === 'reverse') this.#reversedBy.set(entry.reverses, entry.seq);
    } else if (entry.type === 'settle') {
      this.#settledUpTo = Math.max(this.#settledUpTo, entry.upTo);
    }
    if (entry.seq % this.#checkpointInterval === 0) {
      this.#checkpoints.push({ seq: entry.seq, balances: new Map(this.#balances) });
    }
  }

  #writeCommitMarker(seq) {
    const fd = fs.openSync(this.#commitPath, 'w');
    try {
      fs.writeSync(fd, String(seq));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  #append(entry) {
    if (this.#crashed) {
      throw new LedgerError('E_STATE', 'ledger hit a simulated/IO crash; reopen required');
    }
    const seq = this.#entries.length + 1;
    const record = { ...entry, seq };
    const line = `${JSON.stringify(record)}\n`;
    try {
      fs.writeSync(this.#logFd, line);
      this.#hooks.afterWrite?.(record);
      fs.fsyncSync(this.#logFd);
      this.#hooks.afterFsync?.(record);
      this.#writeCommitMarker(seq);
      this.#hooks.afterCommit?.(record);
    } catch (err) {
      this.#crashed = true;
      throw err;
    }
    this.#apply(record);
    return record;
  }

  #assertWritable(id, account) {
    if (typeof id !== 'string' || id.length === 0) {
      throw new LedgerError('E_ARGS', 'id must be a non-empty string');
    }
    if (account !== undefined && (typeof account !== 'string' || account.length === 0)) {
      throw new LedgerError('E_ARGS', 'account must be a non-empty string');
    }
  }

  #assertNonNegativeNext(account, delta) {
    if (this.#allowNegative) return;
    const next = (this.#balances.get(account) ?? 0) + delta;
    if (next < 0) {
      throw new LedgerError(
        'E_STATE',
        `negative balance not allowed for account "${account}" (would become ${next})`,
      );
    }
  }

  post(id, account, amount, meta = null) {
    this.#assertWritable(id, account);
    if (typeof amount !== 'number' || !Number.isFinite(amount)) {
      throw new LedgerError('E_ARGS', 'amount must be a finite number');
    }
    if (this.#idIndex.has(id)) {
      throw new LedgerError('E_STATE', `duplicate entry id "${id}"`);
    }
    this.#assertNonNegativeNext(account, amount);
    const record = this.#append({ type: 'post', id, account, amount, meta });
    return { seq: record.seq, idempotent: false };
  }

  reverse(id, reason = null) {
    this.#assertWritable(id);
    const origSeq = this.#idIndex.get(id);
    if (origSeq === undefined) {
      throw new LedgerError('E_STATE', `cannot reverse unknown id "${id}"`);
    }
    const existing = this.#reversedBy.get(id);
    if (existing !== undefined) {
      return { seq: existing, idempotent: true };
    }
    const orig = this.#entries[origSeq - 1];
    if (orig.type !== 'post') {
      throw new LedgerError('E_STATE', `entry "${id}" is not reversible`);
    }
    if (orig.seq <= this.#settledUpTo) {
      throw new LedgerError(
        'E_STATE',
        `entry "${id}" (seq ${orig.seq}) belongs to a settled period (<= ${this.#settledUpTo})`,
      );
    }
    this.#assertNonNegativeNext(orig.account, -orig.amount);
    const record = this.#append({
      type: 'reverse',
      id: `reverse:${id}`,
      reverses: id,
      account: orig.account,
      amount: -orig.amount,
      reason,
    });
    return { seq: record.seq, idempotent: false };
  }

  settle(upToSeq) {
    if (!Number.isInteger(upToSeq) || upToSeq < 0 || upToSeq > this.#entries.length) {
      throw new LedgerError('E_ARGS', `invalid settle boundary ${upToSeq}`);
    }
    if (upToSeq <= this.#settledUpTo) {
      return { seq: this.#entries.length, idempotent: true };
    }
    const record = this.#append({ type: 'settle', id: `settle:${upToSeq}`, upTo: upToSeq });
    return { seq: record.seq, idempotent: false };
  }

  balance(account, asOfSeq = this.#entries.length) {
    if (typeof account !== 'string' || account.length === 0) {
      throw new LedgerError('E_ARGS', 'account must be a non-empty string');
    }
    if (!Number.isInteger(asOfSeq) || asOfSeq < 0 || asOfSeq > this.#entries.length) {
      throw new LedgerError('E_ARGS', `invalid asOfSeq ${asOfSeq}`);
    }
    let lo = 0;
    let hi = this.#checkpoints.length - 1;
    let baseSeq = 0;
    let base = 0;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.#checkpoints[mid].seq <= asOfSeq) {
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    if (hi >= 0) {
      baseSeq = this.#checkpoints[hi].seq;
      base = this.#checkpoints[hi].balances.get(account) ?? 0;
    }
    let total = base;
    for (let i = baseSeq; i < asOfSeq; i += 1) {
      const entry = this.#entries[i];
      if (entry.account === account) total += deltaOf(entry);
    }
    return total;
  }

  close() {
    if (this.#logFd !== undefined) {
      try {
        fs.closeSync(this.#logFd);
      } catch {
        // already closed
      }
      this.#logFd = undefined;
    }
  }
}
