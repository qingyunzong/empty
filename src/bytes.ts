export function concat(...parts: readonly Uint8Array[]): Uint8Array {
  let total = 0;
  for (const part of parts) total += part.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

export function uint8(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xff) {
    throw new RangeError(`uint8 out of range: ${value}`);
  }
  return new Uint8Array([value]);
}

export function uint16(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`uint16 out of range: ${value}`);
  }
  return new Uint8Array([(value >>> 8) & 0xff, value & 0xff]);
}

export function uint24(value: number): Uint8Array {
  if (!Number.isInteger(value) || value < 0 || value > 0xffffff) {
    throw new RangeError(`uint24 out of range: ${value}`);
  }
  return new Uint8Array([(value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff]);
}

export function lengthPrefixed8(value: Uint8Array): Uint8Array {
  if (value.length > 0xff) throw new RangeError("value is too long for uint8 length prefix");
  return concat(uint8(value.length), value);
}

export function lengthPrefixed16(value: Uint8Array): Uint8Array {
  if (value.length > 0xffff) throw new RangeError("value is too long for uint16 length prefix");
  return concat(uint16(value.length), value);
}

export function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

export function hex(value: Uint8Array): string {
  let out = "";
  for (const byte of value) out += byte.toString(16).padStart(2, "0");
  return out;
}

export function fromHex(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (normalized.length % 2 !== 0) throw new Error("hex input must have an even length");
  const out = new Uint8Array(normalized.length / 2);
  for (let i = 0; i < out.length; i += 1) {
    const byte = Number.parseInt(normalized.slice(i * 2, i * 2 + 2), 16);
    if (Number.isNaN(byte)) throw new Error("invalid hex input");
    out[i] = byte;
  }
  return out;
}

export function equalConstantTime(a: Uint8Array, b: Uint8Array): boolean {
  let diff = a.length ^ b.length;
  const length = Math.min(a.length, b.length);
  for (let i = 0; i < length; i += 1) {
    diff |= a[i] ^ b[i];
  }
  return diff === 0;
}

export function wipe(value: Uint8Array | undefined): void {
  value?.fill(0);
}

export function cloneBytes(value: Uint8Array): Uint8Array {
  return new Uint8Array(value);
}
