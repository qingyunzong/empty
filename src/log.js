import fs from 'node:fs';
import crypto from 'node:crypto';
import { Graph, GraphError } from './graph.js';

export const MAX_OPS = 8000;
export const CRASH_POINTS = ['after_append', 'before_fsync', 'after_index_commit'];

export class PersistError extends Error {
  constructor(message) {
    super(message);
    this.code = 'PERSIST_CORRUPT';
  }
}

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.code = 'INVALID_INPUT';
  }
}

const OPS = new Set(['add_edge', 'del_edge', 'commit']);

const OP_CODE = { add_edge: 1, del_edge: 2, commit: 3 };

// Fast integrity checksum (FNV-style 32-bit x2 with different seeds -> 16 hex
// chars), computed allocation-free over the record fields. Detects torn or
// corrupted records; state_hash below stays sha256.
export function checksumOf(rec) {
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x9e3779b9;
  const fields = [rec.seq, OP_CODE[rec.op] ?? 0, rec.u ?? -1, rec.v ?? -1];
  for (const f of fields) {
    h1 = Math.imul(h1 ^ (f | 0), 0x01000193);
    h2 = Math.imul(h2 ^ (f | 0), 0x01000193) ^ 0x85ebca6b;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}

export function encodeRecord(rec) {
  const obj = { seq: rec.seq, op: rec.op };
  if (rec.u !== undefined) obj.u = rec.u;
  if (rec.v !== undefined) obj.v = rec.v;
  obj.sum = checksumOf(rec);
  return JSON.stringify(obj);
}

const FAST_RE = /^\{"seq":(\d+),"op":"(add_edge|del_edge|commit)"(?:,"u":(\d+),"v":(\d+))?,"sum":"([0-9a-f]{16})"\}$/;

export function decodeRecord(line) {
  const m = FAST_RE.exec(line);
  if (m !== null) {
    const rec = { seq: Number(m[1]), op: m[2] };
    if (m[3] !== undefined) { rec.u = Number(m[3]); rec.v = Number(m[4]); }
    if ((rec.op === 'add_edge' || rec.op === 'del_edge') && (rec.u === undefined || rec.v === undefined)) {
      throw new PersistError('missing endpoints');
    }
    if (rec.op === 'commit' && rec.u !== undefined) throw new PersistError('malformed commit record');
    if (checksumOf(rec) !== m[5]) throw new PersistError(`checksum mismatch at seq ${rec.seq}`);
    return rec;
  }
  // Fallback: accept any well-formed JSON record (e.g. reordered keys).
  let obj;
  try {
    obj = JSON.parse(line);
  } catch {
    throw new PersistError(`unparseable record: ${line.slice(0, 64)}`);
  }
  if (typeof obj !== 'object' || obj === null || !Number.isInteger(obj.seq) || obj.seq < 1 ||
      !OPS.has(obj.op) || typeof obj.sum !== 'string') {
    throw new PersistError('malformed record');
  }
  if ((obj.op === 'add_edge' || obj.op === 'del_edge') &&
      (!Number.isInteger(obj.u) || !Number.isInteger(obj.v))) {
    throw new PersistError('missing endpoints');
  }
  if (checksumOf(obj) !== obj.sum) throw new PersistError(`checksum mismatch at seq ${obj.seq}`);
  return obj;
}

export function hashGraph(graph) {
  return crypto.createHash('sha256').update(graph.canonical()).digest('hex');
}

// Append one record: write -> fsync -> (caller commits in-memory index).
export function appendRecord(logPath, rec) {
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, encodeRecord(rec) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Simulate a crash at a fault point by injecting a torn (truncated) record:
// the bytes of a not-yet-confirmed del_edge only partially reach the file,
// with no newline terminator and no fsync. Recovery must discard the partial
// tail and must NOT treat it as a deletion.
export function injectTornRecord(logPath, seq, u, v) {
  const line = encodeRecord({ seq, op: 'del_edge', u, v }) + '\n';
  const cut = Math.max(1, Math.floor(line.length * 0.6));
  const fd = fs.openSync(logPath, 'a');
  try {
    fs.writeSync(fd, line.slice(0, cut));
  } finally {
    fs.closeSync(fd);
  }
}

// Replay the log. Complete, checksum-valid records are applied in seq order;
// a trailing partial record (no newline terminator) is discarded and the file
// is truncated to the last confirmed record. Corruption in any complete
// record throws PersistError (PERSIST_CORRUPT).
export function replay(logPath) {
  let buf;
  try {
    buf = fs.readFileSync(logPath);
  } catch (e) {
    if (e.code === 'ENOENT') buf = Buffer.alloc(0);
    else throw e;
  }
  const graph = new Graph();
  let applied = 0;
  let discarded = 0;
  let recordCount = 0;
  if (buf.length > 0) {
    const text = buf.toString('utf8');
    const lines = text.split('\n');
    const complete = lines.slice(0, -1);
    const tail = text.endsWith('\n') ? '' : lines[lines.length - 1];
    if (tail.length > 0) discarded = 1;
    let expectedSeq = 1;
    for (const line of complete) {
      const rec = decodeRecord(line);
      if (rec.seq !== expectedSeq) throw new PersistError(`seq gap: expected ${expectedSeq}, got ${rec.seq}`);
      expectedSeq++;
      recordCount++;
      if (rec.op === 'commit') continue;
      try {
        if (rec.op === 'add_edge') graph.addEdge(rec.u, rec.v);
        else graph.delEdge(rec.u, rec.v);
      } catch (e) {
        if (e instanceof GraphError) throw new PersistError(`inconsistent log at seq ${rec.seq}: ${e.message}`);
        throw e;
      }
      applied++;
    }
    if (discarded) {
      let offset = 0;
      for (const line of complete) offset += Buffer.byteLength(line) + 1;
      fs.truncateSync(logPath, offset);
    }
  }
  return { graph, applied, discarded, recordCount, stateHash: hashGraph(graph) };
}
