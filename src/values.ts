import type { SurvivorRecord, TimestampInput } from "./types.ts";

/**
 * Returns true for values that carry no usable field information.
 *
 * `0`, `false`, and valid dates are non-empty.  Empty arrays/objects, blank
 * strings, `null`, and `undefined` are empty.  Cyclic values are handled
 * safely.
 */
export function isEmptyValue(value: unknown, seen?: WeakSet<object>): boolean {
  if (value === null || value === undefined) return true;

  switch (typeof value) {
    case "string":
      return value.trim().length === 0;
    case "number":
      return !Number.isFinite(value);
    case "boolean":
    case "bigint":
    case "symbol":
    case "function":
      return false;
    default:
      break;
  }

  const objectValue = value as object;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(objectValue)) return true;
  visited.add(objectValue);

  if (objectValue instanceof Date) return Number.isNaN(objectValue.getTime());
  if (ArrayBuffer.isView(objectValue)) {
    const view = objectValue as unknown as { length?: number };
    return (view.length ?? 0) === 0;
  }
  if (Array.isArray(objectValue)) {
    return objectValue.every((item) => isEmptyValue(item, visited));
  }
  if (objectValue instanceof Map) {
    if (objectValue.size === 0) return true;
    for (const [key, item] of objectValue) {
      if (!isEmptyValue(key, visited) || !isEmptyValue(item, visited)) {
        return false;
      }
    }
    return true;
  }
  if (objectValue instanceof Set) {
    if (objectValue.size === 0) return true;
    for (const item of objectValue) {
      if (!isEmptyValue(item, visited)) return false;
    }
    return true;
  }

  const keys = Object.keys(objectValue);
  if (keys.length === 0) return true;
  const record = objectValue as Record<string, unknown>;
  return keys.every((key) => isEmptyValue(record[key], visited));
}

/**
 * Default field-value completeness score.
 *
 * It is intentionally information-oriented: a populated scalar is `1`, string
 * length contributes its trimmed code-point length, and arrays/objects/maps
 * contribute the sum of their populated children.  Empty values score `0`.
 * Consumers can supply a domain-specific `completeness` function per field.
 */
export function defaultCompleteness(
  value: unknown,
  seen?: WeakSet<object>,
): number {
  if (isEmptyValue(value)) return 0;

  switch (typeof value) {
    case "string":
      return [...value.trim()].length;
    case "number":
    case "bigint":
    case "boolean":
      return 1;
    case "symbol":
    case "function":
      return 1;
    default:
      break;
  }

  const objectValue = value as object;
  const visited = seen ?? new WeakSet<object>();
  if (visited.has(objectValue)) return 0;
  visited.add(objectValue);

  if (objectValue instanceof Date) {
    return Number.isNaN(objectValue.getTime()) ? 0 : 1;
  }
  if (ArrayBuffer.isView(objectValue)) {
    const view = objectValue as unknown as { length?: number };
    return view.length ?? 0;
  }
  if (Array.isArray(objectValue)) {
    let score = 0;
    for (const item of objectValue) {
      score += defaultCompleteness(item, visited);
    }
    return score;
  }
  if (objectValue instanceof Map) {
    let score = 0;
    for (const [key, item] of objectValue) {
      score += defaultCompleteness(key, visited);
      score += defaultCompleteness(item, visited);
    }
    return score;
  }
  if (objectValue instanceof Set) {
    let score = 0;
    for (const item of objectValue) {
      score += defaultCompleteness(item, visited);
    }
    return score;
  }

  const record = objectValue as Record<string, unknown>;
  let score = 0;
  for (const key of Object.keys(record)) {
    score += defaultCompleteness(record[key], visited);
  }
  return score;
}

/**
 * Fraction of populated fields in a record.  When `fields` is supplied, the
 * denominator is that list, which makes scores comparable across records.
 */
export function recordCompleteness(
  record: SurvivorRecord,
  fields?: readonly string[],
): number {
  const keys = fields ?? Object.keys(record.values);
  if (keys.length === 0) return 0;

  let populated = 0;
  for (const field of keys) {
    if (
      Object.hasOwn(record.values, field) &&
      !isEmptyValue(record.values[field])
    ) {
      populated += 1;
    }
  }
  return populated / keys.length;
}

/**
 * Converts a configured timestamp into epoch milliseconds.  Numeric strings
 * of at least nine digits are treated as epoch milliseconds; other strings are
 * parsed with `Date.parse`.  Invalid values return `null`.
 */
export function parseTimestamp(input: TimestampInput | null | undefined): number | null {
  if (input === null || input === undefined) return null;

  if (input instanceof Date) {
    const time = input.getTime();
    return Number.isNaN(time) ? null : time;
  }
  if (typeof input === "number") {
    return Number.isFinite(input) ? input : null;
  }
  if (typeof input !== "string") return null;

  const trimmed = input.trim();
  if (trimmed.length === 0) return null;
  if (/^\d{9,}$/.test(trimmed)) {
    const numeric = Number(trimmed);
    return Number.isFinite(numeric) ? numeric : null;
  }

  const parsed = Date.parse(trimmed);
  return Number.isNaN(parsed) ? null : parsed;
}

/** UTF-16 code-unit comparison.  It does not depend on the process locale. */
export function compareRecordIds(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** Compares numbers, treating non-finite values as equal to zero. */
export function compareScores(a: number, b: number): number {
  const left = Number.isFinite(a) ? a : 0;
  const right = Number.isFinite(b) ? b : 0;
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

/** Reads an own property without walking the prototype chain. */
export function getOwn<T>(
  object: Readonly<Record<string, T>> | undefined,
  key: string,
): T | undefined {
  if (object === undefined || !Object.hasOwn(object, key)) return undefined;
  return object[key];
}

/** Defines an own data property, including for keys such as `__proto__`. */
export function setOwn(
  object: Record<string, unknown>,
  key: string,
  value: unknown,
): void {
  Object.defineProperty(object, key, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}
