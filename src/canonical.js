import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted lexicographically, no whitespace,
// array order preserved. Deterministic across runs and machines.
export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

// Result hash of a task: derived from predecessor result hashes (sorted by
// predecessor id), the task input hash and the module version, serialized as
// canonical JSON and hashed with SHA-256.
export function computeResultHash(task, depResults) {
  const pairs = depResults
    .map(([id, hash]) => [id, hash])
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  const payload = {
    deps: pairs,
    input: task.input,
    version: task.version,
  };
  return createHash('sha256').update(canonicalize(payload), 'utf8').digest('hex');
}
