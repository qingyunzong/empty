'use strict';

// CRC-32C (Castagnoli), reflected, polynomial 0x1EDC6F41 (reversed 0x82F63B78).
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = c & 1 ? 0x82f63b78 ^ (c >>> 1) : c >>> 1;
  }
  TABLE[n] = c >>> 0;
}

function crc32c(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

module.exports = { crc32c };
