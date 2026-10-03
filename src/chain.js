'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { canonical } = require('./canon');
const { ZERO_HASH } = require('./frame');

const EXIT = { OK: 0, FRAME: 2, LEASE: 3, CHAIN: 5 };

class ChainError extends Error {
  constructor(message) {
    super(message);
    this.code = 'CHAIN_ERROR';
  }
}

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function stateHashOf(state) {
  return sha256hex('STATE:' + canonical(state));
}

function hashEntry(e) {
  return sha256hex(canonical({
    seq: e.seq, kind: e.kind, opId: e.opId, actor: e.actor, cmd: e.cmd,
    args: e.args, prevHash: e.prevHash, inv: e.inv, proof: e.proof ?? null,
    stateHash: e.stateHash,
  }));
}

function checkpointSig({ count, root, stateHash }) {
  return sha256hex(`ATCHK:${count}:${root}:${stateHash}`);
}

function makeCheckpoint({ count, root, stateHash }) {
  const ck = { count, root, stateHash };
  return { ...ck, sig: checkpointSig(ck) };
}

// Append-only log + hash chain + index, with crash recovery.
class Chain {
  // dir === null => in-memory (tests). Crash points are simulated by hooks:
  //   hooks.afterParse, hooks.afterLogFlush, hooks.afterIndexUpdate
  constructor(dir, { checkpointEvery = 4, hooks = {} } = {}) {
    this.dir = dir;
    this.checkpointEvery = checkpointEvery;
    this.hooks = hooks;
    this.entries = [];
    this.state = {};
    this.byOpId = new Map(); // opId -> entry
    this.tip = ZERO_HASH;
    this.checkpoints = [];
    if (dir) {
      fs.mkdirSync(dir, { recursive: true });
      this.logPath = path.join(dir, 'audit.log');
      this.indexPath = path.join(dir, 'index.json');
      this.evidencePath = path.join(dir, 'evidence.json');
      this.checkpointPath = path.join(dir, 'checkpoint.json');
      this.recover();
    }
  }

  get count() {
    return this.entries.length;
  }

  // Rebuild index from the append-only log; the log is the source of truth.
  recover() {
    this.entries = [];
    this.state = {};
    this.byOpId = new Map();
    this.tip = ZERO_HASH;
    if (fs.existsSync(this.logPath)) {
      const lines = fs.readFileSync(this.logPath, 'utf8').split('\n').filter((l) => l.length);
      for (const line of lines) {
        const entry = JSON.parse(line);
        this._verifyAndApply(entry);
      }
    }
    // Cross-check a persisted index against the rebuilt one; log wins.
    if (fs.existsSync(this.indexPath)) {
      const idx = JSON.parse(fs.readFileSync(this.indexPath, 'utf8'));
      if (idx.count !== this.count || idx.tip !== this.tip) {
        this._writeIndex(); // stale index (crash between log flush and index update): rewrite
      }
    } else if (this.count > 0) {
      this._writeIndex();
    }
    return this;
  }

  _verifyAndApply(entry) {
    if (entry.seq !== this.count + 1) throw new ChainError(`chain break: expected seq ${this.count + 1}, got ${entry.seq}`);
    if (entry.prevHash !== this.tip) throw new ChainError(`chain break: prevHash mismatch at seq ${entry.seq}`);
    if (hashEntry(entry) !== entry.hash) throw new ChainError(`chain break: hash mismatch at seq ${entry.seq}`);
    const applied = applyOp(this.state, entry.cmd, entry.args, this);
    if (canonical(applied.inv) !== canonical(entry.inv)) throw new ChainError(`chain break: inverse mismatch at seq ${entry.seq}`);
    if (entry.kind === 'undo') {
      const target = this.byOpId.get(entry.args.target);
      if (!target) throw new ChainError(`chain break: undo target missing at seq ${entry.seq}`);
      const pre = target.seq >= 2 ? this.entries[target.seq - 2].stateHash : stateHashOf({});
      if (entry.proof.targetHash !== target.hash || entry.proof.preStateHash !== pre) {
        throw new ChainError(`chain break: undo proof invalid at seq ${entry.seq}`);
      }
    }
    const sh = stateHashOf(this.state);
    if (sh !== entry.stateHash) throw new ChainError(`chain break: stateHash mismatch at seq ${entry.seq}`);
    entry._invResult = applied;
    this.entries.push(entry);
    this.byOpId.set(entry.opId, entry);
    this.tip = entry.hash;
  }

