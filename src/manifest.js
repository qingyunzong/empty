import { createHash } from 'node:crypto';
import { uvarintEncode } from './varint.js';

const GENESIS = createHash('sha256').update('QCERT/GENESIS').digest();

export function elemHash(el) {
  if (el.kind === 'seg') return Buffer.from(el.hash, 'hex');
  // tombstone element
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from('TOMB'), Buffer.from(el.hash, 'hex'), uvarintEncode(el.epoch)]))
    .digest();
}

export function elemHashHex(el) {
  return elemHash(el).toString('hex');
}

export function computeHead(elements) {
  let h = GENESIS;
  for (const el of elements) {
    h = createHash('sha256').update(Buffer.concat([h, elemHash(el)])).digest();
  }
  return h.toString('hex');
}

export function emptyManifest() {
  return { version: 1, epoch: 0, elements: [], head: computeHead([]) };
}
