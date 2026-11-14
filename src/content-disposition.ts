import type { ParsedContentDisposition } from "./types.ts";
import { basename } from "./url.ts";

function splitParameters(value: string): string[] {
  const parts: string[] = [];
  let start = 0;
  let quoted = false;
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\" && quoted) {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      quoted = !quoted;
      continue;
    }
    if (char === ";" && !quoted) {
      parts.push(value.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(value.slice(start));
  return parts;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && trimmed.startsWith("\"") && trimmed.endsWith("\"")) {
    return trimmed
      .slice(1, -1)
      .replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

function decodeExtValue(value: string): string {
  const firstQuote = value.indexOf("'");
  const secondQuote = firstQuote >= 0 ? value.indexOf("'", firstQuote + 1) : -1;
  const charset =
    firstQuote > 0 ? value.slice(0, firstQuote).trim().toLowerCase() : "";
  const encoded =
    secondQuote >= 0 ? value.slice(secondQuote + 1) : value;
  if (charset === "iso-8859-1" || charset === "latin1") {
    return encoded.replace(/%([0-9a-f]{2})/gi, (_, hex: string) =>
      String.fromCharCode(Number.parseInt(hex, 16)),
    );
  }
  try {
    return decodeURIComponent(encoded);
  } catch {
    return encoded;
  }
}

/**
 * Parses RFC 6266 / RFC 5987 Content-Disposition values. filename* wins over
 * filename, matching browser behavior.
 */
export function parseContentDisposition(
  value: string | undefined,
): ParsedContentDisposition | undefined {
  if (!value) {
    return undefined;
  }

  const parts = splitParameters(value);
  const type = (parts.shift() ?? "").trim().toLowerCase();
  const parameters: Record<string, string> = {};
  let filename: string | undefined;
  let filenameStar: string | undefined;

  for (const part of parts) {
    const equals = part.indexOf("=");
    if (equals < 0) {
      continue;
    }
    const rawName = part.slice(0, equals).trim().toLowerCase();
    const rawValue = part.slice(equals + 1).trim();
    if (!rawName) {
      continue;
    }

    if (rawName === "filename*") {
      filenameStar = decodeExtValue(unquote(rawValue));
      parameters[rawName] = filenameStar;
    } else {
      const decoded = unquote(rawValue);
      parameters[rawName] = decoded;
      if (rawName === "filename") {
        filename = decoded;
      }
    }
  }

  return {
    type,
    filename: filenameStar ?? filename,
    filenameStar,
    parameters,
  };
}

export function dispositionFilename(
  value: string | undefined,
): string | undefined {
  return parseContentDisposition(value)?.filename;
}

export function safeFilename(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }
  const name = basename(value).replace(/[\/\\\u0000-\u001f\u007f]/g, "_").trim();
  return name || undefined;
}

export function filenameMatches(
  declared: string | undefined,
  actual: string | undefined,
): boolean {
  const left = safeFilename(declared);
  const right = safeFilename(actual);
  if (!left || !right) {
    return false;
  }
  return left.normalize("NFC") === right.normalize("NFC");
}
