'use strict';
const { sha256, hashObj } = require('./hash');
const { schedule } = require('./scheduler');

const RULES_VERSION = '1.0.0';
const GENESIS = 'GENESIS';

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code; // exit code 4
  }
}

function createEmptyState() {
  return {
    rulesVersion: RULES_VERSION,
    seq: 0,
    now: 0,
    lamport: 0,
    config: null,
    packages: {},
    hashIndex: {}, // every version hash -> package id
    submitterHeads: {}, // submitter -> hash of their latest package (hash chain)
    quotaUsed: {}, // "period:tenant" -> bytes scheduled this period
  };
}

function computePkgHash(p) {
  return hashObj({
    t: 'pkg',
    id: p.id,
    version: p.version,
    tenant: p.tenant,
    submitter: p.submitter,
    size: p.size,
    level: p.level,
    deadline: p.deadline,
    evidence: p.evidenceHash,
    prev: p.prevHash,
  });
}

function quotaProof(tenant, quotaLimit) {
  return sha256(`quota:${tenant}:${quotaLimit}:${RULES_VERSION}`);
}

function computeStateRoot(state) {
  return hashObj({ t: 'state', state });
}

function periodOf(state, tick) {
  return Math.floor(tick / state.config.periodLength);
}

function quotaKey(state, tenant, tick) {
  return `${periodOf(state, tick)}:${tenant}`;
}

// Parent package id of a package (via the recorded hash-chain link), or null.
function parentOf(state, pkg) {
  if (pkg.prevHash === GENESIS) return null;
  return state.hashIndex[pkg.prevHash] || null;
}

// All transitive descendants of pkgId with their tree depth (root = 0).
function descendantsOf(state, pkgId) {
  const children = new Map();
  for (const pkg of Object.values(state.packages)) {
    const parent = parentOf(state, pkg);
    if (parent) {
      if (!children.has(parent)) children.set(parent, []);
      children.get(parent).push(pkg.id);
    }
  }
  const out = new Map();
  let frontier = [pkgId];
  let depth = 0;
  while (frontier.length) {
    const next = [];
    for (const id of frontier) {
      if (out.has(id)) continue;
      out.set(id, depth);
      for (const c of children.get(id) || []) next.push(c);
    }
    frontier = next;
    depth += 1;
  }
  out.delete(pkgId);
  return out;
}

function ancestorsBlocked(state, pkg) {
  let cur = parentOf(state, pkg);
  while (cur) {
    const p = state.packages[cur];
    if (p.status === 'failed' || p.status === 'recalled') return cur;
    cur = parentOf(state, p);
  }
  return null;
}

function resolvedPrevHash(state, pkg) {
  if (pkg.prevHash === GENESIS) return GENESIS;
  const parentId = state.hashIndex[pkg.prevHash];
  return parentId ? state.packages[parentId].hash : pkg.prevHash;
}

function issueCert(state, pkg, entry, prevRoot) {
  return hashObj({
    t: 'cert',
    id: pkg.id,
    version: pkg.version,
    hash: pkg.hash,
    prev: resolvedPrevHash(state, pkg),
    worker: entry.workerId,
    start: entry.start,
    finish: entry.finish,
    root: prevRoot,
    rules: RULES_VERSION,
  });
}

// Worker availability derived from currently verified packages.
function workerStartTimes(state) {
  const starts = {};
  for (const wk of state.config.workers) starts[wk.id] = state.now;
  for (const pkg of Object.values(state.packages)) {
    if (pkg.status === 'verified' && pkg.schedule) {
      const id = pkg.schedule.workerId;
      starts[id] = Math.max(starts[id], pkg.schedule.finish);
    }
  }
  return starts;
}

function advanceClock(state, event) {
  if (event.now != null) {
    if (!Number.isInteger(event.now) || event.now < 0) {
      throw new ValidationError('bad-request', 'now must be a non-negative integer');
    }
    state.now = Math.max(state.now, event.now);
  }
  state.lamport = Math.max(state.lamport, event.lamport || 0) + 1;
}

