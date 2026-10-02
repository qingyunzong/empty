export function encodeVarints(nums) {
  const bytes = [];
  for (const n of nums) {
    if (!Number.isSafeInteger(n) || n < 0) throw new RangeError('varint expects non-negative safe integers');
    let x = n;
    for (;;) {
      const b = x & 0x7f;
      x = Math.floor(x / 128);
      if (x === 0) { bytes.push(b); break; }
      bytes.push(b | 0x80);
    }
  }
  return Buffer.from(bytes);
}

export function decodeVarints(buf) {
  const out = [];
  let shift = 0;
  let value = 0;
  for (const byte of buf) {
    value += (byte & 0x7f) * 2 ** shift;
    if (byte & 0x80) { shift += 7; continue; }
    out.push(value);
    value = 0;
    shift = 0;
  }
  if (shift !== 0) throw new Error('truncated varint');
  return out;
}

export function encodePositions(positions) {
  const deltas = [];
  let prev = 0;
  for (const p of positions) { deltas.push(p - prev); prev = p; }
  return encodeVarints(deltas);
}

export function decodePositions(buf) {
  const deltas = decodeVarints(buf);
  const out = [];
  let acc = 0;
  for (const d of deltas) { acc += d; out.push(acc); }
  return out;
}
