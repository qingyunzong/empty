import { MergeError, STATUS_ORDER } from './merge.js';

const REQUIRED_FIELDS = ['id', 'account', 'amount', 'ccy', 'seq', 'status'];

/**
 * Parse JSONL text into a Map<id, {rec, line}>.
 * Throws MergeError({code, line, msg}) on bad lines, missing fields,
 * unknown status values, or duplicate ids.
 */
export function parseJsonl(text, file = '<input>') {
  const map = new Map();
  const lines = text.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const lineNo = i + 1;
    const raw = lines[i].trim();
    if (raw === '') continue;
    let rec;
    try {
      rec = JSON.parse(raw);
    } catch {
      throw new MergeError('BAD_JSONL', lineNo, `${file}:${lineNo}: invalid JSON line`);
    }
    if (rec === null || typeof rec !== 'object' || Array.isArray(rec)) {
      throw new MergeError('BAD_JSONL', lineNo, `${file}:${lineNo}: line is not a JSON object`);
    }
    for (const field of REQUIRED_FIELDS) {
      if (!(field in rec)) {
        throw new MergeError('BAD_JSONL', lineNo, `${file}:${lineNo}: missing required field "${field}"`);
      }
    }
    if (!STATUS_ORDER.includes(rec.status)) {
      throw new MergeError(
        'BAD_STATUS',
        lineNo,
        `${file}:${lineNo}: unknown status ${JSON.stringify(rec.status)} (expected one of ${STATUS_ORDER.join(', ')})`,
      );
    }
    if (map.has(rec.id)) {
      throw new MergeError('DUP_ID', lineNo, `${file}:${lineNo}: duplicate id ${JSON.stringify(rec.id)}`);
    }
    map.set(rec.id, { rec, line: lineNo });
  }
  return map;
}
