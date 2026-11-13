import type {
  SourceVersion,
  SourceVersionComparator,
} from "./types.js";

function isNumericString(value: string): boolean {
  return /^\d+$/.test(value);
}

function asBigInt(value: number | bigint | string): bigint | null {
  if (typeof value === "bigint") {
    return value;
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value) || !Number.isInteger(value)) {
      return null;
    }
    return BigInt(value);
  }

  return isNumericString(value) ? BigInt(value) : null;
}

/**
 * Compares source versions without losing integer precision.
 *
 * Numeric strings are treated as numbers so feeds that serialize a sequence as
 * a string remain ordered correctly. Non-numeric strings use locale-independent
 * code-point ordering, which gives the comparator a stable total order.
 */
export const compareSourceVersions: SourceVersionComparator = (
  left,
  right,
) => {
  if (left === right) {
    return 0;
  }

  const leftInteger = asBigInt(left);
  const rightInteger = asBigInt(right);

  if (leftInteger !== null && rightInteger !== null) {
    return leftInteger < rightInteger ? -1 : 1;
  }

  const leftText = String(left);
  const rightText = String(right);
  return leftText < rightText ? -1 : leftText > rightText ? 1 : 0;
};

export function maxSourceVersion(
  left: SourceVersion,
  right: SourceVersion,
  comparator: SourceVersionComparator = compareSourceVersions,
): SourceVersion {
  return comparator(left, right) >= 0 ? left : right;
}

export function sourceVersionKey(version: SourceVersion): string {
  return `${typeof version}:${String(version)}`;
}
