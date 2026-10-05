'use strict';

const crypto = require('node:crypto');

const GENESIS_HASH = '0'.repeat(64);

function canonical(value) {
  if (value === undefined) return 'undefined';
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function valuesEqual(a, b) {
  return canonical(a) === canonical(b);
}

class ConflictError extends Error {
  constructor(details) {
    super(
      `guard conflict at seq ${details.seq} patch ${details.patchIndex} ` +
        `key ${JSON.stringify(details.key)}: expected ${canonical(details.expected)}, got ${canonical(details.actual)}`
    );
    this.name = 'ConflictError';
    this.code = 'CONFLICT';
    this.details = details;
  }
}

class SealedError extends Error {
  constructor(seq) {
    super(`commit at seq ${seq} is sealed and cannot be rewritten`);
    this.name = 'SealedError';
    this.code = 'SEALED';
  }
}

class ArgumentError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ArgumentError';
    this.code = 'ARGUMENT';
  }
}

function validatePatch(patch) {
  if (
    !patch ||
    typeof patch !== 'object' ||
    typeof patch.key !== 'string' ||
    !('old' in patch) ||
    !('new' in patch)
  ) {
    throw new ArgumentError('each patch must be an object {key, old, new}');
  }
}

function normalizePatches(payload) {
  if (Array.isArray(payload)) return payload;
  if (payload && Array.isArray(payload.patches)) return payload.patches;
  if (payload && typeof payload === 'object' && typeof payload.key === 'string') return [payload];
  throw new ArgumentError('patch payload must be a patch, an array of patches, or {patches: [...]}');
}

function invertPatches(patches) {
  return patches.map((p) => ({ key: p.key, old: p.new, new: p.old }));
}

// A null 'new' value removes the key: missing keys and null are the same value.
function applyPatches(state, patches) {
  for (const p of patches) {
    if (p.new === null) delete state[p.key];
    else state[p.key] = p.new;
  }
}

function hashCommit(commit) {
  return sha256(
    canonical({ prevHash: commit.prevHash, patches: commit.patches, stateHash: commit.stateHash })
  );
}

class Ledger {
  constructor() {
    this.commits = [];
    this.cursor = 0;
  }

  static get GENESIS_HASH() {
    return GENESIS_HASH;
  }

  get length() {
    return this.commits.length;
  }

  stateAt(count) {
    const state = {};
    const limit = Math.max(0, Math.min(count, this.commits.length));
    for (let i = 0; i < limit; i++) applyPatches(state, this.commits[i].patches);
    return state;
  }

  get state() {
    return this.stateAt(this.cursor);
  }

  #checkGuards(state, patches, seq) {
    if (!Array.isArray(patches)) throw new ArgumentError('patches must be an array');
    for (let i = 0; i < patches.length; i++) {
      const patch = patches[i];
      validatePatch(patch);
      const has = Object.prototype.hasOwnProperty.call(state, patch.key);
      const actual = has ? state[patch.key] : null;
      if (!valuesEqual(actual, patch.old)) {
        throw new ConflictError({ seq, patchIndex: i, key: patch.key, expected: patch.old, actual });
      }
    }
  }

  #buildCommit(seq, prevHash, patches, state) {
    const commit = {
      seq,
      prevHash,
      patches: patches.map((p) => ({ key: p.key, old: p.old, new: p.new })),
      inverse: invertPatches(patches),
      stateHash: sha256(canonical(state)),
      sealed: false,
    };
    commit.hash = hashCommit(commit);
    return commit;
  }

  apply(patches) {
    const seq = this.cursor + 1;
    const state = this.stateAt(this.cursor);
    this.#checkGuards(state, patches, seq);
    applyPatches(state, patches);
    // A new apply truncates any redo branch beyond the cursor.
    this.commits.length = this.cursor;
    const prevHash = this.cursor === 0 ? GENESIS_HASH : this.commits[this.cursor - 1].hash;
    const commit = this.#buildCommit(seq, prevHash, patches, state);
    this.commits.push(commit);
    this.cursor += 1;
    return commit;
  }

  undo() {
    if (this.cursor === 0) return false;
    this.cursor -= 1;
    return true;
  }

  redo() {
    if (this.cursor >= this.commits.length) return false;
    this.cursor += 1;
    return true;
  }

  seal(seq) {
    this.#commitAt(seq).sealed = true;
  }

  #commitAt(seq) {
    if (!Number.isInteger(seq) || seq < 1 || seq > this.commits.length) {
      throw new ArgumentError(`seq ${seq} out of range 1..${this.commits.length}`);
    }
    return this.commits[seq - 1];
  }

  rewrite(seq, newPatches) {
    const target = this.#commitAt(seq);
    if (target.sealed) throw new SealedError(seq);
    const index = seq - 1;

    // Everything below is built on temporary objects; the live ledger is
    // only swapped in after the full replay succeeds.
    const rewritten = this.commits.slice(0, index);
    const state = this.stateAt(index);
    const hashMap = {};

    this.#checkGuards(state, newPatches, seq);
    applyPatches(state, newPatches);
    const prevHash = index === 0 ? GENESIS_HASH : rewritten[index - 1].hash;
    let commit = this.#buildCommit(seq, prevHash, newPatches, state);
    hashMap[target.hash] = commit.hash;
    rewritten.push(commit);

    for (let i = index + 1; i < this.commits.length; i++) {
      const old = this.commits[i];
      this.#checkGuards(state, old.patches, i + 1);
      applyPatches(state, old.patches);
      const next = this.#buildCommit(i + 1, commit.hash, old.patches, state);
      next.sealed = old.sealed;
      hashMap[old.hash] = next.hash;
      rewritten.push(next);
      commit = next;
    }

    this.commits = rewritten;
    return { hashMap };
  }

  toJSON() {
    return { cursor: this.cursor, commits: this.commits };
  }

  static fromJSON(data) {
    if (!data || typeof data !== 'object' || !Array.isArray(data.commits)) {
      throw new ArgumentError('book must be an object with a commits array');
    }
    const ledger = new Ledger();
    ledger.commits = data.commits.map((c, i) => {
      if (!c || !Array.isArray(c.patches) || typeof c.prevHash !== 'string') {
        throw new ArgumentError(`commit ${i + 1} is malformed`);
      }
      return {
        seq: typeof c.seq === 'number' ? c.seq : i + 1,
        prevHash: c.prevHash,
        patches: c.patches,
        inverse: Array.isArray(c.inverse) ? c.inverse : invertPatches(c.patches),
        stateHash: c.stateHash,
        sealed: c.sealed === true,
        hash: c.hash,
      };
    });
    ledger.cursor = Number.isInteger(data.cursor)
      ? Math.max(0, Math.min(data.cursor, ledger.commits.length))
      : ledger.commits.length;
    return ledger;
  }
}

module.exports = {
  Ledger,
  ConflictError,
  SealedError,
  ArgumentError,
  normalizePatches,
  invertPatches,
  canonical,
  GENESIS_HASH,
};
