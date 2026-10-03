'use strict';
const { RULES_VERSION, canonicalHash, compareKeys } = require('./util');
const { clone } = require('./state');
const { schedule } = require('./scheduler');

const EXIT_VALIDATION = 4;

class ValidationError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ValidationError';
    this.code = code;
    this.exitCode = EXIT_VALIDATION;
  }
}

function verifyChain(chain, payload) {
  if (!Array.isArray(chain) || chain.length === 0) {
    throw new ValidationError('hash-chain-broken', 'hash chain is empty');
  }
  let prev = '0'.repeat(64);
  for (const link of chain) {
    const expect = canonicalHash({ prev, payload });
    if (link !== expect) {
      throw new ValidationError('hash-chain-broken', `hash chain broken at link ${link.slice(0, 12)}`);
    }
    prev = link;
  }
  return prev;
}

function buildChain(payload, count) {
  const chain = [];
  let prev = '0'.repeat(64);
  for (let i = 0; i < count; i++) {
    prev = canonicalHash({ prev, payload });
    chain.push(prev);
  }
  return chain;
}

function sortEvents(events) {
  return [...events].sort(compareKeys);
}

function topoDescendants(state, rootIds) {
  const children = new Map();
  for (const [id, pack] of Object.entries(state.packs)) {
    for (const dep of pack.dependsOn || []) {
      if (!children.has(dep)) children.set(dep, []);
      children.get(dep).push(id);
    }
  }
  const order = [];
  const seen = new Set();
  const queue = [...rootIds];
  while (queue.length > 0) {
    const id = queue.shift();
    if (seen.has(id)) continue;
    seen.add(id);
    order.push(id);
    for (const child of children.get(id) || []) queue.push(child);
  }
  return order;
}

function computeDigest(state, extra) {
  const inputEventsHash = canonicalHash(state.wal);
  const stateRoot = canonicalHash({
    packs: state.packs,
    certs: state.certs,
    quotas: state.quotas,
    revoked: state.revoked,
    superseded: state.superseded,
    seq: state.seq,
  });
  return {
    rulesVersion: RULES_VERSION,
    inputEventsHash,
    stateRoot,
    ...(extra || {}),
  };
}

function requireFields(obj, fields, code) {
  for (const f of fields) {
    if (obj[f] === undefined || obj[f] === null) {
      throw new ValidationError(code, `missing field: ${f}`);
    }
  }
}

function applySubmit(state, event, config) {
  requireFields(event, ['packId', 'tenant', 'size', 'classification', 'chain', 'submitter', 'deadline'], 'invalid-submit');
  const packId = event.packId;
  if (state.packs[packId] || (state.revoked || []).includes(packId)) {
    throw new ValidationError('duplicate-pack', `pack already exists: ${packId}`);
  }
  if (!state.quotas[event.tenant] && config.quotas && config.quotas[event.tenant] !== undefined) {
    state.quotas[event.tenant] = { limit: config.quotas[event.tenant], used: 0 };
  }
  const quota = state.quotas[event.tenant];
  if (!quota) {
    throw new ValidationError('quota-forged', `unknown tenant: ${event.tenant}`);
  }
  if (event.size > quota.limit) {
    throw new ValidationError('quota-forged', `pack size ${event.size} exceeds tenant quota limit ${quota.limit}`);
  }
  if (event.size > quota.limit - quota.used) {
    throw new ValidationError('quota-forged', `tenant quota exhausted for ${event.tenant}`);
  }
  const chainTip = verifyChain(event.chain, event.payload || packId);
  for (const dep of event.dependsOn || []) {
    if (!state.packs[dep] && !(state.revoked || []).includes(dep)) {
      throw new ValidationError('missing-dependency', `unknown dependency: ${dep}`);
    }
  }
  const now = event.now || 0;
  const enqueuedAt = event.enqueuedAt !== undefined ? event.enqueuedAt : now;
  const pack = {
    packId,
    tenant: event.tenant,
    size: event.size,
    classification: event.classification,
    submitter: event.submitter,
    deadline: event.deadline,
    chainTip,
    chainLength: event.chain.length,
    payload: event.payload || packId,
    dependsOn: event.dependsOn || [],
    status: 'queued',
    enqueuedAt,
    boosted: false,
    workerId: null,
    supersededBy: null,
    history: [],
  };
  state.packs[packId] = pack;
  quota.used += event.size;
  const sched = scheduleQueued(state, config, now);
  return { packId, chainTip, schedule: sched };
}

function scheduleQueued(state, config, now) {
  const jobs = [];
  for (const pack of Object.values(state.packs)) {
    if (pack.status !== 'queued') continue;
    jobs.push({
      packId: pack.packId,
      tenant: pack.tenant,
      size: pack.size,
      classification: pack.classification,
      deadline: pack.deadline,
      enqueuedAt: pack.enqueuedAt,
    });
  }
  const initialUsed = new Array(config.workers.length).fill(0);
  for (const pack of Object.values(state.packs)) {
    if (pack.status !== 'scheduled' || !pack.workerId) continue;
    const idx = config.workers.findIndex((w) => w.id === pack.workerId);
    if (idx >= 0) initialUsed[idx] += pack.size;
  }
  const result = schedule(jobs, config.workers, {
    waitThreshold: config.waitThreshold,
    now,
    initialUsed,
  });
  for (const a of result.assignments) {
    const pack = state.packs[a.packId];
    pack.status = 'scheduled';
    pack.workerId = a.workerId;
    pack.boosted = a.boosted;
  }
  return result;
}

