/**
 * Structural equality for event content (predecessor arrays and payloads).
 *
 * `JSON.stringify` alone is order-sensitive for object keys, so values are
 * first canonicalized: object keys are sorted and sets/maps are converted to
 * sorted arrays. Two values are equal when their canonical forms match.
 */
export function deepEqual(left: unknown, right: unknown): boolean {
  return canonicalize(left) === canonicalize(right);
}

function canonicalize(value: unknown): string {
  return JSON.stringify(canonicalizeValue(value));
}

function canonicalizeValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(canonicalizeValue);
  }
  if (value instanceof Set) {
    return {
      __set__: [...value].map(canonicalizeValue).sort((a, b) =>
        compareStrings(JSON.stringify(a), JSON.stringify(b)),
      ),
    };
  }
  if (value instanceof Map) {
    return {
      __map__: [...value.entries()]
        .map(([key, entryValue]) => [
          canonicalizeValue(key),
          canonicalizeValue(entryValue),
        ])
        .sort((a, b) =>
          compareStrings(JSON.stringify(a[0]), JSON.stringify(b[0])),
        ),
    };
  }

  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .map((key) => [key, canonicalizeValue(record[key])] as const);
  return Object.fromEntries(entries);
}

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
