'use strict';

// Append-only settlement audit log with supersedes-based corrections.
// Node.js 22 standard library only.

const crypto = require('node:crypto');
const fs = require('node:fs');

const ENTRY_VERSION = 1;
const GENESIS_PREV_HASH = '0'.repeat(64);
const MAX_FUTURE_SKEW_MS = 5 * 60 * 1000; // wall-clock tolerance for ts / bizTime
const OP_TYPES = new Set(['post', 'correct', 'tombstone']);

function canonicalize(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

function bodyOf(entry) {
  return {
    v: entry.v,
    seq: entry.seq,
    prevHash: entry.prevHash,
    ts: entry.ts,
    bizTime: entry.bizTime,
    op: entry.op,
  };
}

// Signature-style hash: keyed HMAC-SHA256 over the canonical entry body.
function computeHash(key, body) {
  return crypto.createHmac('sha256', key).update(canonicalize(body)).digest('hex');
}

function validateOp(op) {
  if (op === null || typeof op !== 'object') return 'op must be an object';
  if (!OP_TYPES.has(op.type)) return `op.type must be one of ${[...OP_TYPES].join(',')}`;
  if (typeof op.account !== 'string' || op.account.length === 0) return 'op.account must be a non-empty string';
  if (typeof op.bizKey !== 'string' || op.bizKey.length === 0) return 'op.bizKey must be a non-empty string';
  if (op.type === 'post') {
    if (!Number.isSafeInteger(op.amount)) return 'post requires integer op.amount';
    if (op.supersedes != null) return 'post must not carry supersedes';
  }
  if (op.type === 'correct') {
    if (!Number.isSafeInteger(op.amount)) return 'correct requires integer op.amount';
    if (typeof op.supersedes !== 'string' || op.supersedes.length === 0) return 'correct requires op.supersedes';
  }
  if (op.type === 'tombstone') {
    if (typeof op.supersedes !== 'string' || op.supersedes.length === 0) return 'tombstone requires op.supersedes';
    if (op.amount != null) return 'tombstone must not carry amount';
  }
  return null;
}

function keyPathFor(logPath) { return logPath + '.key'; }
function indexPathFor(logPath) { return logPath + '.index'; }

class Ledger {
  constructor(logPath, key) {
    this.logPath = logPath;
    this.key = key;
    this.entries = [];
    this.byId = new Map();
    this.logSize = 0;
  }

  static create(logPath) {
    if (fs.existsSync(logPath)) throw new Error(`log already exists: ${logPath}`);
    const key = crypto.randomBytes(32);
    fs.writeFileSync(keyPathFor(logPath), key.toString('hex') + '\n', { mode: 0o600 });
    fs.writeFileSync(logPath, '');
    fs.writeFileSync(indexPathFor(logPath), '');
    return Ledger.open(logPath);
  }

  static openOrCreate(logPath) {
    return fs.existsSync(logPath) ? Ledger.open(logPath) : Ledger.create(logPath);
  }

  static open(logPath) {
    const keyHex = fs.readFileSync(keyPathFor(logPath), 'utf8').trim();
    const ledger = new Ledger(logPath, Buffer.from(keyHex, 'hex'));
    ledger._recoverIndex();
    ledger._load();
    return ledger;
  }

  // Reconcile the index with the log after a crash.
  // - Index rows pointing past the end of the log (index written, log not) are
  //   dangling and dropped; the index file is rewritten without them.
  // - Log entries missing from the index (log written, index not) are re-indexed.
  _recoverIndex() {
    const indexPath = indexPathFor(this.logPath);
    this.logSize = fs.statSync(this.logPath).size;
    let rows = [];
    if (fs.existsSync(indexPath)) {
      const raw = fs.readFileSync(indexPath, 'utf8');
      for (const line of raw.split('\n')) {
        if (line.trim() === '') continue;
        rows.push(JSON.parse(line));
      }
    }
    const valid = [];
    for (const row of rows) {
      const inRange = row.offset + row.length <= this.logSize;
      const sequential = row.seq === valid.length;
      if (inRange && sequential) valid.push(row);
      else break; // first dangling/broken row invalidates the rest
    }
    let changed = valid.length !== rows.length;

    // Re-index log tail that was written but never indexed.
    let offset = valid.length === 0 ? 0 : valid[valid.length - 1].offset + valid[valid.length - 1].length;
    if (offset < this.logSize) {
      const fd = fs.openSync(this.logPath, 'r');
      const tail = Buffer.alloc(this.logSize - offset);
      fs.readSync(fd, tail, 0, tail.length, offset);
      fs.closeSync(fd);
      let cursor = 0;
      while (cursor < tail.length) {
        const nl = tail.indexOf(0x0a, cursor);
        if (nl === -1) break; // partial trailing line: leave for verify to report
        const length = nl - cursor + 1;
        let hash = null;
        try { hash = JSON.parse(tail.subarray(cursor, nl).toString('utf8')).hash; } catch { /* keep null */ }
        valid.push({ seq: valid.length, offset: offset + cursor, length, hash });
        cursor += length;
      }
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(indexPath, valid.map((r) => JSON.stringify(r)).join('\n') + (valid.length ? '\n' : ''));
    }
    this.indexRows = valid;
  }

  _load() {
    const raw = fs.readFileSync(this.logPath, 'utf8');
    for (const line of raw.split('\n')) {
      if (line === '') continue;
      const entry = JSON.parse(line);
      this.entries.push(entry);
      this.byId.set(entry.hash, entry);
    }
  }

  append(op, opts = {}) {
    const ts = opts.ts ?? Date.now();
    const bizTime = opts.bizTime ?? ts;
    let fullOp = { ...op };
    if (fullOp.supersedes != null) {
      const target = this.byId.get(fullOp.supersedes);
      if (!target) throw new Error(`supersedes target not found: ${fullOp.supersedes}`);
      if (fullOp.bizKey == null) fullOp.bizKey = target.op.bizKey; // corrections inherit business key
    }
    const err = validateOp(fullOp);
    if (err) throw new Error(`invalid op: ${err}`);

    const seq = this.entries.length;
    const prevHash = seq === 0 ? GENESIS_PREV_HASH : this.entries[seq - 1].hash;
    const body = { v: ENTRY_VERSION, seq, prevHash, ts, bizTime, op: fullOp };
    const hash = computeHash(this.key, body);
    const entry = { ...body, hash };
    const line = JSON.stringify(entry) + '\n';
    const length = Buffer.byteLength(line);

    fs.appendFileSync(this.logPath, line); // log first...
    const row = { seq, offset: this.logSize, length, hash };
    fs.appendFileSync(indexPathFor(this.logPath), JSON.stringify(row) + '\n'); // ...then index

    this.logSize += length;
    this.entries.push(entry);
    this.byId.set(hash, entry);
    this.indexRows.push(row);
    return entry;
  }

  get head() {
    if (this.entries.length === 0) return null;
    const last = this.entries[this.entries.length - 1];
    return { seq: last.seq, hash: last.hash };
  }
}

// Verify chain integrity, time windows and signature-style hashes.
// Never mutates the log; reports the first bad entry with its byte offset.
function verifyFile(logPath, opts = {}) {
  const now = opts.now ?? Date.now();
  let key;
  try {
    key = Buffer.from(fs.readFileSync(keyPathFor(logPath), 'utf8').trim(), 'hex');
  } catch (e) {
    return { ok: false, seq: null, offset: null, reason: `key unreadable: ${e.message}` };
  }
  const raw = fs.readFileSync(logPath, 'utf8');
  const lines = raw.split('\n');
  if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop();

  const seenIds = new Set();
  let prevHash = GENESIS_PREV_HASH;
  let prevTs = null;
  let offset = 0;
  let count = 0;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const fail = (reason) => ({ ok: false, seq: i, offset, reason });

    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      return fail('parse-error');
    }
    if (entry.v !== ENTRY_VERSION) return fail(`unsupported-version:${entry.v}`);
    if (entry.seq !== i) return fail(`seq-mismatch:expected-${i}:got-${entry.seq}`);
    if (entry.prevHash !== prevHash) return fail('prev-hash-mismatch');
    if (typeof entry.hash !== 'string' || computeHash(key, bodyOf(entry)) !== entry.hash) return fail('hash-mismatch');
    if (!Number.isSafeInteger(entry.ts) || !Number.isSafeInteger(entry.bizTime)) return fail('invalid-timestamps');
    if (prevTs !== null && entry.ts < prevTs) return fail('time-not-monotonic');
    if (entry.ts > now + MAX_FUTURE_SKEW_MS) return fail('time-in-future');
    if (entry.bizTime > entry.ts + MAX_FUTURE_SKEW_MS) return fail('biztime-after-write');
    const opErr = validateOp(entry.op);
    if (opErr) return fail(`invalid-op:${opErr}`);
    if (entry.op.supersedes != null && !seenIds.has(entry.op.supersedes)) return fail('supersedes-unknown');

    seenIds.add(entry.hash);
    prevHash = entry.hash;
    prevTs = entry.ts;
    offset += Buffer.byteLength(line) + 1;
    count++;
  }
  return { ok: true, entries: count, head: prevHash === GENESIS_PREV_HASH ? null : prevHash };
}

