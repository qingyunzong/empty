'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const GENESIS = '0'.repeat(64);

const EXIT = {
  ANCHOR_NOT_FOUND: 3,
  DUPLICATE_REVERSAL: 4,
  PUBLISHED_TAMPER: 5,
  UNSATISFIABLE: 6,
};

class LedgerError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  return '{' + Object.keys(value).sort().map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function chainHash(tx) {
  return sha256(canonical(tx));
}

function reversalPayloadHash(targetId) {
  return sha256('reverse:' + targetId);
}

function isLedgerTx(tx) {
  return tx !== null && typeof tx === 'object'
    && typeof tx.id === 'string' && tx.id.length > 0
    && typeof tx.parent === 'string' && /^[0-9a-f]{64}$/.test(tx.parent)
    && typeof tx.amount === 'number' && Number.isInteger(tx.amount)
    && typeof tx.account === 'string' && tx.account.length > 0
    && (tx.kind === 'NORMAL' || tx.kind === 'REVERSAL')
    && typeof tx.payloadHash === 'string';
}

function validateTx(tx) {
  if (!isLedgerTx(tx)) {
    throw new LedgerError('INVALID_TX', 2, 'tx must have id, parent (64-hex), integer amount, account, kind NORMAL|REVERSAL, payloadHash');
  }
}

function netTotals(txs) {
  const totals = new Map();
  for (const tx of txs) {
    totals.set(tx.account, (totals.get(tx.account) || 0) + tx.amount);
  }
  return totals;
}

function totalsEqual(a, b) {
  const keys = new Set([...a.keys(), ...b.keys()]);
  for (const k of keys) {
    if ((a.get(k) || 0) !== (b.get(k) || 0)) return false;
  }
  return true;
}

function reversalTargetId(revTx, candidates) {
  for (const c of candidates) {
    if (reversalPayloadHash(c.id) === revTx.payloadHash) return c.id;
  }
  return null;
}

function reverseTxFor(target, parent) {
  return {
    id: `rev-${target.id}`,
    parent,
    amount: -target.amount,
    account: target.account,
    kind: 'REVERSAL',
    payloadHash: reversalPayloadHash(target.id),
  };
}