function applyInit(state, event) {
  if (state.config) throw new ValidationError('bad-request', 'state already initialized');
  const cfg = event.payload;
  if (!cfg || !Array.isArray(cfg.workers) || cfg.workers.length === 0) {
    throw new ValidationError('bad-request', 'config requires workers');
  }
  for (const wk of cfg.workers) {
    if (!wk.id || !(wk.throughput > 0) || !(wk.maxLevel >= 1)) {
      throw new ValidationError('bad-request', 'invalid worker in config');
    }
  }
  state.config = {
    workers: cfg.workers.map((wk) => ({
      id: String(wk.id),
      throughput: wk.throughput,
      maxLevel: wk.maxLevel,
    })),
    quotas: Object.assign({}, cfg.quotas || {}),
    periodLength: cfg.periodLength || 10,
    boostThreshold: cfg.boostThreshold != null ? cfg.boostThreshold : 3,
  };
  return { workers: state.config.workers.length };
}

function applySubmit(state, event) {
  const p = event.payload;
  if (!state.config) throw new ValidationError('bad-request', 'not initialized');
  for (const field of ['id', 'tenant', 'submitter', 'evidenceHash', 'prevHash', 'client']) {
    if (!p[field]) throw new ValidationError('bad-request', `missing field ${field}`);
  }
  if (!Number.isInteger(p.size) || p.size <= 0) {
    throw new ValidationError('bad-request', 'size must be a positive integer');
  }
  if (!Number.isInteger(p.level) || p.level < 1) {
    throw new ValidationError('bad-request', 'level must be a positive integer');
  }
  if (!Number.isInteger(p.deadline) || p.deadline < 0) {
    throw new ValidationError('bad-request', 'deadline must be a non-negative integer');
  }
  if (state.packages[p.id]) {
    throw new ValidationError('duplicate-package', `package ${p.id} already exists`);
  }
  const hash = computePkgHash({
    id: p.id, version: 1, tenant: p.tenant, submitter: p.submitter,
    size: p.size, level: p.level, deadline: p.deadline,
    evidenceHash: p.evidenceHash, prevHash: p.prevHash,
  });
  if (state.hashIndex[hash]) {
    throw new ValidationError('duplicate-package', `package hash ${hash} already submitted`);
  }
  const head = state.submitterHeads[p.submitter] || GENESIS;
  if (p.prevHash !== head) {
    throw new ValidationError(
      'hash-chain-broken',
      `prevHash mismatch for submitter ${p.submitter}: expected ${head}, got ${p.prevHash}`,
    );
  }
  const limit = state.config.quotas[p.tenant];
  if (limit == null) throw new ValidationError('bad-request', `unknown tenant ${p.tenant}`);
  if (p.quotaProof !== quotaProof(p.tenant, limit)) {
    throw new ValidationError('quota-forgery', `invalid quota proof for tenant ${p.tenant}`);
  }
  advanceClock(state, event);
  const pkg = {
    id: p.id,
    version: 1,
    tenant: p.tenant,
    submitter: p.submitter,
    size: p.size,
    level: p.level,
    deadline: p.deadline,
    evidenceHash: p.evidenceHash,
    prevHash: p.prevHash,
    hash,
    order: [event.lamport || 0, p.client, hash],
    status: 'pending',
    submittedAt: state.now,
    schedule: null,
    cert: null,
    recallDepth: null,
    recallRoot: null,
  };
  state.packages[p.id] = pkg;
  state.hashIndex[hash] = p.id;
  state.submitterHeads[p.submitter] = hash;
  return { package: { id: pkg.id, hash: pkg.hash, status: pkg.status } };
}