function applyVerify(state, event, config) {
  requireFields(event, ['packId'], 'invalid-verify');
  const pack = state.packs[event.packId];
  if (!pack) throw new ValidationError('unknown-pack', `unknown pack: ${event.packId}`);
  if (pack.status !== 'scheduled' && pack.status !== 'queued') {
    throw new ValidationError('invalid-state', `pack ${event.packId} not verifiable in status ${pack.status}`);
  }
  const cert = {
    packId: pack.packId,
    chainTip: pack.chainTip,
    chainLength: pack.chainLength,
    payload: pack.payload,
    workerId: pack.workerId,
    boosted: pack.boosted,
    verifiedAtSeq: state.seq + 1,
    rulesVersion: RULES_VERSION,
  };
  cert.certHash = canonicalHash(cert);
  pack.status = 'verified';
  state.certs[pack.packId] = cert;
  return { packId: pack.packId, status: 'verified', cert };
}

function invalidateDependents(state, rootId) {
  const affected = topoDescendants(state, [rootId]).filter((id) => id !== rootId);
  const invalidated = [];
  for (const id of affected) {
    const pack = state.packs[id];
    if (!pack) continue;
    if (pack.status === 'verified') {
      invalidated.push(id);
      delete state.certs[id];
    }
    if (pack.status !== 'recalled') {
      pack.status = 'queued';
      pack.workerId = null;
    }
  }
  return invalidated;
}

function applyCorrect(state, event, config) {
  requireFields(event, ['packId', 'chain'], 'invalid-correct');
  const old = state.packs[event.packId];
  if (!old) throw new ValidationError('unknown-pack', `unknown pack: ${event.packId}`);
  if (old.status === 'recalled') {
    throw new ValidationError('invalid-state', `pack ${event.packId} is recalled`);
  }
  const chainTip = verifyChain(event.chain, event.payload || old.payload);
  const newId = event.newPackId || `${event.packId}#c${(old.history.length + 1)}`;
  if (state.packs[newId]) throw new ValidationError('duplicate-pack', `pack already exists: ${newId}`);
  const invalidated = invalidateDependents(state, event.packId);
  const hadCert = !!state.certs[event.packId];
  delete state.certs[event.packId];
  old.status = 'superseded';
  old.supersededBy = newId;
  state.superseded.push(event.packId);
  const now = event.now || 0;
  const pack = {
    ...clone(old),
    packId: newId,
    chainTip,
    chainLength: event.chain.length,
    payload: event.payload || old.payload,
    status: 'queued',
    enqueuedAt: now,
    workerId: null,
    boosted: false,
    supersededBy: null,
    history: [...old.history, event.packId],
  };
  state.packs[newId] = pack;
  const sched = scheduleQueued(state, config, now);
  return { oldPackId: event.packId, newPackId: newId, chainTip, invalidated, hadCert, schedule: sched };
}

function applyRecall(state, event, config) {
  requireFields(event, ['packId'], 'invalid-recall');
  const pack = state.packs[event.packId];
  if (!pack) throw new ValidationError('unknown-pack', `unknown pack: ${event.packId}`);
  if (pack.status === 'recalled') {
    throw new ValidationError('invalid-state', `pack ${event.packId} already recalled`);
  }
  const tree = topoDescendants(state, [event.packId]);
  const rolledBack = [];
  for (const id of tree) {
    const p = state.packs[id];
    if (!p || p.status === 'recalled') continue;
    if (state.certs[id]) delete state.certs[id];
    p.status = 'recalled';
    p.workerId = null;
    rolledBack.push(id);
    if (!state.revoked.includes(id)) state.revoked.push(id);
    const quota = state.quotas[p.tenant];
    if (quota) quota.used = Math.max(0, quota.used - p.size);
  }
  return { root: event.packId, rolledBack };
}

const APPLIERS = {
  submit: applySubmit,
  verify: applyVerify,
  correct: applyCorrect,
  recall: applyRecall,
};

function execute(store, config, command, events) {
  const record = store.begin(command, { events });
  try {
    const state = clone(store.state);
    const sorted = sortEvents(events);
    const results = [];
    for (const event of sorted) {
      const applier = APPLIERS[command];
      if (!applier) throw new ValidationError('unknown-command', `unknown command: ${command}`);
      results.push(applier(state, event, config));
    }
    store.commit(record, state);
    const digest = computeDigest(store.state, { command, seq: record.seq });
    return { ok: true, command, results, digest };
  } catch (err) {
    store.fail(record, err);
    throw err;
  }
}

function audit(store, config) {
  const recovery = store.recover();
  const recomputed = computeDigest(store.state, { command: 'audit', seq: store.state.seq });
  return {
    recovery,
    ok: true,
    digest: recomputed,
    packs: Object.keys(store.state.packs).length,
    certs: Object.keys(store.state.certs).length,
    revoked: store.state.revoked.length,
  };
}

module.exports = {
  execute,
  audit,
  buildChain,
  verifyChain,
  computeDigest,
  topoDescendants,
  ValidationError,
  EXIT_VALIDATION,
};