// ---- View ----------------------------------------------------------------

function applyAccountOps(accountEntries) {
  const sorted = [...accountEntries].sort((a, b) => a.seq - b.seq);
  const byId = new Map(sorted.map((e) => [e.hash, e]));
  const children = new Map();
  const roots = [];
  for (const e of sorted) {
    if (e.op.supersedes != null) {
      const p = e.op.supersedes;
      if (!children.has(p)) children.set(p, []);
      children.get(p).push(e);
    } else {
      roots.push(e);
    }
  }

  const parentOf = (e) => (e.op.supersedes != null ? byId.get(e.op.supersedes) : null);
  const isAncestor = (a, b) => {
    let cur = parentOf(b);
    while (cur) {
      if (cur.hash === a.hash) return true;
      cur = parentOf(cur);
    }
    return false;
  };

  const effective = [];
  const tombstoned = [];
  const superseded = [];
  const conflicts = [];

  for (const root of roots) {
    // Flatten the whole supersedes tree for this business key.
    const tree = [];
    const stack = [root];
    while (stack.length > 0) {
      const n = stack.pop();
      tree.push(n);
      for (const k of children.get(n.hash) || []) stack.push(k);
    }
    // Business time decides which correction is in effect.
    let maxBizTime = -Infinity;
    for (const n of tree) maxBizTime = Math.max(maxBizTime, n.bizTime);
    let top = tree.filter((n) => n.bizTime === maxBizTime);
    // A correction that supersedes another top node wins over its ancestor.
    top = top.filter((n) => !top.some((m) => m.hash !== n.hash && isAncestor(n, m)));
    top.sort((a, b) => a.seq - b.seq);
    const winner = top[0];
    if (top.length > 1) {
      // Concurrent corrections on the same business key: keep a certificate.
      conflicts.push({
        type: 'concurrent-correction',
        account: root.op.account,
        bizKey: root.op.bizKey,
        bizTime: maxBizTime,
        candidates: top.map((n) => n.hash).sort(),
        winner: winner.hash,
      });
    }
    for (const n of tree) {
      if (n.hash !== winner.hash) superseded.push(n.hash);
    }
    if (winner.op.type === 'tombstone') tombstoned.push(winner.hash);
    else effective.push(winner);
  }

  const balance = effective.reduce((sum, e) => sum + e.op.amount, 0);
  return {
    balance,
    effective: effective.map((e) => e.hash),
    tombstoned,
    superseded: [...new Set(superseded)],
    conflicts,
  };
}

