import { createHash } from 'node:crypto';

// Write-ahead log: one JSON record per line (JSONL).
// Record: {"seq":N,"op":"add_edge","u":1,"v":2,"crc":"..."}
//         {"seq":N,"op":"commit","crc":"..."}
// crc = first 16 hex chars of sha256("seq|op|u|v"). A `commit` record
// confirms every record up to its seq; anything past the last commit is
// unconfirmed and must be discarded (never replayed) during recovery.

export const OP = { ADD: 'add_edge', DEL: 'del_edge', COMMIT: 'commit' };

function crc(payload) {
  return createHash('sha256').update(payload).digest('hex').slice(0, 16);
}

export function encodeRecord(rec) {
  const obj = { seq: rec.seq, op: rec.op };
  if (rec.u !== undefined) obj.u = rec.u;
  if (rec.v !== undefined) obj.v = rec.v;
  obj.crc = crc([rec.seq, rec.op, rec.u ?? '', rec.v ?? ''].join('|'));
  return JSON.stringify(obj) + '\n';
}

export function decodeRecord(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof obj !== 'object' || obj === null) return null;
  const { seq, op, u, v, crc: c } = obj;
  if (!Number.isInteger(seq) || typeof op !== 'string' || typeof c !== 'string') return null;
  if (u !== undefined && !Number.isInteger(u)) return null;
  if (v !== undefined && !Number.isInteger(v)) return null;
  if (crc([seq, op, u ?? '', v ?? ''].join('|')) !== c) return null;
  return { seq, op, u, v };
}

export class PersistCorruptError extends Error {
  constructor() {
    super('PERSIST_CORRUPT');
    this.code = 'PERSIST_CORRUPT';
  }
}

// Parses a log buffer. A trailing line without a newline is a torn write
// (half record) and is reported as `partial` instead of being an error.
// A complete line that fails to decode or has a bad CRC is real corruption.
export function parseLog(buf) {
  if (buf.length === 0) return { records: [], partial: false };
  const text = buf.toString('utf8');
  const lines = text.split('\n');
  let partial = false;
  if (text.endsWith('\n')) {
    lines.pop();
  } else {
    partial = lines.pop().length > 0;
  }
  const records = [];
  for (const line of lines) {
    const rec = line === '' ? null : decodeRecord(line);
    if (!rec) throw new PersistCorruptError();
    records.push(rec);
  }
  return { records, partial };
}
