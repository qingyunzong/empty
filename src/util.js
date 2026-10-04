'use strict';
const crypto = require('node:crypto');

// Deterministic canonical JSON: object keys sorted recursively.
function canonical(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const keys = Object.keys(value).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}';
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(str) {
  let c = 0xffffffff;
  const buf = Buffer.from(str, 'utf8');
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function crc32hex(str) {
  return crc32(str).toString(16).padStart(8, '0');
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

// Error carrying a process exit code (2 frame error, 3 unknown origId, 4 duplicate clOrdId).
class ExitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ExitError';
    this.code = code;
  }
}

module.exports = { canonical, crc32, crc32hex, sha256hex, ExitError };
