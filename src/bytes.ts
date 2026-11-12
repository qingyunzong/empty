import { EdifactEncodeError, EdifactParseError } from "./errors.js";
import type { Separators } from "./types.js";

const SEPARATOR_ORDER = [
  "component",
  "element",
  "decimal",
  "release",
  "repetition",
  "segment",
] as const;

export function byteOfSeparator(value: string): number {
  if (value.length !== 1) {
    throw new EdifactEncodeError("separator must be exactly one character", "separator");
  }
  return value.charCodeAt(0);
}

export function isAsciiLetterOrDigit(byte: number): boolean {
  return (
    (byte >= 0x41 && byte <= 0x5a) ||
    (byte >= 0x61 && byte <= 0x7a) ||
    (byte >= 0x30 && byte <= 0x39)
  );
}

export function validateSeparatorBytes(bytes: readonly number[], offset?: number): void {
  if (bytes.length !== 6) {
    throw new EdifactParseError("UNA must contain exactly six separator bytes", "una", offset);
  }
  const seen = new Set<number>();
  for (const byte of bytes) {
    if (byte < 0x21 || byte > 0x7e) {
      throw new EdifactParseError(
        "separator byte must be in the printable ASCII range 0x21..0x7E",
        "una",
        offset,
      );
    }
    if (isAsciiLetterOrDigit(byte)) {
      throw new EdifactParseError(
        "separator byte must not be an ASCII letter or digit",
        "una",
        offset,
      );
    }
    if (seen.has(byte)) {
      throw new EdifactParseError("UNA separator bytes must be distinct", "una", offset);
    }
    seen.add(byte);
  }
}

export function separatorsFromBytes(bytes: readonly number[], offset?: number): Separators {
  validateSeparatorBytes(bytes, offset);
  return Object.freeze({
    component: String.fromCharCode(bytes[0]!),
    element: String.fromCharCode(bytes[1]!),
    decimal: String.fromCharCode(bytes[2]!),
    release: String.fromCharCode(bytes[3]!),
    repetition: String.fromCharCode(bytes[4]!),
    segment: String.fromCharCode(bytes[5]!),
  });
}

export function separatorBytes(separators: Separators): number[] {
  const bytes = SEPARATOR_ORDER.map((key) => byteOfSeparator(separators[key]));
  validateSeparatorBytes(bytes);
  return bytes;
}

export function normalizeSeparators(input: Separators | string): Separators {
  try {
    if (typeof input === "string") {
      if (input.length !== 6) {
        throw new EdifactEncodeError(
          "separator string must contain exactly six characters",
          "separator",
        );
      }
      const bytes = Array.from(input, (char) => char.charCodeAt(0));
      return separatorsFromBytes(bytes);
    }

    const values = SEPARATOR_ORDER.map((key) => {
      const value = input[key];
      if (typeof value !== "string" || value.length !== 1) {
        throw new EdifactEncodeError(
          `separator ${key} must be exactly one character`,
          "separator",
        );
      }
      return value.charCodeAt(0);
    });
    return separatorsFromBytes(values);
  } catch (error) {
    if (error instanceof EdifactParseError) {
      throw new EdifactEncodeError(error.message, "separator");
    }
    throw error;
  }
}

export function byteArrayFromChunk(chunk: Uint8Array | string): Uint8Array {
  if (typeof chunk === "string") {
    return new TextEncoder().encode(chunk);
  }
  if (chunk instanceof Uint8Array) {
    return chunk;
  }
  throw new TypeError("chunk must be a Uint8Array or string");
}

const STRICT_UTF8_DECODER = new TextDecoder("utf-8", {
  fatal: true,
  ignoreBOM: true,
});

export function decodeStrictUtf8(bytes: readonly number[], offset: number): string {
  try {
    return STRICT_UTF8_DECODER.decode(Uint8Array.from(bytes));
  } catch {
    throw new EdifactParseError("component is not valid strict UTF-8", "utf8", offset);
  }
}
