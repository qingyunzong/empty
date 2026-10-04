/**
 * Fractional position keys over the base-36 alphabet "0-9a-z".
 * A key orders lexicographically; `keyBetween(a, b)` always returns a key k
 * with a < k < b (null bounds mean -inf / +inf).
 */
const DIGITS = '0123456789abcdefghijklmnopqrstuvwxyz';
const BASE = DIGITS.length;

export function keyBetween(a: string | null, b: string | null): string {
  if (a !== null && b !== null && a >= b) {
    throw new Error(`keyBetween: lower bound must be < upper bound (${a} >= ${b})`);
  }
  const lo = a ?? '';
  let hi = b; // null means +infinity
  let result = '';
  let i = 0;
  for (;;) {
    const da = i < lo.length ? DIGITS.indexOf(lo[i]!) : 0;
    const db = hi === null ? BASE : DIGITS.indexOf(hi[i]!);
    if (db - da > 1) {
      return result + DIGITS[(da + db) >> 1];
    }
    // Adjacent or equal digits: emit the lower digit and descend.
    result += DIGITS[da];
    if (hi !== null && da < db) hi = null; // strictly below b now; upper bound opens up
    i += 1;
  }
}

/**
 * Order two positioned elements. Concurrent inserts can produce identical
 * fractional keys, so the stable element ID breaks the tie deterministically.
 */
export function comparePositions(keyA: string, idA: string, keyB: string, idB: string): number {
  if (keyA !== keyB) return keyA < keyB ? -1 : 1;
  if (idA !== idB) return idA < idB ? -1 : 1;
  return 0;
}
