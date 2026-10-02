'use strict';

const { MigrateError, EXIT } = require('./errors');
const { normalizeSet, isAmount, STATES, fail } = require('./model');

function addDelta(delta, account, net, freeze) {
  let d = delta.get(account);
  if (!d) {
    d = { net: 0, freeze: 0 };
    delta.set(account, d);
  }
  d.net += net;
  d.freeze += freeze;
}

function conservationError(account, detail) {
  return new MigrateError(
    EXIT.CONSERVATION,
    `conservation violated for account=${account}: ${detail}`
  );
}

function applySplit(table, op, conservationAccounts) {
  const orig = table.get(op.id);
  if (!orig) fail(`split: instruction ${op.id} not found`);
  if (!Array.isArray(op.parts) || op.parts.length < 2) {
    fail(`split: ${op.id}: parts must be an array of at least 2 entries`);
  }
  const partIds = new Set();
  const parts = op.parts.map((raw, index) => {
    const where = `split(${op.id}).parts[${index}]`;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) fail(`${where}: must be an object`);
    const pid = raw.id;
    if (typeof pid !== 'string' || pid === '') fail(`${where}: id must be a non-empty string`);
    if (partIds.has(pid)) fail(`split: ${op.id}: duplicate part id ${pid}`);
    partIds.add(pid);
    if (pid !== op.id && table.has(pid)) fail(`split: ${op.id}: part id ${pid} already exists`);
    if (raw.account !== undefined && raw.account !== orig.account) {
      throw conservationError(orig.account, `part ${pid} targets account=${raw.account}`);
    }
    if (raw.currency !== undefined && raw.currency !== orig.currency) {
      throw conservationError(orig.account, `part ${pid} targets currency=${raw.currency}`);
    }
    const debit = raw.debit === undefined ? 0 : raw.debit;
    const credit = raw.credit === undefined ? 0 : raw.credit;
    const freeze = raw.freeze === undefined ? 0 : raw.freeze;
    for (const [name, value] of [['debit', debit], ['credit', credit], ['freeze', freeze]]) {
      if (!isAmount(value)) fail(`${where}: ${name} must be a non-negative safe integer`);
    }
    const memo = raw.memo === undefined ? '' : raw.memo;
    if (typeof memo !== 'string') fail(`${where}: memo must be a string`);
    return {
      id: pid,
      account: orig.account,
      debit,
      credit,
      freeze,
      state: orig.state,
      currency: orig.currency,
      memo,
    };
  });
  const sum = (key) => parts.reduce((acc, p) => acc + p[key], 0);
  for (const key of ['debit', 'credit', 'freeze']) {
    if (sum(key) !== orig[key]) {
      throw conservationError(
        orig.account,
        `split ${op.id}: parts ${key} sum ${sum(key)} != original ${orig[key]}`
      );
    }
  }
  table.delete(op.id);
  for (const part of parts) table.set(part.id, part);
  conservationAccounts.add(orig.account);
}

function applyMerge(table, op, conservationAccounts) {
  if (!Array.isArray(op.ids) || op.ids.length < 2) {
    fail(`merge: ids must be an array of at least 2 instruction ids`);
  }
  const ids = [...new Set(op.ids)];
  if (ids.length !== op.ids.length) fail(`merge: duplicate ids in ${JSON.stringify(op.ids)}`);
  const members = ids.map((id) => {
    const instr = table.get(id);
    if (!instr) fail(`merge: instruction ${id} not found`);
    return instr;
  });
  const first = members[0];
  for (const member of members) {
    if (member.account !== first.account) {
      throw new MigrateError(
        EXIT.MERGE_CROSS_ACCOUNT,
        `merge across accounts: ${first.id} account=${first.account} vs ${member.id} account=${member.account}`
      );
    }
    if (member.currency !== first.currency) {
      throw new MigrateError(
        EXIT.MERGE_CROSS_ACCOUNT,
        `merge across currencies: ${first.id} currency=${first.currency} vs ${member.id} currency=${member.currency}`
      );
    }
  }
  const newId = op.newId;
  if (typeof newId !== 'string' || newId === '') fail(`merge: newId must be a non-empty string`);
  if (!ids.includes(newId) && table.has(newId)) fail(`merge: newId ${newId} already exists`);
  const merged = {
    id: newId,
    account: first.account,
    debit: members.reduce((acc, m) => acc + m.debit, 0),
    credit: members.reduce((acc, m) => acc + m.credit, 0),
    freeze: members.reduce((acc, m) => acc + m.freeze, 0),
    state: members.every((m) => m.state === first.state) ? first.state : 'PENDING',
    currency: first.currency,
    memo: op.memo === undefined ? '' : op.memo,
  };
  if (typeof merged.memo !== 'string') fail(`merge: memo must be a string`);
  for (const id of ids) table.delete(id);
  table.set(newId, merged);
  conservationAccounts.add(first.account);
}

