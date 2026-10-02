import { readFile, rename, open } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { EventLog } from './eventlog.js';
import { State } from './state.js';
import { sha256hex } from './hash.js';

export async function writeFileAtomic(path, data) {
  const tmp = `${path}.tmp`;
  const fh = await open(tmp, 'w');
  try {
    await fh.writeFile(data);
    await fh.sync();
  } finally {
    await fh.close();
  }
  await rename(tmp, path);
  try {
    const dh = await open(dirname(path), 'r');
    await dh.sync();
    await dh.close();
  } catch {
    // directory fsync is best-effort on some platforms
  }
}

async function readJsonOrNull(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return null;
  }
}

export function rebuildState(events) {
  const state = new State();
  for (const ev of events) state.applyEvent(ev);
  return state;
}

// Recovery is deterministic and idempotent. The event log is the only
// authoritative artifact; index and manifest are checkpoints that are
// regenerated whenever they are missing, stale, or inconsistent.
//
//   1. verify the hash chain, truncate a torn tail (un-fsynced bytes)
//   2. if manifest+index agree with the log head -> verify-only, no writes
//   3. otherwise -> roll forward: rebuild index from the log, rewrite
//      index and manifest so all three artifacts agree again
export async function recover(dir) {
  const logPath = join(dir, 'events.log');
  const indexPath = join(dir, 'index.json');
  const manifestPath = join(dir, 'manifest.json');

  const verified = await EventLog.readVerified(logPath);
  const report = {
    action: 'verify-only',
    torn: false,
    droppedBytes: 0,
    seq: verified.headSeq,
    headHash: verified.headHash,
  };
  if (verified.torn) {
    const log = new EventLog(logPath);
    await log.truncate(verified.validBytes);
    report.torn = true;
    report.droppedBytes = verified.totalBytes - verified.validBytes;
  }

  const manifest = await readJsonOrNull(manifestPath);
  let indexBytes = null;
  try {
    indexBytes = await readFile(indexPath);
  } catch {
    indexBytes = null;
  }

  const consistent =
    manifest &&
    manifest.seq === verified.headSeq &&
    manifest.logHash === verified.headHash &&
    manifest.logBytes === verified.validBytes &&
    indexBytes &&
    sha256hex(indexBytes) === manifest.indexHash;

  if (!consistent) {
    const state = rebuildState(verified.events);
    const newIndex = Buffer.from(JSON.stringify(state.toJSON()));
    await writeFileAtomic(indexPath, newIndex);
    const newManifest = {
      seq: verified.headSeq,
      lamport: state.lamport,
      logBytes: verified.validBytes,
      logHash: verified.headHash,
      indexHash: sha256hex(newIndex),
    };
    await writeFileAtomic(manifestPath, JSON.stringify(newManifest, null, 2));
    report.action = manifest ? 'rolled-forward' : 'rebuilt';
  }
  return report;
}
