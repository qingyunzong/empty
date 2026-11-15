import {
  bytesEqual,
  bytesToHex,
  toMaskBytes,
  trimLeadingZeroBytes,
  type BinaryLike,
} from "./binary.ts";
import {
  findColumn,
  normalizeSchema,
  type CaptureColumn,
  type CaptureInstanceSchema,
  type CaptureSchemaLike,
} from "./schema.ts";

export type UpdateMaskLike = BinaryLike | number | bigint;
export type UpdateMaskArgument = UpdateMaskLike | null | undefined;

export interface UpdateMaskExplanation {
  /** Mask bytes. */
  mask: Uint8Array;
  /** `0x`-prefixed lowercase hexadecimal representation. */
  maskHex: string;
  /** Changed column names, ordered by capture-instance ordinal. */
  columns: string[];
  /** 1-based column ordinals whose bits are set and which exist in the schema. */
  ordinals: number[];
  /** Zero-based bit positions whose bits are set. */
  bits: number[];
  /** One entry for every schema column, including unchanged columns. */
  columnsByOrdinal: Array<{ ordinal: number; name: string; updated: boolean }>;
  /** True if at least one bit is set anywhere in the mask. */
  hasUpdates: boolean;
}

/**
 * SQL Server's `__$update_mask` is a bitmap over capture-instance column
 * ordinals.  Bit 0 (the least significant bit of the first byte) corresponds
 * to ordinal 1.  This is the same convention used by
 * `sys.fn_cdc_is_bit_set`.
 */
export function isMaskBitSet(mask: UpdateMaskLike | null | undefined, bit: number): boolean {
  if (mask === null || mask === undefined) {
    return false;
  }
  if (!Number.isInteger(bit) || bit < 0) {
    throw new RangeError(`Invalid update-mask bit: ${String(bit)}`);
  }
  const bytes = toMaskBytes(mask);
  const byteIndex = bit >> 3;
  if (byteIndex >= bytes.length) {
    return false;
  }
  return (bytes[byteIndex] & (1 << (bit & 7))) !== 0;
}

/** Check a 1-based capture column ordinal. */
export function isColumnUpdated(
  mask: UpdateMaskLike | null | undefined,
  ordinal: number,
): boolean {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`Invalid column ordinal: ${String(ordinal)}`);
  }
  return isMaskBitSet(mask, ordinal - 1);
}

/** Return a copy of the mask with the bit for a 1-based ordinal changed. */
export function setColumnMaskBit(
  mask: UpdateMaskLike | null | undefined,
  ordinal: number,
  updated = true,
): Uint8Array {
  if (!Number.isInteger(ordinal) || ordinal < 1) {
    throw new RangeError(`Invalid column ordinal: ${String(ordinal)}`);
  }
  let bytes =
    mask === null || mask === undefined ? new Uint8Array(0) : Uint8Array.from(toMaskBytes(mask));
  const bit = ordinal - 1;
  const byteIndex = bit >> 3;
  if (bytes.length <= byteIndex) {
    const expanded = new Uint8Array(byteIndex + 1);
    expanded.set(bytes);
    bytes = expanded;
  }
  if (updated) {
    bytes[byteIndex] |= 1 << (bit & 7);
  } else {
    bytes[byteIndex] &= ~(1 << (bit & 7));
  }
  return bytes;
}

export function maskHasAnyBit(mask: UpdateMaskLike | null | undefined): boolean {
  if (mask === null || mask === undefined) {
    return false;
  }
  return toMaskBytes(mask).some((byte) => byte !== 0);
}

export function maskBitPositions(mask: UpdateMaskLike | null | undefined): number[] {
  if (mask === null || mask === undefined) {
    return [];
  }
  const bytes = toMaskBytes(mask);
  const positions: number[] = [];
  for (let byteIndex = 0; byteIndex < bytes.length; byteIndex += 1) {
    const byte = bytes[byteIndex];
    for (let bit = 0; bit < 8; bit += 1) {
      if ((byte & (1 << bit)) !== 0) {
        positions.push(byteIndex * 8 + bit);
      }
    }
  }
  return positions;
}