function buildView(entries) {
  const byAccount = new Map();
  for (const e of entries) {
    if (!byAccount.has(e.op.account)) byAccount.set(e.op.account, []);
    byAccount.get(e.op.account).push(e);
  }
  const accounts = {};
  for (const [account, ops] of [...byAccount.entries()].sort()) {
    accounts[account] = applyAccountOps(ops);
  }
  return { accounts };
}

// ---- Proof ---------------------------------------------------------------

function makeProof(entries, account) {
  const accountEntries = entries.filter((e) => e.op.account === account);
  const byId = new Map(entries.map((e) => [e.hash, e]));
  const correctionAncestors = {};
  for (const e of accountEntries) {
    const chain = [];
    let cur = e;
    while (cur.op.supersedes != null) {
      cur = byId.get(cur.op.supersedes);
      if (!cur) break;
      chain.push(cur.hash);
    }
    if (chain.length > 0) correctionAncestors[e.hash] = chain;
  }
  const headEntry = entries[entries.length - 1];
  return {
    version: 1,
    account,
    head: { seq: headEntry.seq, hash: headEntry.hash },
    chain: entries.map((e) => ({ seq: e.seq, hash: e.hash })), // hash-chain path
    entries: accountEntries,
    correctionAncestors,
    view: applyAccountOps(accountEntries),
  };
}

