// Third-party proof verifier. Pure functions over proof JSON; no store
// access, no keys, no network. The manifest head is the root of trust.
import { computeHead, segmentHash } from './store.js';

export function verifyProof(proof) {
  if (!proof || typeof proof !== 'object') return false;
  if (proof.type === 'inclusion') return verifyInclusion(proof);
  if (proof.type === 'exclusion') {
    return verifyExclusion(proof) && verifyPriorInclusion(proof.priorInclusion);
  }
  return false;
}

export function verifyInclusion(proof) {
  if (segmentHash(proof.segment) !== proof.hash) return false;
  if (computeHead(proof.state) !== proof.state.head) return false;
  return proof.state.segments.some((s) => s.id === proof.id && s.hash === proof.hash);
}

export function verifyExclusion(proof) {
  if (computeHead(proof.state) !== proof.state.head) return false;
  if (proof.state.segments.some((s) => s.id === proof.id)) return false;
  const tomb = proof.state.tombstones.find((t) => t.id === proof.id);
  if (!tomb || tomb.segHash !== proof.tombstone.segHash) return false;
  return true;
}

export function verifyPriorInclusion(prior) {
  if (!prior || !prior.before) return false;
  if (computeHead(prior.before) !== prior.before.head) return false;
  return prior.before.segments.some((s) => s.id === prior.id && s.hash === prior.hash);
}
