import { stableStringify, sha256, canonicalBatches } from './canon.js';

export function computeCertificate(state, prevHash) {
  const body = {
    version: 1,
    seq: state.seq,
    prevHash: prevHash ?? null,
    batches: canonicalBatches(state.batches),
  };
  const hash = sha256(stableStringify(body));
  return { ...body, hash };
}
