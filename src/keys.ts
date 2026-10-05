import { CanonicalError } from './errors.js';

/**
 * Validate an object key: it must be well-formed Unicode. Lone (unpaired)
 * surrogates are rejected because they have no canonical UTF-8 encoding.
 */
export function validateKey(key: string, offset = 0): void {
  if (typeof key !== 'string') {
    throw new CanonicalError('object key is not a string', offset);
  }
  if (!key.isWellFormed()) {
    throw new CanonicalError(`object key contains an unpaired surrogate: ${JSON.stringify(key)}`, offset);
  }
}

/** UTF-8 bytes of a key. Keys must be validated first. */
export function keyBytes(key: string): Buffer {
  return Buffer.from(key, 'utf8');
}

/** Compare two keys by their UTF-8 byte sequences (lexicographic). */
export function compareKeysUtf8(a: string, b: string): number {
  const ab = keyBytes(a);
  const bb = keyBytes(b);
  return ab.compare(bb);
}
