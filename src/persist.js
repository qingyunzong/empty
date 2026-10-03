import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { Model } from './model.js';
import { Interpreter, modelToCanonical, modelFromCanonical } from './interp.js';

export class RecoveryError extends Error {
  constructor(msg) { super(msg); this.name = 'RecoveryError'; }
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

export const WAL_FILE = path.join('wal', '000001.log');
export const STATE_FILE = path.join('state', 'state.json');
export const CHECKPOINT_FILE = path.join('checkpoint', 'checkpoint.json');

export function isInitialized(dir) {
  return fs.existsSync(path.join(dir, WAL_FILE));
}

export function initStore(dir) {
  for (const sub of ['wal', 'state', 'checkpoint']) {
    fs.mkdirSync(path.join(dir, sub), { recursive: true });
  }
  const walPath = path.join(dir, WAL_FILE);
  if (!fs.existsSync(walPath)) fs.writeFileSync(walPath, '');
  if (!fs.existsSync(path.join(dir, STATE_FILE))) {
    writeState(dir, modelToCanonical(new Model()), 0);
  }
  if (!fs.existsSync(path.join(dir, CHECKPOINT_FILE))) {
    const st = readState(dir);
    writeCheckpoint(dir, st.seq, stateChecksum(st.seq, st.model));
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
}

// --- WAL ---

export function appendWal(dir, seq, script) {
  const payload = JSON.stringify({ seq, script });
  const record = JSON.stringify({ seq, script, checksum: sha256(payload) });
  const fd = fs.openSync(path.join(dir, WAL_FILE), 'a');
  try {
    fs.writeSync(fd, record + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Returns { records, tailIgnored }. A corrupt or truncated final line is an
// uncommitted tail and is ignored; corruption followed by more data is fatal.
export function readWalRecords(dir) {
  const walPath = path.join(dir, WAL_FILE);
  if (!fs.existsSync(walPath)) throw new RecoveryError('WAL is missing');
  const data = fs.readFileSync(walPath, 'utf8');
  const lines = data.split('\n');
  if (lines.length && lines[lines.length - 1] === '') lines.pop();
  const records = [];
  let tailIgnored = false;
  for (let k = 0; k < lines.length; k++) {
    const line = lines[k];
    let ok = false;
    try {
      const rec = JSON.parse(line);
      const payload = JSON.stringify({ seq: rec.seq, script: rec.script });
      ok = typeof rec.seq === 'number' && typeof rec.script === 'string'
        && rec.checksum === sha256(payload);
      if (ok && records.length && rec.seq !== records[records.length - 1].seq + 1) ok = false;
      if (ok && !records.length && rec.seq !== 1) ok = false;
      if (ok) records.push(rec);
    } catch {
      ok = false;
    }
    if (!ok) {
      if (k === lines.length - 1) { tailIgnored = true; break; }
      throw new RecoveryError(`WAL corruption at record ${k + 1}`);
    }
  }
  return { records, tailIgnored };
}

// --- state ---

function stateChecksum(seq, model) {
  return sha256(JSON.stringify({ seq, model }));
}

export function writeState(dir, canonical, seq) {
  const body = { seq, model: canonical };
  const out = { ...body, checksum: stateChecksum(seq, canonical) };
  writeAtomic(path.join(dir, STATE_FILE), JSON.stringify(out, null, 2) + '\n');
}

export function readState(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, STATE_FILE), 'utf8');
    const obj = JSON.parse(raw);
    if (typeof obj.seq !== 'number' || typeof obj.model !== 'object') return null;
    if (obj.checksum !== stateChecksum(obj.seq, obj.model)) return null;
    return obj;
  } catch {
    return null;
  }
}

// --- checkpoint ---

export function writeCheckpoint(dir, seq, stateSum) {
  const body = { seq, stateChecksum: stateSum };
  const out = { ...body, checksum: sha256(JSON.stringify(body)) };
  writeAtomic(path.join(dir, CHECKPOINT_FILE), JSON.stringify(out, null, 2) + '\n');
}

export function readCheckpoint(dir) {
  try {
    const raw = fs.readFileSync(path.join(dir, CHECKPOINT_FILE), 'utf8');
    const obj = JSON.parse(raw);
    const body = { seq: obj.seq, stateChecksum: obj.stateChecksum };
    if (typeof obj.seq !== 'number' || typeof obj.stateChecksum !== 'string') return null;
    if (obj.checksum !== sha256(JSON.stringify(body))) return null;
    return obj;
  } catch {
    return null;
  }
}

// --- recovery ---

// Replays committed WAL records, then idempotently repairs state and
// checkpoint so the store equals the last committed transaction.
export function recoverStore(dir) {
  const { records, tailIgnored } = readWalRecords(dir);
  const model = new Model();
  let seq = 0;
  for (const rec of records) {
    const interp = new Interpreter(model);
    interp.runSource(rec.script);
    seq = rec.seq;
  }
  const canonical = modelToCanonical(model);
  const repaired = [];

  const st = readState(dir);
  if (!st || st.seq !== seq || JSON.stringify(st.model) !== JSON.stringify(canonical)) {
    writeState(dir, canonical, seq);
    repaired.push('state');
  }

  const expectedSum = stateChecksum(seq, canonical);
  const ck = readCheckpoint(dir);
  if (!ck || ck.seq !== seq || ck.stateChecksum !== expectedSum) {
    writeCheckpoint(dir, seq, expectedSum);
    repaired.push('checkpoint');
  }

  return { seq, repaired, tailIgnored, model };
}

export function loadCommittedModel(dir) {
  const st = readState(dir);
  if (!st) throw new RecoveryError('state is missing or corrupt; run plan recover');
  return { model: modelFromCanonical(st.model), seq: st.seq };
}
