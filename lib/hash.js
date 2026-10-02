import { createHash } from 'node:crypto';
import { canonical } from './canon.js';

export function sha256hex(data) {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

// Hash of a record = sha256 of its canonical JSON without the "hash" field.
export function recordHash(record) {
  const { hash, ...rest } = record;
  return sha256hex(canonical(rest));
}
