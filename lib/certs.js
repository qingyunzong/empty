import { digest } from './canonical.js';

// A certificate's hash covers batch_id, seq, prev_hash and the payload.
// The `revoked` flag lives outside the hashed content so that revoking a
// certificate never invalidates its hash and the chain stays verifiable.
export function buildCert({ batchId, seq, prevHash, payload }) {
  const hash = digest({ batch_id: batchId, seq, prev_hash: prevHash, payload });
  return {
    version: 1,
    batch_id: batchId,
    seq,
    prev_hash: prevHash,
    payload,
    hash,
    revoked: false,
  };
}

export function recomputeCertHash(cert) {
  return digest({
    batch_id: cert.batch_id,
    seq: cert.seq,
    prev_hash: cert.prev_hash,
    payload: cert.payload,
  });
}

export function certFileName(batchId, seq) {
  const safe = String(batchId).replace(/[^A-Za-z0-9._-]/g, '_');
  return `${safe}-${String(seq).padStart(4, '0')}.json`;
}
