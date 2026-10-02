// Log-segment encoding/decoding with per-entry checksums.
// A segment (and the WAL itself) is newline-delimited JSON:
//   {"v":1,"type":"segment","site":"A","count":3}        (optional header)
//   {"v":1,"type":"commit","txn":{...},"sum":"<sha256>"} (one per transaction)
// The checksum covers the canonical JSON of the txn, so any bit-flip in a
// line is detected and the entry is skipped as CORRUPT.

import crypto from 'node:crypto';

export function canon(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  return '{' + Object.keys(value).sort()
    .map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
}

export function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function validateTxnShape(txn) {
  if (typeof txn.id !== 'string' || txn.id.length === 0) throw new Error('CORRUPT: bad id');
  if (typeof txn.site !== 'string') throw new Error('CORRUPT: bad site');
  if (typeof txn.clock !== 'object' || txn.clock === null) throw new Error('CORRUPT: bad clock');
  if (typeof txn.reads !== 'object' || txn.reads === null) throw new Error('CORRUPT: bad reads');
  if (typeof txn.writes !== 'object' || txn.writes === null) throw new Error('CORRUPT: bad writes');
  if (!Array.isArray(txn.parents)) throw new Error('CORRUPT: bad parents');
}

export function encodeEntry(txn) {
  return JSON.stringify({ v: 1, type: 'commit', txn, sum: sha256(canon(txn)) });
}

// Returns the txn or throws Error('CORRUPT...').
export function decodeEntryLine(line) {
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new Error('CORRUPT: invalid JSON');
  }
  if (obj?.type !== 'commit' || typeof obj.sum !== 'string') {
    throw new Error('CORRUPT: bad entry');
  }
  validateTxnShape(obj.txn);
  if (sha256(canon(obj.txn)) !== obj.sum) throw new Error('CORRUPT: checksum mismatch');
  return obj.txn;
}

export function encodeSegment(txns, site) {
  const lines = [JSON.stringify({ v: 1, type: 'segment', site, count: txns.length })];
  for (const t of txns) lines.push(encodeEntry(t));
  return lines.join('\n') + '\n';
}

// Tolerant decoder: valid entries are collected, corrupt lines are counted
// and skipped.
export function decodeSegment(text) {
  const txns = [];
  let corrupt = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let looksLikeHeader = false;
    try {
      looksLikeHeader = JSON.parse(line)?.type === 'segment';
    } catch {
      // fall through: counted as corrupt below
    }
    if (looksLikeHeader) continue;
    try {
      txns.push(decodeEntryLine(line));
    } catch {
      corrupt++;
    }
  }
  return { txns, corrupt };
}
