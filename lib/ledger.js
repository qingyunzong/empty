'use strict';

const { AuditError } = require('./errors');

const MAX_LINES = 50000;
const MAX_AMOUNT = 1e12;
const CURRENCY_RE = /^[A-Z]{3}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/;
const DIRECTIONS = new Set(['debit', 'credit']);

function badLine(lineNo, message) {
  throw new AuditError('BAD_LINE', `line ${lineNo}: ${message}`);
}

// Canonical field concatenation that audit rules are matched against:
//   batch|account|currency|amount|direction|timestamp
function concatFields(f) {
  return [f.batch, f.account, f.currency, String(f.amount), f.direction, f.timestamp].join('|');
}

function validateFields(raw, lineNo) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    badLine(lineNo, 'record must be a JSON object');
  }
  const f = raw;
  if (typeof f.batch !== 'string' || f.batch.length === 0) {
    badLine(lineNo, 'batch must be a non-empty string');
  }
  if (typeof f.account !== 'string' || f.account.length === 0) {
    badLine(lineNo, 'account must be a non-empty string');
  }
  if (typeof f.currency !== 'string' || !CURRENCY_RE.test(f.currency)) {
    badLine(lineNo, 'currency must be a 3-letter uppercase code');
  }
  if (typeof f.amount !== 'number' || !Number.isFinite(f.amount)) {
    badLine(lineNo, 'amount must be a finite number');
  }
  if (Math.abs(f.amount) > MAX_AMOUNT) {
    badLine(lineNo, `amount out of range (|amount| > ${MAX_AMOUNT})`);
  }
  if (typeof f.direction !== 'string' || !DIRECTIONS.has(f.direction)) {
    badLine(lineNo, 'direction must be "debit" or "credit"');
  }
  if (
    typeof f.timestamp !== 'string' ||
    !TIMESTAMP_RE.test(f.timestamp) ||
    Number.isNaN(Date.parse(f.timestamp))
  ) {
    badLine(lineNo, 'timestamp must be a valid ISO 8601 datetime');
  }
  return {
    batch: f.batch,
    account: f.account,
    currency: f.currency,
    amount: f.amount,
    direction: f.direction,
    timestamp: f.timestamp,
  };
}

function parseLedger(text) {
  if (typeof text !== 'string') {
    throw new AuditError('BAD_LINE', 'ledger input must be text');
  }
  const lines = text.split(/\r?\n/);
  const entries = [];
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const line = lines[i];
    if (line.trim() === '') continue;
    if (entries.length >= MAX_LINES) {
      throw new AuditError('BAD_LINE', `ledger exceeds ${MAX_LINES} lines`);
    }
    let raw;
    try {
      raw = JSON.parse(line);
    } catch {
      badLine(lineNo, 'invalid JSON');
    }
    const fields = validateFields(raw, lineNo);
    entries.push({ lineNo, fields, concat: concatFields(fields) });
  }
  return entries;
}

module.exports = { parseLedger, concatFields, MAX_LINES, MAX_AMOUNT };
