import { hashRows, hashResult } from './hash.js';

export const SMALL_INPUT_LIMIT = 300;
export const SAMPLE_SIZE = 32;

// deterministic stride sample of input rows
export function sampleRows(rows, k = SAMPLE_SIZE) {
  if (rows.length <= k) return rows;
  const stride = rows.length / k;
  const out = [];
  for (let i = 0; i < k; i++) out.push(rows[Math.floor(i * stride)]);
  return out;
}

// Equivalence certificate for one optimization run:
//  - rules: the exact rewrite rule sequence (with checkable parameters)
//  - inputs: per-table row counts and deterministic sampled-row hashes
//  - fullCheck: for small inputs (<= 300 rows total) the full result hash of the
//    optimized plan vs. direct enumeration, including the HAVING-unknown bucket
export function buildCertificate({ rules, tables, direct, optimized }) {
  const inputs = Object.entries(tables).map(([name, t]) => ({
    table: name,
    rows: t.rows.length,
    sampledRows: Math.min(SAMPLE_SIZE, t.rows.length),
    sampleHash: hashRows(sampleRows(t.rows)),
  }));
  const totalRows = inputs.reduce((a, b) => a + b.rows, 0);
  let fullCheck = null;
  if (totalRows <= SMALL_INPUT_LIMIT && direct && optimized) {
    const directHash = hashResult(direct);
    const optimizedHash = hashResult(optimized);
    fullCheck = { limit: SMALL_INPUT_LIMIT, directHash, optimizedHash, equal: directHash === optimizedHash };
  }
  return { rules, inputs, totalRows, fullCheck };
}
