import type { CanonicalValue } from './types.js';

// This file is an INDEPENDENT second implementation of the canonical
// encoder, written recursively and sharing no code with encoder.ts.
// Tests cross-check the two encoders byte-for-byte.

class RecursiveEncodeError extends Error {}

function fail(message: string): never {
  throw new RecursiveEncodeError(`recursive encoder: ${message}`);
}

function uvarint(n: bigint): number[] {
  if (n < 0n || n > 0xffffffffffffffffn) fail('varint out of range');
  const out: number[] = [];
  do {
    const b = Number(n % 128n);
    n = n / 128n;
    out.push(n > 0n ? b + 128 : b);
  } while (n > 0n);
  return out;
}

function utf8(s: string): number[] {
  if (!s.isWellFormed()) fail(`unpaired surrogate in key ${JSON.stringify(s)}`);
  return [...new TextEncoder().encode(s)];
}

function encodeInto(acc: number[], value: CanonicalValue): void {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) fail(`unsafe number ${value}`);
    acc.push(0x69, ...uvarint(zig(BigInt(value))));
  } else if (typeof value === 'bigint') {
    if (value < -(1n << 63n) || value >= 1n << 63n) fail('int64 overflow');
    acc.push(0x69, ...uvarint(zig(value)));
  } else if (value instanceof Uint8Array) {
    acc.push(0x62, ...uvarint(BigInt(value.length)), ...value);
  } else if (Array.isArray(value)) {
    acc.push(0x61, ...uvarint(BigInt(value.length)));
    for (const item of value) encodeInto(acc, item);
  } else if (value !== null && typeof value === 'object') {
    const pairs: Array<[string, CanonicalValue]> =
      value instanceof Map
        ? [...value.entries()]
        : Object.entries(value as Record<string, CanonicalValue>);
    const seen = new Set<string>();
    const keyed = pairs.map(([k, v]): [number[], CanonicalValue] => {
      if (seen.has(k)) fail(`duplicate key ${JSON.stringify(k)}`);
      seen.add(k);
      return [utf8(k), v];
    });
    keyed.sort((x, y) => cmpBytes(x[0], y[0]));
    acc.push(0x6f, ...uvarint(BigInt(keyed.length)));
    for (const [kb, v] of keyed) {
      acc.push(...uvarint(BigInt(kb.length)), ...kb);
      encodeInto(acc, v);
    }
  } else {
    fail(`unsupported value ${String(value)}`);
  }
}

function zig(n: bigint): bigint {
  return n >= 0n ? n * 2n : -n * 2n - 1n;
}

function cmpBytes(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return a[i]! - b[i]!;
  }
  return a.length - b.length;
}

/** Recursively encode a value into canonical bytes. */
export function encodeRecursive(value: CanonicalValue): Buffer {
  const acc: number[] = [];
  encodeInto(acc, value);
  return Buffer.from(Uint8Array.from(acc));
}