function applyVerify(state, event) {
  if (!state.config) throw new ValidationError('bad-request', 'not initialized');
  advanceClock(state, event);
  const prevRoot = computeStateRoot(state);
  const failed = [];
  for (const id of event.payload.fail || []) {
    const pkg = state.packages[id];
    if (!pkg) throw new ValidationError('unknown-package', `no such package ${id}`);
    pkg.status = 'failed';
    pkg.cert = null;
    pkg.schedule = null;
    failed.push(id);
  }
  // Candidate selection: pending or stale (needs re-verify), ancestors clean.
  const threshold = state.config.boostThreshold;
  const candidates = [];
  for (const pkg of Object.values(state.packages)) {
    if (pkg.status !== 'pending' && pkg.status !== 'stale') continue;
    if (ancestorsBlocked(state, pkg)) continue;
    const boosted = state.now - pkg.submittedAt >= threshold;
    candidates.push({ pkg, boosted });
  }
  // Admission: quota with anti-starvation. Boosted packages bypass quota but
  // never the security-level constraint (enforced by the scheduler).
  const admittedThisRun = {};
  const quotaFits = (pkg) => {
    const limit = state.config.quotas[pkg.tenant];
    const used = (state.quotaUsed[quotaKey(state, pkg.tenant, state.now)] || 0)
      + (admittedThisRun[pkg.tenant] || 0);
    return used + pkg.size <= limit;
  };
  candidates.sort((a, b) => {
    if (a.boosted !== b.boosted) return a.boosted ? -1 : 1;
    const fa = quotaFits(a.pkg);
    const fb = quotaFits(b.pkg);
    if (fa !== fb) return fa ? -1 : 1;
    if (a.pkg.deadline !== b.pkg.deadline) return a.pkg.deadline - b.pkg.deadline;
    for (let i = 0; i < 3; i += 1) {
      const x = a.pkg.order[i];
      const y = b.pkg.order[i];
      if (x !== y) return x < y ? -1 : 1;
    }
    return 0;
  });
  const admitted = [];
  const deferred = [];
  for (const c of candidates) {
    if (c.boosted || quotaFits(c.pkg)) {
      admitted.push(c);
      admittedThisRun[c.pkg.tenant] = (admittedThisRun[c.pkg.tenant] || 0) + c.pkg.size;
    } else {
      deferred.push({ pkg: c.pkg.id, reason: 'quota' });
    }
  }
  const schedInput = admitted.map((c) => ({
    id: c.pkg.id,
    size: c.pkg.size,
    level: c.pkg.level,
    deadline: c.pkg.deadline,
    boosted: c.boosted,
  }));
  const result = schedule(schedInput, state.config.workers, workerStartTimes(state));
  const scheduleOut = [];
  const results = [];
  for (const c of admitted) {
    const entry = result.assignments.get(c.pkg.id);
    if (!entry) {
      deferred.push({ pkg: c.pkg.id, reason: 'unscheduled' });
      results.push({ pkg: c.pkg.id, status: c.pkg.status, pass: false });
      continue;
    }
    const pkg = c.pkg;
    pkg.status = 'verified';
    pkg.schedule = entry;
    pkg.cert = issueCert(state, pkg, entry, prevRoot);
    pkg.recallDepth = null;
    pkg.recallRoot = null;
    const key = quotaKey(state, pkg.tenant, state.now);
    state.quotaUsed[key] = (state.quotaUsed[key] || 0) + pkg.size;
    scheduleOut.push(entry);
    results.push({ pkg: pkg.id, status: 'verified', pass: true, onTime: entry.onTime, cert: pkg.cert });
  }
  scheduleOut.sort((a, b) => (a.workerId < b.workerId ? -1 : a.workerId > b.workerId ? 1 : a.start - b.start));
  return { schedule: scheduleOut, results, failed, deferred };
}

