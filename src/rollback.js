import { RollbackError } from './errors.js';

// Rollback hierarchy: unlock -> revert params -> clear certs.
// Any out-of-order phase is a ROLLBACK error.
export const ROLLBACK_PHASES = ['unlock', 'revert', 'cert-clear'];

export class RollbackEngine {
  constructor(store, certs) {
    this.store = store;
    this.certs = certs; // CertStore or null
    this.phaseIndex = 0;
    this.done = [];
  }

  expect(phase) {
    const want = ROLLBACK_PHASES[this.phaseIndex];
    if (phase !== want) {
      throw new RollbackError(
        `rollback phase order violated: expected '${want}', got '${phase}'`,
        { expected: want, got: phase, completed: [...this.done] },
      );
    }
  }

  unlock() {
    this.expect('unlock');
    const unlocked = [];
    for (const [key, entry] of this.store.state) {
      if (entry.locked) {
        entry.locked = false;
        unlocked.push(key);
      }
    }
    this.done.push('unlock');
    this.phaseIndex += 1;
    return unlocked;
  }

  revert(snapshot) {
    this.expect('revert');
    const reverted = [];
    for (const [key, prev] of Object.entries(snapshot.params || {})) {
      const entry = this.store.state.get(key);
      if (!entry) continue;
      if (entry.value !== prev.value) {
        entry.value = prev.value;
        reverted.push(key);
      }
      entry.locked = false;
      entry.vv = { ...(prev.vv || entry.vv) };
    }
    this.done.push('revert');
    this.phaseIndex += 1;
    return reverted;
  }

  certClear() {
    this.expect('cert-clear');
    let cleared = 0;
    if (this.certs) cleared = this.certs.clear();
    this.done.push('cert-clear');
    this.phaseIndex += 1;
    return cleared;
  }

  // Convenience: full ordered rollback to a snapshot.
  runAll(snapshot) {
    const unlocked = this.unlock();
    const reverted = this.revert(snapshot);
    const certs = this.certClear();
    return { unlocked, reverted, certsCleared: certs };
  }
}

export class CertStore {
  constructor() { this.certs = new Map(); }
  issue(id, subject) {
    if (this.certs.has(id)) {
      throw new RollbackError(`cert '${id}' already issued`, { id });
    }
    this.certs.set(id, { id, subject, issuedAt: this.certs.size + 1 });
    return this.certs.get(id);
  }
  revoke(id) {
    if (!this.certs.delete(id)) {
      throw new RollbackError(`cert '${id}' not found`, { id });
    }
  }
  clear() {
    const n = this.certs.size;
    this.certs.clear();
    return n;
  }
  list() { return [...this.certs.values()]; }
}
