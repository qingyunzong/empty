export function encodeDeltas(sortedPositions) {
  const bytes = [];
  let prev = 0;
  for (const pos of sortedPositions) {
    let v = pos - prev;
    prev = pos;
    do {
      const b = v & 0x7f;
      v = Math.floor(v / 128);
      bytes.push(v > 0 ? b | 0x80 : b);
    } while (v > 0);
  }
  return Buffer.from(bytes).toString('base64');
}

export function decodeDeltas(b64) {
  const buf = Buffer.from(b64, 'base64');
  const out = [];
  let prev = 0;
  let i = 0;
  while (i < buf.length) {
    let shift = 0;
    let v = 0;
    let b;
    do {
      b = buf[i++];
      v += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    prev += v;
    out.push(prev);
  }
  return out;
}
