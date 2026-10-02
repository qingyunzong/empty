import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { crc32 } from './crc32.js';
import { canonical } from './canon.js';
import { emptyState, clone, applyOp, inverseOf, stateHash } from './state.js';
import { SchedError } from './errors.js';

const LOG_FILE = 'log.dat';
const INDEX_FILE = 'snapshot.index';
const SNAP_DIR = 'snapshots';
const CONFIG_FILE = 'config.json';
const GENESIS = '0'.repeat(64);

export function initStore(dir, opts = {}) {
  fs.mkdirSync(path.join(dir, SNAP_DIR), { recursive: true });
  for (const f of [LOG_FILE, INDEX_FILE]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) fs.writeFileSync(p, '');
  }
  const cfg = path.join(dir, CONFIG_FILE);
  if (!fs.existsSync(cfg)) {
    fs.writeFileSync(cfg, JSON.stringify({ snapshotEvery: opts.snapshotEvery ?? 5 }));
  }
}

function hashRecord(record) {
  const { hash, ...rest } = record;
  return crypto.createHash('sha256').update(canonical(rest)).digest('hex');
}

function encodeChunk(record) {
  const buf = Buffer.from(canonical(record), 'utf8');
  return crc32(buf).toString(16).padStart(8, '0') + ' ' + buf.toString('base64') + '\n';
}

