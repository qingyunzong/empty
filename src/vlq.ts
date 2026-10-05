const CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const TABLE = new Map<string, number>([...CHARS].map((c, i) => [c, i]));

export function decodeVlq(str: string, pos: { i: number }): number {
  let result = 0;
  let shift = 0;
  let continuation = true;
  while (continuation) {
    if (pos.i >= str.length) throw new Error('unexpected end of VLQ sequence');
    const digit = TABLE.get(str[pos.i++]);
    if (digit === undefined) throw new Error(`invalid base64 digit: ${str[pos.i - 1]}`);
    continuation = (digit & 32) !== 0;
    result += (digit & 31) * 2 ** shift;
    shift += 5;
  }
  const negative = result % 2 === 1;
  result = (result - (negative ? 1 : 0)) / 2;
  return negative ? -result : result;
}

export function decodeVlqAll(str: string): number[] {
  const pos = { i: 0 };
  const out: number[] = [];
  while (pos.i < str.length) out.push(decodeVlq(str, pos));
  return out;
}

export function encodeVlq(value: number): string {
  let vlq = Math.abs(value) * 2 + (value < 0 ? 1 : 0);
  let out = '';
  do {
    let digit = vlq % 32;
    vlq = Math.floor(vlq / 32);
    if (vlq > 0) digit |= 32;
    out += CHARS[digit];
  } while (vlq > 0);
  return out;
}
