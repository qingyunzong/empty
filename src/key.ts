/**
 * Multi-level key handling.
 *
 * A key part is a string, a number, or null. `null` is a first-class
 * category of its own: it is distinct from the string "null", from the
 * number 0, and from a missing (shorter) key level.
 */
export type KeyPart = string | number | null;
export type Key = readonly KeyPart[];

/** Canonical, collision-free encoding of a single key part. */
export function encodePart(part: KeyPart): string {
  if (part === null) return "\0n";
  if (typeof part === "number") {
    if (!Number.isFinite(part)) throw new Error(`non-finite key part: ${part}`);
    return `\0i${part}`;
  }
  return `\0s${part}`;
}

/** Canonical encoding of a whole key. Length-prefixed per level so that
 *  ["A"] and ["A", null] never collide. */
export function encodeKey(key: Key): string {
  return key.map(encodePart).join("");
}

/** Decode a canonical key string back into parts (inverse of encodeKey). */
export function decodeKey(encoded: string): KeyPart[] {
  const parts: KeyPart[] = [];
  let i = 0;
  while (i < encoded.length) {
    if (encoded[i] !== "\0") throw new Error(`corrupt encoded key at ${i}`);
    const tag = encoded[i + 1];
    if (tag === "n") {
      parts.push(null);
      i += 2;
    } else {
      const next = encoded.indexOf("\0", i + 2);
      const raw = next === -1 ? encoded.slice(i + 2) : encoded.slice(i + 2, next);
      parts.push(tag === "i" ? Number(raw) : raw);
      i = next === -1 ? encoded.length : next;
    }
  }
  return parts;
}

/** All prefixes of a key, shortest first: [] , [k0], [k0,k1], ... */
export function* prefixes(key: Key): Generator<Key> {
  for (let len = 0; len <= key.length; len++) yield key.slice(0, len);
}
