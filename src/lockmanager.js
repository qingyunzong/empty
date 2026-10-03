import { enumerateCycles } from './waitgraph.js';
import { DbError, E_DEADLOCK, E_LOCK_TIMEOUT } from './errors.js';

// Per-account exclusive lock manager with wait-for graph deadlock detection.
// On a detected cycle the transaction with the smallest txid is aborted with
// E_DEADLOCK. Waits longer than timeoutMs fail with E_LOCK_TIMEOUT.
export class LockManager {
  constructor({ timeoutMs = 200 } = {}) {
    this.timeoutMs = timeoutMs;
    this.locks = new Map(); // account -> { holder, queue: [waiter] }
    this.waiting = new Map(); // txid -> waiter
  }

  buildGraph() {
    const graph = new Map();
    for (const [txid, waiter] of this.waiting) {
      if (!graph.has(txid)) graph.set(txid, new Set());
      graph.get(txid).add(waiter.lock.holder);
    }
    return graph;
  }

  async acquire(txid, account) {
    let lock = this.locks.get(account);
    if (!lock) {
      this.locks.set(account, { holder: txid, queue: [] });
      return;
    }
    if (lock.holder === txid) return; // re-entrant within the same transaction
    const waiter = { txid, account, lock, settled: false, timer: null, resolve: null, reject: null };
    const promise = new Promise((resolve, reject) => {
      waiter.resolve = resolve;
      waiter.reject = reject;
    });
    lock.queue.push(waiter);
    this.waiting.set(txid, waiter);
    waiter.timer = setTimeout(() => this._timeout(waiter), this.timeoutMs);
    this._detectDeadlock();
    await promise;
  }

  _detectDeadlock() {
    const cycles = enumerateCycles(this.buildGraph());
    if (cycles.length === 0) return;
    let victim = Infinity;
    for (const cycle of cycles) {
      for (const txid of cycle) victim = Math.min(victim, txid);
    }
    const waiter = this.waiting.get(victim);
    if (waiter) {
      this._settle(waiter, new DbError(E_DEADLOCK, `deadlock cycle detected; transaction ${victim} aborted`));
    }
  }

  _timeout(waiter) {
    if (waiter.settled) return;
    this._settle(waiter, new DbError(E_LOCK_TIMEOUT, `lock wait exceeded ${this.timeoutMs}ms`));
  }

  _settle(waiter, err) {
    waiter.settled = true;
    clearTimeout(waiter.timer);
    this.waiting.delete(waiter.txid);
    const idx = waiter.lock.queue.indexOf(waiter);
    if (idx >= 0) waiter.lock.queue.splice(idx, 1);
    waiter.reject(err);
  }

  releaseAll(txid) {
    for (const [account, lock] of [...this.locks]) {
      if (lock.holder !== txid) continue;
      const next = lock.queue.shift();
      if (next) {
        lock.holder = next.txid;
        next.settled = true;
        clearTimeout(next.timer);
        this.waiting.delete(next.txid);
        next.resolve();
      } else {
        this.locks.delete(account);
      }
    }
  }
}
