const BASE64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const BASE64_VALUES: ReadonlyMap<string, number> = new Map(
  Array.from(BASE64_CHARS, (ch, i) => [ch, i] as const),
);

/** Encode one signed integer as a base64-VLQ string. */
export function encodeVlq(value: number): string {
  let vlq = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = '';
  do {
    let digit = vlq & 31;
    vlq >>>= 5;
    if (vlq > 0) digit |= 32;
    out += BASE64_CHARS.charAt(digit);
  } while (vlq > 0);
  return out;
}

/** Decode one base64-VLQ value from `text` starting at `start`. */
export function decodeVlq(text: string, start: number): { value: number; next: number } {
  let result = 0;
  let shift = 0;
  let pos = start;
  let continuation: number;
  do {
    if (pos >= text.length) throw new Error('Unexpected end of VLQ sequence');
    const ch = text.charAt(pos++);
    const digit = BASE64_VALUES.get(ch);
    if (digit === undefined) throw new Error(`Invalid base64 digit: ${ch}`);
    continuation = digit & 32;
    result += (digit & 31) << shift;
    shift += 5;
  } while (continuation);
  const negative = (result & 1) === 1;
  const value = result >>> 1;
  return { value: negative ? -value : value, next: pos };
}
