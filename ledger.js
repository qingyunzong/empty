'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');

const GENESIS_HASH = '0'.repeat(64);
const EVENT_TYPES = new Set(['reserve', 'commit', 'release', 'freeze']);
const DEFAULT_LIMIT = 1_000_000_000;

class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

function canonicalPayload(record) {
  return JSON.stringify({
    seq: record.seq,
    eventId: record.eventId,
    type: record.type,
    account: record.account,
    amount: record.amount,
    prevHash: record.prevHash,
  });
}

function computeHash(record) {
  return crypto.createHash('sha256').update(canonicalPayload(record), 'utf8').digest('hex');
}

function validateRecord(record) {
  if (record === null || typeof record !== 'object' || Array.isArray(record)) return 'not an object';
  if (!Number.isInteger(record.seq) || record.seq < 1) return 'invalid seq';
  if (typeof record.eventId !== 'string' || record.eventId.length === 0) return 'invalid eventId';
  if (!EVENT_TYPES.has(record.type)) return 'invalid type';
  if (typeof record.account !== 'string' || record.account.length === 0) return 'invalid account';
  if (typeof record.amount !== 'number' || !Number.isFinite(record.amount) || record.amount < 0) return 'invalid amount';
  if (typeof record.prevHash !== 'string' || !/^[0-9a-f]{64}$/.test(record.prevHash)) return 'invalid prevHash';
  if (typeof record.hash !== 'string' || !/^[0-9a-f]{64}$/.test(record.hash)) return 'invalid hash';
  return null;
}

class Ledger {
  constructor(file, options = {}) {
    this.file = file;
    this.limit = options.limit === undefined ? DEFAULT_LIMIT : options.limit;
    this.accounts = new Map();
    this.eventIds = new Set();
    this.seq = 0;
    this.headHash = GENESIS_HASH;
    this.recovery = this._recover();
  }

  _limitFor(account) {
    if (typeof this.limit === 'object' && this.limit !== null) {
      return this.limit[account] === undefined ? DEFAULT_LIMIT : this.limit[account];
    }
    return this.limit;
  }

  _ensureAccount(name) {
    let acc = this.accounts.get(name);
    if (!acc) {
      acc = { limit: this._limitFor(name), held: 0, committed: 0, frozen: false };
      this.accounts.set(name, acc);
    }
    return acc;
  }

  _recover() {
    const report = {
      truncated: false,
      offset: null,
      line: null,
      reason: null,
      validEvents: 0,
      headHash: GENESIS_HASH,
    };
    let buf;
    try {
      buf = fs.readFileSync(this.file);
    } catch (err) {
      if (err.code === 'ENOENT') return report;
      throw err;
    }
    let start = 0;
    let lineNo = 0;
    while (start < buf.length) {
      const nl = buf.indexOf(0x0a, start);
      const end = nl === -1 ? buf.length : nl;
      const line = buf.subarray(start, end).toString('utf8');
      lineNo += 1;
      const problem = this._inspectLine(line);
      if (problem !== null) {
        fs.truncateSync(this.file, start);
        report.truncated = true;
        report.offset = start;
        report.line = lineNo;
        report.reason = problem;
        break;
      }
      this._replay(JSON.parse(line));
      if (nl === -1) break;
      start = nl + 1;
    }
    report.validEvents = this.seq;
    report.headHash = this.headHash;
    return report;
  }

  _inspectLine(line) {
    if (line.length === 0) return 'empty line';
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      return 'invalid JSON';
    }
    const invalid = validateRecord(record);
    if (invalid !== null) return invalid;
    if (record.seq !== this.seq + 1) return `seq gap: expected ${this.seq + 1}, got ${record.seq}`;
    if (record.prevHash !== this.headHash) return 'prevHash mismatch';
    if (computeHash(record) !== record.hash) return 'hash mismatch';
    if (this.eventIds.has(record.eventId)) return `duplicate eventId ${record.eventId}`;
    return null;
  }

  _replay(record) {
    this._apply(record);
    this.eventIds.add(record.eventId);
    this.seq = record.seq;
    this.headHash = record.hash;
  }

  _check(event) {
    const acc = this.accounts.get(event.account);
    switch (event.type) {
      case 'reserve': {
        if (acc && acc.frozen) return 'account frozen';
        const a = acc || { limit: this._limitFor(event.account), held: 0, committed: 0 };
        if (a.limit - a.held - a.committed < event.amount) return 'insufficient available';
        return null;
      }
      case 'commit': {
        if (!acc) return 'unknown account';
        if (acc.held < event.amount) return 'insufficient held';
        return null;
      }
      case 'release': {
        if (!acc) return 'unknown account';
        if (acc.held < event.amount) return 'insufficient held';
        return null;
      }
      case 'freeze':
        return null;
      default:
        return 'unknown type';
    }
  }

  _apply(event) {
    const acc = this._ensureAccount(event.account);
    switch (event.type) {
      case 'reserve':
        acc.held += event.amount;
        break;
      case 'commit':
        acc.held -= event.amount;
        acc.committed += event.amount;
        break;
      case 'release':
        acc.held -= event.amount;
        break;
      case 'freeze':
        acc.frozen = true;
        break;
    }
  }

  append(input, options = {}) {
    const crash = options.crash || null;
    if (crash !== null && crash !== 'beforeAppend' && crash !== 'afterAppend') {
      throw new TypeError(`unknown crash point: ${crash}`);
    }
    const event = {
      seq: this.seq + 1,
      eventId: input.eventId,
      type: input.type,
      account: input.account,
      amount: input.type === 'freeze' ? 0 : input.amount,
      prevHash: this.headHash,
    };
    const invalid = validateRecord({ ...event, hash: GENESIS_HASH });
    if (invalid !== null) throw new TypeError(`invalid event: ${invalid}`);
    if (this.eventIds.has(event.eventId)) {
      return { applied: false, reason: 'duplicate eventId', event: null };
    }
    const rejected = this._check(event);
    if (rejected !== null) {
      return { applied: false, reason: rejected, event: null };
    }
    event.hash = computeHash(event);
    if (crash === 'beforeAppend') throw new CrashError('beforeAppend');
    const fd = fs.openSync(this.file, 'a');
    try {
      fs.writeSync(fd, JSON.stringify(event) + '\n');
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (crash === 'afterAppend') throw new CrashError('afterAppend');
    this._apply(event);
    this.eventIds.add(event.eventId);
    this.seq = event.seq;
    this.headHash = event.hash;
    return { applied: true, reason: null, event };
  }

  snapshot() {
    const accounts = {};
    for (const name of [...this.accounts.keys()].sort()) {
      const acc = this.accounts.get(name);
      accounts[name] = {
        limit: acc.limit,
        held: acc.held,
        committed: acc.committed,
        available: acc.limit - acc.held - acc.committed,
        frozen: acc.frozen,
      };
    }
    return { seq: this.seq, headHash: this.headHash, accounts };
  }
}

module.exports = { Ledger, CrashError, computeHash, canonicalPayload, GENESIS_HASH, EVENT_TYPES };
