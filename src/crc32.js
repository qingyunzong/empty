// CRC-32 (IEEE 802.3, polynomial 0xEDB88320), standard library only.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  TABLE[n] = c >>> 0;
}

export function crc32(str) {
  let crc = 0xffffffff;
  const buf = Buffer.from(str, 'utf8');
  for (const b of buf) crc = (TABLE[(crc ^ b) & 0xff] ^ (crc >>> 8)) >>> 0;
  return ((crc ^ 0xffffffff) >>> 0).toString(16).padStart(8, '0');
}
