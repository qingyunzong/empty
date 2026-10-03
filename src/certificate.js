import { canonicalize, hashValue } from './canonical.js';

/**
 * Build a deterministic SHA-256 state certificate for a clean merge.
 * No timestamps: identical inputs always yield an identical certificate.
 */
export function buildCertificate({ base, left, right, merged, stats }) {
  const certificate = {
    version: 1,
    algorithm: 'sha256',
    inputs: {
      base: hashValue(base),
      left: hashValue(left),
      right: hashValue(right),
    },
    merged: {
      sha256: hashValue(merged),
      records: stats.records,
    },
    stats: {
      records: stats.records,
      conflicts: stats.conflicts,
    },
  };
  return certificate;
}

/** Serialize any value deterministically (sorted keys, pretty-printed). */
export function serialize(value) {
  return JSON.stringify(JSON.parse(canonicalize(value)), null, 2) + '\n';
}
