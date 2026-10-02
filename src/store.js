'use strict';
// Transactional file store with write-ahead journal.
//
// Balance and frozen ledgers are committed as separate files, so a crash can
// leave them inconsistent. Every commit first journals pre/post images; on
// recovery an unfinished journal entry is rolled back on BOTH sides, so the
// pair is always consistent (either fully pre or fully post).

const fs = require('node:fs');
const path = require('node:path');
const { GuardError, ERR, initialState, applyEvent, hashState } = require('./model');

function writeJsonAtomic(file, value) {
  const tmp = file + '.tmp';
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(value));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

function split(state) {
  const balance = {};
  const frozen = {};
  for (const [name, acc] of Object.entries(state.accounts)) {
    balance[name] = acc.balance;
    frozen[name] = acc.frozen;
  }
  return {
    balance,
    frozen,
    meta: { sales: state.sales, refunds: state.refunds, refundStack: state.refundStack },
  };
}

function join(balance, frozen, meta) {
  const state = initialState();
  for (const name of new Set([...Object.keys(balance), ...Object.keys(frozen)])) {
    state.accounts[name] = { balance: balance[name] || 0, frozen: frozen[name] || 0 };
  }
  state.sales = meta.sales || {};
  state.refunds = meta.refunds || {};
  state.refundStack = meta.refundStack || {};
  return state;
}

class Store {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.files = {
      balance: path.join(dir, 'balance.json'),
      frozen: path.join(dir, 'frozen.json'),
      meta: path.join(dir, 'meta.json'),
      journal: path.join(dir, 'journal.json'),
    };
  }

  load() {
    return join(
      readJson(this.files.balance, {}),
      readJson(this.files.frozen, {}),
      readJson(this.files.meta, {})
    );
  }

  // Commit a transaction (one or more events) atomically.
  // opts.expectedHash: optimistic concurrency token (hashState of the state the
  //   caller validated against). Mismatch => conflict certificate, no writes.
  // opts.onCrash(point): test hook invoked after each physical write stage
  //   ('journal' | 'balance' | 'frozen' | 'meta'); if it throws, the commit
  //   aborts mid-flight, simulating a crash.
  commit(events, opts = {}) {
    const pre = this.load();
    if (opts.expectedHash !== undefined && hashState(pre) !== opts.expectedHash) {
      return {
        ok: false,
        code: ERR.DUPLICATE_REFUND,
        reason: 'concurrent conflict: base state changed since validation',
        certificate: {
          code: ERR.DUPLICATE_REFUND,
          reason: 'concurrent conflict: base state changed since validation',
          events,
          expectedHash: opts.expectedHash,
          actualHash: hashState(pre),
        },
      };
    }
    const post = structuredClone(pre);
    try {
      for (const ev of events) applyEvent(post, ev);
    } catch (e) {
      if (!(e instanceof GuardError)) throw e;
      return {
        ok: false,
        code: e.code,
        reason: e.message,
        certificate: { code: e.code, reason: e.message, events, stateHash: hashState(pre) },
      };
    }
    const crash = (point) => {
      if (opts.onCrash) opts.onCrash(point);
    };
    const entry = { pre: split(pre), post: split(post), done: false };
    writeJsonAtomic(this.files.journal, entry);
    crash('journal');
    writeJsonAtomic(this.files.balance, entry.post.balance);
    crash('balance');
    writeJsonAtomic(this.files.frozen, entry.post.frozen);
    crash('frozen');
    writeJsonAtomic(this.files.meta, entry.post.meta);
    crash('meta');
    writeJsonAtomic(this.files.journal, { ...entry, done: true });
    return { ok: true, hash: hashState(post) };
  }

  // Roll back an unfinished transaction on BOTH ledgers.
  recover() {
    const entry = readJson(this.files.journal, null);
    if (!entry || entry.done) return { recovered: false };
    writeJsonAtomic(this.files.balance, entry.pre.balance);
    writeJsonAtomic(this.files.frozen, entry.pre.frozen);
    writeJsonAtomic(this.files.meta, entry.pre.meta);
    writeJsonAtomic(this.files.journal, { ...entry, done: true, rolledBack: true });
    return { recovered: true };
  }
}

module.exports = { Store };
