import { applyOps, cloneState, DEFAULT_BUILDERS, initialState, ManifestError } from './state.js';
import { blockedOf, certificateOf, failedOf, fullBuild, hashesOf } from './build.js';

export class Reference {
  constructor(options = {}) {
    this.builders = new Set(options.builders ?? DEFAULT_BUILDERS);
    this.state = initialState();
    this.history = [];
    this.prev = null;
  }

  commit(ops, txId) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, error: { code: 'E_EMPTY_TRANSACTION', message: 'transaction contains no operations' } };
    }
    const id = txId ?? `tx-${this.history.length + 1}`;
    if (this.history.some((h) => h.txId === id)) {
      return { ok: false, error: { code: 'E_DUP_TX', message: `transaction '${id}' already committed` } };
    }
    let nextState;
    try {
      nextState = applyOps(cloneState(this.state), ops);
    } catch (err) {
      if (err instanceof ManifestError) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
    this.state = nextState;
    const build = fullBuild(this.state, this.builders);
    const diff = this.diffAgainst(this.prev, build);
    this.prev = build;
    this.history.push({ txId: id, state: cloneState(this.state), prev: build });
    return { ok: true, tx: id, diff, errors: build.errors, blocked: blockedOf(build), certificate: certificateOf(this.state, build, id) };
  }

  diffAgainst(prev, curr) {
    const changed = [];
    const removed = [];
    const added = [];
    const releasesChanged = [];
    if (prev) {
      for (const [id, r] of curr.artifacts) {
        const old = prev.artifacts.get(id);
        if (!old) {
          added.push(id);
          changed.push(id);
        } else if ((old.hash ?? null) !== (r.hash ?? null) || (old.error?.code ?? null) !== (r.error?.code ?? null)) {
          changed.push(id);
        }
      }
      for (const id of prev.artifacts.keys()) {
        if (!curr.artifacts.has(id)) removed.push(id);
      }
      for (const [id, r] of curr.releases) {
        const old = prev.releases.get(id);
        if (!old || JSON.stringify(old) !== JSON.stringify(r)) releasesChanged.push(id);
      }
    } else {
      for (const id of curr.artifacts.keys()) {
        added.push(id);
        changed.push(id);
      }
      for (const id of curr.releases.keys()) releasesChanged.push(id);
    }
    return {
      changed: changed.sort(),
      added: added.sort(),
      removed: removed.sort(),
      releasesChanged: releasesChanged.sort(),
    };
  }

  rollback(txId) {
    const idx = this.history.findIndex((h) => h.txId === txId);
    if (idx === -1) {
      return { ok: false, error: { code: 'E_TX_NOT_FOUND', message: `transaction '${txId}' not found` } };
    }
    const reverted = this.history.slice(idx).map((h) => h.txId);
    this.history.length = idx;
    const last = this.history.at(-1);
    this.state = last ? cloneState(last.state) : initialState();
    this.prev = last ? last.prev : null;
    return { ok: true, rolledBack: txId, reverted, certificate: certificateOf(this.state, this.prev ?? fullBuild(this.state, this.builders), last?.txId ?? null) };
  }

  currentHashes() {
    return this.prev ? hashesOf(this.prev) : {};
  }

  currentFailed() {
    return this.prev ? failedOf(this.prev) : {};
  }

  currentBlocked() {
    return this.prev ? blockedOf(this.prev) : {};
  }
}

Reference.prototype.certificate = function certificate() {
  const build = this.prev ?? fullBuild(this.state, this.builders);
  return certificateOf(this.state, build, this.history.at(-1)?.txId ?? null);
};
