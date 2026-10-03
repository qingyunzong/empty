'use strict';
const crypto = require('crypto');

function canon(value) {
  if (Array.isArray(value)) return '[' + value.map(canon).join(',') + ']';
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort()
      .map((k) => JSON.stringify(k) + ':' + canon(value[k])).join(',') + '}';
  }
  return JSON.stringify(value);
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32hex(str) {
  const buf = Buffer.from(str, 'utf8');
  let c = 0xFFFFFFFF;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xFF] ^ (c >>> 8);
  return ((c ^ 0xFFFFFFFF) >>> 0).toString(16).padStart(8, '0');
}

function sha256hex(str) {
  return crypto.createHash('sha256').update(str, 'utf8').digest('hex');
}

module.exports = { canon, crc32hex, sha256hex };
