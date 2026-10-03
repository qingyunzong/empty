import { createHash } from 'node:crypto';

export function sha256Hex(data) {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}

// Recursively sort object keys so hashing/serialization is deterministic.
export function canonicalize(value) {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = canonicalize(value[key]);
    return out;
  }
  return value;
}

export function stableStringify(value, indent = 0) {
  return JSON.stringify(canonicalize(value), null, indent);
}
