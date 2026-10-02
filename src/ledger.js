import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const EXIT_CODES = {
  UNSATISFIABLE: 2,
  ANCHOR_NOT_FOUND: 3,
  REVERSAL_CONFLICT: 4,
  PUBLISHED_VIOLATION: 5,
};

export class LedgerError extends Error {
  constructor(code, message, exitCode = 1) {
    super(message);
    this.name = 'LedgerError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

const TX_KEYS = ['account', 'amount', 'id', 'kind', 'parent', 'payloadHash'];
const KINDS = new Set(['NORMAL', 'REVERSAL']);
const MICRO = 1_000_000;
const MAX_DP_ITEMS = 64;

export function canonicalTx(tx) {
  const out = {};
  for (const key of TX_KEYS) out[key] = tx[key] === undefined ? null : tx[key];
  return JSON.stringify(out);
}

export function hashTx(tx) {
  return createHash('sha256').update(canonicalTx(tx), 'utf8').digest('hex');
}

export function reversalId(id) {
  return `REV-${id}`;
}

export function reversalPayloadHash(id) {
  return createHash('sha256').update(`reversal-of:${id}`, 'utf8').digest('hex');
}

export function toMicro(amount) {
  const scaled = amount * MICRO;
  const rounded = Math.round(scaled);
  if (!Number.isSafeInteger(rounded) || Math.abs(scaled - rounded) > 1e-3 * Math.max(1, Math.abs(scaled))) {
    throw new LedgerError('INVALID_TX', `amount ${amount} is not representable with 6 decimal places`);
  }
  return BigInt(rounded);
}

function crash(point) {
  process.stderr.write(
    JSON.stringify({ error: { code: 'FAULT_INJECTED', message: `simulated crash at ${point}` } }) + '\n',
  );
  process.exit(99);
}

// Crash-safe write: tmp file -> fsync -> atomic rename -> dir fsync.
// Fault injection points (env LEDGER_FAULT): tmp-write, rename, head-update.
function atomicWriteFile(file, data, kind) {
  const tmp = `${file}.tmp-${process.pid}`;
  const fault = process.env.LEDGER_FAULT;
  if (fault === 'tmp-write' && kind !== 'head') {
    fs.writeFileSync(tmp, data.slice(0, Math.max(1, Math.floor(data.length / 2))));
    crash('tmp-write');
  }
  fs.writeFileSync(tmp, data);
  const fd = fs.openSync(tmp, 'r+');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  if (fault === 'rename' && kind !== 'head') crash('rename');
  if (fault === 'head-update' && kind === 'head') crash('head-update');
  fs.renameSync(tmp, file);
  try {
    const dfd = fs.openSync(path.dirname(file), 'r');
    fs.fsyncSync(dfd);
    fs.closeSync(dfd);
  } catch {
    // directory fsync is best-effort
  }
}

function validateTxShape(tx) {
  if (typeof tx !== 'object' || tx === null || Array.isArray(tx)) {
    throw new LedgerError('INVALID_TX', 'transaction must be an object');
  }
  if (typeof tx.id !== 'string' || tx.id.length === 0) {
    throw new LedgerError('INVALID_TX', 'id must be a non-empty string');
  }
  if (typeof tx.amount !== 'number' || !Number.isFinite(tx.amount)) {
    throw new LedgerError('INVALID_TX', 'amount must be a finite number');
  }
  toMicro(tx.amount);
  if (typeof tx.account !== 'string' || tx.account.length === 0) {
    throw new LedgerError('INVALID_TX', 'account must be a non-empty string');
  }
  if (!KINDS.has(tx.kind)) {
    throw new LedgerError('INVALID_TX', `kind must be one of ${[...KINDS].join('|')}`);
  }
  if (typeof tx.payloadHash !== 'string' || tx.payloadHash.length === 0) {
    throw new LedgerError('INVALID_TX', 'payloadHash must be a non-empty string');
  }
  if (tx.parent !== null && tx.parent !== undefined && typeof tx.parent !== 'string') {
    throw new LedgerError('INVALID_TX', 'parent must be a hash string or null');
  }
}

function validateReversal(tx, chain, upto, { strict = true } = {}) {
  if (!tx.id.startsWith('REV-')) {
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} must be named REV-<targetId>`);
  }
  const targetId = tx.id.slice(4);
  const target = chain.slice(0, upto).find((t) => t.id === targetId);
  if (tx.payloadHash !== reversalPayloadHash(targetId)) {
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} payloadHash does not match its target`);
  }
  if (!target) {
    if (!strict && chain.slice(upto).some((t) => t.id === targetId)) {
      throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} appears before its target ${targetId}`);
    }
    // Lenient mode (chain validation after a rewrite): the target may have been
    // dropped from the unpublished suffix. The reversal stays as an audit entry
    // and remains bound to its target id via payloadHash.
    if (!strict) return;
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} has no earlier target ${targetId}`);
  }
  if (target.kind !== 'NORMAL') {
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} targets a non-NORMAL transaction`);
  }
  if (tx.account !== target.account) {
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} account does not match its target`);
  }
  if (toMicro(tx.amount) !== -toMicro(target.amount)) {
    throw new LedgerError('CHAIN_CORRUPT', `reversal ${tx.id} amount is not the negation of its target`);
  }
}

