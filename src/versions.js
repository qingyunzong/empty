import { createHash } from 'node:crypto';

function deepFreeze(value) {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}

// Canonical JSON: object keys sorted recursively, so the hash is
// independent of key insertion order ("normalized hash").
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function normalizedHash(template, variables) {
  return createHash('sha256')
    .update(JSON.stringify(canonicalize({ template, variables })))
    .digest('hex');
}

function setPath(obj, path, value) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (cur[k] === null || typeof cur[k] !== 'object') cur[k] = {};
    cur = cur[k];
  }
  cur[keys[keys.length - 1]] = value;
}

function unsetPath(obj, path) {
  const keys = path.split('.');
  let cur = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    cur = cur?.[keys[i]];
    if (cur === null || typeof cur !== 'object') return;
  }
  delete cur[keys[keys.length - 1]];
}

// Immutable version store: every patch produces a new frozen snapshot;
// undo/redo only move the cursor, never mutate existing versions.
export class VersionStore {
  constructor(template, variables = {}) {
    this.template = template;
    this.versions = [deepFreeze(structuredClone(variables))];
    this.cursor = 0;
  }

  get version() {
    return this.cursor;
  }

  get variables() {
    return this.versions[this.cursor];
  }

  get hash() {
    return normalizedHash(this.template, this.variables);
  }

  // patch: { set: { 'a.b': value, ... }, unset: ['a.b', ...] }
  applyPatch(patch) {
    const next = structuredClone(this.variables);
    if (patch.set) for (const [path, value] of Object.entries(patch.set)) setPath(next, path, value);
    if (patch.unset) for (const path of patch.unset) unsetPath(next, path);
    this.versions.length = this.cursor + 1; // drop any redo tail
    this.versions.push(deepFreeze(next));
    this.cursor++;
    return this.cursor;
  }

  undo() {
    if (this.cursor > 0) this.cursor--;
    return this.cursor;
  }

  redo() {
    if (this.cursor < this.versions.length - 1) this.cursor++;
    return this.cursor;
  }
}
