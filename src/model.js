'use strict';

const AMOUNT_FIELDS = ['debit', 'credit', 'freeze'];
const RESTATEABLE_FIELDS = [...AMOUNT_FIELDS, 'state', 'memo', 'account', 'currency'];

class MigrateError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'MigrateError';
    this.exitCode = exitCode;
  }
}

function fail(exitCode, message) {
  throw new MigrateError(exitCode, message);
}

function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateAmount(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    fail(2, `${label}: amount must be a non-negative safe integer, got ${JSON.stringify(value)}`);
  }
}

function validateInstruction(inst, label) {
  if (!isPlainObject(inst)) fail(2, `${label}: instruction must be an object`);
  if (typeof inst.id !== 'string' || inst.id.length === 0) fail(2, `${label}: id must be a non-empty string`);
  if (typeof inst.account !== 'string' || inst.account.length === 0) fail(2, `${label}: account must be a non-empty string`);
  if (typeof inst.currency !== 'string' || inst.currency.length === 0) fail(2, `${label}: currency must be a non-empty string`);
  for (const field of AMOUNT_FIELDS) validateAmount(inst[field], `${label}: ${field}`);
  if (typeof inst.state !== 'string' || inst.state.length === 0) fail(2, `${label}: state must be a non-empty string`);
  if (inst.memo !== undefined && typeof inst.memo !== 'string') fail(2, `${label}: memo must be a string`);
}

function clean(inst) {
  const out = {
    id: inst.id,
    account: inst.account,
    currency: inst.currency,
    debit: inst.debit,
    credit: inst.credit,
    freeze: inst.freeze,
    state: inst.state,
  };
  if (inst.memo !== undefined) out.memo = inst.memo;
  return out;
}

function normalizeInstructions(doc, label) {
  const list = Array.isArray(doc) ? doc : isPlainObject(doc) && Array.isArray(doc.instructions) ? doc.instructions : null;
  if (!list) fail(2, `${label}: expected an array of instructions or { "instructions": [...] }`);
  const out = list.map((inst, i) => {
    validateInstruction(inst, `${label}[${i}]`);
    return clean(inst);
  });
  const seen = new Set();
  for (const inst of out) {
    if (seen.has(inst.id)) fail(2, `${label}: duplicate instruction id ${JSON.stringify(inst.id)}`);
    seen.add(inst.id);
  }
  return out;
}

function normalizeOps(doc) {
  const list = Array.isArray(doc) ? doc : isPlainObject(doc) && Array.isArray(doc.ops) ? doc.ops : null;
  if (!list) fail(2, 'patch: expected an array of ops or { "ops": [...] }');
  return list;
}

function netOf(inst) {
  return inst.debit - inst.credit;
}

function tableByAccount(instructions) {
  const table = new Map();
  for (const inst of instructions) {
    let row = table.get(inst.account);
    if (!row) {
      row = { net: 0, freeze: 0 };
      table.set(inst.account, row);
    }
    row.net += netOf(inst);
    row.freeze += inst.freeze;
  }
  return table;
}

function pruneZeros(table) {
  const out = {};
  for (const key of Object.keys(table).sort()) {
    const row = table[key];
    if (row.net !== 0 || row.freeze !== 0) out[key] = { net: row.net, freeze: row.freeze };
  }
  return out;
}

function accountDelta(oldInstructions, newInstructions) {
  const oldTable = tableByAccount(oldInstructions);
  const newTable = tableByAccount(newInstructions);
  const accounts = new Set([...oldTable.keys(), ...newTable.keys()]);
  const delta = {};
  for (const account of accounts) {
    const before = oldTable.get(account) || { net: 0, freeze: 0 };
    const after = newTable.get(account) || { net: 0, freeze: 0 };
    delta[account] = { net: after.net - before.net, freeze: after.freeze - before.freeze };
  }
  return pruneZeros(delta);
}

function addContribution(contrib, account, net, freeze) {
  if (!contrib[account]) contrib[account] = { net: 0, freeze: 0 };
  contrib[account].net += net;
  contrib[account].freeze += freeze;
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (value[key] !== undefined) out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function deepEqual(a, b) {
  return canonicalJson(a) === canonicalJson(b);
}

module.exports = {
  AMOUNT_FIELDS,
  RESTATEABLE_FIELDS,
  MigrateError,
  fail,
  isPlainObject,
  validateAmount,
  validateInstruction,
  clean,
  normalizeInstructions,
  normalizeOps,
  netOf,
  tableByAccount,
  pruneZeros,
  accountDelta,
  addContribution,
  canonicalJson,
  deepEqual,
};
