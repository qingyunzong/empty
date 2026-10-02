// Deterministic canonical serialization used for all hashing.
// Object keys are sorted lexicographically; no whitespace; arrays keep order.

export function canonicalize(value) {
  if (value === null) return 'null';
  const t = typeof value;
  if (t === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('cannot canonicalize non-finite number');
    }
    return JSON.stringify(value);
  }
  if (t === 'string' || t === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map((item) => canonicalize(item)).join(',') + ']';
  }
  if (t === 'object') {
    const keys = Object.keys(value).sort();
    return (
      '{' +
      keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') +
      '}'
    );
  }
  throw new TypeError(`cannot canonicalize value of type ${t}`);
}
