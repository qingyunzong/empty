import { createHash } from 'node:crypto';

// Deterministic serialization: object keys sorted, arrays kept in order.
export function canonicalize(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalize).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const body = Object.keys(value)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonicalize(value[k])}`)
      .join(',');
    return `{${body}}`;
  }
  return JSON.stringify(value);
}

export function makeCertificate(planResult, version) {
  const canonical = canonicalize({ ...planResult, version });
  return {
    canonical,
    sha256: createHash('sha256').update(canonical, 'utf8').digest('hex'),
  };
}
