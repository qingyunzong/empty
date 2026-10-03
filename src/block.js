import { createHash } from 'node:crypto';
import { canonical } from './canonical.js';
import { crc32 } from './crc32.js';

export const GENESIS = 'GENESIS';

export function blockContent(block) {
  return {
    level: block.level,
    parent: block.parent,
    transfers: block.transfers,
    deltas: block.deltas,
    index: block.index,
  };
}

export function createBlock({ level, parent, transfers, deltas, index }) {
  const content = blockContent({ level, parent, transfers, deltas, index });
  const serialized = canonical(content);
  return {
    ...content,
    crc: crc32(serialized),
    hash: createHash('sha256').update(serialized).digest('hex'),
  };
}

export function verifyBlock(block) {
  if (!block || typeof block !== 'object') return 'CORRUPT';
  const { level, parent, transfers, deltas, index, crc, hash } = block;
  if (
    !Number.isSafeInteger(level) ||
    typeof parent !== 'string' ||
    !Array.isArray(transfers) ||
    !deltas || typeof deltas !== 'object' || Array.isArray(deltas) ||
    !Array.isArray(index) ||
    typeof crc !== 'string' ||
    typeof hash !== 'string'
  ) {
    return 'CORRUPT';
  }
  const serialized = canonical(blockContent(block));
  if (crc32(serialized) !== crc) return 'CORRUPT';
  if (createHash('sha256').update(serialized).digest('hex') !== hash) return 'CORRUPT';
  return null;
}