function looksLikeSchema(value: unknown): boolean {
  if (Array.isArray(value)) {
    return value.every(
      (entry) =>
        typeof entry === "string" ||
        (entry !== null &&
          typeof entry === "object" &&
          ("name" in entry || "column_name" in entry || "ordinal" in entry)),
    );
  }
  return (
    value !== null &&
    typeof value === "object" &&
    Array.isArray((value as { columns?: unknown }).columns)
  );
}

function explainUpdateMaskInternal(
  mask: UpdateMaskLike | null | undefined,
  schemaLike: CaptureSchemaLike,
): UpdateMaskExplanation {
  const schema = normalizeSchema(schemaLike);
  const bytes = mask === null || mask === undefined ? new Uint8Array(0) : toMaskBytes(mask);
  const bits = maskBitPositions(bytes);
  const bitSet = new Set(bits);
  const columnsByOrdinal = schema.columns.map((column) => ({
    ordinal: column.ordinal,
    name: column.name,
    updated: bitSet.has(column.ordinal - 1),
  }));
  const changed = columnsByOrdinal.filter((column) => column.updated);

  return {
    mask: bytes,
    maskHex: bytesToHex(bytes, true),
    columns: changed.map((column) => column.name),
    ordinals: changed.map((column) => column.ordinal),
    bits,
    columnsByOrdinal,
    hasUpdates: bits.length > 0,
  };
}

/** Explain a mask.  Both `(mask, schema)` and `(schema, mask)` are accepted. */
export function explainUpdateMask(
  mask: UpdateMaskLike | null | undefined,
  schema: CaptureSchemaLike,
): UpdateMaskExplanation;
export function explainUpdateMask(
  schema: CaptureSchemaLike,
  mask: UpdateMaskLike | null | undefined,
): UpdateMaskExplanation;
export function explainUpdateMask(
  first: unknown,
  second: unknown,
): UpdateMaskExplanation {
  if (looksLikeSchema(first) && !looksLikeSchema(second)) {
    return explainUpdateMaskInternal(
      second as UpdateMaskLike,
      first as CaptureSchemaLike,
    );
  }
  return explainUpdateMaskInternal(
    first as UpdateMaskLike,
    second as CaptureSchemaLike,
  );
}

/**
 * Decode an update mask into changed column names, in capture-instance
 * ordinal order.  Bits that do not correspond to a schema column are ignored,
 * which makes the function safe for schemas that changed over time.
 */
export function decodeUpdateMask(
  mask: UpdateMaskLike | null | undefined,
  schemaLike: CaptureSchemaLike,
): string[];
export function decodeUpdateMask(
  schemaLike: CaptureSchemaLike,
  mask: UpdateMaskLike | null | undefined,
): string[];
export function decodeUpdateMask(first: unknown, second: unknown): string[] {
  if (looksLikeSchema(first) && !looksLikeSchema(second)) {
    return explainUpdateMaskInternal(
      second as UpdateMaskLike,
      first as CaptureSchemaLike,
    ).columns;
  }
  return explainUpdateMaskInternal(
    first as UpdateMaskLike,
    second as CaptureSchemaLike,
  ).columns;
}

/**
 * Alias for integrations that name the operation "parse".  Both argument
 * orders are accepted: `(mask, schema)` and `(schema, mask)`.
 */
export function parseUpdateMask(
  mask: UpdateMaskLike | null | undefined,
  schema: CaptureSchemaLike,
): string[];
export function parseUpdateMask(
  schema: CaptureSchemaLike,
  mask: UpdateMaskLike | null | undefined,
): string[];
export function parseUpdateMask(first: unknown, second: unknown): string[] {
  if (looksLikeSchema(first) && !looksLikeSchema(second)) {
    return decodeUpdateMask(
      second as UpdateMaskLike,
      first as CaptureSchemaLike,
    );
  }
  return decodeUpdateMask(
    first as UpdateMaskLike,
    second as CaptureSchemaLike,
  );
}

/** Alias for integrations that name the operation "interpret". */
export function interpretUpdateMask(
  mask: UpdateMaskLike | null | undefined,
  schema: CaptureSchemaLike,
): string[];
export function interpretUpdateMask(
  schema: CaptureSchemaLike,
  mask: UpdateMaskLike | null | undefined,
): string[];
export function interpretUpdateMask(first: unknown, second: unknown): string[] {
  return parseUpdateMask(first as never, second as never);
}
/** Alias emphasizing the result shape. */
export const maskToColumns = decodeUpdateMask;
export const decodeMask = decodeUpdateMask;
export const parseMask = decodeUpdateMask;
export const getUpdatedColumns = decodeUpdateMask;
export const getChangedColumns = decodeUpdateMask;
export const isBitSet = isMaskBitSet;
export const isUpdateMaskBitSet = isMaskBitSet;
export const isUpdateMaskColumnUpdated = isColumnUpdated;

