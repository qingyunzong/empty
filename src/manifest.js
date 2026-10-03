import { canonical, defSig, hashArtifact, hashFile, hashRelease, sha256 } from './hash.js';
import { applyOps, cloneState, DEFAULT_BUILDERS, initialState, ManifestError } from './state.js';
import { certificateOf, findCycleNodes, topoLayers } from './build.js';

function failure(code, message) {
  return { code, message };
}

export class Manifest {
  constructor(options = {}) {
    this.builders = new Set(options.builders ?? DEFAULT_BUILDERS);
    this.state = initialState();
    this.cache = new Map();
    this.fileHashes = new Map();
    this.releaseCache = new Map();
    this.releaseStatus = new Map();
    this.history = [];
    this.lastBuild = null;
  }

  snapshot() {
    return {
      state: cloneState(this.state),
      cache: structuredClone(this.cache),
      fileHashes: structuredClone(this.fileHashes),
      releaseCache: structuredClone(this.releaseCache),
      releaseStatus: structuredClone(this.releaseStatus),
    };
  }

  restore(snap) {
    this.state = cloneState(snap.state);
    this.cache = structuredClone(snap.cache);
    this.fileHashes = structuredClone(snap.fileHashes);
    this.releaseCache = structuredClone(snap.releaseCache);
    this.releaseStatus = structuredClone(snap.releaseStatus);
  }

  commit(ops, txId) {
    if (!Array.isArray(ops) || ops.length === 0) {
      return { ok: false, error: { code: 'E_EMPTY_TRANSACTION', message: 'transaction contains no operations' } };
    }
    const id = txId ?? `tx-${this.history.length + 1}`;
    if (this.history.some((h) => h.txId === id)) {
      return { ok: false, error: { code: 'E_DUP_TX', message: `transaction '${id}' already committed` } };
    }
    const snap = this.snapshot();
    let nextState;
    try {
      nextState = applyOps(cloneState(this.state), ops);
    } catch (err) {
      if (err instanceof ManifestError) return { ok: false, error: { code: err.code, message: err.message } };
      throw err;
    }
    this.state = nextState;
    const build = this.build();
    this.history.push({ txId: id, snap });
    return { ok: true, tx: id, ...build, certificate: this.certificate(id) };
  }

  rollback(txId) {
    const idx = this.history.findIndex((h) => h.txId === txId);
    if (idx === -1) {
      return { ok: false, error: { code: 'E_TX_NOT_FOUND', message: `transaction '${txId}' not found` } };
    }
    const reverted = this.history.slice(idx).map((h) => h.txId);
    this.restore(this.history[idx].snap);
    this.history.length = idx;
    this.lastBuild = null;
    return { ok: true, rolledBack: txId, reverted, certificate: this.certificate(this.history.at(-1)?.txId ?? null) };
  }

