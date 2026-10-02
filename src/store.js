import fs from 'node:fs';
import path from 'node:path';
import { canonical, hash } from './canon.js';
import { mergeClocks } from './clock.js';

export class RecoveryError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RecoveryError';
  }
}

export function paths(dir) {
  return {
    log: path.join(dir, 'log.jsonl'),
    snapshot: path.join(dir, 'snapshot.json'),
    snapshotTmp: path.join(dir, 'snapshot.json.tmp'),
    manifest: path.join(dir, 'manifest.json'),
    manifestTmp: path.join(dir, 'manifest.json.tmp'),
    seed: path.join(dir, 'seed.json'),
    constraints: path.join(dir, 'constraints.json'),
    identity: path.join(dir, 'identity.json'),
  };
}

export function crash(point) {
  fs.writeSync(2, JSON.stringify({ error: { code: 70, type: 'crash', point } }) + '\n');
  process.exit(70);
}

export function maybeCrash(point) {
  if (process.env.PLAN_SYNC_FAIL_AT === point) crash(point);
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
  } catch { /* best effort */ }
}

export function appendChange(dir, change) {
  const p = paths(dir);
  const line = canonical(change);
  maybeCrash('before-append');
  const fd = fs.openSync(p.log, 'a');
  if (process.env.PLAN_SYNC_FAIL_AT === 'after-append') {
    fs.writeSync(fd, line.slice(0, Math.ceil(line.length / 2)));
    fs.closeSync(fd);
    crash('after-append');
  }
  fs.writeSync(fd, line + '\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function writeLog(dir, changes) {
  const p = paths(dir);
  const fd = fs.openSync(p.log, 'w');
  for (const c of changes) fs.writeSync(fd, canonical(c) + '\n');
  fs.fsyncSync(fd);
  fs.closeSync(fd);
}

export function persist(state) {
  const p = paths(state.dir);
  const snap = {
    baseHash: hash(state.base),
    logHash: hash(state.changes),
    clock: state.clock,
    logLen: state.changes.length,
    changes: state.changes,
  };
  let fd = fs.openSync(p.snapshotTmp, 'w');
  fs.writeSync(fd, canonical(snap));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  maybeCrash('before-rename');
  fs.renameSync(p.snapshotTmp, p.snapshot);
  fsyncDir(state.dir);
  const manifest = { snapshotLogLen: snap.logLen, snapshotHash: hash(snap), clock: state.clock };
  fd = fs.openSync(p.manifestTmp, 'w');
  fs.writeSync(fd, canonical(manifest));
  fs.fsyncSync(fd);
  fs.closeSync(fd);
  fs.renameSync(p.manifestTmp, p.manifest);
  fsyncDir(state.dir);
  maybeCrash('after-manifest');
  return manifest;
}

export function loadIdentity(dir) {
  const f = paths(dir).identity;
  if (!fs.existsSync(f)) return null;
  try { return JSON.parse(fs.readFileSync(f, 'utf8')).node || null; } catch { return null; }
}

export function saveIdentity(dir, node) {
  fs.writeFileSync(paths(dir).identity, canonical({ node }));
}

export function recover(dir) {
  const p = paths(dir);
  const report = {
    discardedTmpSnapshot: false,
    truncated: false,
    replayed: 0,
    committed: null,
    recoveredFrom: null,
  };
  if (fs.existsSync(p.snapshotTmp)) {
    fs.rmSync(p.snapshotTmp);
    report.discardedTmpSnapshot = true;
  }
  if (fs.existsSync(p.manifestTmp)) fs.rmSync(p.manifestTmp);
  let manifest = null;
  if (fs.existsSync(p.manifest)) {
    try { manifest = JSON.parse(fs.readFileSync(p.manifest, 'utf8')); }
    catch { manifest = null; report.manifestInvalid = true; }
  }
  if (manifest) report.committed = { logLen: manifest.snapshotLogLen, clock: manifest.clock };
  let snap = null;
  if (manifest && fs.existsSync(p.snapshot)) {
    try {
      const s = JSON.parse(fs.readFileSync(p.snapshot, 'utf8'));
      if (hash(s) === manifest.snapshotHash) snap = s;
    } catch { snap = null; }
  }
  const base = fs.existsSync(p.seed)
    ? JSON.parse(fs.readFileSync(p.seed, 'utf8'))
    : { jobs: [], ops: [] };
  const constraints = fs.existsSync(p.constraints)
    ? JSON.parse(fs.readFileSync(p.constraints, 'utf8'))
    : {};
  if (snap && snap.baseHash !== hash(base)) snap = null;
  let entries = [];
  if (fs.existsSync(p.log)) {
    const text = fs.readFileSync(p.log, 'utf8');
    const lines = text.split('\n');
    if (lines.length && lines[lines.length - 1] === '') lines.pop();
    const parsed = [];
    for (let i = 0; i < lines.length; i++) {
      try {
        parsed.push(JSON.parse(lines[i]));
      } catch {
        if (i === lines.length - 1) {
          let offset = 0;
          for (let k = 0; k < i; k++) offset += Buffer.byteLength(lines[k]) + 1;
          const fd = fs.openSync(p.log, 'r+');
          fs.ftruncateSync(fd, offset);
          fs.fsyncSync(fd);
          fs.closeSync(fd);
          report.truncated = true;
        } else {
          throw new RecoveryError(`corrupt log line ${i + 1} in ${p.log}`);
        }
      }
    }
    entries = parsed;
  }
  if (snap) {
    const prefix = entries.slice(0, snap.logLen);
    if (snap.logLen > entries.length || hash(prefix) !== snap.logHash) snap = null;
  }
  const changes = snap ? [...snap.changes] : [];
  let clock = snap ? { ...snap.clock } : {};
  const start = snap ? snap.logLen : 0;
  for (let i = start; i < entries.length; i++) {
    changes.push(entries[i]);
    clock = mergeClocks(clock, entries[i].clock || {});
    report.replayed++;
  }
  report.recoveredFrom = snap ? 'snapshot+log' : 'log';
  report.logLen = changes.length;
  report.clock = clock;
  return { state: { dir, base, constraints, changes, clock }, report };
}
