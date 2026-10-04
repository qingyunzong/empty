// RFC 3986 unreserved characters: A-Z a-z 0-9 - . _ ~
// Only these are decoded from percent-escapes; reserved characters
// (gen-delims / sub-delims) and everything else stay percent-encoded.
export function isUnreservedByte(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e // ~
  );
}

const HEX = /^[0-9A-Fa-f]{2}$/;

export function isValidEscape(triplet: string): boolean {
  return HEX.test(triplet);
}
