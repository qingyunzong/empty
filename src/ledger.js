'use strict';

// Settlement-batch ledger handling: JSONL parsing/validation, canonical
// field concatenation, and auditing lines against compiled rules.

const { parse, RegexError } = require('./regex');
const { compileAst } = require('./automata');

const MAX_LINES = 50000;
const MAX_LINE_LENGTH = 8192;
const MAX_ABS_AMOUNT = 1e12;
const DIRECTIONS = new Set(['debit', 'credit']);
const CURRENCY_RE = /^[A-Z]{3}$/;
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?(Z|[+-]\d{2}:\d{2})?$/;
const SEPARATOR_RE = /[|\r\n]/;

class LineError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'LineError';
    this.code = 'BAD_LINE';
    if (line !== undefined) this.line = line;
  }
}

class AmbiguousRuleError extends Error {
  constructor(message, line) {
    super(message);
    this.name = 'AmbiguousRuleError';
    this.code = 'AMBIGUOUS_RULE';
    if (line !== undefined) this.line = line;
  }
}

function validateRecord(rec, lineNo) {
  const bad = (msg) => new LineError(`line ${lineNo}: ${msg}`, lineNo);
  if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
    throw bad('record must be a JSON object');
  }
  for (const f of ['batch', 'account']) {
    if (typeof rec[f] !== 'string' || rec[f].length === 0) {
      throw bad(`field '${f}' must be a non-empty string`);
    }
    if (SEPARATOR_RE.test(rec[f])) {
      throw bad(`field '${f}' must not contain '|' or newlines`);
    }
  }
  if (typeof rec.currency !== 'string' || !CURRENCY_RE.test(rec.currency)) {
    throw bad(`field 'currency' must be a 3-letter uppercase code`);
  }
  if (typeof rec.amount !== 'number' || !Number.isFinite(rec.amount)) {
    throw bad(`field 'amount' must be a finite number`);
  }
  if (rec.amount < 0 || rec.amount > MAX_ABS_AMOUNT) {
    throw bad(`field 'amount' out of range [0, ${MAX_ABS_AMOUNT}]`);
  }
  if (!DIRECTIONS.has(rec.direction)) {
    throw bad(`field 'direction' must be 'debit' or 'credit'`);
  }
  if (
    typeof rec.timestamp !== 'string' ||
    !TIMESTAMP_RE.test(rec.timestamp) ||
    Number.isNaN(Date.parse(rec.timestamp))
  ) {
    throw bad(`field 'timestamp' must be ISO 8601 (e.g. 2026-10-01T08:00:00Z)`);
  }
}

function formatAmount(n) {
  return String(n);
}

// Canonical concatenation the audit rules are matched against.
function concatRecord(rec) {
  return [rec.batch, rec.account, rec.currency, formatAmount(rec.amount), rec.direction, rec.timestamp].join('|');
}

function compileRules(ruleDefs) {
  if (!Array.isArray(ruleDefs)) throw new RegexError('rules must be an array');
  return ruleDefs.map((def, i) => {
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      throw new RegexError(`rule ${i} must be an object`);
    }
    const { id, pattern, decision } = def;
    if (typeof id !== 'string' || id.length === 0) {
      throw new RegexError(`rule ${i} must have a non-empty string 'id'`);
    }
    if (decision !== 'flag' && decision !== 'pass') {
      throw new RegexError(`rule '${id}' must have decision 'flag' or 'pass'`);
    }
    const compiled = compileAst(parse(pattern));
    return { id, decision, match: compiled.match };
  });
}

function audit(ruleDefs, text) {
  const compiled = compileRules(ruleDefs);
  if (typeof text !== 'string') throw new LineError('ledger input must be a string');
  const raw = text.split('\n');
  if (raw.length && raw[raw.length - 1] === '') raw.pop();
  if (raw.length > MAX_LINES) {
    throw new LineError(`too many lines: ${raw.length} exceeds limit ${MAX_LINES}`);
  }

  const match = [];
  const flaggedCents = new Map();
  let flaggedCount = 0;

  raw.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (line.length > MAX_LINE_LENGTH) {
      throw new LineError(`line ${lineNo}: exceeds ${MAX_LINE_LENGTH} characters`, lineNo);
    }
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new LineError(`line ${lineNo}: invalid JSON`, lineNo);
    }
    validateRecord(rec, lineNo);
    const s = concatRecord(rec);
    const matched = [];
    const decisions = new Set();
    for (const c of compiled) {
      if (c.match(s)) {
        matched.push(c.id);
        decisions.add(c.decision);
      }
    }
    if (decisions.size > 1) {
      // A line matching both 'flag' and 'pass' rules is an unresolved
      // conflict; it must never be silently treated as a non-match.
      throw new AmbiguousRuleError(
        `line ${lineNo} matched conflicting rules: ${matched.join(', ')}`,
        lineNo
      );
    }
    const decision = decisions.size === 0 ? 'none' : [...decisions][0];
    if (decision === 'flag') {
      flaggedCount++;
      flaggedCents.set(rec.currency, (flaggedCents.get(rec.currency) || 0) + Math.round(rec.amount * 100));
    }
    match.push({ line: lineNo, batch: rec.batch, matched, decision });
  });

  const flaggedByCurrency = {};
  for (const ccy of [...flaggedCents.keys()].sort()) {
    flaggedByCurrency[ccy] = flaggedCents.get(ccy) / 100;
  }
  return { match, summary: { lines: match.length, flaggedCount, flaggedByCurrency } };
}

module.exports = {
  audit,
  compileRules,
  concatRecord,
  validateRecord,
  LineError,
  AmbiguousRuleError,
  MAX_LINES,
  MAX_ABS_AMOUNT,
};
