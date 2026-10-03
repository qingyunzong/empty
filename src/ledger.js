import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const GENESIS_HASH = '0'.repeat(64);
export const EVENT_TYPES = new Set(['reserve', 'commit', 'release', 'freeze']);

export class CrashError extends Error {
  constructor(phase) {
    super(`simulated crash at ${phase}`);
    this.name = 'CrashError';
    this.phase = phase;
    this.code = 'LEDGER_CRASH';
  }
}

export class LedgerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
  }
}

function canonical(event) {
  return JSON.stringify({
    seq: event.seq,
    eventId: event.eventId,
    type: event.type,
    account: event.account,
    amount: event.amount,
    prevHash: event.prevHash,
  });
}

export function hashEvent(event) {
  return createHash('sha256').update(canonical(event), 'utf8').digest('hex');
}

function isHex64(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

// Returns null when the record is a valid link in the chain, otherwise a reason.
export function validateRecord(record, expectedSeq, expectedPrevHash) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    return 'record is not an object';
  }
  if (!Number.isInteger(record.seq) || record.seq !== expectedSeq) {
    return `seq mismatch: expected ${expectedSeq}, got ${String(record.seq)}`;
  }
  if (typeof record.eventId !== 'string' || record.eventId.length === 0) {
    return 'eventId missing';
  }
  if (!EVENT_TYPES.has(record.type)) {
    return `unknown type: ${String(record.type)}`;
  }
  if (typeof record.account !== 'string' || record.account.length === 0) {
    return 'account missing';
  }
  if (!Number.isInteger(record.amount) || record.amount < 0) {
    return 'amount must be a non-negative integer';
  }
  if (!isHex64(record.prevHash) || record.prevHash !== expectedPrevHash) {
    return 'prevHash does not match chain';
  }
  if (!isHex64(record.hash) || record.hash !== hashEvent(record)) {
    return 'record hash mismatch';
  }
  return null;
}

export class Ledger {
  static open(file, options = {}) {
    const ledger = new Ledger(file, options);
    ledger._recover();
    return ledger;
  }

  constructor(file, options = {}) {
    this.file = file;
    this.defaultLimit = options.defaultLimit ?? 1000;
    this.crash = options.crash ?? null; // { phase: 'beforeAppend'|'afterAppend', at: <append index> }
    this.exitOnCrash = options.exitOnCrash ?? false;
    this.accounts = new Map();
    this.seenEventIds = new Set();
    this.events = [];
    this.lastHash = GENESIS_HASH;
    this.appendAttempts = 0;
    this._fd = null;
    this.recovery = {
      truncated: false,
      byteOffset: null,
      line: null,
      reason: null,
      eventsReplayed: 0,
    };
  }

  _account(name) {
    let account = this.accounts.get(name);
    if (!account) {
      account = {
        limit: this.defaultLimit,
        available: this.defaultLimit,
        held: 0,
        frozen: false,
      };
      this.accounts.set(name, account);
    }
    return account;
  }

