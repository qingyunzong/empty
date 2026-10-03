// Tamper-evident certificates: sha256 over a canonical (key-sorted) encoding.
import { createHash } from 'node:crypto';
import { certError } from './errors.js';

export function canonical(value) {
  if (Array.isArray(value)) {
    return `[${value.map(canonical).join(',')}]`;
  }
  if (value !== null && typeof value === 'object') {
    const keys = Object.keys(value).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function digest(value) {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

// A certificate binds: the digest of the raw batch input, the exact operation
// sequence applied, and the hash of the resulting interval state. `cause`
// records why a previous certificate was invalidated (correction/revocation).
export function issueCert({ seq, prevId = null, inputDigest, ops, output, cause = null }) {
  const body = {
    version: 1,
    seq,
    prevId,
    inputDigest,
    ops,
    outputHash: digest(output),
    cause,
  };
  return { id: digest(body), body, output };
}

// Recompute the id from the body and the output hash from the stored output.
// Any tampering (e.g. one changed endpoint) breaks one of the two checks.
export function verifyCert(cert) {
  if (!cert || typeof cert !== 'object' || !cert.body || typeof cert.id !== 'string') {
    throw certError('malformed certificate', { cert });
  }
  if (digest(cert.body) !== cert.id) {
    throw certError('certificate id mismatch: body was tampered', { certId: cert.id });
  }
  if (digest(cert.output) !== cert.body.outputHash) {
    throw certError('output hash mismatch: intervals were tampered', { certId: cert.id });
  }
  return true;
}

export function verifyChain(certs) {
  for (let i = 0; i < certs.length; i += 1) {
    verifyCert(certs[i]);
    const expectedPrev = i === 0 ? null : certs[i - 1].id;
    if (certs[i].body.prevId !== expectedPrev) {
      throw certError('certificate chain link broken', {
        seq: certs[i].body.seq,
        expectedPrev,
        actualPrev: certs[i].body.prevId,
      });
    }
  }
  return true;
}
