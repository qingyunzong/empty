import { createHash } from 'node:crypto';
import { encodeCanonical } from './encoder.js';
import type { CanonicalValue } from './types.js';

/**
 * Digest of a value's canonical encoding. Because object keys are sorted by
 * UTF-8 bytes before encoding, the digest does not depend on the insertion
 * order of the source object or Map.
 */
export function digestCanonical(value: CanonicalValue, algorithm = 'sha256'): string {
  return digestBytes(encodeCanonical(value), algorithm);
}

/** Digest of already-encoded canonical bytes. */
export function digestBytes(bytes: Uint8Array, algorithm = 'sha256'): string {
  return createHash(algorithm).update(bytes).digest('hex');
}