  // Append a new entry executing cmd/args. Returns the entry.
  append({ opId, actor, cmd, args, kind = 'op' }) {
    let proof = null;
    if (kind === 'undo') {
      const target = this.byOpId.get(args.target);
      if (!target) throw new ChainError(`undo target not found: ${args.target}`);
      proof = {
        targetHash: target.hash,
        targetSeq: target.seq,
        preStateHash: target.seq >= 2 ? this.entries[target.seq - 2].stateHash : stateHashOf({}),
      };
      const applied = applyInverse(this.state, target);
      return this._commit({ opId, actor, cmd: 'undo', args: { target: args.target }, kind, inv: applied.inv, proof });
    }
    const applied = applyOp(this.state, cmd, args, this);
    return this._commit({ opId, actor, cmd, args, kind, inv: applied.inv, proof });
  }

  _commit({ opId, actor, cmd, args, kind, inv, proof }) {
    const entry = {
      seq: this.count + 1, kind, opId, actor, cmd, args,
      prevHash: this.tip, inv, proof, stateHash: stateHashOf(this.state),
    };
    entry.hash = hashEntry(entry);
    // crash point 2: log flushed, index not yet updated
    if (this.dir) fs.appendFileSync(this.logPath, canonical(entry) + '\n');
    if (this.hooks.afterLogFlush) this.hooks.afterLogFlush(entry);
    this.entries.push(entry);
    this.byOpId.set(opId, entry);
    this.tip = entry.hash;
    if (this.dir) this._writeIndex();
    // crash point 3: index updated
    if (this.hooks.afterIndexUpdate) this.hooks.afterIndexUpdate(entry);
    if (this.dir && this.count % this.checkpointEvery === 0) this.issueCheckpoint();
    return entry;
  }

  _writeIndex() {
    const opIds = {};
    for (const [opId, e] of this.byOpId) opIds[opId] = { seq: e.seq, hash: e.hash };
    const tmp = this.indexPath + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify({ count: this.count, tip: this.tip, opIds }));
    fs.renameSync(tmp, this.indexPath);
  }

  issueCheckpoint() {
    const ck = makeCheckpoint({ count: this.count, root: this.tip, stateHash: stateHashOf(this.state) });
    this.checkpoints.push(ck);
    if (this.dir) fs.writeFileSync(this.checkpointPath, JSON.stringify(ck, null, 2) + '\n');
    return ck;
  }

  recordEvidence(rejection) {
    if (!this.dir) return;
    let list = [];
    if (fs.existsSync(this.evidencePath)) list = JSON.parse(fs.readFileSync(this.evidencePath, 'utf8'));
    list.push(rejection);
    fs.writeFileSync(this.evidencePath, JSON.stringify(list, null, 2) + '\n');
  }

  // Verify the whole log against a checkpoint object. Throws ChainError.
  verifyCheckpoint(ck) {
    if (ck.sig !== checkpointSig(ck)) throw new ChainError('checkpoint signature invalid');
    if (ck.count !== this.count) throw new ChainError(`checkpoint count ${ck.count} != log count ${this.count}`);
    if (ck.root !== this.tip) throw new ChainError(`checkpoint root ${ck.root} != log tip ${this.tip}`);
    if (ck.stateHash !== stateHashOf(this.state)) throw new ChainError('checkpoint stateHash mismatch');
    return true;
  }
}

// Apply a normal op to state; returns { inv } the inverse op.
function applyOp(state, cmd, args, chain) {
  switch (cmd) {
    case 'set': {
      const had = Object.prototype.hasOwnProperty.call(state, args.key);
      const old = state[args.key];
      state[args.key] = args.value;
      return { inv: had ? { cmd: 'set', args: { key: args.key, value: old } } : { cmd: 'del', args: { key: args.key } } };
    }
    case 'del': {
      const had = Object.prototype.hasOwnProperty.call(state, args.key);
      const old = state[args.key];
      delete state[args.key];
      return { inv: had ? { cmd: 'set', args: { key: args.key, value: old } } : { cmd: 'noop', args: {} } };
    }
    case 'inc': {
      const cur = Number(state[args.key] ?? 0);
      state[args.key] = cur + Number(args.n);
      return { inv: { cmd: 'inc', args: { key: args.key, n: -Number(args.n) } } };
    }
    case 'noop':
      return { inv: { cmd: 'noop', args: {} } };
    case 'undo': {
      const target = chain.byOpId.get(args.target);
      if (!target) throw new ChainError(`undo target not found: ${args.target}`);
      return applyInverse(state, target);
    }
    default:
      throw new ChainError(`unknown cmd: ${cmd}`);
  }
}

// Apply the inverse of an existing entry; inverse of the inverse is the entry's own op.
function applyInverse(state, target) {
  const r = applyOp(state, target.inv.cmd, target.inv.args, null);
  void r;
  return { inv: { cmd: target.cmd, args: target.args } };
}

module.exports = { Chain, ChainError, EXIT, hashEntry, stateHashOf, makeCheckpoint, checkpointSig, applyOp, sha256hex };