function decodeChunk(line) {
  const sp = line.indexOf(' ');
  if (sp !== 8) return null;
  const payload = Buffer.from(line.slice(sp + 1), 'base64').toString('utf8');
  const crc = crc32(Buffer.from(payload, 'utf8')).toString(16).padStart(8, '0');
  if (crc !== line.slice(0, sp)) return null;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

function readIndex(dir) {
  const p = path.join(dir, INDEX_FILE);
  if (!fs.existsSync(p)) return [];
  return fs
    .readFileSync(p, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function writeIndex(dir, entries) {
  fs.writeFileSync(
    path.join(dir, INDEX_FILE),
    entries.map((e) => JSON.stringify(e)).join('\n') + (entries.length ? '\n' : '')
  );
}

function loadSnapshot(dir, entry) {
  const p = path.join(dir, SNAP_DIR, `${entry.seq}.json`);
  let snap;
  try {
    snap = JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch {
    throw new SchedError('E_CRC', `snapshot at seq ${entry.seq} unreadable`);
  }
  if (snap.seq !== entry.seq || snap.chainHash !== entry.chainHash || stateHash(snap.state) !== entry.stateHash) {
    throw new SchedError('E_CRC', `snapshot at seq ${entry.seq} failed integrity check`);
  }
  return snap;
}

export function openStore(dir) {
  const logPath = path.join(dir, LOG_FILE);
  if (!fs.existsSync(logPath)) throw new SchedError('E_NO_STORE', `no store at ${dir}`);
  const config = JSON.parse(fs.readFileSync(path.join(dir, CONFIG_FILE), 'utf8'));

  let entries = readIndex(dir);
  const buf = fs.readFileSync(logPath);
  const chunks = [];
  let corruptOffset = -1;
  let pos = 0;
  while (pos < buf.length) {
    let nl = buf.indexOf(0x0a, pos);
    if (nl === -1) nl = buf.length;
    const record = decodeChunk(buf.subarray(pos, nl).toString('utf8'));
    if (record === null) {
      corruptOffset = pos;
      break;
    }
    chunks.push({ offset: pos, record });
    pos = nl + 1;
  }

  if (corruptOffset !== -1) {
    const nl = buf.indexOf(0x0a, corruptOffset);
    const isTailLine = nl === -1 || nl === buf.length - 1;
    if (!isTailLine) {
      throw new SchedError('E_CRC', `corrupt chunk at offset ${corruptOffset} inside history`);
    }
    // Corruption confined to the current (tail) chunk: drop the last
    // transaction, keep every snapshot that still points into intact data.
    fs.truncateSync(logPath, corruptOffset);
    const usable = entries.filter((e) => e.offset <= corruptOffset);
    if (usable.length !== entries.length) {
      entries = usable;
      writeIndex(dir, entries);
    }
  }

  // Verify the audit chain from genesis.
  let prev = GENESIS;
  const records = [];
  for (const { record } of chunks) {
    if (record.prevHash !== prev || record.hash !== hashRecord(record)) {
      throw new SchedError('E_CRC', 'audit chain broken');
    }
    records.push(record);
    prev = record.hash;
  }

  // Fold state from the latest valid snapshot, then replay the tail.
  let state = emptyState();
  let fromSeq = 0;
  if (entries.length) {
    const entry = entries[entries.length - 1];
    const snap = loadSnapshot(dir, entry);
    const anchor = records.find((r) => r.seq === entry.seq);
    if (!anchor || anchor.hash !== snap.chainHash) {
      throw new SchedError('E_CRC', 'snapshot does not match log chain');
    }
    state = snap.state;
    fromSeq = snap.seq;
  }
  for (const r of records) {
    if (r.seq <= fromSeq) continue;
    for (const op of r.ops) applyOp(state, op);
  }

  return {
    dir,
    config,
    records,
    state,
    seq: records.length ? records[records.length - 1].seq : 0,
    chainHash: records.length ? records[records.length - 1].hash : GENESIS,
  };
}

function maybeSnapshot(dir, record, state, every) {
  if (record.seq % every !== 0) return;
  const snap = { seq: record.seq, state: clone(state), chainHash: record.hash };
  fs.writeFileSync(path.join(dir, SNAP_DIR, `${record.seq}.json`), JSON.stringify(snap));
  const offset = fs.statSync(path.join(dir, LOG_FILE)).size;
  fs.appendFileSync(
    path.join(dir, INDEX_FILE),
    JSON.stringify({ seq: record.seq, offset, stateHash: stateHash(state), chainHash: record.hash }) + '\n'
  );
}

export function commit(dir, ops, meta = {}) {
  const store = openStore(dir);
  const state = clone(store.state);
  const inverse = [];
  for (const op of ops) {
    inverse.unshift(inverseOf(state, op));
    applyOp(state, op);
  }
  const record = {
    seq: store.seq + 1,
    type: meta.type ?? 'change',
    target: meta.target ?? null,
    ops,
    inverse,
    prevHash: store.chainHash,
  };
  record.hash = hashRecord(record);
  fs.appendFileSync(path.join(dir, LOG_FILE), encodeChunk(record));
  maybeSnapshot(dir, record, state, store.config.snapshotEvery);
  return record;
}

function lastEffectiveChange(records) {
  const net = new Map();
  for (const r of records) {
    if (r.type === 'undo') net.set(r.target, (net.get(r.target) ?? 0) + 1);
    if (r.type === 'redo') net.set(r.target, (net.get(r.target) ?? 0) - 1);
  }
  for (let i = records.length - 1; i >= 0; i--) {
    if (records[i].type === 'change' && !(net.get(records[i].seq) > 0)) return records[i];
  }
  return null;
}

export function undo(dir) {
  const store = openStore(dir);
  const target = lastEffectiveChange(store.records);
  if (!target) throw new SchedError('E_UNDO_EMPTY', 'nothing to undo');
  return commit(dir, target.inverse, { type: 'undo', target: target.seq });
}

export function redo(dir) {
  const store = openStore(dir);
  const head = store.records[store.records.length - 1];
  if (!head || head.type !== 'undo') {
    throw new SchedError('E_DIVERGED', 'redo only valid while history tail is an undo');
  }
  const target = store.records.find((r) => r.seq === head.target);
  if (!target) throw new SchedError('E_DIVERGED', 'undo target missing from history');
  return commit(dir, target.ops, { type: 'redo', target: target.seq });
}

export function verify(dir) {
  const store = openStore(dir);
  return {
    ok: true,
    seq: store.seq,
    records: store.records.length,
    stateHash: stateHash(store.state),
    chainHash: store.chainHash,
  };
}