  build() {
    const { files, artifacts, releases } = this.state;
    const fileHash = new Map();
    for (const [id, f] of files) fileHash.set(id, hashFile(f.content));

    const reasons = new Map();
    const dirty = new Set();
    for (const [id, a] of artifacts) {
      const sig = defSig(a);
      const cached = this.cache.get(id);
      if (!cached) {
        dirty.add(id);
        reasons.set(id, 'added');
      } else if (cached.defSig !== sig) {
        dirty.add(id);
        reasons.set(id, 'definition-changed');
      }
    }
    const removed = [];
    for (const id of this.cache.keys()) {
      if (!artifacts.has(id)) {
        removed.push(id);
        this.cache.delete(id);
      }
    }

    const changedInputs = new Set(removed);
    for (const [id, h] of fileHash) {
      if (this.fileHashes.get(id) !== h) changedInputs.add(id);
    }
    for (const id of this.fileHashes.keys()) {
      if (!fileHash.has(id)) changedInputs.add(id);
    }

    const dependents = new Map();
    for (const [id, a] of artifacts) {
      for (const inp of a.inputs) {
        if (!dependents.has(inp)) dependents.set(inp, []);
        dependents.get(inp).push(id);
      }
    }
    const queue = [...changedInputs, ...dirty];
    const queued = new Set(queue);
    while (queue.length) {
      const node = queue.pop();
      for (const dep of dependents.get(node) ?? []) {
        if (!dirty.has(dep)) {
          dirty.add(dep);
          reasons.set(dep, `input-changed:${node}`);
        }
        if (!queued.has(dep)) {
          queued.add(dep);
          queue.push(dep);
        }
      }
    }

    const cycleNodes = findCycleNodes(artifacts);
    const errors = [];
    const failed = new Map();
    const changed = [];
    if (cycleNodes.size) {
      errors.push({ code: 'E_CYCLE', message: `dependency cycle among: ${[...cycleNodes].sort().join(', ')}`, nodes: [...cycleNodes].sort() });
    }
    for (const id of cycleNodes) {
      const err = failure('E_CYCLE', 'artifact is part of a dependency cycle');
      failed.set(id, err);
      const before = this.cache.get(id);
      if (!before || (before.error?.code ?? null) !== 'E_CYCLE') changed.push(id);
      this.cache.set(id, { defSig: defSig(artifacts.get(id)), error: err });
    }

    const buildable = [...dirty].filter((id) => !cycleNodes.has(id));
    const order = topoLayers(artifacts, buildable);
    if (order.length !== buildable.length) {
      const leftover = buildable.filter((id) => !order.includes(id));
      errors.push({ code: 'E_CYCLE', message: 'unresolved cyclic dependencies remain', nodes: leftover.sort() });
      for (const id of leftover) {
        const err = failure('E_CYCLE', 'artifact is part of a dependency cycle');
        failed.set(id, err);
        const before = this.cache.get(id);
        if (!before || (before.error?.code ?? null) !== 'E_CYCLE') changed.push(id);
        this.cache.set(id, { defSig: defSig(artifacts.get(id)), error: err });
      }
    }

    const artifactError = (id) => {
      if (failed.has(id)) return failed.get(id);
      return this.cache.get(id)?.error ?? null;
    };
    const artifactHash = (id) => this.cache.get(id)?.hash ?? null;

    const recomputed = [];
    for (const id of order) {
      const artifact = artifacts.get(id);
      const before = this.cache.get(id);
      let result;
      if (!this.builders.has(artifact.builder)) {
        result = { error: failure('E_BUILDER', `unknown builder '${artifact.builder}'`) };
      } else {
        const inputs = [];
        let inputError = null;
        for (const inp of [...artifact.inputs].sort()) {
          if (fileHash.has(inp)) {
            inputs.push({ id: inp, hash: fileHash.get(inp) });
          } else if (artifacts.has(inp)) {
            const err = artifactError(inp);
            if (err) {
              inputError = failure('E_INPUT_FAILED', `input '${inp}' failed (${err.code})`);
              break;
            }
            inputs.push({ id: inp, hash: artifactHash(inp) });
          } else {
            inputError = failure('E_INPUT', `input '${inp}' does not exist`);
            break;
          }
        }
        result = inputError ? { error: inputError } : { hash: hashArtifact(artifact.builder, inputs) };
      }
      recomputed.push(id);
      const outcomeChanged = !before || (before.hash ?? null) !== (result.hash ?? null) || (before.error?.code ?? null) !== (result.error?.code ?? null);
      if (outcomeChanged) changed.push(id);
      if (result.error) {
        failed.set(id, result.error);
        errors.push({ code: result.error.code, message: `artifact '${id}': ${result.error.message}`, nodes: [id] });
        this.cache.set(id, { defSig: defSig(artifact), error: result.error });
      } else {
        this.cache.set(id, { defSig: defSig(artifact), hash: result.hash });
      }
    }

    const releasesChanged = [];
    const releaseOut = {};
    const blocked = {};
    for (const [id, rel] of releases) {
      const inputs = [];
      const blockedBy = [];
      for (const inp of [...rel.inputs].sort()) {
        if (fileHash.has(inp)) {
          inputs.push({ id: inp, hash: fileHash.get(inp) });
        } else if (artifacts.has(inp)) {
          const err = artifactError(inp);
          if (err) blockedBy.push(inp);
          else inputs.push({ id: inp, hash: artifactHash(inp) });
        } else {
          blockedBy.push(inp);
        }
      }
      const status = blockedBy.length
        ? { status: 'blocked', blockedBy: blockedBy.sort() }
        : { status: 'ok', hash: hashRelease(inputs) };
      const sig = canonical(status);
      if (this.releaseCache.get(id) !== sig) {
        releasesChanged.push(id);
        this.releaseCache.set(id, sig);
      }
      this.releaseStatus.set(id, status);
      releaseOut[id] = status;
      if (status.status === 'blocked') blocked[id] = status.blockedBy;
    }
    for (const id of [...this.releaseCache.keys()]) {
      if (!releases.has(id)) {
        this.releaseCache.delete(id);
        this.releaseStatus.delete(id);
      }
    }

    this.fileHashes = fileHash;

    const diff = {
      recomputed,
      changed: changed.sort(),
      added: [...dirty].filter((id) => reasons.get(id) === 'added').sort(),
      removed: removed.sort(),
      failed: Object.fromEntries([...this.cache.entries()].filter(([, c]) => c.error).map(([id, c]) => [id, c.error.code]).sort()),
      reasons: Object.fromEntries([...reasons.entries()].sort()),
      releasesChanged: releasesChanged.sort(),
      releases: releaseOut,
    };
    this.lastBuild = { diff, errors, blocked };
    return { diff, errors, blocked };
  }

