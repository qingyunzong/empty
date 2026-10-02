'use strict';

const { MigrateError, EXIT } = require('./errors');

const STATES = new Set(['PENDING', 'SETTLED', 'CANCELLED']);

function fail(message) {
  throw new MigrateError(EXIT.USAGE, message);
}

function isAmount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function normalizeInstruction(raw, where) {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where}: instruction must be an object`);
  }
  const id = raw.id;
  if (typeof id !== 'string' || id === '') fail(`${where}: id must be a non-empty string`);
  const account = raw.account;
  if (typeof account !== 'string' || account === '') {
    fail(`${where}: instruction ${id}: account must be a non-empty string`);
  }
  const debit = raw.debit === undefined ? 0 : raw.debit;
  const credit = raw.credit === undefined ? 0 : raw.credit;
  const freeze = raw.freeze === undefined ? 0 : raw.freeze;
  for (const [name, value] of [['debit', debit], ['credit', credit], ['freeze', freeze]]) {
    if (!isAmount(value)) {
      fail(`${where}: instruction ${id}: ${name} must be a non-negative safe integer`);
    }
  }
  const state = raw.state === undefined ? 'PENDING' : raw.state;
  if (!STATES.has(state)) {
    fail(`${where}: instruction ${id}: state must be one of ${[...STATES].join(',')}`);
  }
  const currency = raw.currency === undefined ? null : raw.currency;
  if (currency !== null && typeof currency !== 'string') {
    fail(`${where}: instruction ${id}: currency must be a string`);
  }
  const memo = raw.memo === undefined ? '' : raw.memo;
  if (typeof memo !== 'string') fail(`${where}: instruction ${id}: memo must be a string`);
  return { id, account, debit, credit, freeze, state, currency, memo };
}

function normalizeSet(rawList, where) {
  if (!Array.isArray(rawList)) fail(`${where}: instruction set must be an array`);
  const table = new Map();
  rawList.forEach((raw, index) => {
    const instr = normalizeInstruction(raw, `${where}[${index}]`);
    if (table.has(instr.id)) fail(`${where}: duplicate instruction id ${instr.id}`);
    table.set(instr.id, instr);
  });
  return table;
}

function accountTotals(instructions) {
  const totals = new Map();
  for (const instr of instructions) {
    let t = totals.get(instr.account);
    if (!t) {
      t = { debit: 0, credit: 0, freeze: 0 };
      totals.set(instr.account, t);
    }
    t.debit += instr.debit;
    t.credit += instr.credit;
    t.freeze += instr.freeze;
  }
  return totals;
}

module.exports = { STATES, isAmount, normalizeInstruction, normalizeSet, accountTotals, fail };
