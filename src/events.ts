import type { Key } from "./key";

/** Exact integer input: bigint preferred; number must be a safe integer;
 *  string must be an integer literal (avoids float rounding at the boundary). */
export type ExactInt = bigint | number | string;

export function toBigInt(value: ExactInt): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) {
      throw new Error(`number is not a safe integer, use bigint or string: ${value}`);
    }
    return BigInt(value);
  }
  if (!/^-?\d+$/.test(value.trim())) {
    throw new Error(`string is not an integer literal: ${JSON.stringify(value)}`);
  }
  return BigInt(value);
}

/** Append a new fact to the table. */
export interface InsertEvent {
  readonly kind: "insert";
  readonly id: string;
  readonly row: Key;
  readonly col: Key;
  readonly value: ExactInt;
}

/** Correction: adjust the value of a previous insert by a signed delta. */
export interface AdjustEvent {
  readonly kind: "adjust";
  readonly id: string;
  readonly target: string;
  readonly delta: ExactInt;
}

/** Correction: migrate a previous insert to a different row/column group. */
export interface MoveEvent {
  readonly kind: "move";
  readonly id: string;
  readonly target: string;
  readonly row?: Key;
  readonly col?: Key;
}

export type PivotEvent = InsertEvent | AdjustEvent | MoveEvent;

export type IngestResult =
  | { readonly applied: true }
  | { readonly applied: false; readonly reason: "duplicate-event-id" | "unknown-target" };
