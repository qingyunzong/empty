'use strict';

const POLY = 0x82f63b78;
const TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ POLY : c >>> 1;
  TABLE[i] = c >>> 0;
}

function crc32c(buf, crc = 0xffffffff) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c >>> 0;
}

function crc32cFinal(buf) {
  return (crc32c(buf) ^ 0xffffffff) >>> 0;
}

module.exports = { crc32c, crc32cFinal };
