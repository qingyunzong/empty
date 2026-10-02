// Canonical JSON: sorted object keys, no whitespace. Used for hashing so that
// the same logical record always hashes identically regardless of key order.
export function canonical(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonical).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  const parts = keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k]));
  return '{' + parts.join(',') + '}';
}