function verifyProof(proof, key, opts = {}) {
  const fail = (reason) => ({ ok: false, reason });
  if (!proof || proof.version !== 1) return fail('bad-proof-version');
  const chain = proof.chain;
  if (!Array.isArray(chain) || chain.length === 0) return fail('empty-chain');
  for (let i = 0; i < chain.length; i++) {
    if (chain[i].seq !== i) return fail(`chain-seq-mismatch:${i}`);
  }
  if (proof.head.seq !== chain.length - 1 || proof.head.hash !== chain[chain.length - 1].hash) {
    return fail('head-mismatch');
  }
  const byId = new Map();
  for (const entry of proof.entries) {
    if (computeHash(key, bodyOf(entry)) !== entry.hash) return fail(`entry-hash-mismatch:${entry.seq}`);
    if (entry.op.account !== proof.account) return fail(`foreign-entry:${entry.seq}`);
    if (chain[entry.seq] == null || chain[entry.seq].hash !== entry.hash) return fail(`not-in-chain:${entry.seq}`);
    const expectPrev = entry.seq === 0 ? GENESIS_PREV_HASH : chain[entry.seq - 1].hash;
    if (entry.prevHash !== expectPrev) return fail(`prev-hash-mismatch:${entry.seq}`);
    byId.set(entry.hash, entry);
  }
  // Recompute correction ancestry from the entries themselves.
  for (const e of proof.entries) {
    const chainAnc = [];
    let cur = e;
    while (cur.op.supersedes != null) {
      cur = byId.get(cur.op.supersedes);
      if (!cur) return fail(`ancestor-missing:${e.hash}`);
      chainAnc.push(cur.hash);
    }
    const declared = proof.correctionAncestors[e.hash] || [];
    if (canonicalize(chainAnc) !== canonicalize(declared)) return fail(`ancestor-mismatch:${e.hash}`);
  }
  // Rebuild the account view from proof entries and compare.
  const rebuilt = applyAccountOps(proof.entries);
  if (canonicalize(rebuilt) !== canonicalize(proof.view)) return fail('view-mismatch');
  // Optional: cross-check the proof head against the live log tip.
  if (opts.headHash != null && opts.headHash !== proof.head.hash) return fail('head-vs-log-mismatch');
  return { ok: true, account: proof.account, head: proof.head, entries: proof.entries.length };
}

module.exports = {
  GENESIS_PREV_HASH,
  MAX_FUTURE_SKEW_MS,
  canonicalize,
  computeHash,
  bodyOf,
  validateOp,
  Ledger,
  verifyFile,
  applyAccountOps,
  buildView,
  makeProof,
  verifyProof,
  keyPathFor,
  indexPathFor,
};
