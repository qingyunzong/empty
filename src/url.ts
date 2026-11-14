import type { SafeUrl } from "./types.js";

export interface ParsedUrl {
  readonly url: URL;
  readonly safe: SafeUrl;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_URL_LENGTH = 8192;

function hasSecureTransport(url: URL): boolean {
  if (url.protocol === "https:") {
    return true;
  }
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

export function redactUrl(raw: unknown): SafeUrl | null {
  const parsed = parseTopLevelUrl(raw);
  return parsed === null ? null : parsed.safe;
}

export function parseTopLevelUrl(raw: unknown): ParsedUrl | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (!hasSecureTransport(url) || url.username !== "" || url.password !== "") {
    return null;
  }

  const queryKeys = [...new Set(url.searchParams.keys())].sort();
  const safe: SafeUrl = Object.freeze({
    origin: url.origin,
    pathname: url.pathname,
    queryKeys: Object.freeze(queryKeys),
    hasFragment: url.hash !== "",
  });

  return { url, safe };
}

export function parseOrigin(raw: unknown): string | null {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_LENGTH) {
    return null;
  }

  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (
    !hasSecureTransport(url) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== ""
  ) {
    return null;
  }

  return url.origin;
}
