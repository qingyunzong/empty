'use strict';

// CRC-16/CCITT-FALSE: poly 0x1021, init 0xFFFF, no reflection, xorout 0.
const TABLE = new Uint16Array(256);
for (let i = 0; i < 256; i++) {
  let c = i << 8;
  for (let b = 0; b < 8; b++) {
    c = (c & 0x8000) !== 0 ? ((c << 1) ^ 0x1021) & 0xffff : (c << 1) & 0xffff;
  }
  TABLE[i] = c;
}

function crc16(buf, init = 0xffff) {
  let crc = init;
  for (let i = 0; i < buf.length; i++) {
    crc = ((crc << 8) ^ TABLE[((crc >> 8) ^ buf[i]) & 0xff]) & 0xffff;
  }
  return crc;
}

module.exports = { crc16 };