function applyRestate(table, op, delta) {
  const orig = table.get(op.id);
  if (!orig) fail(`restate: instruction ${op.id} not found`);
  const fields = op.fields;
  if (fields === null || typeof fields !== 'object' || Array.isArray(fields)) {
    fail(`restate: ${op.id}: fields must be an object`);
  }
  const allowed = new Set(['debit', 'credit', 'freeze', 'state', 'memo']);
  for (const key of Object.keys(fields)) {
    if (!allowed.has(key)) fail(`restate: ${op.id}: unknown field ${key}`);
  }
  const next = { ...orig };
  if (orig.state === 'SETTLED') {
    for (const key of ['debit', 'credit', 'freeze', 'state']) {
      if (key in fields && fields[key] !== orig[key]) {
        throw new MigrateError(
          EXIT.SETTLED_AMOUNT,
          `restate modifies SETTLED instruction ${op.id}: field ${key} ${orig[key]} -> ${fields[key]} (only memo may change)`
        );
      }
    }
  }
  for (const key of ['debit', 'credit', 'freeze']) {
    if (key in fields) {
      if (!isAmount(fields[key])) fail(`restate: ${op.id}: ${key} must be a non-negative safe integer`);
      next[key] = fields[key];
    }
  }
  if ('state' in fields) {
    if (!STATES.has(fields.state)) fail(`restate: ${op.id}: invalid state ${fields.state}`);
    next.state = fields.state;
  }
  if ('memo' in fields) {
    if (typeof fields.memo !== 'string') fail(`restate: ${op.id}: memo must be a string`);
    next.memo = fields.memo;
  }
  addDelta(
    delta,
    orig.account,
    (next.debit - next.credit) - (orig.debit - orig.credit),
    next.freeze - orig.freeze
  );
  table.set(op.id, next);
}

function applyOps(rawInstructions, rawOps) {
  const table = normalizeSet(rawInstructions, 'old');
  const ops = Array.isArray(rawOps) ? rawOps : rawOps && rawOps.ops;
  if (!Array.isArray(ops)) fail('patch must be an array of ops or an object with an ops array');
  const delta = new Map();
  const conservationAccounts = new Set();
  ops.forEach((op, index) => {
    if (op === null || typeof op !== 'object' || Array.isArray(op)) fail(`ops[${index}]: must be an object`);
    if (op.op === 'split') applySplit(table, op, conservationAccounts);
    else if (op.op === 'merge') applyMerge(table, op, conservationAccounts);
    else if (op.op === 'restate') applyRestate(table, op, delta);
    else fail(`ops[${index}]: unknown op ${op.op}`);
  });
  const perAccountDelta = {};
  for (const account of [...delta.keys()].sort()) {
    const d = delta.get(account);
    if (d.net === 0 && d.freeze === 0) continue;
    perAccountDelta[account] = { net: d.net, freeze: d.freeze };
  }
  const proof = {
    version: 1,
    perAccountDelta,
    conservation: {
      ok: true,
      accounts: [...conservationAccounts].sort(),
      residual: Object.fromEntries(
        [...conservationAccounts].sort().map((a) => [a, { net: 0, freeze: 0 }])
      ),
    },
    forbiddenOps: [],
  };
  return { instructions: [...table.values()], proof };
}

module.exports = { applyOps };
