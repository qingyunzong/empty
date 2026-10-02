// Unsigned LEB128 varint encoding (standard library only).

export function encodeVarint(n) {
  if (!Number.isInteger(n) || n < 0) {
    throw new Error('varint: non-negative integer required');
  }
  const out = [];
  let v = n;
  do {
    let b = v % 128;
    v = Math.floor(v / 128);
    if (v > 0) b += 128;
    out.push(b);
  } while (v > 0);
  return out;
}

export function decodeVarints(buf) {
  const nums = [];
  let value = 0;
  let shift = 0;
  for (const byte of buf) {
    value += (byte & 0x7f) * 2 ** shift;
    if (byte < 128) {
      nums.push(value);
      value = 0;
      shift = 0;
    } else {
      shift += 7;
    }
  }
  if (shift !== 0) throw new Error('truncated varint sequence');
  return nums;
}
