import { createHash } from 'node:crypto';

export function sha256(data: string): string {
  return createHash('sha256').update(data).digest('hex');
}

export const EMPTY_HASH = sha256('empty');

export function hashValue(value: string): string {
  return sha256(`value:${value}`);
}

export function hashLeaf(key: string, valueHash: string): string {
  return sha256(`leaf:${key}:${valueHash}`);
}

export function hashInternal(leftHash: string, rightHash: string): string {
  return sha256(`node:${leftHash}:${rightHash}`);
}

const MAX_DEPTH = 256;

export function maxDepth(): number {
  return MAX_DEPTH;
}

/** Bit of sha256(key) at the given depth; determines trie shape on both replicas. */
export function keyBit(key: string, depth: number): 0 | 1 {
  if (depth >= MAX_DEPTH) throw new Error('key hash prefix exhausted (sha256 collision?)');
  const hex = sha256(key);
  const nibble = parseInt(hex[depth >> 2], 16);
  return ((nibble >> (3 - (depth & 3))) & 1) as 0 | 1;
}
