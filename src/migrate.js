'use strict';

const {
  RESTATEABLE_FIELDS,
  fail,
  isPlainObject,
  validateAmount,
  clean,
  normalizeInstructions,
  normalizeOps,
  netOf,
  accountDelta,
  addContribution,
  pruneZeros,
} = require('./model');

function findById(instructions, id) {
  return instructions.find((inst) => inst.id === id);
}

function applySplit(current, op, index, proofOps) {
  const orig = findById(current, op.id);
  if (!orig) fail(2, `split: unknown instruction id ${JSON.stringify(op.id)}`);
  if (!Array.isArray(op.parts) || op.parts.length < 1) {
    fail(2, `split ${op.id}: parts must be a non-empty array`);
  }
  const existing = new Set(current.map((inst) => inst.id));
  const seen = new Set();
  const parts = op.parts.map((part, i) => {
    if (!isPlainObject(part) || typeof part.id !== 'string' || part.id.length === 0) {
      fail(2, `split ${op.id}: part ${i} must have a non-empty string id`);
    }
    if (part.id === op.id || existing.has(part.id) || seen.has(part.id)) {
      fail(2, `split ${op.id}: duplicate or colliding part id ${JSON.stringify(part.id)}`);
    }
    seen.add(part.id);
    const out = {
      id: part.id,
      account: part.account !== undefined ? part.account : orig.account,
      currency: part.currency !== undefined ? part.currency : orig.currency,
      debit: part.debit !== undefined ? part.debit : 0,
      credit: part.credit !== undefined ? part.credit : 0,
      freeze: part.freeze !== undefined ? part.freeze : 0,
      state: part.state !== undefined ? part.state : orig.state,
    };
    const memo = part.memo !== undefined ? part.memo : orig.memo;
    if (memo !== undefined) out.memo = memo;
    for (const field of ['debit', 'credit', 'freeze']) validateAmount(out[field], `split part ${part.id}: ${field}`);
    return out;
  });

  const contrib = {};
  addContribution(contrib, orig.account, -netOf(orig), -orig.freeze);
  for (const part of parts) addContribution(contrib, part.account, netOf(part), part.freeze);
  const contributions = pruneZeros(contrib);
  const badAccounts = Object.keys(contributions);
  if (badAccounts.length > 0) {
    const account = badAccounts[0];
    const row = contributions[account];
    fail(
      25,
      `conservation violated by split ${op.id}: account ${account} net delta ${row.net}, freeze delta ${row.freeze}`
    );
  }

  const next = current.filter((inst) => inst.id !== op.id).concat(parts);
  proofOps.push({ index, op: 'split', id: op.id, inputs: [clean(orig)], outputs: parts.map(clean), contributions });
  return next;
}

function applyMerge(current, op, index, proofOps) {
  if (!Array.isArray(op.ids) || op.ids.length < 2) {
    fail(2, `merge: ids must be an array of at least 2 instruction ids`);
  }
  if (new Set(op.ids).size !== op.ids.length) fail(2, `merge: duplicate ids in ${JSON.stringify(op.ids)}`);
  const ins = op.ids.map((id) => {
    const inst = findById(current, id);
    if (!inst) fail(2, `merge: unknown instruction id ${JSON.stringify(id)}`);
    return inst;
  });
  const { account, currency } = ins[0];
  for (const inst of ins.slice(1)) {
    if (inst.account !== account) {
      fail(27, `merge ${op.newId}: instructions span accounts ${account} and ${inst.account} (ids ${op.ids.join(', ')})`);
    }
    if (inst.currency !== currency) {
      fail(27, `merge ${op.newId}: instructions span currencies ${currency} and ${inst.currency} (ids ${op.ids.join(', ')})`);
    }
  }
  if (typeof op.newId !== 'string' || op.newId.length === 0) fail(2, 'merge: newId must be a non-empty string');
  if (op.ids.includes(op.newId) || findById(current, op.newId)) {
    fail(2, `merge: newId ${JSON.stringify(op.newId)} collides with an existing instruction id`);
  }

  const merged = {
    id: op.newId,
    account,
    currency,
    debit: ins.reduce((sum, inst) => sum + inst.debit, 0),
    credit: ins.reduce((sum, inst) => sum + inst.credit, 0),
    freeze: ins.reduce((sum, inst) => sum + inst.freeze, 0),
    state: ins.every((inst) => inst.state === ins[0].state) ? ins[0].state : 'PENDING',
  };
  if (op.memo !== undefined) merged.memo = op.memo;

  const contrib = {};
  for (const inst of ins) addContribution(contrib, inst.account, -netOf(inst), -inst.freeze);
  addContribution(contrib, merged.account, netOf(merged), merged.freeze);
  const contributions = pruneZeros(contrib);
  const badAccounts = Object.keys(contributions);
  if (badAccounts.length > 0) {
    const acct = badAccounts[0];
    const row = contributions[acct];
    fail(25, `conservation violated by merge ${op.newId}: account ${acct} net delta ${row.net}, freeze delta ${row.freeze}`);
  }

  const consumed = new Set(op.ids);
  const next = current.filter((inst) => !consumed.has(inst.id)).concat([merged]);
  proofOps.push({
    index,
    op: 'merge',
    ids: [...op.ids],
    newId: op.newId,
    inputs: ins.map(clean),
    outputs: [clean(merged)],
    contributions,
  });
  return next;
}

