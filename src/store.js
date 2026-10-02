import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class PersistError extends Error {
  constructor(message) {
    super(message);
    this.name = 'PersistError';
  }
}

export class CrashError extends Error {
  constructor(point) {
    super(`simulated crash at ${point}`);
    this.name = 'CrashError';
    this.point = point;
  }
}

export const CRASH_POINTS = ['after-tmp-write', 'after-rename', 'after-commit'];

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`;
}

function checksumOf(state) {
  const payload = { version: state.version, fencing: state.fencing, leases: state.leases };
  return crypto.createHash('sha256').update(stableStringify(payload)).digest('hex');
}

export function emptyState() {
  return { version: 1, fencing: {}, leases: {} };
}

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

export function validateState(raw) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new PersistError('lease.json is not valid JSON');
  }
  if (!isPlainObject(parsed)) throw new PersistError('lease.json root must be an object');
  if (parsed.version !== 1) throw new PersistError(`unsupported version: ${parsed.version}`);
  if (!isPlainObject(parsed.fencing)) throw new PersistError('fencing must be an object');
  for (const [task, epoch] of Object.entries(parsed.fencing)) {
    if (!Number.isInteger(epoch) || epoch < 0) {
      throw new PersistError(`fencing epoch for ${task} must be a non-negative integer`);
    }
  }
  if (!isPlainObject(parsed.leases)) throw new PersistError('leases must be an object');
  for (const [task, lease] of Object.entries(parsed.leases)) {
    if (!isPlainObject(lease)) throw new PersistError(`lease for ${task} must be an object`);
    if (typeof lease.owner !== 'string' || lease.owner.length === 0) {
      throw new PersistError(`lease for ${task} has no owner`);
    }
    if (!Number.isInteger(lease.epoch) || lease.epoch < 1) {
      throw new PersistError(`lease epoch for ${task} must be a positive integer`);
    }
    if (typeof lease.leaseStart !== 'number' || typeof lease.leaseExpiry !== 'number'
        || lease.leaseExpiry < lease.leaseStart) {
      throw new PersistError(`lease for ${task} has invalid time bounds`);
    }
    if ((parsed.fencing[task] ?? 0) < lease.epoch) {
      throw new PersistError(`fencing epoch regressed below lease epoch for ${task}`);
    }
  }
  if (typeof parsed.checksum !== 'string' || parsed.checksum !== checksumOf(parsed)) {
    throw new PersistError('checksum mismatch');
  }
  return { version: 1, fencing: parsed.fencing, leases: parsed.leases };
}

export class LeaseStore {
  constructor(dir) {
    this.dir = dir;
    this.file = path.join(dir, 'lease.json');
    this.tmp = path.join(dir, 'lease.tmp');
  }

  load() {
    if (!fs.existsSync(this.file)) return emptyState();
    return validateState(fs.readFileSync(this.file, 'utf8'));
  }

  // Commit protocol: write+fsync lease.tmp, then atomic rename to lease.json,
  // then fsync the directory. The rename is the single atomic commit point.
  commit(state, { crashAt } = {}) {
    fs.mkdirSync(this.dir, { recursive: true });
    const body = JSON.stringify({ ...state, checksum: checksumOf(state) });
    const fd = fs.openSync(this.tmp, 'w');
    try {
      fs.writeSync(fd, body);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (crashAt === 'after-tmp-write') throw new CrashError(crashAt);
    fs.renameSync(this.tmp, this.file);
    if (crashAt === 'after-rename') throw new CrashError(crashAt);
    const dfd = fs.openSync(this.dir, 'r');
    try {
      fs.fsyncSync(dfd);
    } finally {
      fs.closeSync(dfd);
    }
    if (crashAt === 'after-commit') throw new CrashError(crashAt);
  }

  // Recovery rule: the rename is the commit point, so lease.tmp is never a
  // valid lease and is always discarded; lease.json is either fully old or
  // fully new, never torn.
  recover() {
    const tmpExists = fs.existsSync(this.tmp);
    if (tmpExists) fs.unlinkSync(this.tmp);
    if (!fs.existsSync(this.file)) {
      return { action: tmpExists ? 'discarded-tmp' : 'empty', state: emptyState() };
    }
    const state = this.load();
    return { action: tmpExists ? 'discarded-tmp' : 'committed', state };
  }
}
