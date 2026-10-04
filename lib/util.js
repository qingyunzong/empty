'use strict';
const crypto = require('node:crypto');

function sha256hex(data) {
  return crypto.createHash('sha256').update(data).digest('hex');
}

function hmacSha256hex(key, data) {
  return crypto.createHmac('sha256', key).update(data).digest('hex');
}

function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function merkleRoot(hexHashes) {
  if (hexHashes.length === 0) return '0'.repeat(64);
  let level = hexHashes.map((h) => Buffer.from(h, 'hex'));
  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const a = level[i];
      const b = i + 1 < level.length ? level[i + 1] : a;
      next.push(crypto.createHash('sha256').update(Buffer.concat([a, b])).digest());
    }
    level = next;
  }
  return level[0].toString('hex');
}

module.exports = { sha256hex, hmacSha256hex, canonical, crc32, merkleRoot };
