export interface RandomSource {
  randomBytes(length: number): Uint8Array;
}

export function createSystemRandomSource(): RandomSource {
  return {
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      globalThis.crypto.getRandomValues(bytes);
      return bytes;
    },
  };
}

export function toHex(bytes: Uint8Array): string {
  let out = '';
  for (const byte of bytes) {
    out += byte.toString(16).padStart(2, '0');
  }
  return out;
}
