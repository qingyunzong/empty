import fs from 'node:fs';
import path from 'node:path';
import { canon, sha256, fsyncDir, fsyncFile } from './util.js';
import { logHash, readLog, truncateLog } from './log.js';
import { recovery, validation } from './errors.js';
import { mergeClocks } from './clock.js';
import { applyToDyn } from './fold.js';
import { validatePlan, initialDyn } from './model.js';

export const FILES = {
  log: 'log.jsonl',
  snapshot: 'snapshot.json',
  snapshotTmp: 'snapshot.tmp.json',
  manifest: 'manifest.json',
  manifestTmp: 'manifest.tmp.json',
};

export function stateHashOf(dyn) {
  return sha256(canon({ addedOps: dyn.addedOps, cancelled: [...dyn.cancelled].sort(), order: dyn.order }));
}

export function faultPoint() {
  return process.env.PLAN_SYNC_FAULT || null;
}

export function injectCrash(point) {
  process.stderr.write(JSON.stringify({ error: { code: 'FAULT_INJECTED', message: `injected crash at ${point}`, point } }) + '\n');
  process.exit(86);
}

export function commitStore(dir, snapshot) {
  const p = (f) => path.join(dir, f);
  const bytes = Buffer.from(JSON.stringify(snapshot, null, 2) + '\n');
  const fault = faultPoint();
  if (fault === 'before-rename') {
    const half = bytes.subarray(0, Math.max(1, Math.floor(bytes.length / 2)));
    fs.writeFileSync(p(FILES.snapshotTmp), half);
    fsyncFile(p(FILES.snapshotTmp));
    fsyncDir(dir);
    injectCrash('before-rename');
  }
  fs.writeFileSync(p(FILES.snapshotTmp), bytes);
  fsyncFile(p(FILES.snapshotTmp));
  fs.renameSync(p(FILES.snapshotTmp), p(FILES.snapshot));
  fsyncDir(dir);
  const manifest = {
    format: 1,
    node: snapshot.node,
    clock: snapshot.clock,
    logLen: snapshot.logLen,
    logHash: snapshot.logHash,
    stateHash: snapshot.stateHash,
    snapshotFile: FILES.snapshot,
    snapshotHash: sha256(bytes),
    status: 'committed',
  };
  const mbytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n');
  fs.writeFileSync(p(FILES.manifestTmp), mbytes);
  fsyncFile(p(FILES.manifestTmp));
  fs.renameSync(p(FILES.manifestTmp), p(FILES.manifest));
  fsyncDir(dir);
  if (fault === 'after-manifest') injectCrash('after-manifest');
  return manifest;
}

export function initStore(dir, plan, node) {
  fs.mkdirSync(dir, { recursive: true });
  validatePlan(plan);
  const dyn = initialDyn(plan);
  fs.writeFileSync(path.join(dir, FILES.log), '');
  fsyncFile(path.join(dir, FILES.log));
  const snapshot = {
    format: 1, node, plan, dyn, pending: [], clock: {},
    logLen: 0, logHash: logHash([]), stateHash: stateHashOf(dyn),
  };
  return commitStore(dir, snapshot);
}

export function recover(dir) {
  const p = (f) => path.join(dir, f);
  const report = { discardedTmpSnapshot: false, truncatedTail: false, replayed: 0 };
  if (!fs.existsSync(p(FILES.manifest))) throw recovery('manifest missing: not a committed plan-sync store', { dir });
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(p(FILES.manifest), 'utf8'));
  } catch {
    throw recovery('manifest unreadable', { dir });
  }
  if (fs.existsSync(p(FILES.snapshotTmp))) {
    fs.rmSync(p(FILES.snapshotTmp));
    fsyncDir(dir);
    report.discardedTmpSnapshot = true;
  }
  if (fs.existsSync(p(FILES.manifestTmp))) fs.rmSync(p(FILES.manifestTmp));
  if (!fs.existsSync(p(FILES.snapshot))) throw recovery('snapshot missing', { dir });
  const snapBytes = fs.readFileSync(p(FILES.snapshot));
  if (sha256(snapBytes) !== manifest.snapshotHash) throw recovery('snapshot hash mismatch with manifest', { dir });
  let snapshot;
  try {
    snapshot = JSON.parse(snapBytes.toString('utf8'));
  } catch {
    throw recovery('snapshot unreadable', { dir });
  }
  if (snapshot.logLen !== manifest.logLen || snapshot.logHash !== manifest.logHash)
    throw recovery('snapshot/manifest log pointers disagree', { dir });
  const logRes = readLog(p(FILES.log));
  if (logRes.truncated) {
    truncateLog(p(FILES.log), logRes.validBytes);
    report.truncatedTail = true;
  }
  const entries = logRes.entries;
  if (entries.length < manifest.logLen)
    throw recovery('log shorter than committed manifest', { have: entries.length, want: manifest.logLen });
  if (logHash(entries.slice(0, manifest.logLen)) !== manifest.logHash)
    throw recovery('committed log prefix hash mismatch', { dir });
  const dyn = structuredClone(snapshot.dyn);
  const tail = entries.slice(manifest.logLen);
  for (const e of tail) applyToDyn(dyn, e);
  report.replayed = tail.length;
  const clock = tail.reduce((c, e) => mergeClocks(c, e.clock ?? {}), snapshot.clock ?? {});
  return {
    dir,
    plan: snapshot.plan,
    node: snapshot.node,
    dyn,
    pending: snapshot.pending ?? [],
    clock,
    entries,
    manifest,
    report,
  };
}
