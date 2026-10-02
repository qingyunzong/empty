// Persistence: WAL (append-only, checksummed records), state.json and
// checkpoint.json (atomically written, checksummed snapshots).
//
// Commit order:  1. append WAL commit record (+fsync)
//                2. write state.json (tmp+rename)
//                3. write checkpoint.json (tmp+rename)
//                4. truncate WAL
// Crash between any two steps is recoverable; see recover().

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class RecoveryError extends Error {
  constructor(msg) {
    super(msg);
    this.name = 'RecoveryError';
  }
}

function stable(x) {
  if (Array.isArray(x)) return '[' + x.map(stable).join(',') + ']';
  if (x !== null && typeof x === 'object') {
    return '{' + Object.keys(x).sort().map((k) => JSON.stringify(k) + ':' + stable(x[k])).join(',') + '}';
  }
  return JSON.stringify(x);
}

function checksum(payload) {
  return crypto.createHash('sha256').update(stable(payload)).digest('hex');
}

function wrap(payload) {
  return { payload, sum: checksum(payload) };
}

function unwrap(text, file) {
  let rec;
  try {
    rec = JSON.parse(text);
  } catch {
    throw new RecoveryError(`${file}: not valid JSON`);
  }
  if (typeof rec !== 'object' || rec === null || typeof rec.sum !== 'string' || !('payload' in rec)) {
    throw new RecoveryError(`${file}: malformed record`);
  }
  if (checksum(rec.payload) !== rec.sum) {
    throw new RecoveryError(`${file}: checksum mismatch`);
  }
  return rec.payload;
}

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.walPath = path.join(dir, 'wal.log');
    this.statePath = path.join(dir, 'state.json');
    this.ckptPath = path.join(dir, 'checkpoint.json');
  }

  static emptyState() {
    return { gen: 0, env: { lines: [], constraints: [] }, jobs: [] };
  }

  init() {
    fs.mkdirSync(this.dir, { recursive: true });
    if (!fs.existsSync(this.walPath)) fs.writeFileSync(this.walPath, '');
    if (!fs.existsSync(this.statePath)) {
      this.writeJsonAtomic(this.statePath, wrap(Store.emptyState()));
    }
  }

  writeJsonAtomic(file, obj) {
    const tmp = file + '.tmp';
    const fd = fs.openSync(tmp, 'w');
    fs.writeSync(fd, JSON.stringify(obj));
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fs.renameSync(tmp, file);
  }

  appendWal(records) {
    const fd = fs.openSync(this.walPath, 'a');
    try {
      for (const r of records) {
        fs.writeSync(fd, JSON.stringify(wrap(r)) + '\n');
      }
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  }

  appendOp(op) {
    this.appendWal([{ type: 'op', op }]);
  }

  // Read the valid prefix of the WAL. A record that fails to parse or whose
  // checksum mismatches ends the valid prefix; the tail is ignored.
  readWal() {
    if (!fs.existsSync(this.walPath)) return [];
    const text = fs.readFileSync(this.walPath, 'utf8');
    const out = [];
    for (const line of text.split('\n')) {
      if (line === '') continue;
      try {
        out.push(unwrap(line, 'wal.log'));
      } catch {
        break; // corrupt tail: ignore
      }
    }
    return out;
  }

  readChecked(file) {
    let text;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (e) {
      if (e.code === 'ENOENT') return null;
      throw e;
    }
    return unwrap(text, path.basename(file));
  }

  // Recover to the last committed state.
  //  - corrupt state.json / checkpoint.json -> RecoveryError (RECOVERY_ERROR)
  //  - uncommitted or corrupt WAL tail -> ignored
  //  - committed WAL records newer than the snapshot -> replayed, state repaired
  // Returns { gen, env, jobs }.
  recover() {
    const state = this.readChecked(this.statePath);
    if (state === null) throw new RecoveryError('state.json: missing (run `plan init` first)');
    let base = state;
    const ckpt = this.readChecked(this.ckptPath);
    if (ckpt !== null && ckpt.gen > base.gen) base = ckpt;
    for (const rec of this.readWal()) {
      if (rec.type === 'commit' && rec.seq > base.gen) {
        base = { gen: rec.seq, env: rec.snapshot.env, jobs: rec.snapshot.jobs };
      }
    }
    if (base !== state) {
      // idempotent repair: rewrite state.json so it matches the last commit
      this.writeJsonAtomic(this.statePath, wrap(base));
    }
    return base;
  }

  // Persist a committed transaction. `snapshot` = { env, jobs }.
  commit(snapshot) {
    const cur = this.recover();
    const gen = cur.gen + 1;
    const full = { gen, env: snapshot.env, jobs: snapshot.jobs };
    // 1. WAL commit record (durable before anything else)
    this.appendWal([{ type: 'commit', seq: gen, snapshot: { env: snapshot.env, jobs: snapshot.jobs } }]);
    // 2. state
    this.writeJsonAtomic(this.statePath, wrap(full));
    // 3. checkpoint
    this.writeJsonAtomic(this.ckptPath, wrap(full));
    // 4. checkpoint is durable: WAL can be truncated
    const fd = fs.openSync(this.walPath, 'w');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    return full;
  }
}
