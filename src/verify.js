import fs from 'node:fs';
import path from 'node:path';
import { canonicalize } from './canonical.js';
import { ZERO_HASH, hashRecord } from './hash.js';
import { applyOp, genesisState, readWal } from './store.js';

function tamper(seq, reason) {
  return { ok: false, code: 'E_TAMPER', seq, reason };
}

// Recompute every hash from the WAL alone, replay all operations, and
// cross-check each persisted snapshot. Never trusts stored digests.
export function verify(dir) {
  const walFile = path.join(dir, 'wal.log');
  if (!fs.existsSync(walFile)) {
    return { ok: false, code: 'E_NOT_FOUND', reason: `no WAL at ${walFile}` };
  }
  let records;
  try {
    records = readWal(dir);
  } catch (err) {
    return { ok: false, code: 'E_TAMPER', seq: -1, reason: `unreadable WAL: ${err.message}` };
  }
  if (records.length === 0) {
    return tamper(0, 'WAL is empty');
  }

  let state = genesisState();
  let prevDigest = ZERO_HASH;
  let prevVersion = -1;

  for (let i = 0; i < records.length; i += 1) {
    const rec = records[i];
    const seq = rec?.seq;
    if (typeof seq !== 'number' || seq !== i) {
      return tamper(typeof seq === 'number' ? seq : i, `sequence gap: expected seq ${i}`);
    }
    const cert = rec.certificate;
    if (cert === undefined || rec.op === undefined) {
      return tamper(seq, 'record missing op or certificate');
    }
    if (cert.version !== seq || cert.snapshotVersion !== seq) {
      return tamper(seq, 'certificate version fields do not match sequence');
    }
    const expectedParent = seq === 0 ? null : prevVersion;
    if (cert.parentVersion !== expectedParent) {
      return tamper(seq, 'parent version chain broken');
    }
    if (cert.prevCertHash !== prevDigest) {
      return tamper(seq, 'certificate hash chain broken');
    }
    if (hashRecord(rec.op) !== cert.opHash) {
      return tamper(seq, 'operation hash mismatch');
    }
    const { digest, ...unsigned } = cert;
    if (hashRecord(unsigned) !== digest) {
      return tamper(seq, 'certificate digest mismatch');
    }
    try {
      state = applyOp(state, structuredClone(rec.op));
    } catch (err) {
      return tamper(seq, `operation does not replay: ${err.message}`);
    }
    const snapFile = path.join(dir, 'state', 'v' + String(seq).padStart(6, '0') + '.json');
    if (!fs.existsSync(snapFile)) {
      return tamper(seq, 'snapshot file missing');
    }
    let snapshot;
    try {
      snapshot = JSON.parse(fs.readFileSync(snapFile, 'utf8'));
    } catch {
      return tamper(seq, 'snapshot file is not valid JSON');
    }
    if (canonicalize(snapshot) !== canonicalize(state)) {
      return tamper(seq, 'snapshot does not match replayed state');
    }
    prevDigest = digest;
    prevVersion = cert.version;
  }

  const headFile = path.join(dir, 'state', 'head.json');
  if (!fs.existsSync(headFile)) {
    return tamper(prevVersion, 'head.json missing');
  }
  const head = JSON.parse(fs.readFileSync(headFile, 'utf8'));
  if (canonicalize(head) !== canonicalize(state)) {
    return tamper(prevVersion, 'head.json does not match replayed state');
  }

  return { ok: true, versions: prevVersion, head: prevDigest };
}