  _recover() {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      return;
    }
    const buffer = fs.readFileSync(this.file);
    let position = 0;
    let seq = 0;
    while (position < buffer.length) {
      let newline = buffer.indexOf(0x0a, position);
      const lineEnd = newline === -1 ? buffer.length : newline;
      const recordEnd = newline === -1 ? buffer.length : newline + 1;
      const line = buffer.toString('utf8', position, lineEnd);
      let reason = null;
      let record = null;
      if (line.trim().length === 0) {
        reason = 'empty line';
      } else {
        try {
          record = JSON.parse(line);
        } catch {
          reason = 'invalid JSON';
        }
      }
      if (reason === null) {
        reason = validateRecord(record, seq, this.lastHash);
      }
      if (reason !== null) {
        fs.truncateSync(this.file, position);
        this.recovery = {
          truncated: true,
          byteOffset: position,
          line: seq,
          reason,
          eventsReplayed: seq,
        };
        return;
      }
      this._applyRecord(record);
      this.events.push(record);
      this.lastHash = record.hash;
      position = recordEnd;
      seq += 1;
    }
    this.recovery.eventsReplayed = seq;
  }

  _applyRecord(record) {
    if (this.seenEventIds.has(record.eventId)) {
      return;
    }
    this.seenEventIds.add(record.eventId);
    const account = this._account(record.account);
    switch (record.type) {
      case 'reserve':
        account.available -= record.amount;
        account.held += record.amount;
        break;
      case 'commit':
        account.held -= record.amount;
        account.limit -= record.amount;
        break;
      case 'release':
        account.held -= record.amount;
        account.available += record.amount;
        break;
      case 'freeze':
        account.frozen = true;
        break;
    }
  }

  _maybeCrash(phase) {
    if (this.crash && this.crash.phase === phase && this.crash.at === this.appendAttempts) {
      if (this.exitOnCrash) {
        process.exit(phase === 'afterAppend' ? 42 : 1);
      }
      throw new CrashError(phase);
    }
  }

  _append(type, account, amount, eventId) {
    const event = {
      seq: this.events.length,
      eventId,
      type,
      account,
      amount,
      prevHash: this.lastHash,
    };
    event.hash = hashEvent(event);

    this._maybeCrash('beforeAppend');

    if (this._fd === null) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      this._fd = fs.openSync(this.file, 'a');
    }
    fs.writeSync(this._fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(this._fd);

    this._maybeCrash('afterAppend');

    this.appendAttempts += 1;
    this._applyRecord(event);
    this.events.push(event);
    this.lastHash = event.hash;
    return event;
  }

  _submit(type, account, amount, eventId) {
    const id = eventId ?? randomUUID();
    if (this.seenEventIds.has(id)) {
      const existing = this.events.find((event) => event.eventId === id);
      return { applied: false, duplicate: true, event: existing ?? null };
    }
    this._validate(type, account, amount);
    const event = this._append(type, account, amount, id);
    return { applied: true, duplicate: false, event };
  }

  _validate(type, account, amount) {
    if (typeof account !== 'string' || account.length === 0) {
      throw new LedgerError('INVALID_ACCOUNT', 'account must be a non-empty string');
    }
    if (type === 'freeze') {
      return;
    }
    if (!Number.isInteger(amount) || amount <= 0) {
      throw new LedgerError('INVALID_AMOUNT', 'amount must be a positive integer');
    }
    const state = this.accounts.get(account) ?? {
      limit: this.defaultLimit,
      available: this.defaultLimit,
      held: 0,
      frozen: false,
    };
    if (type === 'reserve') {
      if (state.frozen) {
        throw new LedgerError('ACCOUNT_FROZEN', `account ${account} is frozen`);
      }
      if (state.available < amount) {
        throw new LedgerError(
          'INSUFFICIENT_AVAILABLE',
          `account ${account} has ${state.available} available, needs ${amount}`,
        );
      }
    } else if (type === 'commit' || type === 'release') {
      if (state.held < amount) {
        throw new LedgerError(
          'INSUFFICIENT_HELD',
          `account ${account} holds ${state.held}, needs ${amount}`,
        );
      }
    }
  }

  reserve(account, amount, eventId) {
    return this._submit('reserve', account, amount, eventId);
  }

  commit(account, amount, eventId) {
    return this._submit('commit', account, amount, eventId);
  }

  release(account, amount, eventId) {
    return this._submit('release', account, amount, eventId);
  }

  freeze(account, eventId) {
    return this._submit('freeze', account, 0, eventId);
  }

  state() {
    const result = {};
    for (const [name, account] of this.accounts) {
      result[name] = { ...account };
    }
    return result;
  }

  close() {
    if (this._fd !== null) {
      fs.closeSync(this._fd);
      this._fd = null;
    }
  }
}
