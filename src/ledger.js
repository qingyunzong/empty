'use strict';

const { Store, buildChunk } = require('./store');
const { selectSettleable } = require('./selection');
const { BusinessError, CorruptError } = require('./errors');

class Ledger {
  constructor(store, chunks, corrupt, index, state, missing) {
    this.store = store;
    this.chunks = chunks;       // Map<hash, chunk> of integrity-valid chunks
    this.corrupt = corrupt;     // [{file, reason}]
    this.index = index;         // [{level, hash}]
    this.state = state;         // {rolledback, corrected, seq}
    this.missing = missing;     // Set<hash> chunks with unresolvable parents
  }

  isActive(hash) {
    return (
      this.chunks.has(hash) &&
      !this.missing.has(hash) &&
      !this.state.rolledback.includes(hash) &&
      !(hash in this.state.corrected)
    );
  }

  statusOf(hash) {
    if (!this.chunks.has(hash)) return 'absent';
    if (this.missing.has(hash)) return 'missing';
    if (this.state.rolledback.includes(hash)) return 'rolledback';
    if (hash in this.state.corrected) return 'corrected';
    return 'final';
  }

  activeChunks() {
    const out = [];
    for (const [hash, c] of this.chunks) {
      if (this.isActive(hash)) out.push(c);
    }
    return out.sort((a, b) => a.level - b.level || a.seq - b.seq);
  }

  childrenMap() {
    const map = new Map();
    for (const [hash, c] of this.chunks) {
      if (!this.isActive(hash)) continue;
      if (c.parentHash == null) continue;
      if (!map.has(c.parentHash)) map.set(c.parentHash, []);
      map.get(c.parentHash).push(c);
    }
    return map;
  }

  // Active descendants (transitive) of the given chunk hash.
  activeDescendants(hash) {
    const kids = this.childrenMap();
    const out = [];
    const stack = [...(kids.get(hash) || [])];
    while (stack.length) {
      const c = stack.pop();
      out.push(c);
      stack.push(...(kids.get(c.hash) || []));
    }
    return out;
  }

  head() {
    const active = this.activeChunks();
    return active.length ? active[active.length - 1] : null;
  }

  findByBatch(batchId) {
    for (const c of this.activeChunks()) {
      if (c.batchId === batchId) return c;
    }
    return null;
  }

  // Active chain from genesis to the given chunk (inclusive).
  chainTo(hash) {
    const chain = [];
    let cur = this.chunks.get(hash);
    while (cur) {
      chain.unshift(cur);
      cur = cur.parentHash != null ? this.chunks.get(cur.parentHash) : null;
    }
    return chain;
  }

  netPosition(chain) {
    const net = {};
    for (const c of chain) {
      for (const [p, d] of Object.entries(c.deltas)) {
        net[p] = (net[p] || 0) + d.net;
      }
    }
    return net;
  }

  remainingBudgets(budgets, parentHash) {
    const net = parentHash != null ? this.netPosition(this.chainTo(parentHash)) : {};
    const remaining = {};
    for (const [p, b] of Object.entries(budgets)) {
      remaining[p] = b - (net[p] || 0);
    }
    return remaining;
  }

  assertHealthy() {
    if (this.corrupt.length) {
      throw new CorruptError(this.corrupt.map((c) => c.file).join(','));
    }
  }

  save() {
    this.store.writeIndex(this.index);
    this.store.writeState(this.state);
  }
}

function load(dir) {
  const store = new Store(dir);
  store.ensureDirs();
  const { chunks, corrupt } = store.loadChunks();
  const state = store.loadState();

  // Recovery: rebuild level index from the chunk chain. If the process
  // crashed after persisting a chunk but before updating the index, the
  // chunk is rediscovered here and its index entry restored.
  let index = store.loadIndex();
  const known = new Set(index.map((e) => e.hash));
  let recovered = false;
  for (const [hash, c] of chunks) {
    if (!known.has(hash)) {
      index.push({ level: c.level, hash });
      recovered = true;
    }
  }
  index.sort((a, b) => a.level - b.level);
  if (recovered || !store.indexExists()) {
    store.writeIndex(index);
  }

  // Missing references: a chunk whose parent hash cannot be resolved stays
  // 'missing' and is never treated as settleable. Propagates transitively.
  const missing = new Set();
  let changed = true;
  while (changed) {
    changed = false;
    for (const [hash, c] of chunks) {
      if (missing.has(hash)) continue;
      if (c.parentHash != null && (!chunks.has(c.parentHash) || missing.has(c.parentHash))) {
        missing.add(hash);
        changed = true;
      }
    }
  }

  return new Ledger(store, chunks, corrupt, index, state, missing);
}

