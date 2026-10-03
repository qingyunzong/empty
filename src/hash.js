import { createHash } from 'node:crypto';

export function canon(v) {
  if (v === null || v === undefined) return 'null';
  if (typeof v === 'number') return `n:${Object.is(v, -0) ? 0 : v}`;
  if (typeof v === 'boolean') return `b:${v}`;
  if (typeof v === 'string') return `s:${JSON.stringify(v)}`;
  if (Array.isArray(v)) return `[${v.map(canon).join(',')}]`;
  const keys = Object.keys(v).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canon(v[k])}`).join(',')}}`;
}

export function hashRows(rows) {
  const h = createHash('sha256');
  const sorted = rows.map(canon).sort();
  h.update(String(sorted.length));
  for (const s of sorted) {
    h.update('\n');
    h.update(s);
  }
  return h.digest('hex');
}

// Hash of a full query result, including the three-valued HAVING "unknown" bucket,
// so unknown rows are part of the equivalence proof and can never be silently dropped.
export function hashResult(res) {
  const h = createHash('sha256');
  h.update('rows:');
  h.update(hashRows(res.rows));
  h.update('unknown:');
  h.update(hashRows(res.unknown));
  return h.digest('hex');
}
