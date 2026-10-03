// WAL-backed persistence. The append-only wal.log is the source of truth:
// every commit is one JSON line (full state, monotonically increasing seq).
// A torn trailing line after a crash is ignored on recovery.
// Cross-process mutual exclusion via an atomic mkdir lock with stale-pid
// recovery, so a crashed backfill never wedges the store.

import fs from 'node:fs';
import path from 'node:path';
import { initialState, DomainError } from './engine.js';

export class Store {
  constructor(dir) {
    this.dir = dir;
    this.walFile = path.join(dir, 'wal.log');
    this.lockDir = path.join(dir, 'lock');
    fs.mkdirSync(dir, { recursive: true });
  }

  load() {
    let state = initialState();
    let lines;
    try {
      lines = fs.readFileSync(this.walFile, 'utf8').split('\n');
    } catch (e) {
      if (e.code === 'ENOENT') return state;
      throw e;
    }
    for (const line of lines) {
      if (!line) continue;
      try {
        const rec = JSON.parse(line);
        if (rec && Number.isInteger(rec.seq)) state = rec; // last valid record wins
      } catch {
        break; // torn tail from a crash: ignore the rest
      }
    }
    return state;
  }

  commit(state) {
    state.seq += 1;
    const line = JSON.stringify(state) + '\n';
    const fd = fs.openSync(this.walFile, 'a');
    try {
      fs.writeSync(fd, line);
      fs.fsyncSync(fd); // durable before the lock is released
    } finally {
      fs.closeSync(fd);
    }
    return state;
  }
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

function sleepMs(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

export function acquireLock(store, timeoutMs = 15000) {
  const pidFile = path.join(store.lockDir, 'pid');
  const start = Date.now();
  for (;;) {
    try {
      fs.mkdirSync(store.lockDir);
      fs.writeFileSync(pidFile, String(process.pid));
      break;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
      let stale = false;
      try {
        const pid = Number(fs.readFileSync(pidFile, 'utf8'));
        stale = Number.isInteger(pid) && pid > 0 && !pidAlive(pid);
      } catch {
        stale = false; // pid file not written yet; treat as busy
      }
      if (stale) {
        fs.rmSync(store.lockDir, { recursive: true, force: true });
        continue;
      }
      if (Date.now() - start > timeoutMs) {
        throw new DomainError('E_LOCKED', 'timed out acquiring store lock');
      }
      sleepMs(15);
    }
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fs.rmSync(store.lockDir, { recursive: true, force: true });
  };
}

export function withLock(store, fn) {
  const release = acquireLock(store);
  try {
    return fn();
  } finally {
    release();
  }
}