function applyRestate(current, op, index, proofOps) {
  const inst = findById(current, op.id);
  if (!inst) fail(2, `restate: unknown instruction id ${JSON.stringify(op.id)}`);
  if (!isPlainObject(op.fields)) fail(2, `restate ${op.id}: fields must be an object`);
  for (const key of Object.keys(op.fields)) {
    if (!RESTATEABLE_FIELDS.includes(key)) fail(2, `restate ${op.id}: field ${JSON.stringify(key)} is not restateable`);
  }
  if (inst.state === 'SETTLED') {
    for (const [key, value] of Object.entries(op.fields)) {
      if (key === 'memo') continue;
      if (JSON.stringify(value) !== JSON.stringify(inst[key])) {
        fail(26, `restate ${op.id}: cannot modify ${key} on SETTLED instruction (only memo is allowed)`);
      }
    }
  }
  const updated = { ...inst, ...op.fields };
  for (const field of ['debit', 'credit', 'freeze']) validateAmount(updated[field], `restate ${op.id}: ${field}`);
  if (typeof updated.state !== 'string' || updated.state.length === 0) fail(2, `restate ${op.id}: state must be a non-empty string`);
  if (typeof updated.account !== 'string' || updated.account.length === 0) fail(2, `restate ${op.id}: account must be a non-empty string`);
  if (typeof updated.currency !== 'string' || updated.currency.length === 0) fail(2, `restate ${op.id}: currency must be a non-empty string`);
  if (updated.memo !== undefined && typeof updated.memo !== 'string') fail(2, `restate ${op.id}: memo must be a string`);

  const contrib = {};
  addContribution(contrib, inst.account, -netOf(inst), -inst.freeze);
  addContribution(contrib, updated.account, netOf(updated), updated.freeze);
  const contributions = pruneZeros(contrib);

  const next = current.map((item) => (item.id === op.id ? clean(updated) : item));
  proofOps.push({ index, op: 'restate', id: op.id, inputs: [clean(inst)], outputs: [clean(updated)], contributions });
  return next;
}

const HANDLERS = {
  split: applySplit,
  merge: applyMerge,
  restate: applyRestate,
};

function applyPatch(oldDoc, patchDoc) {
  const oldInstructions = normalizeInstructions(oldDoc, 'old');
  const ops = normalizeOps(patchDoc);
  const proofOps = [];
  let current = oldInstructions;
  ops.forEach((op, index) => {
    if (!isPlainObject(op) || typeof op.op !== 'string') fail(2, `patch op ${index}: missing op type`);
    const handler = HANDLERS[op.op];
    if (!handler) fail(2, `patch op ${index}: unknown op ${JSON.stringify(op.op)}`);
    current = handler(current, op, index, proofOps);
  });

  const perAccountDelta = accountDelta(oldInstructions, current);
  const conservation = proofOps
    .filter((entry) => entry.op === 'split' || entry.op === 'merge')
    .map((entry) => ({
      opIndex: entry.index,
      op: entry.op,
      accounts: entry.contributions,
      ok: Object.keys(entry.contributions).length === 0,
    }));

  const proof = {
    version: 1,
    ops: proofOps,
    perAccountDelta,
    conservation,
    forbiddenOps: [],
  };
  return { instructions: current, proof };
}

module.exports = { applyPatch };
