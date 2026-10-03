// Crash-safe append-only event log with compaction.
//
// Compact failure points (in order):
//   1. write log.ndjson.tmp
//   2. fsync(tmp)
//   3. rename(tmp -> log.ndjson)   (atomic on POSIX)
// After a crash at ANY point, recover() yields either the old complete log
// or the new complete log -- never a torn one:
//   - crash before rename: log.ndjson (old) is intact; tmp is discarded.
//   - crash after rename:  tmp is gone; log.ndjson is the new complete log.
import fs from 'node:fs';
import path from 'node:path';
import { buildState, serializeNodes } from './chain.js';

export const LOG_FILE = 'log.ndjson';
export const TMP_FILE = 'log.ndjson.tmp';

export class SimulatedCrash extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.point = point;
  }
}

export const CRASH_POINTS = Object.freeze([
  'before-tmp-write', 'after-tmp-write', 'after-fsync', 'after-rename',
]);

const logPath = (dir) => path.join(dir, LOG_FILE);
const tmpPath = (dir) => path.join(dir, TMP_FILE);

// Recover from a crash, then return the authoritative events.
export function recover(dir) {
  const log = logPath(dir);
  const tmp = tmpPath(dir);
  const logExists = fs.existsSync(log);
  const tmpExists = fs.existsSync(tmp);
  if (tmpExists && logExists) {
    // Crash before rename: the old log is authoritative, discard the tmp.
    fs.unlinkSync(tmp);
  } else if (tmpExists && !logExists) {
    // Log missing but tmp present: promote tmp only if it parses completely.
    try {
      const lines = fs.readFileSync(tmp, 'utf8').trim().split('\n').filter(Boolean);
      lines.forEach((l) => JSON.parse(l));
      fs.renameSync(tmp, log);
    } catch {
      fs.unlinkSync(tmp);
    }
  }
  return readEvents(dir);
}

export function readEvents(dir) {
  const log = logPath(dir);
  if (!fs.existsSync(log)) return [];
  return fs.readFileSync(log, 'utf8').trim().split('\n')
    .filter(Boolean).map((l) => JSON.parse(l));
}

export function appendEvent(dir, event) {
  recover(dir);
  const fd = fs.openSync(logPath(dir), 'a');
  try {
    fs.writeSync(fd, JSON.stringify(event) + '\n');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return event;
}

// Compact the log into a single snapshot event. `crashAt` (test hook)
// simulates a crash at one of CRASH_POINTS by throwing SimulatedCrash.
export function compact(dir, { crashAt = null } = {}) {
  const events = recover(dir);
  const state = buildState(events);
  const snapshot = {
    type: 'snapshot',
    compactedEvents: events.length,
    nodes: serializeNodes(state),
  };
  if (crashAt === 'before-tmp-write') throw new SimulatedCrash(crashAt);
  const fd = fs.openSync(tmpPath(dir), 'w');
  try {
    fs.writeSync(fd, JSON.stringify(snapshot) + '\n');
    if (crashAt === 'after-tmp-write') throw new SimulatedCrash(crashAt);
    fs.fsyncSync(fd);
    if (crashAt === 'after-fsync') throw new SimulatedCrash(crashAt);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmpPath(dir), logPath(dir));
  if (crashAt === 'after-rename') throw new SimulatedCrash(crashAt);
  return snapshot;
}