export function maskBytesEqual(
  left: UpdateMaskLike | null | undefined,
  right: UpdateMaskLike | null | undefined,
): boolean {
  if (left === null || left === undefined || right === null || right === undefined) {
    return (left === null || left === undefined) && (right === null || right === undefined);
  }
  return bytesEqual(
    trimLeadingZeroBytes(toMaskBytes(left)),
    trimLeadingZeroBytes(toMaskBytes(right)),
  );
}

/** The union of two masks, useful when before/after images disagree. */
export function combineUpdateMasks(
  left: UpdateMaskLike | null | undefined,
  right: UpdateMaskLike | null | undefined,
): Uint8Array {
  const a = left === null || left === undefined ? new Uint8Array(0) : toMaskBytes(left);
  const b = right === null || right === undefined ? new Uint8Array(0) : toMaskBytes(right);
  const size = Math.max(a.length, b.length);
  const result = new Uint8Array(size);
  for (let index = 0; index < size; index += 1) {
    result[index] = (a[index] ?? 0) | (b[index] ?? 0);
  }
  return result;
}

function valuesEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (left instanceof Uint8Array && right instanceof Uint8Array) {
    return bytesEqual(left, right);
  }
  if (left instanceof Date && right instanceof Date) {
    return left.getTime() === right.getTime();
  }
  if (Array.isArray(left) && Array.isArray(right)) {
    return (
      left.length === right.length &&
      left.every((value, index) => valuesEqual(value, right[index]))
    );
  }
  if (
    left !== null &&
    right !== null &&
    typeof left === "object" &&
    typeof right === "object"
  ) {
    const leftRecord = left as Record<string, unknown>;
    const rightRecord = right as Record<string, unknown>;
    const leftKeys = Object.keys(leftRecord).sort();
    const rightKeys = Object.keys(rightRecord).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && valuesEqual(leftRecord[key], rightRecord[key]),
      )
    );
  }
  return false;
}

/** Infer changed columns by comparing before/after values (mask fallback). */
export function inferChangedColumns(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  schemaLike: CaptureSchemaLike,
): string[] {
  const schema = normalizeSchema(schemaLike);
  return schema.columns
    .filter((column) => !valuesEqual(before[column.name], after[column.name]))
    .map((column) => column.name);
}

/**
 * Reconstruct the after-image values by applying only the columns selected by
 * the mask to the before-image.  This mirrors what an update mask means even
 * if a partial after-image is supplied.
 */
export function applyUpdateMask(
  before: Record<string, unknown>,
  after: Record<string, unknown>,
  mask: UpdateMaskLike | null | undefined,
  schemaLike: CaptureSchemaLike,
): Record<string, unknown> {
  const schema = normalizeSchema(schemaLike);
  const result: Record<string, unknown> = { ...before };
  for (const column of schema.columns) {
    if (isColumnUpdated(mask, column.ordinal)) {
      if (Object.prototype.hasOwnProperty.call(after, column.name)) {
        result[column.name] = after[column.name];
      }
    } else if (!Object.prototype.hasOwnProperty.call(before, column.name)) {
      if (Object.prototype.hasOwnProperty.call(after, column.name)) {
        result[column.name] = after[column.name];
      }
    }
  }
  return result;
}

export const applyMask = applyUpdateMask;

/** Project the capture-instance columns from a CDC row. */
export function projectCaptureRow(
  row: Record<string, unknown>,
  schemaLike: CaptureSchemaLike,
): Record<string, unknown> {
  const schema = normalizeSchema(schemaLike);
  const projected: Record<string, unknown> = {};
  for (const column of schema.columns) {
    if (Object.prototype.hasOwnProperty.call(row, column.name)) {
      projected[column.name] = row[column.name];
    }
  }
  return projected;
}

export function columnForOrdinal(
  schemaLike: CaptureSchemaLike,
  ordinal: number,
): CaptureColumn | undefined {
  return findColumn(normalizeSchema(schemaLike), ordinal);
}