  certificate(tx) {
    const build = {
      fileHash: this.fileHashes,
      artifacts: new Map([...this.cache.entries()].map(([id, c]) => [id, c.hash ? { hash: c.hash } : { error: c.error }])),
      releases: new Map([...this.releaseStatus.entries()]),
    };
    return certificateOf(this.state, build, tx ?? this.history.at(-1)?.txId ?? null);
  }

  currentHashes() {
    const out = {};
    for (const [id, h] of this.fileHashes) out[id] = h;
    for (const [id, c] of this.cache) if (c.hash) out[id] = c.hash;
    for (const [id, s] of this.releaseStatus) if (s.status === 'ok') out[id] = s.hash;
    return out;
  }

  currentFailed() {
    const out = {};
    for (const [id, c] of this.cache) if (c.error) out[id] = c.error.code;
    return out;
  }

  currentBlocked() {
    const out = {};
    for (const [id, s] of this.releaseStatus) if (s.status === 'blocked') out[id] = s.blockedBy;
    return out;
  }

  hash(id) {
    if (this.fileHashes.has(id)) return { ok: true, id, hash: this.fileHashes.get(id) };
    const c = this.cache.get(id);
    if (c) {
      return c.hash
        ? { ok: true, id, hash: c.hash }
        : { ok: false, error: { code: c.error.code, message: `artifact '${id}' has no hash: ${c.error.message}` } };
    }
    const rel = this.releaseStatus.get(id);
    if (rel) {
      return rel.status === 'ok'
        ? { ok: true, id, hash: rel.hash }
        : { ok: false, error: { code: 'E_BLOCKED', message: `release '${id}' is blocked by: ${rel.blockedBy.join(', ')}` } };
    }
    return { ok: false, error: { code: 'E_NODE', message: `node '${id}' does not exist` } };
  }

  getState() {
    return {
      files: Object.fromEntries([...this.state.files.entries()].map(([id, f]) => [id, { content: f.content, hash: this.fileHashes.get(id) ?? hashFile(f.content) }])),
      artifacts: Object.fromEntries([...this.state.artifacts.entries()].map(([id, a]) => [id, { ...a, ...(this.cache.get(id)?.hash ? { hash: this.cache.get(id).hash } : {}), ...(this.cache.get(id)?.error ? { error: this.cache.get(id).error.code } : {}) }])),
      releases: Object.fromEntries([...this.state.releases.entries()].map(([id, r]) => [id, { ...r, ...(this.releaseStatus.get(id) ?? {}) }])),
      history: this.history.map((h) => h.txId),
    };
  }
}
