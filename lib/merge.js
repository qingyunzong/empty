'use strict';

const crypto = require('node:crypto');

const STATUS_RANK = Object.freeze({ DRAFT: 0, LOCKED: 1, SETTLED: 2 });

const MERGE_FIELDS = Object.freeze(['account', 'amount', 'ccy', 'seq', 'status']);

const RULES = Object.freeze({
  AMOUNT_BOTH_CHANGED: 'R1',
  CCY_BOTH_CHANGED: 'R2',
  STATUS_BOTH_CHANGED: 'R3',
  STATUS_ROLLBACK: 'R4',
  DELETE_VS_MODIFY: 'R5',
  ADD_ADD_CONFLICT: 'R6',
  FIELD_BOTH_CHANGED: 'R7',
});

const FIELD_RULE = Object.freeze({
  amount: RULES.AMOUNT_BOTH_CHANGED,
  ccy: RULES.CCY_BOTH_CHANGED,
  status: RULES.STATUS_BOTH_CHANGED,
  account: RULES.FIELD_BOTH_CHANGED,
  seq: RULES.FIELD_BOTH_CHANGED,
});

class MergeInputError extends Error {
  constructor(code, line, msg) {
    super(msg);
    this.name = 'MergeInputError';
    this.code = code;
    this.line = line;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

function sha256Hex(text) {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

function sameRecord(a, b) {
  if (a === null || b === null) return a === b;
  return canonical(a) === canonical(b);
}

function parseJsonl(text, sourceName) {
  const records = new Map();
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const lineNo = i + 1;
    const raw = lines[i];
    if (raw.trim() === '') continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch (err) {
      throw new MergeInputError('BAD_JSONL', lineNo, `${sourceName}:${lineNo} invalid JSON: ${err.message}`);
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new MergeInputError('BAD_JSONL', lineNo, `${sourceName}:${lineNo} record must be a JSON object`);
    }
    if (typeof rec.id === 'undefined') {
      throw new MergeInputError('BAD_JSONL', lineNo, `${sourceName}:${lineNo} record missing "id"`);
    }
    if (records.has(rec.id)) {
      throw new MergeInputError('DUP_ID', lineNo, `${sourceName}:${lineNo} duplicate id ${JSON.stringify(rec.id)}`);
    }
    if (typeof rec.status !== 'undefined' && !(rec.status in STATUS_RANK)) {
      throw new MergeInputError(
        'INVALID_STATUS',
        lineNo,
        `${sourceName}:${lineNo} illegal status transition target ${JSON.stringify(rec.status)}`,
      );
    }
    records.set(rec.id, rec);
  }
  return records;
}

function summarize(rec) {
  if (rec === null || typeof rec === 'undefined') return null;
  const out = {};
  for (const f of ['id', ...MERGE_FIELDS]) {
    if (typeof rec[f] !== 'undefined') out[f] = rec[f];
  }
  return out;
}

function makeConflict(id, rule, base, left, right) {
  const entry = {
    id,
    rule,
    base: summarize(base),
    left: summarize(left),
    right: summarize(right),
  };
  entry.sha256 = sha256Hex(canonical(entry));
  return entry;
}

function mergeFieldValue(baseVal, leftVal, rightVal) {
  if (Object.is(leftVal, rightVal)) return { ok: true, value: leftVal };
  if (Object.is(leftVal, baseVal)) return { ok: true, value: rightVal };
  if (Object.is(rightVal, baseVal)) return { ok: true, value: leftVal };
  return { ok: false };
}

function mergeOne(id, base, left, right) {
  if (base === null) {
    if (left === null && right === null) return { record: null };
    if (left === null) return { record: right };
    if (right === null) return { record: left };
    if (sameRecord(left, right)) return { record: left };
    return { conflict: makeConflict(id, RULES.ADD_ADD_CONFLICT, base, left, right) };
  }
  if (left === null && right === null) return { record: null };
  if (left === null) {
    if (sameRecord(right, base)) return { record: null };
    return { conflict: makeConflict(id, RULES.DELETE_VS_MODIFY, base, left, right) };
  }
  if (right === null) {
    if (sameRecord(left, base)) return { record: null };
    return { conflict: makeConflict(id, RULES.DELETE_VS_MODIFY, base, left, right) };
  }
  if (
    typeof left.status !== 'undefined'
    && typeof base.status !== 'undefined'
    && STATUS_RANK[left.status] < STATUS_RANK[base.status]
  ) {
    return { conflict: makeConflict(id, RULES.STATUS_ROLLBACK, base, left, right) };
  }
  if (
    typeof right.status !== 'undefined'
    && typeof base.status !== 'undefined'
    && STATUS_RANK[right.status] < STATUS_RANK[base.status]
  ) {
    return { conflict: makeConflict(id, RULES.STATUS_ROLLBACK, base, left, right) };
  }
  const record = { id };
  for (const field of MERGE_FIELDS) {
    const res = mergeFieldValue(base[field], left[field], right[field]);
    if (!res.ok) {
      return { conflict: makeConflict(id, FIELD_RULE[field], base, left, right) };
    }
    if (typeof res.value !== 'undefined') record[field] = res.value;
  }
  return { record };
}

function compareIds(a, b) {
  const na = typeof a === 'number' ? a : NaN;
  const nb = typeof b === 'number' ? b : NaN;
  if (Number.isFinite(na) && Number.isFinite(nb) && na !== nb) return na - nb;
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

function mergeMaps(baseMap, leftMap, rightMap) {
  const ids = new Set([...baseMap.keys(), ...leftMap.keys(), ...rightMap.keys()]);
  const records = [];
  const conflicts = [];
  for (const id of [...ids].sort(compareIds)) {
    const base = baseMap.has(id) ? baseMap.get(id) : null;
    const left = leftMap.has(id) ? leftMap.get(id) : null;
    const right = rightMap.has(id) ? rightMap.get(id) : null;
    const outcome = mergeOne(id, base, left, right);
    if (outcome.conflict) {
      conflicts.push(outcome.conflict);
    } else if (outcome.record !== null) {
      records.push(outcome.record);
    }
  }
  return { records, conflicts };
}

function mergeTexts(baseText, leftText, rightText, names = {}) {
  const baseMap = parseJsonl(baseText, names.base || 'base');
  const leftMap = parseJsonl(leftText, names.left || 'left');
  const rightMap = parseJsonl(rightText, names.right || 'right');
  return mergeMaps(baseMap, leftMap, rightMap);
}

function toJsonl(records) {
  return records.map((r) => JSON.stringify(r)).join('\n') + (records.length ? '\n' : '');
}

module.exports = {
  STATUS_RANK,
  MERGE_FIELDS,
  RULES,
  MergeInputError,
  canonical,
  sha256Hex,
  parseJsonl,
  mergeMaps,
  mergeOne,
  mergeTexts,
  compareIds,
  toJsonl,
};
