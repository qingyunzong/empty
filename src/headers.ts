import type { HeaderSource } from "./types.ts";

function normalizeValue(value: unknown): string | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  if (Array.isArray(value)) {
    return value.map((part) => String(part)).join(", ");
  }
  return String(value);
}

/**
 * Reads a response header from the common shapes used by fetch, webRequest
 * listeners, download descriptors, and serialized event records.
 */
export function getHeader(
  headers: HeaderSource | undefined,
  name: string,
): string | undefined {
  if (!headers) {
    return undefined;
  }

  const wanted = name.toLowerCase();

  if (typeof Headers !== "undefined" && headers instanceof Headers) {
    const value = headers.get(name);
    return value ?? undefined;
  }

  if (headers instanceof Map) {
    for (const [key, value] of headers) {
      if (String(key).toLowerCase() === wanted) {
        return normalizeValue(value);
      }
    }
    return undefined;
  }

  if (Array.isArray(headers)) {
    const values: string[] = [];
    for (const pair of headers as readonly (readonly [string, string])[]) {
      if (String(pair[0]).toLowerCase() === wanted) {
        values.push(String(pair[1]));
      }
    }
    return values.length > 0 ? values.join(", ") : undefined;
  }

  if (typeof headers === "object" && Symbol.iterator in headers) {
    for (const pair of headers as Iterable<readonly [string, string]>) {
      if (String(pair[0]).toLowerCase() === wanted) {
        return String(pair[1]);
      }
    }
    return undefined;
  }

  for (const [key, value] of Object.entries(headers as Record<string, unknown>)) {
    if (key.toLowerCase() === wanted) {
      return normalizeValue(value);
    }
  }
  return undefined;
}

export function headerContentType(
  headers: HeaderSource | undefined,
): string | undefined {
  const value = getHeader(headers, "content-type");
  return value?.split(";", 1)[0]?.trim().toLowerCase() || undefined;
}

export function headerContentDisposition(
  headers: HeaderSource | undefined,
): string | undefined {
  return getHeader(headers, "content-disposition");
}
