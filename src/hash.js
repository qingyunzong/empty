import { createHash } from 'node:crypto';
import { canonical } from './canon.js';

export const GENESIS = '0'.repeat(64);

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Hash of an event record (every field except `hash` itself).
export function hashEvent(record) {
  const { hash, ...rest } = record;
  return sha256hex(canonical(rest));
}

// Domain-separated Merkle leaf / inner-node hashes.
export function leafHash(eventHash) {
  return sha256hex('leaf:' + eventHash);
}

export function nodeHash(left, right) {
  return sha256hex('node:' + left + right);
}
