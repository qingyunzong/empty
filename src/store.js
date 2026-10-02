// Persistence: append-only WAL (crc32 per record) + JSON snapshot (atomic via
// tmp+rename) + derived index. Fault injection points (env QCL_CRASH_AT):
//   wal-append      : WAL appended but not fsynced -> torn tail, replay WAL
//   snapshot-rename : tmp snapshot written, crash before rename -> ignore half
//   index-update    : index written stale/corrupt -> rebuild, no double count
import fs from 'node:fs';
import path from 'node:path';
import { crc32 } from 'node:zlib';
import { canonical, hashState } from './hash.js';
import { MachineError, EXIT } from './machine.js';

export const CRASH_POINTS = Object.freeze(['wal-append', 'snapshot-rename', 'index-update']);
export const CRASH_EXIT = 99;

export function paths(dir) {
  return {
    wal: path.join(dir, 'wal.log'),
    snapshot: path.join(dir, 'snapshot.json'),
    snapshotTmp: path.join(dir, 'snapshot.json.tmp'),
    index: path.join(dir, 'index.json'),
  };
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

function crashAt(point) {
  if (process.env.QCL_CRASH_AT === point) {
    process.stderr.write(`CRASH simulated at ${point}\n`);
    process.exit(CRASH_EXIT);
  }
}

function recordCrc(rec) {
  const body = canonical({ seq: rec.seq, op: rec.op, hash: rec.hash });
  return crc32(Buffer.from(body, 'utf8')).toString(16).padStart(8, '0');
}

export function encodeRecord(rec) {
  return JSON.stringify({ ...rec, crc: recordCrc(rec) });
}

// Append one WAL record and fsync. Crash point 1: after the append, before
// fsync, the write is torn (partial line, no newline) and the process dies.
export function appendWal(dir, rec) {
  const p = paths(dir);
  const line = `${encodeRecord(rec)}\n`;
  if (process.env.QCL_CRASH_AT === 'wal-append') {
    const torn = line.slice(0, Math.max(1, Math.floor(line.length * 0.6)));
    fs.appendFileSync(p.wal, torn, 'utf8'); // no fsync, torn tail
    crashAt('wal-append');
  }
  const fd = fs.openSync(p.wal, 'a');
  try {
    fs.writeSync(fd, line);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Read WAL. A corrupt non-trailing record is a hard checksum failure (exit 22);
// a corrupt/incomplete trailing record is a torn tail from crash point 1.
export function readWal(dir) {
  const p = paths(dir);
  if (!fs.existsSync(p.wal)) return { records: [], torn: false };
  const raw = fs.readFileSync(p.wal, 'utf8');
  const lines = raw.split('\n');
  if (lines.at(-1) === '') lines.pop();
  const records = [];
  let torn = false;
  for (let i = 0; i < lines.length; i += 1) {
    const last = i === lines.length - 1;
    let rec = null;
    try {
      rec = JSON.parse(lines[i]);
    } catch {
      rec = null;
    }
    const bad = !rec
      || typeof rec.seq !== 'number'
      || rec.seq !== i + 1
      || rec.crc !== recordCrc(rec);
    if (bad) {
      if (last) { torn = true; break; }
      throw new MachineError(EXIT.WAL_CHECKSUM, `WAL checksum failure at record ${i + 1}`);
    }
    records.push(rec);
  }
  return { records, torn };
}

// Truncate the WAL to its valid prefix (recovery for the torn tail).
export function truncateWal(dir, records) {
  const p = paths(dir);
  const data = records.map((r) => `${encodeRecord(r)}\n`).join('');
  const fd = fs.openSync(p.wal, 'w');
  try {
    fs.writeSync(fd, data);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Snapshot: write tmp, fsync, rename (atomic). Crash point 2: after the tmp
// file is durable but before the rename -> a half snapshot is left behind.
export function writeSnapshot(dir, state) {
  const p = paths(dir);
  const payload = JSON.stringify({ seq: state.seq, hash: hashState(state), state }, null, 2);
  const fd = fs.openSync(p.snapshotTmp, 'w');
  try {
    fs.writeSync(fd, payload);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  crashAt('snapshot-rename');
  fs.renameSync(p.snapshotTmp, p.snapshot);
}

export function readSnapshot(dir) {
  const p = paths(dir);
  const halfSnapshot = fs.existsSync(p.snapshotTmp);
  if (!fs.existsSync(p.snapshot)) return { snapshot: null, halfSnapshot };
  const snapshot = JSON.parse(fs.readFileSync(p.snapshot, 'utf8'));
  return { snapshot, halfSnapshot };
}

export function discardHalfSnapshot(dir) {
  const p = paths(dir);
  if (fs.existsSync(p.snapshotTmp)) fs.rmSync(p.snapshotTmp);
}

// Index: derived only. Crash point 3: a stale/corrupt (double-counted) index
// is left on disk; recovery rebuilds it from state.
export function writeIndex(dir, index) {
  const p = paths(dir);
  let toWrite = index;
  if (process.env.QCL_CRASH_AT === 'index-update') {
    toWrite = structuredClone(index);
    for (const k of Object.keys(toWrite.defectsByStatus)) toWrite.defectsByStatus[k] *= 2;
    for (const k of Object.keys(toWrite.ordersByStatus)) toWrite.ordersByStatus[k] *= 2;
    fs.writeFileSync(p.index, JSON.stringify(toWrite, null, 2));
    crashAt('index-update');
  }
  fs.writeFileSync(p.index, JSON.stringify(toWrite, null, 2));
}

export function readIndex(dir) {
  const p = paths(dir);
  if (!fs.existsSync(p.index)) return null;
  return JSON.parse(fs.readFileSync(p.index, 'utf8'));
}
