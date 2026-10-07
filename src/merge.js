import { createHash } from 'node:crypto';

export const STATUS_ORDER = ['DRAFT', 'LOCKED', 'SETTLED'];

export const RULES = Object.freeze({
  AMOUNT_CONFLICT: 'R1',
  CCY_CONFLICT: 'R2',
  STATUS_CONFLICT: 'R3',
  STATUS_ROLLBACK: 'R4',
  DELETE_MODIFY: 'R5',
  ADD_ADD_CONFLICT: 'R6',
  FIELD_CONFLICT: 'R7',
});

const FIELD_RULES = Object.freeze({
  account: RULES.FIELD_CONFLICT,
  amount: RULES.AMOUNT_CONFLICT,
  ccy: RULES.CCY_CONFLICT,
  seq: RULES.FIELD_CONFLICT,
});

const MERGED_FIELDS = ['account', 'amount', 'ccy', 'seq'];
const RECORD_FIELDS = ['id', 'account', 'amount', 'ccy', 'seq', 'status'];

export class MergeError extends Error {
  constructor(code, line, msg) {
    super(msg);
    this.name = 'MergeError';
    this.code = code;
    this.line = line;
  }
}

export function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const keys = Object.keys(value).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
}

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function summarize(rec) {
  if (rec == null) return null;
  const out = {};
  for (const field of RECORD_FIELDS) out[field] = rec[field];
  return out;
}

function recordsEqual(a, b) {
  return canonical(summarize(a)) === canonical(summarize(b));
}

function statusRank(status) {
  return STATUS_ORDER.indexOf(status);
}

function checkTransition(from, to, id, line) {
  if (statusRank(to) - statusRank(from) > 1) {
    throw new MergeError(
      'ILLEGAL_TRANSITION',
      line,
      `id=${id}: illegal status transition ${from}->${to} (must advance at most one step)`,
    );
  }
}

function mergeScalar(baseVal, leftVal, rightVal) {
  if (Object.is(leftVal, rightVal)) return { ok: true, value: leftVal };
  if (Object.is(leftVal, baseVal)) return { ok: true, value: rightVal };
  if (Object.is(rightVal, baseVal)) return { ok: true, value: leftVal };
  return { ok: false };
}

function makeConflict(id, rule, baseRec, leftRec, rightRec) {
  const summary = {
    id,
    rule,
    base: summarize(baseRec),
    left: summarize(leftRec),
    right: summarize(rightRec),
  };
  return { ...summary, sha256: sha256Hex(canonical(summary)) };
}

function compareId(a, b) {
  const sa = String(a);
  const sb = String(b);
  if (sa < sb) return -1;
  if (sa > sb) return 1;
  return 0;
}

/**
 * Three-way merge of settlement records.
 * Each dataset is a Map<id, {rec, line}> produced by parseJsonl.
 * Returns { result: [rec], conflicts: [conflict] } deterministically sorted.
 */
export function mergeDatasets(base, left, right) {
  const ids = new Set([...base.keys(), ...left.keys(), ...right.keys()]);
  const result = [];
  const conflicts = [];

  for (const id of ids) {
    const b = base.get(id);
    const l = left.get(id);
    const r = right.get(id);

    if (b && l) checkTransition(b.rec.status, l.rec.status, id, l.line);
    if (b && r) checkTransition(b.rec.status, r.rec.status, id, r.line);

    if (b && l && r) {
      const rec = { ...b.rec };
      const rules = [];
      for (const field of MERGED_FIELDS) {
        const m = mergeScalar(b.rec[field], l.rec[field], r.rec[field]);
        if (m.ok) rec[field] = m.value;
        else rules.push(FIELD_RULES[field]);
      }
      const s = mergeScalar(b.rec.status, l.rec.status, r.rec.status);
      if (!s.ok) {
        rules.push(RULES.STATUS_CONFLICT);
      } else if (statusRank(s.value) < statusRank(b.rec.status)) {
        rules.push(RULES.STATUS_ROLLBACK);
      } else {
        rec.status = s.value;
      }
      if (rules.length > 0) {
        for (const rule of rules) conflicts.push(makeConflict(id, rule, b.rec, l.rec, r.rec));
      } else {
        result.push(rec);
      }
    } else if (b && (l || r)) {
      const kept = l || r;
      if (recordsEqual(kept.rec, b.rec)) {
        // deletion on the other side takes effect: other side unmodified, base exists
      } else {
        conflicts.push(makeConflict(id, RULES.DELETE_MODIFY, b.rec, l?.rec ?? null, r?.rec ?? null));
      }
    } else if (b) {
      // deleted on both sides
    } else if (l && r) {
      if (recordsEqual(l.rec, r.rec)) result.push({ ...l.rec });
      else conflicts.push(makeConflict(id, RULES.ADD_ADD_CONFLICT, null, l.rec, r.rec));
    } else {
      result.push({ ...(l || r).rec });
    }
  }

  result.sort((x, y) => compareId(x.id, y.id));
  conflicts.sort((x, y) => compareId(x.id, y.id) || compareId(x.rule, y.rule));
  return { result, conflicts };
}
