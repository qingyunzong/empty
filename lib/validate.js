'use strict';

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isNonNegNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0;
}

function isPosNumber(v) {
  return typeof v === 'number' && Number.isFinite(v) && v > 0;
}

function fail(msg) {
  return { ok: false, error: msg };
}

function validateInput(data) {
  if (!isPlainObject(data)) return fail('input must be a JSON object');

  if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
    return fail('accounts must be a non-empty array');
  }
  const accountIds = new Set();
  for (const a of data.accounts) {
    if (!isPlainObject(a) || typeof a.id !== 'string' || a.id === '') {
      return fail('each account needs a non-empty string id');
    }
    if (!isNonNegNumber(a.limit)) return fail(`account ${a.id}: limit must be a non-negative number`);
    if (accountIds.has(a.id)) return fail(`duplicate account id ${a.id}`);
    accountIds.add(a.id);
  }

  if (!Array.isArray(data.batches) || data.batches.length === 0) {
    return fail('batches must be a non-empty array');
  }
  const batchIds = new Set();
  for (const b of data.batches) {
    if (!isPlainObject(b) || typeof b.id !== 'string' || b.id === '') {
      return fail('each batch needs a non-empty string id');
    }
    if (typeof b.start !== 'string' || typeof b.end !== 'string' ||
        Number.isNaN(Date.parse(b.start)) || Number.isNaN(Date.parse(b.end))) {
      return fail(`batch ${b.id}: start/end must be ISO timestamps`);
    }
    if (Date.parse(b.start) >= Date.parse(b.end)) {
      return fail(`batch ${b.id}: start must be before end`);
    }
    if (b.status !== undefined && !['pending', 'running', 'done'].includes(b.status)) {
      return fail(`batch ${b.id}: status must be pending|running|done`);
    }
    if (batchIds.has(b.id)) return fail(`duplicate batch id ${b.id}`);
    batchIds.add(b.id);
  }

  if (!Array.isArray(data.transactions)) return fail('transactions must be an array');
  const txIds = new Set();
  for (const t of data.transactions) {
    if (!isPlainObject(t) || typeof t.id !== 'string' || t.id === '') {
      return fail('each transaction needs a non-empty string id');
    }
    if (txIds.has(t.id)) return fail(`duplicate transaction id ${t.id}`);
    txIds.add(t.id);
    if (!accountIds.has(t.account)) return fail(`transaction ${t.id}: unknown account ${t.account}`);
    if (!isPosNumber(t.amount)) return fail(`transaction ${t.id}: amount must be a positive number`);
    if (t.windows !== undefined) {
      if (!Array.isArray(t.windows)) return fail(`transaction ${t.id}: windows must be an array`);
      for (const w of t.windows) {
        if (!batchIds.has(w)) return fail(`transaction ${t.id}: unknown batch window ${w}`);
      }
    }
  }

  if (data.cancellations !== undefined) {
    if (!Array.isArray(data.cancellations)) return fail('cancellations must be an array');
    for (const c of data.cancellations) {
      if (!txIds.has(c)) return fail(`cancellation references unknown transaction ${c}`);
    }
  }

  if (data.state !== undefined) {
    if (!isPlainObject(data.state) || !isPlainObject(data.state.retries)) {
      return fail('state.retries must be an object');
    }
    for (const [key, r] of Object.entries(data.state.retries)) {
      if (!isPlainObject(r) || typeof r.txId !== 'string' || typeof r.batchId !== 'string') {
        return fail(`state.retries.${key}: needs txId and batchId`);
      }
      if (!['PENDING', 'RUNNING', 'SUCCESS', 'FAILED', 'CANCELLED'].includes(r.state)) {
        return fail(`state.retries.${key}: invalid state ${r.state}`);
      }
      if (typeof r.freezeCommitted !== 'boolean') {
        return fail(`state.retries.${key}: freezeCommitted must be boolean`);
      }
      if (!batchIds.has(r.batchId)) return fail(`state.retries.${key}: unknown batch ${r.batchId}`);
      if (!txIds.has(r.txId)) return fail(`state.retries.${key}: unknown transaction ${r.txId}`);
    }
  }

  return { ok: true };
}

module.exports = { validateInput };
