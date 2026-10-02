import fs from 'node:fs';
import path from 'node:path';

export const EXIT = Object.freeze({
  OK: 0,
  STATE: 2,
  CROSS_DAY: 21,
  PLAN_INVALID: 22,
  AMBIGUOUS: 23,
  FAULT: 70,
});

export const FAULT_POINTS = Object.freeze(['before-fsync', 'before-rename', 'after-head']);

export class DaybookError extends Error {
  constructor(code, exitCode, message) {
    super(message);
    this.name = 'DaybookError';
    this.code = code;
    this.exitCode = exitCode;
  }
}

export class FaultInjected extends Error {
  constructor(point) {
    super(`fault injected at ${point}`);
    this.name = 'FaultInjected';
    this.point = point;
  }
}

export const stateError = (msg) => new DaybookError('STATE_ERROR', EXIT.STATE, msg);
export const planInvalid = (reason, msg) => {
  const e = new DaybookError('PLAN_INVALID', EXIT.PLAN_INVALID, msg);
  e.reason = reason;
  return e;
};
export const crossDay = (msg) => new DaybookError('REWRITE_CROSS_DAY', EXIT.CROSS_DAY, msg);
export const ambiguous = (msg) => new DaybookError('RECOVERY_AMBIGUOUS', EXIT.AMBIGUOUS, msg);

export function pathsFor(dir) {
  return {
    dir,
    head: path.join(dir, 'HEAD'),
    snapshot: path.join(dir, 'snapshot.json'),
    wal: path.join(dir, 'wal.jsonl'),
    walTmp: path.join(dir, 'wal.jsonl.tmp'),
  };
}

export function emptyState() {
  return { version: 1, seq: 0, openDate: null, lastCommittedDate: null, days: {} };
}

function fsyncFile(file) {
  const fd = fs.openSync(file, 'r+');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function fsyncDir(dir) {
  try {
    const fd = fs.openSync(dir, 'r');
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // best effort on filesystems that do not support directory fsync
  }
}

function writeAtomic(file, data) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, data);
  fsyncFile(tmp);
  fs.renameSync(tmp, file);
  fsyncDir(path.dirname(file));
}

function maybeFault(faultAt, point) {
  if (faultAt === point) throw new FaultInjected(point);
}

function parseState(json, source) {
  let s;
  try {
    s = JSON.parse(json);
  } catch {
    throw ambiguous(`corrupt JSON state in ${source}`);
  }
  if (!s || s.version !== 1 || typeof s.days !== 'object' || s.days === null) {
    throw ambiguous(`invalid state shape in ${source}`);
  }
  return s;
}

// Durable mutation pipeline. Crash points (injectable):
//   before-fsync  : wal.jsonl.tmp written but not yet fsynced
//   before-rename : wal.jsonl.tmp fsynced but not yet renamed over wal.jsonl
//   after-head    : HEAD switched to "wal" but checkpoint back to snapshot not done
export function commitMutation(dir, state, op, faultAt = null) {
  const p = pathsFor(dir);
  fs.mkdirSync(dir, { recursive: true });
  state.seq += 1;
  const header = {
    kind: 'daybook-wal',
    version: 1,
    op,
    seq: state.seq,
    date: state.openDate ?? state.lastCommittedDate ?? null,
  };
  const payload = `${JSON.stringify(header)}\n${JSON.stringify(state)}\n`;
  fs.writeFileSync(p.walTmp, payload);
  maybeFault(faultAt, 'before-fsync');
  fsyncFile(p.walTmp);
  maybeFault(faultAt, 'before-rename');
  fs.renameSync(p.walTmp, p.wal);
  fsyncDir(dir);
  writeAtomic(p.head, 'wal\n');
  maybeFault(faultAt, 'after-head');
  // checkpoint: fold wal into snapshot, then point HEAD back at snapshot
  writeAtomic(p.snapshot, `${JSON.stringify(state, null, 2)}\n`);
  writeAtomic(p.head, 'snapshot\n');
  try {
    fs.unlinkSync(p.wal);
  } catch {}
  fsyncDir(dir);
}

// Determine the authoritative state from HEAD + files.
// repair=true also removes stale artifacts and folds a durable wal into the snapshot.
export function resolve(dir, { repair = false } = {}) {
  const p = pathsFor(dir);
  fs.mkdirSync(dir, { recursive: true });
  const head = fs.existsSync(p.head) ? fs.readFileSync(p.head, 'utf8').trim() : null;
  const haveSnapshot = fs.existsSync(p.snapshot);
  const haveWal = fs.existsSync(p.wal);
  const haveTmp = fs.existsSync(p.walTmp);

  if (head === null) {
    if (!haveSnapshot && !haveWal && !haveTmp) {
      const state = emptyState();
      if (repair) {
        writeAtomic(p.snapshot, `${JSON.stringify(state, null, 2)}\n`);
        writeAtomic(p.head, 'snapshot\n');
      }
      return { state, status: 'EMPTY', basis: [] };
    }
    throw ambiguous('HEAD is missing but state files exist');
  }
  if (head !== 'snapshot' && head !== 'wal') {
    throw ambiguous(`HEAD has unknown value: ${JSON.stringify(head)}`);
  }

  if (head === 'snapshot') {
    if (!haveSnapshot) throw ambiguous('HEAD points to snapshot but snapshot.json is missing');
    const state = parseState(fs.readFileSync(p.snapshot, 'utf8'), 'snapshot.json');
    if (repair) {
      for (const f of [p.walTmp, p.wal]) {
        if (fs.existsSync(f)) fs.unlinkSync(f);
      }
      fsyncDir(dir);
    }
    const status = state.openDate ? 'OPEN_OLD' : state.lastCommittedDate ? 'OLD_COMMITTED' : 'EMPTY';
    return { state, status, basis: ['HEAD', 'snapshot.json'] };
  }

  // head === 'wal': the wal was renamed in and HEAD switched, so wal.jsonl is authoritative.
  if (!haveWal) throw ambiguous('HEAD points to wal but wal.jsonl is missing');
  const lines = fs
    .readFileSync(p.wal, 'utf8')
    .split('\n')
    .filter((l) => l.length > 0);
  if (lines.length < 2) throw ambiguous('wal.jsonl is truncated');
  let header;
  try {
    header = JSON.parse(lines[0]);
  } catch {
    throw ambiguous('wal.jsonl header is corrupt');
  }
  if (!header || header.kind !== 'daybook-wal' || header.version !== 1) {
    throw ambiguous('wal.jsonl header is invalid');
  }
  const state = parseState(lines[1], 'wal.jsonl');
  if (repair) {
    writeAtomic(p.snapshot, `${JSON.stringify(state, null, 2)}\n`);
    writeAtomic(p.head, 'snapshot\n');
    for (const f of [p.wal, p.walTmp]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
    fsyncDir(dir);
  }
  const status = state.openDate ? 'OPEN_NEW' : 'COMMITTED_NEW';
  return { state, status, basis: ['HEAD', 'wal.jsonl'] };
}
