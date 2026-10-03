'use strict';

const { badDiff } = require('./errors');

const DIFF_KINDS = Object.freeze({
  MISSING_IN_SNAPSHOT: 'MISSING_IN_SNAPSHOT',
  MISSING_IN_LEDGER: 'MISSING_IN_LEDGER',
  AMOUNT_MISMATCH: 'AMOUNT_MISMATCH',
  CURRENCY_MISMATCH: 'CURRENCY_MISMATCH',
  STATUS_MISMATCH: 'STATUS_MISMATCH',
  ATTRIBUTE_MISMATCH: 'ATTRIBUTE_MISMATCH',
});

const COMPARED_FIELDS = ['accountId', 'day', 'amount', 'currency', 'status'];

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function validateEntry(entry, side) {
  if (!isPlainObject(entry)) throw badDiff(`${side} entry is not an object`, { entry });
  if (typeof entry.id !== 'string' || entry.id.length === 0) {
    throw badDiff(`${side} entry missing string id`, { entry });
  }
  if (typeof entry.accountId !== 'string' || entry.accountId.length === 0) {
    throw badDiff(`${side} entry ${entry.id} missing accountId`);
  }
  if (typeof entry.day !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(entry.day)) {
    throw badDiff(`${side} entry ${entry.id} has bad day`, { day: entry.day });
  }
  if (typeof entry.amount !== 'number' || !Number.isFinite(entry.amount)) {
    throw badDiff(`${side} entry ${entry.id} has non-finite amount`, { amount: entry.amount });
  }
  if (typeof entry.currency !== 'string' || entry.currency.length !== 3) {
    throw badDiff(`${side} entry ${entry.id} has bad currency`, { currency: entry.currency });
  }
  if (typeof entry.status !== 'string' || entry.status.length === 0) {
    throw badDiff(`${side} entry ${entry.id} missing status`);
  }
}

function indexById(entries, side) {
  if (!Array.isArray(entries)) throw badDiff(`${side} is not an array`);
  const map = new Map();
  for (const entry of entries) {
    validateEntry(entry, side);
    if (map.has(entry.id)) throw badDiff(`duplicate id ${entry.id} in ${side}`);
    map.set(entry.id, entry);
  }
  return map;
}

function classifyPair(ledgerEntry, snapshotEntry) {
  if (ledgerEntry.amount !== snapshotEntry.amount) return DIFF_KINDS.AMOUNT_MISMATCH;
  if (ledgerEntry.currency !== snapshotEntry.currency) return DIFF_KINDS.CURRENCY_MISMATCH;
  if (ledgerEntry.status !== snapshotEntry.status) return DIFF_KINDS.STATUS_MISMATCH;
  if (ledgerEntry.accountId !== snapshotEntry.accountId || ledgerEntry.day !== snapshotEntry.day) {
    return DIFF_KINDS.ATTRIBUTE_MISMATCH;
  }
  return null;
}

// Deterministic diff: output sorted by id so classification is stable.
function classifyDiff(ledgerEntries, snapshotEntries) {
  const ledger = indexById(ledgerEntries, 'ledger');
  const snapshot = indexById(snapshotEntries, 'snapshot');
  const ids = [...new Set([...ledger.keys(), ...snapshot.keys()])].sort();
  const diffs = [];
  for (const id of ids) {
    const le = ledger.get(id);
    const se = snapshot.get(id);
    if (le && !se) {
      diffs.push({ id, kind: DIFF_KINDS.MISSING_IN_SNAPSHOT, ledger: le, snapshot: null });
    } else if (!le && se) {
      diffs.push({ id, kind: DIFF_KINDS.MISSING_IN_LEDGER, ledger: null, snapshot: se });
    } else {
      const kind = classifyPair(le, se);
      if (kind) diffs.push({ id, kind, ledger: le, snapshot: se });
    }
  }
  return diffs;
}

module.exports = { DIFF_KINDS, COMPARED_FIELDS, classifyDiff, validateEntry };
