// Canonical JSON serialization: object keys sorted recursively, arrays kept in
// order, no whitespace. Two structurally equal values always serialize to the
// same string, which makes it safe as hash input.
export function canonicalJSON(value) {
  if (value === null) return 'null';
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalJSON).join(',') + ']';
  }
  if (type === 'object') {
    const keys = Object.keys(value).sort();
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJSON(value[k])).join(',') + '}';
  }
  throw new TypeError(`cannot canonicalize value of type ${type}`);
}