class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.txsDir = path.join(dir, 'txs');
    this.headPath = path.join(dir, 'HEAD');
  }

  static init(dir) {
    const ledger = new Ledger(dir);
    if (fs.existsSync(ledger.headPath)) {
      throw new LedgerError('ALREADY_INITIALIZED', 2, `ledger already initialized at ${dir}`);
    }
    fs.mkdirSync(ledger.txsDir, { recursive: true });
    fs.writeFileSync(ledger.headPath, GENESIS + '\n');
    return ledger;
  }

  static open(dir) {
    const ledger = new Ledger(dir);
    if (!fs.existsSync(ledger.headPath)) {
      throw new LedgerError('NOT_INITIALIZED', 2, `no ledger at ${dir} (run init first)`);
    }
    ledger.recover();
    return ledger;
  }

  // Remove any leftover tmp files from an interrupted commit.
  // tmp files are never referenced by HEAD, so deleting them is always safe.
  recover() {
    for (const name of fs.readdirSync(this.txsDir)) {
      if (name.endsWith('.tmp')) fs.rmSync(path.join(this.txsDir, name), { force: true });
    }
    fs.rmSync(this.headPath + '.tmp', { force: true });
  }

  head() {
    return fs.readFileSync(this.headPath, 'utf8').trim();
  }

  hasTx(hash) {
    return fs.existsSync(path.join(this.txsDir, hash + '.json'));
  }

  readTx(hash) {
    let raw;
    try {
      raw = fs.readFileSync(path.join(this.txsDir, hash + '.json'), 'utf8');
    } catch {
      throw new LedgerError('CHAIN_BROKEN', EXIT.PUBLISHED_TAMPER, `missing tx file for ${hash}`);
    }
    try {
      return JSON.parse(raw);
    } catch {
      throw new LedgerError('CHAIN_BROKEN', EXIT.PUBLISHED_TAMPER, `corrupt tx file for ${hash}`);
    }
  }

  // Walk the chain from HEAD back to genesis; returns entries oldest-first.
  // Each entry: { hash, tx }
  chain() {
    const out = [];
    let cursor = this.head();
    const seen = new Set();
    while (cursor !== GENESIS) {
      if (seen.has(cursor)) {
        throw new LedgerError('CHAIN_BROKEN', EXIT.PUBLISHED_TAMPER, `cycle detected at ${cursor}`);
      }
      seen.add(cursor);
      const tx = this.readTx(cursor);
      if (chainHash(tx) !== cursor) {
        throw new LedgerError('CHAIN_BROKEN', EXIT.PUBLISHED_TAMPER, `hash mismatch at ${cursor}`);
      }
      out.push({ hash: cursor, tx });
      cursor = tx.parent;
    }
    out.reverse();
    return out;
  }

  // Persist a batch of new txs plus a new head, atomically w.r.t. crashes:
  //   1. write each tx to <hash>.json.tmp, fsync, rename to <hash>.json
  //      (tx files are content-addressed and immutable; orphans are harmless)
  //   2. write HEAD.tmp, fsync, rename to HEAD (the single atomic "commit" point)
  // Any failure before HEAD rename leaves the old chain intact; a failure
  // after leaves the new chain intact. Faults are injected via LEDGER_FAIL_AT
  // = tmp | rename | head for testing.
  commit(newTxs, newHead) {
    for (const tx of newTxs) {
      const hash = chainHash(tx);
      const finalPath = path.join(this.txsDir, hash + '.json');
      if (this.hasTx(hash)) continue; // immutable, already stored
      const tmpPath = finalPath + '.tmp';
      this.injectFault('tmp');
      const fd = fs.openSync(tmpPath, 'w');
      fs.writeSync(fd, JSON.stringify(tx, null, 2) + '\n');
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      this.injectFault('rename');
      fs.renameSync(tmpPath, finalPath);
    }
    this.injectFault('head');
    const tmpHead = this.headPath + '.tmp';
    const fd = fs.openSync(tmpHead, 'w');
    fs.writeSync(fd, newHead + '\n');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmpHead, this.headPath);
    return newHead;
  }

  injectFault(point) {
    if (process.env.LEDGER_FAIL_AT === point) {
      throw new LedgerError('INJECTED_FAULT', 1, `injected fault at ${point}`);
    }
  }

  append(tx) {
    validateTx(tx);
    const head = this.head();
    if (tx.parent !== head) {
      throw new LedgerError('PARENT_MISMATCH', 2, `tx parent ${tx.parent} != current head ${head}`);
    }
    const chain = this.chain();
    if (chain.some((e) => e.tx.id === tx.id)) {
      throw new LedgerError('DUPLICATE_ID', 2, `tx id ${tx.id} already exists`);
    }
    return this.commit([tx], chainHash(tx));
  }

  reverse(txId) {
    const chain = this.chain();
    const target = chain.find((e) => e.tx.id === txId);
    if (!target) throw new LedgerError('UNKNOWN_TX', 2, `no transaction with id ${txId}`);
    if (target.tx.kind === 'REVERSAL') {
      throw new LedgerError('INVALID_REVERSAL', 2, 'cannot reverse a REVERSAL transaction');
    }
    const payloadHash = reversalPayloadHash(txId);
    if (chain.some((e) => e.tx.kind === 'REVERSAL' && e.tx.payloadHash === payloadHash)) {
      throw new LedgerError('DUPLICATE_REVERSAL', EXIT.DUPLICATE_REVERSAL, `tx ${txId} is already reversed`);
    }
    const tx = reverseTxFor(target.tx, this.head());
    return this.commit([tx], chainHash(tx));
  }

  // Rewrite the unpublished suffix after `anchor` (inclusive prefix is kept).
  // `drop` lists NORMAL tx ids to discard. Reversals are always kept and
  // their causal order preserved; per-account totals must be unchanged.
  rewrite({ anchor, drop = [] }) {
    const chain = this.chain();
    const anchorIndex = chain.findIndex((e) => e.hash === anchor);
    if (anchorIndex === -1) {
      throw new LedgerError('ANCHOR_NOT_FOUND', EXIT.ANCHOR_NOT_FOUND, `anchor ${anchor} not in chain`);
    }
    const published = chain.slice(0, anchorIndex + 1);
    const suffix = chain.slice(anchorIndex + 1);

    const dropSet = new Set(drop);
    for (const id of dropSet) {
      const inPublished = published.find((e) => e.tx.id === id);
      if (inPublished) {
        throw new LedgerError('PUBLISHED_TAMPER', EXIT.PUBLISHED_TAMPER,
          `tx ${id} is the anchor or its ancestor; dropping it breaks the published hash chain`);
      }
      const inSuffix = suffix.find((e) => e.tx.id === id);
      if (!inSuffix) throw new LedgerError('UNKNOWN_TX', 2, `no transaction with id ${id}`);
      if (inSuffix.tx.kind === 'REVERSAL') {
        throw new LedgerError('INVALID_DROP', 2, `cannot drop REVERSAL tx ${id}`);
      }
    }

    const kept = suffix.filter((e) => !dropSet.has(e.tx.id));

    if (!totalsEqual(netTotals(suffix.map((e) => e.tx)), netTotals(kept.map((e) => e.tx)))) {
      throw new LedgerError('UNSATISFIABLE', EXIT.UNSATISFIABLE,
        'dropping the requested txs changes per-account totals');
    }

    const keptIds = new Set(kept.map((e) => e.tx.id));
    const suffixIds = new Set(suffix.map((e) => e.tx.id));
    const allTxs = chain.map((e) => e.tx);
    for (const e of kept) {
      if (e.tx.kind !== 'REVERSAL') continue;
      const targetId = reversalTargetId(e.tx, allTxs);
      if (targetId && suffixIds.has(targetId) && !keptIds.has(targetId)) {
        throw new LedgerError('UNSATISFIABLE', EXIT.UNSATISFIABLE,
          `reversal ${e.tx.id} depends on dropped tx ${targetId}`);
      }
    }

    // Rebuild the suffix on top of the anchor, keeping relative order.
    const newTxs = [];
    let parent = anchor;
    for (const e of kept) {
      const tx = { ...e.tx, parent };
      newTxs.push(tx);
      parent = chainHash(tx);
    }
    const newHead = newTxs.length > 0 ? chainHash(newTxs[newTxs.length - 1]) : anchor;
    const newHeadHash = this.commit(newTxs, newHead);

    // Orphaned old-suffix tx files are removed only after the new head is
    // durable, so a crash here cannot produce a half-chain.
    const keepHashes = new Set([...published.map((e) => e.hash), ...newTxs.map(chainHash)]);
    for (const e of suffix) {
      if (!keepHashes.has(e.hash)) {
        fs.rmSync(path.join(this.txsDir, e.hash + '.json'), { force: true });
      }
    }
    return newHeadHash;
  }

  verify() {
    const chain = this.chain(); // throws CHAIN_BROKEN on any inconsistency
    return { ok: true, length: chain.length, head: this.head() };
  }

  balances() {
    return Object.fromEntries(netTotals(this.chain().map((e) => e.tx)));
  }
}