function validateChain(chain) {
  const ids = new Set();
  for (let i = 0; i < chain.length; i++) {
    const tx = chain[i];
    if (ids.has(tx.id)) {
      throw new LedgerError('CHAIN_CORRUPT', `duplicate transaction id ${tx.id}`);
    }
    ids.add(tx.id);
    if (tx.kind === 'REVERSAL') validateReversal(tx, chain, i, { strict: false });
  }
}

function betterSelection(a, b) {
  if (a.length !== b.length) return a.length < b.length;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return a[i] < b[i];
  }
  return false;
}

// Minimal-cardinality subset of items whose micro amounts sum to target.
// Tie-break: lexicographically smallest index list (keeps earliest txs).
function pickSubset(items, target) {
  if (items.length > MAX_DP_ITEMS) {
    const sum = items.reduce((acc, item) => acc + item.micro, 0n);
    if (sum === target) return items.map((_, i) => i);
    if (target === 0n) return [];
    return null;
  }
  const best = new Map([[0n, []]]);
  for (let i = 0; i < items.length; i++) {
    const { micro } = items[i];
    for (const [sum, sel] of [...best.entries()]) {
      const nextSum = sum + micro;
      const candidate = [...sel, i];
      const current = best.get(nextSum);
      if (current === undefined || betterSelection(candidate, current)) {
        best.set(nextSum, candidate);
      }
    }
  }
  return best.get(target) ?? null;
}

// Rewrite plan for the unpublished suffix:
// - every REVERSAL is kept, in original relative order;
// - a NORMAL tx that is reversed inside the suffix is dropped (its reversal
//   stays behind as the audit trail of the cancellation);
// - free NORMAL txs may be dropped; kept free txs must sum, per account, to the
//   sum of ALL NORMAL amounts of the suffix (i.e. totals minus reversals);
// - among valid plans, minimize kept count, then prefer earliest txs.
export function planRewrite(suffix) {
  const reversedIds = new Set();
  for (const tx of suffix) {
    if (tx.kind === 'REVERSAL') reversedIds.add(tx.id.slice(4));
  }
  const required = new Map();
  const freeByAccount = new Map();
  for (let i = 0; i < suffix.length; i++) {
    const tx = suffix[i];
    if (tx.kind !== 'NORMAL') continue;
    const micro = toMicro(tx.amount);
    required.set(tx.account, (required.get(tx.account) ?? 0n) + micro);
    if (!reversedIds.has(tx.id)) {
      if (!freeByAccount.has(tx.account)) freeByAccount.set(tx.account, []);
      freeByAccount.get(tx.account).push({ micro, index: i });
    }
  }
  const keepIndices = new Set();
  const accounts = new Set([...required.keys(), ...freeByAccount.keys()]);
  for (const account of accounts) {
    const target = required.get(account) ?? 0n;
    const items = freeByAccount.get(account) ?? [];
    const picked = pickSubset(items, target);
    if (picked === null) {
      throw new LedgerError(
        'UNSATISFIABLE',
        `cannot preserve totals for account ${account}: need ${target} micro-units from ${items.length} free NORMAL transactions`,
        EXIT_CODES.UNSATISFIABLE,
      );
    }
    for (const position of picked) keepIndices.add(items[position].index);
  }
  const kept = [];
  const dropped = [];
  for (let i = 0; i < suffix.length; i++) {
    const tx = suffix[i];
    if (tx.kind === 'REVERSAL' || keepIndices.has(i)) {
      kept.push(tx);
    } else {
      dropped.push(tx);
    }
  }
  return { kept, dropped };
}

