import { createHash } from 'node:crypto';

/** A SHA-256 hex digest of a file's exact bytes. */
export type Digest = string;

export function digestBytes(data: Uint8Array): Digest {
  return createHash('sha256').update(data).digest('hex');
}