// Enumerate every valid rewrite of an unpublished suffix: every subset of
// droppable NORMAL txs (REVERSALs are always kept) whose per-account totals
// match the original suffix, times every ordering that keeps each REVERSAL
// after the tx it reverses (when both are in the suffix). Reversal targets
// outside the suffix (e.g. in the published prefix) impose no constraint.
function enumerateRewrites(suffix) {
  const targetIndex = suffix.map((tx) => {
    if (tx.kind !== 'REVERSAL') return -1;
    return suffix.findIndex((t) => reversalPayloadHash(t.id) === tx.payloadHash);
  });
  const fullTotals = netTotals(suffix);
  const normalIdx = [];
  const revIdx = [];
  suffix.forEach((tx, i) => (tx.kind === 'REVERSAL' ? revIdx : normalIdx).push(i));

  const results = [];
  for (let mask = 0; mask < (1 << normalIdx.length); mask++) {
    const keptNormals = normalIdx.filter((_, bit) => (mask >> bit) & 1);
    const keptSet = new Set([...keptNormals, ...revIdx]);
    let ok = true;
    for (const r of revIdx) {
      const t = targetIndex[r];
      if (t !== -1 && !keptSet.has(t)) { ok = false; break; }
    }
    if (!ok) continue;
    if (!totalsEqual(fullTotals, netTotals([...keptSet].map((i) => suffix[i])))) continue;

    const preds = new Map();
    for (const r of revIdx) {
      const t = targetIndex[r];
      if (t !== -1 && keptSet.has(t)) preds.set(r, new Set([t]));
    }
    for (const perm of topoPermutations([...keptSet], preds)) {
      results.push(perm.map((i) => suffix[i]));
    }
  }
  return results;
}

// All topological orderings of `items` under precedence constraints preds[i].
function topoPermutations(items, preds) {
  const remaining = new Set(items);
  const acc = [];
  const out = [];
  (function rec() {
    if (remaining.size === 0) {
      out.push([...acc]);
      return;
    }
    for (const item of [...remaining].sort((a, b) => a - b)) {
      const deps = preds.get(item);
      if (deps && [...deps].some((d) => remaining.has(d))) continue;
      remaining.delete(item);
      acc.push(item);
      rec();
      acc.pop();
      remaining.add(item);
    }
  })();
  return out;
}

module.exports = {
  GENESIS,
  EXIT,
  LedgerError,
  Ledger,
  canonical,
  sha256,
  chainHash,
  reversalPayloadHash,
  reversalTargetId,
  reverseTxFor,
  netTotals,
  totalsEqual,
  enumerateRewrites,
  isLedgerTx,
};
