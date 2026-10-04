'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { sha256hex, hmacSha256hex, canonical, merkleRoot } = require('./util');

const GENESIS = '0'.repeat(64);

class ChainError extends Error {
  constructor(reason, index) {
    super(reason + ' at entry ' + index);
    this.name = 'ChainError';
    this.reason = reason;
    this.index = index;
  }
}

function entryHash(entry) {
  const { hash, ...rest } = entry;
  return sha256hex(canonical(rest));
}

function verifyChain(entries) {
  let prev = GENESIS;
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    if (e.index !== i) throw new ChainError('index_gap', i);
    if (e.prevHash !== prev) throw new ChainError('chain_break', i);
    if (entryHash(e) !== e.hash) throw new ChainError('hash_mismatch', i);
    if (e.kind === 'inverse') {
      const p = e.proof || {};
      const t = entries[p.targetIndex];
      if (!t || t.hash !== p.targetHash) throw new ChainError('proof_invalid', i);
      if (t.stateHashBefore !== p.targetStateBefore) throw new ChainError('proof_invalid', i);
      if (t.opId !== e.undoOf) throw new ChainError('proof_invalid', i);
    }
    prev = e.hash;
  }
}

// Reads a JSONL log, truncating a torn tail left by a crash mid-write.
function loadEntriesFromFile(logPath) {
  if (!fs.existsSync(logPath)) return [];
  const buf = fs.readFileSync(logPath);
  const entries = [];
  let good = 0;
  let pos = 0;
  while (pos < buf.length) {
    const nl = buf.indexOf(0x0a, pos);
    if (nl === -1) break;
    try {
      entries.push(JSON.parse(buf.subarray(pos, nl).toString('utf8')));
      good = nl + 1;
    } catch {
      break;
    }
    pos = nl + 1;
  }
  if (good < buf.length) fs.truncateSync(logPath, good);
  verifyChain(entries);
  return entries;
}

class AuditLog {
  // dir === null selects the in-memory mode used by tests / the reference serializer.
  constructor(dir, opts = {}) {
    this.dir = dir || null;
    this.memory = !dir;
    this.entries = [];
    this.hooks = opts.hooks || {};
    this.checkpointEvery = opts.checkpointEvery || 4;
    if (!this.memory) {
      fs.mkdirSync(dir, { recursive: true });
      this.logPath = path.join(dir, 'audit.log');
      this.keyPath = path.join(dir, 'terminal.key');
      this.checkpointPath = path.join(dir, 'checkpoint.json');
    }
  }

  get headHash() {
    return this.entries.length ? this.entries[this.entries.length - 1].hash : GENESIS;
  }

  get root() {
    return merkleRoot(this.entries.map((e) => e.hash));
  }

  open() {
    if (this.memory) return;
    if (!fs.existsSync(this.keyPath)) {
      fs.writeFileSync(this.keyPath, crypto.randomBytes(32).toString('hex'), { mode: 0o600 });
    }
    this.key = fs.readFileSync(this.keyPath, 'utf8').trim();
    this.entries = loadEntriesFromFile(this.logPath);
    this.fd = fs.openSync(this.logPath, 'a');
  }

  append(entry) {
    if (this.memory) {
      this.entries.push(entry);
      return;
    }
    fs.writeSync(this.fd, JSON.stringify(entry) + '\n');
    fs.fsyncSync(this.fd);
    if (this.hooks.afterFlush) this.hooks.afterFlush(entry); // crash point 2
    this.entries.push(entry);
  }

  maybeCheckpoint() {
    if (this.memory) return;
    if (this.entries.length > 0 && this.entries.length % this.checkpointEvery === 0) {
      this.writeCheckpoint();
    }
  }

  writeCheckpoint() {
    const body = {
      version: 1,
      count: this.entries.length,
      root: this.root,
      headHash: this.headHash,
      vclock: this.entries.length,
      log: path.basename(this.logPath),
      key: path.basename(this.keyPath),
    };
    const cp = { ...body, sig: hmacSha256hex(this.key, canonical(body)) };
    const tmp = this.checkpointPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(cp, null, 2) + '\n');
    fs.renameSync(tmp, this.checkpointPath);
    return cp;
  }
}

function verifyCheckpointFile(checkpointPath) {
  const cp = JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
  const dir = path.dirname(path.resolve(checkpointPath));
  const logPath = path.resolve(dir, cp.log);
  const keyPath = path.resolve(dir, cp.key);
  const entries = loadEntriesFromFile(logPath); // throws ChainError
  const problems = [];
  if (entries.length !== cp.count) problems.push('count_mismatch');
  if (merkleRoot(entries.map((e) => e.hash)) !== cp.root) problems.push('root_mismatch');
  const head = entries.length ? entries[entries.length - 1].hash : GENESIS;
  if (head !== cp.headHash) problems.push('head_mismatch');
  let key = null;
  try {
    key = fs.readFileSync(keyPath, 'utf8').trim();
  } catch {
    problems.push('key_unreadable');
  }
  if (key !== null) {
    const { sig, ...body } = cp;
    if (hmacSha256hex(key, canonical(body)) !== sig) problems.push('bad_signature');
  }
  return {
    ok: problems.length === 0,
    problems,
    count: entries.length,
    root: cp.root,
    headHash: head,
    sig: problems.length === 0 ? 'valid' : 'invalid',
  };
}

module.exports = { AuditLog, ChainError, GENESIS, entryHash, verifyChain, verifyCheckpointFile };
