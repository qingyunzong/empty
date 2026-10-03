'use strict';

class ValidationError extends Error {
  constructor(errors) {
    super('invalid input: ' + errors.join('; '));
    this.name = 'ValidationError';
    this.errors = errors;
  }
}

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isId = (v) => typeof v === 'string' && v.length > 0;
const isNonNegNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPosNumber = (v) => typeof v === 'number' && Number.isFinite(v) && v > 0;

function parseTime(value) {
  if (typeof value !== 'string') return null;
  const t = Date.parse(value);
  return Number.isNaN(t) ? null : t;
}

function normalize(raw) {
  const errors = [];
  if (!isObject(raw)) {
    throw new ValidationError(['top-level value must be an object']);
  }

  const accounts = new Map();
  if (!Array.isArray(raw.accounts) || raw.accounts.length === 0) {
    errors.push('accounts must be a non-empty array');
  } else {
    raw.accounts.forEach((a, i) => {
      const where = `accounts[${i}]`;
      if (!isObject(a)) { errors.push(`${where} must be an object`); return; }
      if (!isId(a.id)) { errors.push(`${where}.id must be a non-empty string`); return; }
      if (accounts.has(a.id)) { errors.push(`${where}.id ${JSON.stringify(a.id)} is duplicated`); return; }
      if (!isNonNegNumber(a.limit)) { errors.push(`${where}.limit must be a non-negative number`); return; }
      accounts.set(a.id, { id: a.id, limit: a.limit });
    });
  }

  const batches = [];
  const batchIds = new Set();
  if (!Array.isArray(raw.batches) || raw.batches.length === 0) {
    errors.push('batches must be a non-empty array');
  } else {
    raw.batches.forEach((b, i) => {
      const where = `batches[${i}]`;
      if (!isObject(b)) { errors.push(`${where} must be an object`); return; }
      if (!isId(b.id)) { errors.push(`${where}.id must be a non-empty string`); return; }
      if (batchIds.has(b.id)) { errors.push(`${where}.id ${JSON.stringify(b.id)} is duplicated`); return; }
      const start = parseTime(b.start);
      const end = parseTime(b.end);
      if (start === null || end === null) { errors.push(`${where} must have valid ISO start/end timestamps`); return; }
      if (!(start < end)) { errors.push(`${where} start must be before end`); return; }
      batchIds.add(b.id);
      batches.push({ id: b.id, start, end });
    });
    batches.sort((x, y) => x.start - y.start || (x.id < y.id ? -1 : 1));
  }

  const transactions = [];
  const txIds = new Set();
  if (!Array.isArray(raw.transactions)) {
    errors.push('transactions must be an array');
  } else {
    raw.transactions.forEach((t, i) => {
      const where = `transactions[${i}]`;
      if (!isObject(t)) { errors.push(`${where} must be an object`); return; }
      if (!isId(t.id)) { errors.push(`${where}.id must be a non-empty string`); return; }
      if (txIds.has(t.id)) { errors.push(`${where}.id ${JSON.stringify(t.id)} is duplicated`); return; }
      txIds.add(t.id);
      if (!accounts.has(t.account)) { errors.push(`${where}.account references an unknown account`); return; }
      if (!isPosNumber(t.amount)) { errors.push(`${where}.amount must be a positive number`); return; }

      let windows = null;
      if (t.windows !== undefined) {
        if (!Array.isArray(t.windows) || t.windows.length === 0) {
          errors.push(`${where}.windows must be a non-empty array of [start, end] pairs`);
          return;
        }
        windows = [];
        for (const w of t.windows) {
          const ws = Array.isArray(w) && w.length === 2 ? parseTime(w[0]) : null;
          const we = Array.isArray(w) && w.length === 2 ? parseTime(w[1]) : null;
          if (ws === null || we === null || !(ws <= we)) {
            errors.push(`${where}.windows entries must be [validStart, validEnd] with start <= end`);
            return;
          }
          windows.push([ws, we]);
        }
      }

      let routes = null;
      if (t.routes !== undefined) {
        if (!Array.isArray(t.routes) || t.routes.some((r) => !isId(r) || !batchIds.has(r))) {
          errors.push(`${where}.routes must be an array of known batch ids`);
          return;
        }
        routes = [...t.routes];
      }

      let failures = [];
      if (t.failures !== undefined) {
        if (!Array.isArray(t.failures) || t.failures.some((f) => !isId(f) || !batchIds.has(f))) {
          errors.push(`${where}.failures must be an array of known batch ids`);
          return;
        }
        failures = [...t.failures];
      }

      transactions.push({ id: t.id, account: t.account, amount: t.amount, windows, routes, failures });
    });
  }

  const cancellations = [];
  if (raw.cancellations !== undefined) {
    if (!Array.isArray(raw.cancellations)) {
      errors.push('cancellations must be an array');
    } else {
      raw.cancellations.forEach((c, i) => {
        const where = `cancellations[${i}]`;
        if (!isObject(c) || !txIds.has(c.tx)) { errors.push(`${where}.tx references an unknown transaction`); return; }
        if (!batchIds.has(c.atBatch)) { errors.push(`${where}.atBatch references an unknown batch`); return; }
        const phase = c.phase === undefined ? 'before' : c.phase;
        if (phase !== 'before' && phase !== 'during') {
          errors.push(`${where}.phase must be "before" or "during"`);
          return;
        }
        cancellations.push({ tx: c.tx, atBatch: c.atBatch, phase });
      });
    }
  }

  if (errors.length > 0) throw new ValidationError(errors);

  for (const tx of transactions) {
    tx.domain = batches
      .filter((b) => tx.routes === null || tx.routes.includes(b.id))
      .filter((b) => tx.windows === null || tx.windows.some(([s, e]) => s <= b.start && b.end <= e))
      .map((b) => b.id);
  }

  return { accounts, batches, transactions, cancellations };
}

module.exports = { normalize, ValidationError };
