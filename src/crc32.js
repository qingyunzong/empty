// CRC-32 (IEEE 802.3, polynomial 0xEDB88320), table-driven, stdlib only.
const TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n += 1) {
  let c = n;
  for (let k = 0; k < 8; k += 1) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  TABLE[n] = c >>> 0;
}

export function crc32(buf, crc = 0xFFFFFFFF) {
  let c = crc >>> 0;
  for (let i = 0; i < buf.length; i += 1) {
    c = TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8);
  }
  return (c ^ 0xFFFFFFFF) >>> 0;
}