function applyCorrect(state, event) {
  const p = event.payload;
  if (!state.config) throw new ValidationError('bad-request', 'not initialized');
  const pkg = state.packages[p.pkg];
  if (!pkg) throw new ValidationError('unknown-package', `no such package ${p.pkg}`);
  if (pkg.status !== 'failed' && pkg.status !== 'recalled') {
    throw new ValidationError('not-correctable', `package ${p.pkg} is ${pkg.status}, not failed/recalled`);
  }
  if (!p.evidenceHash) throw new ValidationError('bad-request', 'missing evidenceHash');
  if (!Number.isInteger(p.size) || p.size <= 0) {
    throw new ValidationError('bad-request', 'size must be a positive integer');
  }
  advanceClock(state, event);
  const next = {
    id: pkg.id,
    version: pkg.version + 1,
    tenant: pkg.tenant,
    submitter: pkg.submitter,
    size: p.size,
    level: pkg.level,
    deadline: p.deadline != null ? p.deadline : pkg.deadline,
    evidenceHash: p.evidenceHash,
    prevHash: pkg.prevHash,
  };
  const hash = computePkgHash(next);
  if (state.hashIndex[hash]) {
    throw new ValidationError('duplicate-package', 'corrected evidence duplicates an existing hash');
  }
  Object.assign(pkg, next, { hash });
  pkg.status = 'pending';
  pkg.submittedAt = state.now;
  pkg.schedule = null;
  pkg.cert = null;
  pkg.recallDepth = null;
  pkg.recallRoot = null;
  state.hashIndex[hash] = pkg.id;
  state.submitterHeads[pkg.submitter] = hash;
  // Dependent packages must be re-verified: cascade stale down the tree.
  const stale = [];
  for (const [id] of descendantsOf(state, pkg.id)) {
    const dep = state.packages[id];
    if (dep.status === 'recalled' && dep.recallRoot && dep.recallRoot !== pkg.id) continue;
    dep.status = 'stale';
    dep.cert = null;
    dep.schedule = null;
    dep.recallDepth = null;
    dep.recallRoot = null;
    stale.push(id);
  }
  stale.sort();
  return { pkg: pkg.id, version: pkg.version, hash: pkg.hash, stale };
}

function applyRecall(state, event) {
  const p = event.payload;
  if (!state.config) throw new ValidationError('bad-request', 'not initialized');
  const pkg = state.packages[p.pkg];
  if (!pkg) throw new ValidationError('unknown-package', `no such package ${p.pkg}`);
  if (pkg.status === 'recalled') {
    throw new ValidationError('bad-request', `package ${p.pkg} already recalled`);
  }
  advanceClock(state, event);
  // Hierarchical rollback: the whole recall tree is rolled back level by level.
  const rolledBack = [{ id: pkg.id, depth: 0 }];
  pkg.status = 'recalled';
  pkg.recallDepth = 0;
  pkg.recallRoot = pkg.id;
  pkg.cert = null;
  pkg.schedule = null;
  for (const [id, depth] of descendantsOf(state, pkg.id)) {
    const dep = state.packages[id];
    dep.status = 'recalled';
    dep.recallDepth = depth;
    dep.recallRoot = pkg.id;
    dep.cert = null;
    dep.schedule = null;
    rolledBack.push({ id, depth });
  }
  rolledBack.sort((a, b) => a.depth - b.depth || (a.id < b.id ? -1 : 1));
  return { pkg: pkg.id, rolledBack };
}

const APPLIERS = {
  init: applyInit,
  submit: applySubmit,
  verify: applyVerify,
  correct: applyCorrect,
  recall: applyRecall,
};

// Apply one event to state (mutates). Returns command-specific info.
function applyEvent(state, event) {
  const applier = APPLIERS[event.type];
  if (!applier) throw new ValidationError('bad-request', `unknown event type ${event.type}`);
  const info = applier(state, event);
  state.seq += 1;
  return info;
}

function digestOf(state, eventsHash) {
  return {
    rulesVersion: RULES_VERSION,
    seq: state.seq,
    eventsHash,
    stateRoot: computeStateRoot(state),
  };
}

module.exports = {
  RULES_VERSION,
  GENESIS,
  ValidationError,
  createEmptyState,
  computePkgHash,
  computeStateRoot,
  quotaProof,
  descendantsOf,
  applyEvent,
  digestOf,
};