export class Ledger {
  constructor(dir) {
    this.dir = dir;
    this.txsDir = path.join(dir, 'txs');
    this.headFile = path.join(dir, 'HEAD');
    this.publishedFile = path.join(dir, 'PUBLISHED');
  }

  static init(dir) {
    fs.mkdirSync(path.join(dir, 'txs'), { recursive: true });
    const headFile = path.join(dir, 'HEAD');
    if (!fs.existsSync(headFile)) fs.writeFileSync(headFile, 'EMPTY\n');
    return new Ledger(dir);
  }

  #cleanup() {
    const sweep = (dir, match) => {
      let names;
      try {
        names = fs.readdirSync(dir);
      } catch {
        return;
      }
      for (const name of names) {
        if (match(name)) fs.rmSync(path.join(dir, name), { force: true });
      }
    };
    sweep(this.dir, (n) => n.startsWith('HEAD.tmp-') || n.startsWith('PUBLISHED.tmp-'));
    sweep(this.txsDir, (n) => n.includes('.tmp-'));
  }

  #requireInit() {
    if (!fs.existsSync(this.headFile)) {
      throw new LedgerError('NOT_INITIALIZED', `ledger not initialized at ${this.dir}`);
    }
  }

  #readMarker(file) {
    if (!fs.existsSync(file)) return null;
    const content = fs.readFileSync(file, 'utf8').trim();
    return content === '' || content === 'EMPTY' ? null : content;
  }

  head() {
    return this.#readMarker(this.headFile);
  }

  published() {
    return this.#readMarker(this.publishedFile);
  }

  #txPath(hash) {
    return path.join(this.txsDir, `${hash}.json`);
  }

  #readTx(hash) {
    let raw;
    try {
      raw = fs.readFileSync(this.#txPath(hash), 'utf8');
    } catch {
      throw new LedgerError('CHAIN_CORRUPT', `missing transaction file for ${hash}`);
    }
    let tx;
    try {
      tx = JSON.parse(raw);
    } catch {
      throw new LedgerError('CHAIN_CORRUPT', `unparseable transaction file ${hash}`);
    }
    try {
      validateTxShape(tx);
    } catch (error) {
      throw new LedgerError('CHAIN_CORRUPT', `invalid transaction ${hash}: ${error.message}`);
    }
    if (hashTx(tx) !== hash) {
      throw new LedgerError('CHAIN_CORRUPT', `hash mismatch for transaction ${hash}`);
    }
    return tx;
  }

  loadChain() {
    this.#requireInit();
    const chain = [];
    const seen = new Set();
    let cursor = this.head();
    while (cursor !== null) {
      if (seen.has(cursor)) {
        throw new LedgerError('CHAIN_CORRUPT', `cycle detected at ${cursor}`);
      }
      seen.add(cursor);
      const tx = this.#readTx(cursor);
      chain.push(tx);
      cursor = tx.parent;
    }
    chain.reverse();
    validateChain(chain);
    const published = this.published();
    if (published !== null && !seen.has(published)) {
      throw new LedgerError('CHAIN_CORRUPT', `published anchor ${published} is not on the chain`);
    }
    return chain;
  }

  #commitTx(tx) {
    const hash = hashTx(tx);
    atomicWriteFile(this.#txPath(hash), canonicalTx(tx) + '\n', 'tx');
    atomicWriteFile(this.headFile, hash + '\n', 'head');
    return hash;
  }

  append(input) {
    this.#requireInit();
    this.#cleanup();
    const chain = this.loadChain();
    const headHash = chain.length === 0 ? null : hashTx(chain[chain.length - 1]);
    const tx = { ...input };
    if (tx.kind === undefined) tx.kind = 'NORMAL';
    if (tx.parent === undefined) tx.parent = headHash;
    validateTxShape(tx);
    if (tx.parent !== headHash) {
      throw new LedgerError(
        'PARENT_MISMATCH',
        `parent ${tx.parent} does not match current head ${headHash ?? 'EMPTY'}`,
      );
    }
    if (chain.some((t) => t.id === tx.id)) {
      throw new LedgerError('DUPLICATE_ID', `transaction id ${tx.id} already exists`);
    }
    if (tx.kind === 'REVERSAL') validateReversal(tx, chain, chain.length);
    const hash = this.#commitTx(tx);
    return { hash, tx };
  }

  reverse(txId) {
    this.#requireInit();
    this.#cleanup();
    const chain = this.loadChain();
    const target = chain.find((t) => t.id === txId);
    if (!target) {
      throw new LedgerError('TX_NOT_FOUND', `no transaction with id ${txId}`);
    }
    if (target.kind === 'REVERSAL') {
      throw new LedgerError(
        'REVERSAL_CONFLICT',
        `cannot reverse reversal transaction ${txId}`,
        EXIT_CODES.REVERSAL_CONFLICT,
      );
    }
    if (chain.some((t) => t.id === reversalId(txId))) {
      throw new LedgerError(
        'DUPLICATE_REVERSAL',
        `transaction ${txId} is already reversed`,
        EXIT_CODES.REVERSAL_CONFLICT,
      );
    }
    const tx = {
      id: reversalId(txId),
      parent: hashTx(chain[chain.length - 1]),
      amount: -target.amount,
      account: target.account,
      kind: 'REVERSAL',
      payloadHash: reversalPayloadHash(txId),
    };
    const hash = this.#commitTx(tx);
    return { hash, tx };
  }

  rewrite(anchorHash) {
    this.#requireInit();
    this.#cleanup();
    const chain = this.loadChain();
    const hashes = chain.map(hashTx);
    const anchorIndex = hashes.indexOf(anchorHash);
    if (anchorIndex === -1) {
      throw new LedgerError(
        'ANCHOR_NOT_FOUND',
        `anchor ${anchorHash} is not on the chain`,
        EXIT_CODES.ANCHOR_NOT_FOUND,
      );
    }
    const published = this.published();
    if (published !== null) {
      const publishedIndex = hashes.indexOf(published);
      if (anchorIndex < publishedIndex) {
        throw new LedgerError(
          'PUBLISHED_VIOLATION',
          `anchor ${anchorHash} precedes published anchor ${published}; rewriting would break the published prefix`,
          EXIT_CODES.PUBLISHED_VIOLATION,
        );
      }
    }
    const suffix = chain.slice(anchorIndex + 1);
    const plan = planRewrite(suffix);
    let parent = anchorHash;
    const kept = [];
    for (const tx of plan.kept) {
      const next = {
        id: tx.id,
        parent,
        amount: tx.amount,
        account: tx.account,
        kind: tx.kind,
        payloadHash: tx.payloadHash,
      };
      kept.push(next);
      parent = hashTx(next);
    }
    for (const tx of kept) {
      atomicWriteFile(this.#txPath(hashTx(tx)), canonicalTx(tx) + '\n', 'tx');
    }
    atomicWriteFile(this.publishedFile, anchorHash + '\n', 'data');
    atomicWriteFile(this.headFile, parent + '\n', 'head');
    return {
      anchor: anchorHash,
      kept: kept.map((t) => t.id),
      dropped: plan.dropped.map((t) => t.id),
      head: parent,
    };
  }

  verify() {
    this.#requireInit();
    this.#cleanup();
    const chain = this.loadChain();
    const accounts = {};
    for (const tx of chain) {
      accounts[tx.account] = (accounts[tx.account] ?? 0) + tx.amount;
    }
    for (const account of Object.keys(accounts)) {
      accounts[account] = Math.round(accounts[account] * MICRO) / MICRO;
    }
    return {
      ok: true,
      height: chain.length,
      head: chain.length === 0 ? null : hashTx(chain[chain.length - 1]),
      published: this.published(),
      accounts,
    };
  }
}
