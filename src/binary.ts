/**
 * Binary helpers shared by LSN/seqval handling and update-mask handling.
 *
 * SQL Server returns `binary`/`varbinary` values as Node `Buffer` objects in
 * most drivers, but services also often transport them as hex strings.  The
 * helpers in this module deliberately accept all common representations.
 */

export type BinaryLike =
  | string
  | number
  | bigint
  | Uint8Array
  | ArrayBuffer
  | readonly number[]
  | { type: "Buffer"; data: readonly number[] }
  | { type: "Buffer"; data: ArrayBuffer | Uint8Array }
  | { data: readonly number[] };

const HEX_RE = /^[0-9a-f]+$/i;

function assertByte(value: number): number {
  if (!Number.isInteger(value) || value < 0 || value > 255) {
    throw new RangeError(`Invalid byte value: ${String(value)}`);
  }
  return value;
}

function bytesFromArrayLike(value: ArrayLike<number>): Uint8Array {
  const bytes = new Uint8Array(value.length);
  for (let index = 0; index < value.length; index += 1) {
    bytes[index] = assertByte(value[index]);
  }
  return bytes;
}

function bytesFromHex(value: string): Uint8Array {
  let hex = value.trim();
  if (hex.startsWith("0x") || hex.startsWith("0X")) {
    hex = hex.slice(2);
  }

  hex = hex.replace(/[\s:_-]/g, "");
  if (hex.length === 0) {
    return new Uint8Array(0);
  }
  if (!HEX_RE.test(hex)) {
    throw new TypeError(`Invalid hexadecimal value: ${value}`);
  }
  if (hex.length % 2 !== 0) {
    hex = `0${hex}`;
  }

  const bytes = new Uint8Array(hex.length / 2);
  for (let index = 0; index < bytes.length; index += 1) {
    bytes[index] = Number.parseInt(hex.slice(index * 2, index * 2 + 2), 16);
  }
  return bytes;
}

/**
 * Convert a value that represents SQL Server binary data to bytes.
 *
 * Accepted forms: `Uint8Array`/`Buffer`, `ArrayBuffer`, number arrays, hex
 * strings (with or without `0x`), and the JSON shape produced for a Buffer.
 */
export function toBytes(value: BinaryLike): Uint8Array {
  if (typeof value === "string") {
    return bytesFromHex(value);
  }
  if (typeof value === "number" || typeof value === "bigint") {
    return unsignedIntegerToBytes(value);
  }
  if (value instanceof Uint8Array) {
    return Uint8Array.from(value);
  }
  if (value instanceof ArrayBuffer) {
    return new Uint8Array(value.slice(0));
  }
  if (Array.isArray(value)) {
    return bytesFromArrayLike(value);
  }
  if (value !== null && typeof value === "object") {
    if ("data" in value) {
      const data = value.data;
      if (data instanceof Uint8Array) {
        return Uint8Array.from(data);
      }
      if (data instanceof ArrayBuffer) {
        return new Uint8Array(data.slice(0));
      }
      if (Array.isArray(data)) {
        return bytesFromArrayLike(data);
      }
    }
  }
  throw new TypeError(`Unsupported binary value: ${String(value)}`);
}

export function bytesToHex(bytes: Uint8Array, withPrefix = false): string {
  let hex = "";
  for (const byte of bytes) {
    hex += byte.toString(16).padStart(2, "0");
  }
  return withPrefix ? `0x${hex}` : hex;
}

/** Remove leading zero bytes, keeping one byte for the value zero. */
export function trimLeadingZeroBytes(bytes: Uint8Array): Uint8Array {
  let offset = 0;
  while (offset < bytes.length - 1 && bytes[offset] === 0) {
    offset += 1;
  }
  return bytes.slice(offset);
}

/**
 * Normalize an LSN or seqval to a stable, display-friendly `0x` hex string.
 * Byte length is preserved so callers can still see the SQL `binary(10)`
 * representation.
 */
export function normalizeLsn(value: BinaryLike): string {
  return bytesToHex(toBytes(value), true);
}

/**
 * Canonical key form for an LSN/seqval.  Leading zero bytes are irrelevant
 * when comparing SQL binary values, so they are removed here.
 */
export function canonicalLsn(value: BinaryLike): string {
  return bytesToHex(trimLeadingZeroBytes(toBytes(value)));
}

/** Compare two SQL Server LSN/seqval values. */
export function compareLsn(left: BinaryLike, right: BinaryLike): number {
  const a = trimLeadingZeroBytes(toBytes(left));
  const b = trimLeadingZeroBytes(toBytes(right));
  if (a.length !== b.length) {
    return a.length < b.length ? -1 : 1;
  }
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) {
      return a[index] < b[index] ? -1 : 1;
    }
  }
  return 0;
}

export function lsnEquals(left: BinaryLike, right: BinaryLike): boolean {
  return compareLsn(left, right) === 0;
}

export function bytesEqual(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) {
    return false;
  }
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return false;
    }
  }
  return true;
}

/**
 * Convert an unsigned integer to the shortest big-endian byte representation
 * of at least one byte.  This is convenient for tests and for masks supplied
 * as plain integers.
 */
export function unsignedIntegerToBytes(value: number | bigint): Uint8Array {
  let current = typeof value === "bigint" ? value : BigInt(value);
  if (current < 0n) {
    throw new RangeError("Binary values must not be negative");
  }
  if (current === 0n) {
    return new Uint8Array([0]);
  }
  const bytes: number[] = [];
  while (current > 0n) {
    bytes.unshift(Number(current & 0xffn));
    current >>= 8n;
  }
  return Uint8Array.from(bytes);
}

/** Parse an update mask supplied as bytes, a hex string, or an integer. */
export function toMaskBytes(value: BinaryLike | number | bigint): Uint8Array {
  if (typeof value === "number" || typeof value === "bigint") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new RangeError("Update mask numbers must be safe integers");
    }
    return unsignedIntegerToBytes(value);
  }
  return toBytes(value);
}

/**
 * JSON-safe encoding for binary values inside persisted rows.  The merger
 * snapshot may contain arbitrary driver rows, and a Buffer would otherwise
 * turn into a driver-specific object when serialized.
 */
export function encodeBinaryForJson(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return { __cdc_binary__: bytesToHex(value, true) };
  }
  if (value instanceof ArrayBuffer) {
    return { __cdc_binary__: bytesToHex(new Uint8Array(value), true) };
  }
  if (value instanceof Date) {
    return { __cdc_date__: value.toISOString() };
  }
  if (typeof value === "bigint") {
    return { __cdc_bigint__: value.toString() };
  }
  if (Array.isArray(value)) {
    return value.map(encodeBinaryForJson);
  }
  if (value !== null && typeof value === "object") {
    const encoded: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      encoded[key] = encodeBinaryForJson(child);
    }
    return encoded;
  }
  return value;
}

export function decodeBinaryFromJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(decodeBinaryFromJson);
  }
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record);
    if (keys.length === 1 && keys[0] === "__cdc_binary__") {
      return toBytes(String(record.__cdc_binary__));
    }
    if (keys.length === 1 && keys[0] === "__cdc_date__") {
      return new Date(String(record.__cdc_date__));
    }
    if (keys.length === 1 && keys[0] === "__cdc_bigint__") {
      return BigInt(String(record.__cdc_bigint__));
    }
    const decoded: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(record)) {
      decoded[key] = decodeBinaryFromJson(child);
    }
    return decoded;
  }
  return value;
}
