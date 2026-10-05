import { CanonicalError } from './errors.js';
import { validateKey, keyBytes } from './keys.js';
import { TAG_ARRAY, TAG_BYTES, TAG_INTEGER, TAG_OBJECT } from './tags.js';
import type { CanonicalValue } from './types.js';
import { encodeVarint } from './varint.js';

/** Zigzag-encode a signed 64-bit integer into an unsigned one. */
function zigzag(value: bigint): bigint {
  return value >= 0n ? value * 2n : -2n * value - 1n;
}

function toInt64(value: number | bigint): bigint {
  if (typeof value === 'number') {
    if (!Number.isSafeInteger(value)) {
      throw new CanonicalError(`number is not a safe integer: ${value}`, 0);
    }
    return BigInt(value);
  }
  if (value < -(2n ** 63n) || value > 2n ** 63n - 1n) {
    throw new CanonicalError('integer is outside the signed 64-bit range', 0);
  }
  return value;
}

interface SortedEntry {
  readonly keyBytes: Buffer;
  readonly value: CanonicalValue;
}

/**
 * Normalize an object into entries sorted by UTF-8 key bytes.
 * Rejects duplicate keys and keys containing unpaired surrogates.
 */
export function normalizeObject(obj: object): SortedEntry[] {
  const raw: Array<readonly [string, CanonicalValue]> =
    obj instanceof Map ? [...obj.entries()] : Object.entries(obj as Record<string, CanonicalValue>);

  const entries: SortedEntry[] = raw.map(([key, value]) => {
    validateKey(key);
    return { keyBytes: keyBytes(key), value };
  });

  entries.sort((a, b) => a.keyBytes.compare(b.keyBytes));

  for (let i = 1; i < entries.length; i++) {
    if (entries[i]!.keyBytes.equals(entries[i - 1]!.keyBytes)) {
      throw new CanonicalError(`duplicate object key: ${JSON.stringify(raw.find(([k]) => keyBytes(k).equals(entries[i]!.keyBytes))![0])}`, 0);
    }
  }
  return entries;
}

/**
 * Build a canonical object from explicit key/value entries. Unlike a plain
 * JS object, an entry list can contain duplicates — they are rejected here.
 */
export function obj(entries: Iterable<readonly [string, CanonicalValue]>): ReadonlyMap<string, CanonicalValue> {
  const map = new Map<string, CanonicalValue>();
  for (const [key, value] of entries) {
    validateKey(key);
    if (map.has(key)) {
      throw new CanonicalError(`duplicate object key: ${JSON.stringify(key)}`, 0);
    }
    map.set(key, value);
  }
  return map;
}

type WorkItem =
  | { readonly kind: 'raw'; readonly bytes: Buffer }
  | { readonly kind: 'value'; readonly value: CanonicalValue };

/**
 * Iteratively encode a value into its canonical byte form.
 * An explicit work stack keeps deep nesting from overflowing the call stack.
 */
export function encodeCanonical(root: CanonicalValue): Buffer {
  const out: Buffer[] = [];
  const stack: WorkItem[] = [{ kind: 'value', value: root }];

  while (stack.length > 0) {
    const item = stack.pop()!;
    if (item.kind === 'raw') {
      out.push(item.bytes);
      continue;
    }
    const value = item.value;

    if (typeof value === 'number' || typeof value === 'bigint') {
      out.push(Buffer.from(Uint8Array.of(TAG_INTEGER)));
      out.push(encodeVarint(zigzag(toInt64(value))));
    } else if (value instanceof Uint8Array) {
      out.push(Buffer.from(Uint8Array.of(TAG_BYTES)));
      out.push(encodeVarint(BigInt(value.length)));
      out.push(Buffer.from(value));
    } else if (Array.isArray(value)) {
      out.push(Buffer.from(Uint8Array.of(TAG_ARRAY)));
      out.push(encodeVarint(BigInt(value.length)));
      for (let i = value.length - 1; i >= 0; i--) {
        stack.push({ kind: 'value', value: value[i]! });
      }
    } else if (typeof value === 'object' && value !== null) {
      const entries = normalizeObject(value);
      out.push(Buffer.from(Uint8Array.of(TAG_OBJECT)));
      out.push(encodeVarint(BigInt(entries.length)));
      for (let i = entries.length - 1; i >= 0; i--) {
        stack.push({ kind: 'value', value: entries[i]!.value });
        stack.push({ kind: 'raw', bytes: Buffer.concat([encodeVarint(BigInt(entries[i]!.keyBytes.length)), entries[i]!.keyBytes]) });
      }
    } else {
      throw new CanonicalError(`unsupported value type: ${typeof value}`, 0);
    }
  }
  return Buffer.concat(out);
}
