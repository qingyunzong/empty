'use strict';

const { QuotaError, E_DEADLOCK, E_LOCK_TIMEOUT } = require('./errors');

// Per-account exclusive lock manager with a waits-for graph.
// Deadlock cycles are detected by enumerating elementary cycles in the
// (small) waits-for digraph; the transaction with the smallest id in the
// cycle is chosen as the victim and aborted with E_DEADLOCK.
class LockManager {
  constructor({ lockTimeoutMs = 200, now = () => Date.now(), onVictim = null } = {}) {
    this.lockTimeoutMs = lockTimeoutMs;
    this.now = now;
    // Called with the victim txn id when a deadlock cycle is found and the
    // current requester is not the victim; the owner of this callback must
    // abort the victim (releasing its locks and rejecting its waiters).
    this.onVictim = onVictim;
    this.owners = new Map(); // account -> txnId
    this.waiters = new Map(); // account -> [waiter]
    this.waitingOn = new Map(); // txnId -> account currently awaited
  }

  clear() {
    this.owners.clear();
    this.waiters.clear();
    this.waitingOn.clear();
  }

  ownerOf(account) {
    return this.owners.get(account);
  }

  owns(txnId, account) {
    return this.owners.get(account) === txnId;
  }

  // Synchronous acquisition used by tests to seed lock state.
  acquireSync(txnId, account) {
    if (this.owns(txnId, account)) return;
    const owner = this.owners.get(account);
    if (owner === undefined) {
      this.owners.set(account, txnId);
      return;
    }
    throw new QuotaError(E_LOCK_TIMEOUT, `account ${account} is locked by txn ${owner}`);
  }

  async acquire(txnId, account, { timeoutMs } = {}) {
    const limit = timeoutMs === undefined ? this.lockTimeoutMs : timeoutMs;
    for (;;) {
      if (this.owns(txnId, account)) return;
      const owner = this.owners.get(account);
      if (owner === undefined) {
        this.owners.set(account, txnId);
        return;
      }
      const victim = this._deadlockVictimIfWaits(txnId, account);
      if (victim !== null) {
        if (victim === txnId) {
          throw new QuotaError(
            E_DEADLOCK,
            `deadlock cycle detected; txn ${victim} chosen as victim`
          );
        }
        // Abort the smallest-id txn in the cycle, then retry: its suicide
        // releases locks and breaks the cycle.
        if (this.onVictim) this.onVictim(victim);
        else this._abortWaitersOf(victim);
        continue;
      }
      return this._wait(txnId, account, limit);
    }
  }

  _wait(txnId, account, timeoutMs) {
    return new Promise((resolve, reject) => {
      const waiter = {
        txnId,
        account,
        resolve: () => {
          cleanup();
          resolve();
        },
        reject: (err) => {
          cleanup();
          reject(err);
        },
        timer: null,
      };
      const cleanup = () => {
        if (waiter.timer) clearTimeout(waiter.timer);
        this._removeWaiter(waiter);
      };
      waiter.timer = setTimeout(() => {
        cleanup();
        reject(
          new QuotaError(
            E_LOCK_TIMEOUT,
            `timed out after ${timeoutMs}ms waiting for account ${account}`
          )
        );
      }, timeoutMs);
      let queue = this.waiters.get(account);
      if (!queue) {
        queue = [];
        this.waiters.set(account, queue);
      }
      queue.push(waiter);
      this.waitingOn.set(txnId, account);
    });
  }

  _removeWaiter(waiter) {
    const queue = this.waiters.get(waiter.account);
    if (queue) {
      const idx = queue.indexOf(waiter);
      if (idx !== -1) queue.splice(idx, 1);
      if (queue.length === 0) this.waiters.delete(waiter.account);
    }
    if (this.waitingOn.get(waiter.txnId) === waiter.account) {
      this.waitingOn.delete(waiter.txnId);
    }
  }

  release(txnId, account) {
    if (!this.owns(txnId, account)) return;
    this.owners.delete(account);
    this._grantNext(account);
  }

