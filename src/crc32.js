'use strict';

let zlibCrc32 = null;
try {
  // Node >= 22.2 提供 zlib.crc32；不可用时退回纯 JS 实现。
  zlibCrc32 = require('node:zlib').crc32 || null;
} catch {
  zlibCrc32 = null;
}

let table = null;
function getTable() {
  if (table) return table;
  table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

function crc32(buf) {
  if (zlibCrc32) return zlibCrc32(buf) >>> 0;
  const t = getTable();
  let c = 0xFFFFFFFF;
  for (let i = 0; i < buf.length; i++) {
    c = t[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}

module.exports = { crc32 };
