// Reversible compression for position lists: delta encoding + unsigned LEB128 varint.
// Positions are stored as binary blocks (base64 inside the segment file),
// never as raw JSON arrays.

export function encodePositions(positions) {
  const bytes = [];
  let prev = 0;
  for (const pos of positions) {
    if (!Number.isInteger(pos) || pos < 0) throw new Error(`bad position: ${pos}`);
    let delta = pos - prev;
    prev = pos;
    do {
      let byte = delta & 0x7f;
      delta = Math.floor(delta / 128);
      if (delta !== 0) byte |= 0x80;
      bytes.push(byte);
    } while (delta !== 0);
  }
  return Buffer.from(bytes);
}

export function decodePositions(buf) {
  const out = [];
  let prev = 0;
  let value = 0;
  let shift = 0;
  for (const byte of buf) {
    value += (byte & 0x7f) * 2 ** shift;
    if ((byte & 0x80) === 0) {
      prev += value;
      out.push(prev);
      value = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
  if (shift !== 0) throw new Error('truncated position block');
  return out;
}
