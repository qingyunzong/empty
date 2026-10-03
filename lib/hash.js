import { createHash } from 'node:crypto';

export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(value[k])).join(',') + '}';
}

export function hashEvent(eventWithoutHash) {
  return sha256Hex(canonicalize(eventWithoutHash));
}

export function hashLeaf(leafHex) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x00]), Buffer.from(leafHex, 'hex')]))
    .digest('hex');
}

export function hashNode(leftHex, rightHex) {
  return createHash('sha256')
    .update(Buffer.concat([Buffer.from([0x01]), Buffer.from(leftHex, 'hex'), Buffer.from(rightHex, 'hex')]))
    .digest('hex');
}
