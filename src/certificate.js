import { createHash } from 'node:crypto';
import { canonicalJson } from './merge.js';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function buildCertificate({ merged, inputs }) {
  const inputDigests = {};
  for (const [name, content] of Object.entries(inputs)) {
    inputDigests[name] = sha256Hex(content);
  }
  return {
    algorithm: 'sha256',
    recordCount: Object.keys(merged).length,
    inputs: inputDigests,
    mergedDigest: sha256Hex(canonicalJson(merged)),
  };
}
