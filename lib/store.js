'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ERR_CHUNK_MISSING = 50;
const ERR_SEQ_HOLE = 51;
const ERR_CONFLICT = 52;
const ERR_HASH_MISMATCH = 53;

class StoreError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'StoreError';
    this.code = code;
  }
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function fsyncFile(filePath) {
  const fd = fs.openSync(filePath, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dirPath) {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function serializeState(state) {
  return canonical({ accounts: state.accounts || {} });
}

function snapshotsDir(storeDir) {
  return path.join(storeDir, 'snapshots');
}

function deltaLogPath(storeDir) {
  return path.join(storeDir, 'delta.log');
}

function listSnapshotIds(storeDir) {
  const dir = snapshotsDir(storeDir);
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((d) => /^snap-\d{6}$/.test(d))
    .sort();
}

function nextSnapshotId(storeDir) {
  const ids = listSnapshotIds(storeDir);
  const max = ids.reduce((m, id) => Math.max(m, parseInt(id.slice(5), 10)), 0);
  return 'snap-' + String(max + 1).padStart(6, '0');
}

function readDeltas(storeDir) {
  const file = deltaLogPath(storeDir);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
  const entries = lines.map((l) => JSON.parse(l));
  entries.forEach((entry, i) => {
    const expected = i + 1;
    if (typeof entry.seq !== 'number') {
      throw new StoreError(ERR_CONFLICT, `delta entry ${expected} has no numeric seq`);
    }
    if (entry.seq > expected) {
      throw new StoreError(ERR_SEQ_HOLE, `seq hole: expected ${expected}, found ${entry.seq}`);
    }
    if (entry.seq < expected) {
      throw new StoreError(ERR_CONFLICT, `duplicate seq ${entry.seq} at position ${expected}`);
    }
  });
  return entries;
}

function hashDeltaPrefix(entries, uptoSeq) {
  const lines = entries.filter((e) => e.seq <= uptoSeq).map((e) => canonical(e));
  return sha256(lines.join('\n'));
}

function appendDelta(storeDir, ops, opts = {}) {
  const fsyncOn = opts.fsync !== false;
  fs.mkdirSync(storeDir, { recursive: true });
  const seq = lastDeltaSeq(storeDir) + 1;
  const entry = { seq, ops };
  const file = deltaLogPath(storeDir);
  fs.appendFileSync(file, canonical(entry) + '\n');
  if (fsyncOn) fsyncFile(file);
  return entry;
}

function lastDeltaSeq(storeDir) {
  const file = deltaLogPath(storeDir);
  if (!fs.existsSync(file)) return 0;
  const size = fs.statSync(file).size;
  if (size === 0) return 0;
  const fd = fs.openSync(file, 'r');
  try {
    const tailSize = Math.min(size, 65536);
    const buf = Buffer.alloc(tailSize);
    fs.readSync(fd, buf, 0, tailSize, size - tailSize);
    let lines = buf.toString('utf8').split('\n').filter((l) => l.length > 0);
    if (tailSize < size) lines = lines.slice(1);
    if (lines.length === 0) {
      const all = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.length > 0);
      if (all.length === 0) return 0;
      return JSON.parse(all[all.length - 1]).seq;
    }
    return JSON.parse(lines[lines.length - 1]).seq;
  } finally {
    fs.closeSync(fd);
  }
}

function maybeCrash(crashPoint, point) {
  if (crashPoint === point) {
    process.kill(process.pid, 'SIGKILL');
  }
}

function writeSnapshot(storeDir, state, opts = {}) {
  const chunkSize = opts.chunkSize || 4096;
  const fsyncOn = opts.fsync !== false;
  const crashPoint = opts.crashPoint || process.env.AUDIT_CRASH_POINT || null;
  const id = nextSnapshotId(storeDir);
  const snapDir = path.join(snapshotsDir(storeDir), id);
  const chunksDir = path.join(snapDir, 'chunks');
  fs.mkdirSync(chunksDir, { recursive: true });

  const buf = Buffer.from(serializeState(state), 'utf8');
  const chunks = [];
  for (let offset = 0, index = 0; offset < buf.length; offset += chunkSize, index += 1) {
    const name = 'chunk-' + String(index).padStart(6, '0');
    const rel = path.join('chunks', name);
    const file = path.join(snapDir, rel);
    const slice = buf.subarray(offset, Math.min(offset + chunkSize, buf.length));
    fs.writeFileSync(file, slice);
    if (fsyncOn) fsyncFile(file);
    chunks.push({ file: rel, sha256: sha256(slice) });
  }
  if (fsyncOn) fsyncDir(chunksDir);

  const deltas = readDeltas(storeDir);
  const baseSeq = deltas.length;
  const manifest = {
    version: 1,
    snapshotId: id,
    baseSeq,
    chunkSize,
    chunkCount: chunks.length,
    chunks,
    stateHash: sha256(buf),
    deltaHash: hashDeltaPrefix(deltas, baseSeq),
  };

  const tmpPath = path.join(snapDir, 'manifest.json.tmp');
  fs.writeFileSync(tmpPath, canonical(manifest) + '\n');
  maybeCrash(crashPoint, 'before-manifest-fsync');
  if (fsyncOn) fsyncFile(tmpPath);
  maybeCrash(crashPoint, 'before-commit');
  fs.renameSync(tmpPath, path.join(snapDir, 'manifest.json'));
  if (fsyncOn) fsyncDir(snapDir);
  maybeCrash(crashPoint, 'after-commit');
  return manifest;
}

function verifySnapshot(storeDir, snapshotId) {
  const snapDir = path.join(snapshotsDir(storeDir), snapshotId);
  const manifestPath = path.join(snapDir, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    throw new StoreError(ERR_CONFLICT, `snapshot ${snapshotId} has no committed manifest`);
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const parts = [];
  for (const chunk of manifest.chunks) {
    const file = path.join(snapDir, chunk.file);
    if (!fs.existsSync(file)) {
      throw new StoreError(ERR_CHUNK_MISSING, `chunk missing: ${snapshotId}/${chunk.file}`);
    }
    const data = fs.readFileSync(file);
    const actual = sha256(data);
    if (actual !== chunk.sha256) {
      throw new StoreError(ERR_HASH_MISMATCH, `chunk hash mismatch: ${snapshotId}/${chunk.file}`);
    }
    parts.push(data);
  }
  const buf = Buffer.concat(parts);
  if (sha256(buf) !== manifest.stateHash) {
    throw new StoreError(ERR_HASH_MISMATCH, `state hash mismatch: ${snapshotId}`);
  }
  return { manifest, state: JSON.parse(buf.toString('utf8')) };
}

function findTrustedSnapshot(storeDir) {
  const ids = listSnapshotIds(storeDir);
  for (let i = ids.length - 1; i >= 0; i -= 1) {
    const snapDir = path.join(snapshotsDir(storeDir), ids[i]);
    if (!fs.existsSync(path.join(snapDir, 'manifest.json'))) continue;
    try {
      const { manifest, state } = verifySnapshot(storeDir, ids[i]);
      return { snapshotId: ids[i], manifest, state };
    } catch (err) {
      continue;
    }
  }
  return null;
}

function applyEntry(state, entry, context) {
  const diff = {};
  const note = (account, before) => {
    if (!(account in diff)) diff[account] = before;
  };
  for (const op of entry.ops) {
    if (op.type === 'add') {
      const before = state.accounts[op.account] || 0;
      note(op.account, before);
      state.accounts[op.account] = before + op.amount;
    } else if (op.type === 'correct') {
      const before = state.accounts[op.account] || 0;
      note(op.account, before);
      state.accounts[op.account] = op.balance;
    } else if (op.type === 'undo') {
      const target = context.bySeq.get(op.seq);
      if (!target) {
        throw new StoreError(ERR_CONFLICT, `undo references unknown seq ${op.seq}`);
      }
      const targetDiff = context.history.get(op.seq);
      for (const top of target.ops) {
        if (top.type === 'add') {
          const before = state.accounts[top.account] || 0;
          note(top.account, before);
          state.accounts[top.account] = before - top.amount;
        } else if (top.type === 'correct') {
          if (!targetDiff || !(top.account in targetDiff)) {
            throw new StoreError(
              ERR_CONFLICT,
              `undo of correct in seq ${op.seq} crosses snapshot boundary`
            );
          }
          const before = state.accounts[top.account] || 0;
          note(top.account, before);
          state.accounts[top.account] = targetDiff[top.account];
        } else if (top.type === 'undo') {
          if (!targetDiff) {
            throw new StoreError(
              ERR_CONFLICT,
              `undo of undo in seq ${op.seq} crosses snapshot boundary`
            );
          }
          for (const [account, beforeValue] of Object.entries(targetDiff)) {
            note(account, state.accounts[account] || 0);
            state.accounts[account] = beforeValue;
          }
        }
      }
    } else {
      throw new StoreError(ERR_CONFLICT, `unknown op type: ${op.type}`);
    }
  }
  context.history.set(entry.seq, diff);
}

function restore(storeDir) {
  const trusted = findTrustedSnapshot(storeDir);
  const deltas = readDeltas(storeDir);
  const baseSeq = trusted ? trusted.manifest.baseSeq : 0;
  if (deltas.length < baseSeq) {
    throw new StoreError(
      ERR_SEQ_HOLE,
      `delta log ends at seq ${deltas.length} but snapshot baseSeq is ${baseSeq}`
    );
  }
  if (trusted) {
    const actual = hashDeltaPrefix(deltas, baseSeq);
    if (actual !== trusted.manifest.deltaHash) {
      throw new StoreError(
        ERR_CONFLICT,
        `delta entries <= baseSeq ${baseSeq} differ from snapshot manifest (same seq, different content)`
      );
    }
  }
  const state = trusted
    ? { accounts: Object.assign({}, trusted.state.accounts) }
    : { accounts: {} };
  const bySeq = new Map(deltas.map((e) => [e.seq, e]));
  const context = { bySeq, history: new Map() };
  for (const entry of deltas) {
    if (entry.seq > baseSeq) applyEntry(state, entry, context);
  }
  return {
    state,
    trustedPoint: trusted ? { snapshotId: trusted.snapshotId, baseSeq } : null,
    appliedThrough: deltas.length,
    finalStateHash: sha256(serializeState(state)),
  };
}

function buildProof(storeDir) {
  const snapshots = [];
  let firstError = null;
  for (const id of listSnapshotIds(storeDir)) {
    const snapDir = path.join(snapshotsDir(storeDir), id);
    const manifestPath = path.join(snapDir, 'manifest.json');
    if (!fs.existsSync(manifestPath)) {
      snapshots.push({ snapshotId: id, committed: false });
      continue;
    }
    const manifestRaw = fs.readFileSync(manifestPath, 'utf8');
    const manifest = JSON.parse(manifestRaw);
    const record = {
      snapshotId: id,
      committed: true,
      baseSeq: manifest.baseSeq,
      stateHash: manifest.stateHash,
      deltaHash: manifest.deltaHash,
      manifestHash: sha256(manifestRaw),
    };
    try {
      verifySnapshot(storeDir, id);
      record.status = 'ok';
    } catch (err) {
      record.status = 'invalid';
      record.error = { code: err.code || 1, message: err.message };
      if (!firstError) firstError = record.error;
    }
    snapshots.push(record);
  }
  let delta;
  try {
    const entries = readDeltas(storeDir);
    delta = {
      count: entries.length,
      firstSeq: entries.length ? 1 : 0,
      lastSeq: entries.length,
      contiguous: true,
      deltaHash: hashDeltaPrefix(entries, entries.length),
    };
  } catch (err) {
    delta = { contiguous: false, error: { code: err.code || 1, message: err.message } };
    if (!firstError) firstError = delta.error;
  }
  const trusted = findTrustedSnapshot(storeDir);
  const trustedPoint = trusted
    ? { snapshotId: trusted.snapshotId, baseSeq: trusted.manifest.baseSeq }
    : null;
  let recovered = null;
  try {
    const r = restore(storeDir);
    recovered = { appliedThrough: r.appliedThrough, finalStateHash: r.finalStateHash };
  } catch (err) {
    recovered = { error: { code: err.code || 1, message: err.message } };
    if (!firstError) firstError = recovered.error;
  }
  const proof = { version: 1, snapshots, delta, trustedPoint, recovered };
  proof.proofHash = sha256(canonical(proof));
  return { proof, firstError };
}

module.exports = {
  StoreError,
  ERR_CHUNK_MISSING,
  ERR_SEQ_HOLE,
  ERR_CONFLICT,
  ERR_HASH_MISMATCH,
  canonical,
  sha256,
  serializeState,
  readDeltas,
  appendDelta,
  writeSnapshot,
  verifySnapshot,
  findTrustedSnapshot,
  restore,
  buildProof,
  hashDeltaPrefix,
  listSnapshotIds,
};