// --- validation helpers ---

function validateTransfers(transfers) {
  if (!Array.isArray(transfers)) throw new BusinessError('transfers must be an array');
  const seen = new Set();
  for (const t of transfers) {
    if (!t || typeof t.id !== 'string' || !t.id) throw new BusinessError('transfer id required');
    if (seen.has(t.id)) throw new BusinessError(`duplicate transfer id: ${t.id}`);
    seen.add(t.id);
    if (!t.from || !t.to || typeof t.from !== 'string' || typeof t.to !== 'string') {
      throw new BusinessError(`transfer ${t.id}: from/to required`);
    }
    if (t.from === t.to) throw new BusinessError(`transfer ${t.id}: self transfer`);
    if (!Number.isSafeInteger(t.amount) || t.amount <= 0) {
      throw new BusinessError(`transfer ${t.id}: amount must be a positive integer`);
    }
  }
}

function validateBudgets(budgets) {
  for (const [p, b] of Object.entries(budgets || {})) {
    if (!p) throw new BusinessError('budget participant required');
    if (!Number.isSafeInteger(b) || b < 0) {
      throw new BusinessError(`budget for ${p} must be a non-negative integer`);
    }
  }
}

function deltasFor(transfers, ids) {
  const picked = new Set(ids);
  const deltas = {};
  for (const t of transfers) {
    if (!picked.has(t.id)) continue;
    if (!deltas[t.from]) deltas[t.from] = { debit: 0, credit: 0, net: 0 };
    if (!deltas[t.to]) deltas[t.to] = { debit: 0, credit: 0, net: 0 };
    deltas[t.from].debit += t.amount;
    deltas[t.from].net += t.amount;
    deltas[t.to].credit += t.amount;
    deltas[t.to].net -= t.amount;
  }
  return deltas;
}

// --- operations ---

function propose(dir, { batchId, transfers, budgets }) {
  if (!batchId) throw new BusinessError('batch id required');
  validateTransfers(transfers);
  validateBudgets(budgets);
  const ledger = load(dir);
  ledger.assertHealthy();
  if (ledger.store.readProposal(batchId)) {
    throw new BusinessError(`proposal already exists: ${batchId}`);
  }
  if (ledger.findByBatch(batchId)) {
    throw new BusinessError(`batch already finalized: ${batchId}`);
  }
  const proposal = { batchId, transfers, budgets: budgets || {} };
  ledger.store.writeProposal(proposal);
  return proposal;
}

function finalize(dir, { batchId, parentBatchId }) {
  const ledger = load(dir);
  ledger.assertHealthy();
  const proposal = ledger.store.readProposal(batchId);
  if (!proposal) throw new BusinessError(`no proposal for batch: ${batchId}`);
  if (ledger.findByBatch(batchId)) {
    throw new BusinessError(`batch already finalized: ${batchId}`);
  }

  let parent = null;
  if (parentBatchId != null) {
    parent = ledger.findByBatch(parentBatchId);
    if (!parent) throw new BusinessError(`parent batch not final: ${parentBatchId}`);
  } else {
    parent = ledger.head();
  }

  const remaining = ledger.remainingBudgets(proposal.budgets, parent ? parent.hash : null);
  const settled = selectSettleable(proposal.transfers, remaining);
  const deltas = deltasFor(proposal.transfers, settled);

  ledger.state.seq += 1;
  const level = parent ? parent.level + 1 : 0;
  const indexEntries = (parent ? ledger.chainTo(parent.hash) : []).map((c) => ({
    level: c.level,
    hash: c.hash,
  }));
  const chunk = buildChunk({
    batchId,
    level,
    parentHash: parent ? parent.hash : null,
    dependsOn: parent ? [parent.hash] : [],
    corrects: null,
    transfers: settled,
    deltas,
    budgets: proposal.budgets,
    seq: ledger.state.seq,
    index: indexEntries,
  });
  ledger.store.writeChunk(chunk);
  ledger.chunks.set(chunk.hash, chunk);
  ledger.index.push({ level, hash: chunk.hash });
  ledger.save();
  return chunk;
}

