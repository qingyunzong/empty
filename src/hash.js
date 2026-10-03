import { createHash } from 'node:crypto';
import { canonicalize } from './canonical.js';

export const ZERO_HASH = '0'.repeat(64);

export function sha256hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function hashRecord(record) {
  return sha256hex(canonicalize(record));
}
