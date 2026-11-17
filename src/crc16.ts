const CRC16_TABLE = new Uint16Array(256);

for (let index = 0; index < 256; index += 1) {
  let value = index << 8;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 0x8000) !== 0 ? ((value << 1) ^ 0x1021) & 0xffff : (value << 1) & 0xffff;
  }
  CRC16_TABLE[index] = value;
}

/**
 * CRC16/XMODEM, the checksum used by Redis Cluster.
 */
export function crc16(input: string | Uint8Array): number {
  const bytes = typeof input === "string" ? new TextEncoder().encode(input) : input;
  let crc = 0;

  for (const byte of bytes) {
    crc = ((crc << 8) ^ CRC16_TABLE[((crc >> 8) ^ byte) & 0xff]!) & 0xffff;
  }

  return crc;
}

/**
 * Returns the Redis Cluster hash slot for a key.
 *
 * A non-empty `{...}` substring selects the hash tag. Only the first pair of
 * braces is considered, matching Redis' CLUSTER KEYSLOT implementation.
 */
export function keySlot(key: string): number {
  let hashInput = key;
  const open = key.indexOf("{");

  if (open >= 0) {
    const close = key.indexOf("}", open + 1);
    if (close > open + 1) {
      hashInput = key.slice(open + 1, close);
    }
  }

  return crc16(hashInput) & 0x3fff;
}

export const SLOT_COUNT = 16384;
