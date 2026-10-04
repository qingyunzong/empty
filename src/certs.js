import { canonical, sha256 } from './util.js';

export const HASH_FIELDS = [
  'seq',
  'recordId',
  'clientRecordId',
  'type',
  'lotId',
  'testCode',
  'value',
  'correctsRecordId',
  'judgment',
  'reportedAt',
  'prevHash',
];

export function computeRecordHash(record) {
  const body = {};
  for (const field of HASH_FIELDS) body[field] = record[field] ?? null;
  return sha256(canonical(body));
}

export function certificateFor(record, hash) {
  const cert = { version: 1 };
  for (const field of HASH_FIELDS) cert[field] = record[field] ?? null;
  cert.hash = hash;
  return cert;
}

// Standalone verification: a certificate is self-contained, no db needed.
export function verifyCertificateData(cert) {
  if (cert === null || typeof cert !== 'object') return { valid: false, reason: 'not an object' };
  if (cert.version !== 1) return { valid: false, reason: 'unsupported version' };
  if (typeof cert.hash !== 'string') return { valid: false, reason: 'missing hash' };
  const recomputed = computeRecordHash(cert);
  if (recomputed !== cert.hash) return { valid: false, reason: 'hash mismatch' };
  return { valid: true };
}
