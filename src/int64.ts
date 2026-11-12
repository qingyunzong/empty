import {
  INT64_MAX,
  INT64_MIN,
  type Interval,
  RemoteContractError,
} from "./types.ts";

const DECIMAL_INTEGER = /^[+-]?[0-9]+$/;
const encoder = new TextEncoder();

export function parseInteger(
  value: unknown,
  code: string,
  label: string,
): bigint {
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new RemoteContractError(
        code,
        `${label} must be a safe integer when supplied as a number`,
        { label, value },
      );
    }
    return BigInt(value);
  }
  if (typeof value === "string" && DECIMAL_INTEGER.test(value)) {
    return BigInt(value);
  }
  throw new RemoteContractError(
    code,
    `${label} must be an int64 integer`,
    { label, value },
  );
}

export function parseCount(value: unknown, label = "total"): bigint {
  const count = parseInteger(value, "TOTAL_INVALID", label);
  if (count < 0n) {
    throw new RemoteContractError(
      "TOTAL_INVALID",
      `${label} must be non-negative`,
      { label, value },
    );
  }
  return count;
}

export function assertInt64(time: bigint, code: string, label: string): void {
  if (time < INT64_MIN || time > INT64_MAX) {
    throw new RemoteContractError(code, `${label} is outside int64`, {
      label,
      time: time.toString(),
    });
  }
}

export function normalizeTime(
  value: unknown,
  code = "TIME_INVALID",
  label = "time",
): bigint {
  const time = parseInteger(value, code, label);
  assertInt64(time, code, label);
  return time;
}

/**
 * Exact partition of a non-empty closed int64 interval:
 * [from, mid] and [mid + 1, to], where mid = from + floor((to-from)/2).
 * bigint arithmetic avoids both overflow and floating point rounding.
 */
export function splitTimeInterval(
  from: bigint,
  to: bigint,
): readonly [Interval, Interval] {
  assertInt64(from, "TIME_OUT_OF_DOMAIN", "from");
  assertInt64(to, "TIME_OUT_OF_DOMAIN", "to");
  if (from >= to) {
    throw new RangeError("splitTimeInterval requires from < to");
  }
  const mid = from + (to - from) / 2n;
  return [
    { from, to: mid },
    { from: mid + 1n, to },
  ];
}

/**
 * UTF-8 byte order for IDs. JS string comparison uses UTF-16 code units and is
 * not the same ordering for arbitrary Unicode, so we compare encoded bytes.
 */
export function compareIdBytes(left: string, right: string): number {
  const a = encoder.encode(left);
  const b = encoder.encode(right);
  const length = Math.min(a.length, b.length);
  for (let index = 0; index < length; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) {
      return difference;
    }
  }
  return a.length - b.length;
}

export function compareRecords(
  left: { readonly time: bigint; readonly id: string },
  right: { readonly time: bigint; readonly id: string },
): number {
  if (left.time < right.time) {
    return -1;
  }
  if (left.time > right.time) {
    return 1;
  }
  return compareIdBytes(left.id, right.id);
}
