import { MissingBusinessKeyError } from "./errors.ts";
import type { KeySelector } from "./types.ts";

export type BusinessKey = string | number;

export const DEFAULT_KEY_FIELD = "id";

export function isBusinessKey(value: unknown): value is BusinessKey {
  if (typeof value === "string") {
    return value.trim().length > 0;
  }
  return typeof value === "number" && Number.isFinite(value);
}

export function assertBusinessKey(
  value: unknown,
  index?: number,
): asserts value is BusinessKey {
  if (!isBusinessKey(value)) {
    throw new MissingBusinessKeyError({ key: value, index });
  }
}

/**
 * DOM text and JSON values differ in type, while the same business key may
 * arrive as `1` on one page and `"1"` after a refresh. Canonicalizing to the
 * string form gives stable identity across those boundaries.
 */
export function keyToken(key: BusinessKey): string {
  return String(key);
}

export function readField(source: unknown, field: string): unknown {
  if (source === null || source === undefined) {
    return undefined;
  }
  if (typeof source !== "object") {
    return undefined;
  }
  const direct = (source as Record<string, unknown>)[field];
  if (direct !== undefined) {
    return direct;
  }
  if (!field.includes(".")) {
    return undefined;
  }
  let cursor: unknown = source;
  for (const part of field.split(".")) {
    if (cursor === null || typeof cursor !== "object") {
      return undefined;
    }
    cursor = (cursor as Record<string, unknown>)[part];
  }
  return cursor;
}

export function resolveKeySelector<Row>(
  selector: KeySelector<Row> | undefined,
  field: string | undefined,
): { selector: KeySelector<Row>; field: string } {
  if (selector !== undefined) {
    return {
      selector,
      field: typeof selector === "string" ? selector : field ?? DEFAULT_KEY_FIELD,
    };
  }
  const resolved = field ?? DEFAULT_KEY_FIELD;
  return { selector: resolved, field: resolved };
}

export function readBusinessKey<Row>(
  row: Row,
  selector: KeySelector<Row>,
  index: number,
): BusinessKey {
  const raw =
    typeof selector === "function"
      ? selector(row, index)
      : readField(row, selector);
  assertBusinessKey(raw, index);
  return raw;
}