function correct(dir, { batchId, transfers, budgets }) {
  validateTransfers(transfers);
  validateBudgets(budgets);
  const ledger = load(dir);
  ledger.assertHealthy();
  const target = ledger.findByBatch(batchId);
  if (!target) throw new BusinessError(`no final batch to correct: ${batchId}`);

  // Cascade rollback only to explicit dependents; unrelated nodes stay final.
  const descendants = ledger.activeDescendants(target.hash);
  for (const d of descendants) {
    ledger.state.rolledback.push(d.hash);
  }

  const remaining = ledger.remainingBudgets(budgets, target.parentHash);
  const settled = selectSettleable(transfers, remaining);
  const deltas = deltasFor(transfers, settled);

  ledger.state.seq += 1;
  const indexEntries = (target.parentHash ? ledger.chainTo(target.parentHash) : []).map((c) => ({
    level: c.level,
    hash: c.hash,
  }));
  const chunk = buildChunk({
    batchId,
    level: target.level,
    parentHash: target.parentHash,
    dependsOn: target.parentHash != null ? [target.parentHash] : [],
    corrects: target.hash,
    transfers: settled,
    deltas,
    budgets: budgets || {},
    seq: ledger.state.seq,
    index: indexEntries,
  });
  ledger.store.writeChunk(chunk);
  ledger.chunks.set(chunk.hash, chunk);
  ledger.state.corrected[target.hash] = chunk.hash;
  ledger.index.push({ level: chunk.level, hash: chunk.hash });
  ledger.save();
  return { chunk, rolledBack: descendants };
}

function rollback(dir, { batchId }) {
  const ledger = load(dir);
  ledger.assertHealthy();
  const target = ledger.findByBatch(batchId);
  if (!target) throw new BusinessError(`no final batch to roll back: ${batchId}`);
  const descendants = ledger.activeDescendants(target.hash);
  ledger.state.rolledback.push(target.hash);
  for (const d of descendants) {
    ledger.state.rolledback.push(d.hash);
  }
  ledger.save();
  return { target, rolledBack: descendants };
}

function verify(dir) {
  const ledger = load(dir);
  const lines = [];
  if (ledger.corrupt.length) {
    for (const c of ledger.corrupt) lines.push(`CORRUPT ${c.file} (${c.reason})`);
    return { code: 2, lines };
  }
  if (ledger.missing.size) {
    for (const hash of [...ledger.missing].sort()) {
      const c = ledger.chunks.get(hash);
      lines.push(`MISSING parent=${c.parentHash} for chunk=${hash} batch=${c.batchId}`);
    }
    return { code: 2, lines };
  }
  lines.push('OK');
  return { code: 0, lines };
}

function stateReport(dir) {
  const ledger = load(dir);
  ledger.assertHealthy();
  const lines = [];
  const all = [...ledger.chunks.values()].sort((a, b) => a.level - b.level || a.seq - b.seq);
  for (const c of all) {
    lines.push(
      `chunk level=${c.level} batch=${c.batchId} hash=${c.hash.slice(0, 12)} ` +
      `status=${ledger.statusOf(c.hash)} settled=[${c.transfers.join(',')}]`
    );
  }
  const head = ledger.head();
  if (head) {
    const net = ledger.netPosition(ledger.chainTo(head.hash));
    const parts = Object.entries(net)
      .sort()
      .map(([p, v]) => `${p}=${v}`)
      .join(' ');
    lines.push(`net ${parts}`);
  } else {
    lines.push('net (empty)');
  }
  return { code: 0, lines };
}

module.exports = { load, propose, finalize, correct, rollback, verify, stateReport };