  releaseAll(txnId, abortCode = E_DEADLOCK) {
    for (const [account, owner] of [...this.owners]) {
      if (owner === txnId) {
        this.owners.delete(account);
        this._grantNext(account);
      }
    }
    this._abortWaitersOf(txnId, abortCode);
  }

  _grantNext(account) {
    const queue = this.waiters.get(account);
    if (!queue || queue.length === 0) return;
    const next = queue[0];
    this.owners.set(account, next.txnId);
    next.resolve();
  }

  _abortWaitersOf(txnId, code = E_DEADLOCK) {
    for (const queue of this.waiters.values()) {
      for (const waiter of [...queue]) {
        if (waiter.txnId === txnId) {
          waiter.reject(
            new QuotaError(code, `txn ${txnId} aborted while waiting`)
          );
        }
      }
    }
  }

  // Directed waits-for graph: edge waitingTxn -> holderTxn.
  buildWaitsForGraph(extraEdges = []) {
    const graph = new Map();
    const addEdge = (from, to) => {
      if (from === to) return;
      if (!graph.has(from)) graph.set(from, new Set());
      graph.get(from).add(to);
    };
    for (const [account, queue] of this.waiters) {
      const owner = this.owners.get(account);
      if (owner === undefined) continue;
      for (const waiter of queue) addEdge(waiter.txnId, owner);
    }
    for (const [from, to] of extraEdges) addEdge(from, to);
    return graph;
  }

  // Enumerate all elementary cycles of the (small) waits-for digraph via DFS.
  static enumerateCycles(graph) {
    const cycles = [];
    const nodes = [...graph.keys()];
    const indexOf = new Map(nodes.map((node, idx) => [node, idx]));
    const canonical = new Set();
    for (const start of nodes) {
      const path = [start];
      const onPath = new Set([start]);
      const dfs = (current) => {
        const neighbors = graph.get(current);
        if (!neighbors) return;
        for (const next of neighbors) {
          if (next === start) {
            const key = canonicalKey(path);
            if (!canonical.has(key)) {
              canonical.add(key);
              cycles.push([...path]);
            }
          } else if (!onPath.has(next) && indexOf.has(next)) {
            // Only visit nodes ordered after start so each elementary cycle
            // is found exactly once (from its smallest-index member).
            if (indexOf.get(next) > indexOf.get(start)) {
              path.push(next);
              onPath.add(next);
              dfs(next);
              path.pop();
              onPath.delete(next);
            }
          }
        }
      };
      dfs(start);
    }
    return cycles;
  }

  // Returns the victim txn id (smallest id in the detected cycle) if letting
  // txnId wait on `account` would close a cycle, otherwise null.
  _deadlockVictimIfWaits(txnId, account) {
    const owner = this.owners.get(account);
    if (owner === undefined || owner === txnId) return null;
    const graph = this.buildWaitsForGraph([[txnId, owner]]);
    const cycles = LockManager.enumerateCycles(graph);
    if (cycles.length === 0) return null;
    let victim = null;
    for (const cycle of cycles) {
      for (const id of cycle) {
        if (victim === null || compareTxnIds(id, victim) < 0) victim = id;
      }
    }
    return victim;
  }
}

// Compare txn ids numerically when possible (so T2 < T10), else as strings.
function compareTxnIds(a, b) {
  const na = typeof a === 'number' ? a : Number(String(a).replace(/^[A-Za-z]+/, ''));
  const nb = typeof b === 'number' ? b : Number(String(b).replace(/^[A-Za-z]+/, ''));
  if (Number.isFinite(na) && Number.isFinite(nb)) return na - nb;
  return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0;
}

function canonicalKey(cycle) {
  // Rotation-invariant key so each elementary cycle is reported once.
  const ids = cycle.map(String);
  let best = null;
  for (let i = 0; i < ids.length; i++) {
    const rotated = ids.slice(i).concat(ids.slice(0, i)).join(',');
    if (best === null || rotated < best) best = rotated;
  }
  return best;
}

module.exports = { LockManager };
