/**
 * Default ports for the schemes a host source may rely on. When a host source
 * or the target URL omits an explicit port, the scheme default is used so
 * that `http://example.test` and `http://example.test:80` compare equal.
 */
const DEFAULT_PORTS: Readonly<Record<string, number>> = {
  "http:": 80,
  "https:": 443,
  "ws:": 80,
  "wss:": 443,
  "ftp:": 21,
};

export interface OriginParts {
  scheme: string;
  host: string;
  port: number;
}

export function defaultPortFor(scheme: string): number | undefined {
  return DEFAULT_PORTS[scheme.toLowerCase()];
}

/**
 * Parse a page origin such as `https://example.test` into comparable parts.
 * Throws when the string is not an absolute hierarchical URL with a host.
 */
export function parseOrigin(origin: string): OriginParts {
  let url: URL;
  try {
    url = new URL(origin);
  } catch {
    throw new TypeError(`Invalid page origin: ${origin}`);
  }
  if (!url.hostname || url.origin === "null") {
    throw new TypeError(`Page origin has no host: ${origin}`);
  }
  const explicit = url.port ? Number(url.port) : undefined;
  return {
    scheme: url.protocol.toLowerCase(),
    host: url.hostname.toLowerCase(),
    port: explicit ?? defaultPortFor(url.protocol) ?? 0,
  };
}

/**
 * Resolve a resource URL against the page origin so protocol-relative
 * (`//cdn.test/x.js`) and relative paths inherit the page scheme/host.
 */
export function resolveTargetUrl(rawUrl: string, pageOrigin: string): URL {
  let url: URL;
  try {
    url = new URL(rawUrl, pageOrigin);
  } catch {
    throw new TypeError(`Invalid resource URL: ${rawUrl}`);
  }
  return url;
}

export function effectivePort(url: URL): number {
  if (url.port) {
    return Number(url.port);
  }
  return defaultPortFor(url.protocol) ?? 0;
}

/**
 * Thrown when a percent-encoded path contains a malformed escape. Callers
 * treat this as a denial rather than trying to salvage the path.
 */
export class BadEscapeError extends Error {
  constructor(path: string) {
    super(`Malformed percent-encoding in path: ${path}`);
    this.name = "BadEscapeError";
  }
}

function percentDecodeOnce(path: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < path.length; i += 1) {
    const ch = path[i];
    if (ch === "%") {
      const hex = path.slice(i + 1, i + 3);
      if (hex.length !== 2 || !/^[0-9a-fA-F]{2}$/.test(hex)) {
        throw new BadEscapeError(path);
      }
      bytes.push(parseInt(hex, 16));
      i += 2;
    } else {
      const code = ch.codePointAt(0) ?? 0;
      if (code > 0xff) {
        bytes.push(...new TextEncoder().encode(ch));
      } else {
        bytes.push(code);
      }
    }
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  } catch {
    throw new BadEscapeError(path);
  }
}

/**
 * Remove `.` and `..` dot segments from an absolute path (RFC 3986
 * remove_dot_segments), implemented as a segment stack so traversal cannot
 * escape the root.
 */
function removeDotSegments(path: string): string {
  const hadTrailingSlash = path.length > 1 && path.endsWith("/");
  const segments = path.split("/");
  const kept: string[] = [];
  segments.forEach((segment, index) => {
    if (index === 0) {
      kept.push(segment); // leading "" keeps the path absolute
    } else if (segment === "" || segment === ".") {
      // empty (double/trailing slash) and current-dir segments are dropped
    } else if (segment === "..") {
      if (kept.length > 1) {
        kept.pop();
      }
    } else {
      kept.push(segment);
    }
  });
  let result = kept.join("/");
  if (result === "") {
    result = "/";
  }
  if (hadTrailingSlash && !result.endsWith("/")) {
    result += "/";
  }
  return result;
}

/**
 * Percent-decode exactly once, then collapse dot segments. Returns null when
 * the path contains a malformed escape so the caller can deny the resource.
 */
export function normalizePath(pathname: string): string | null {
  try {
    const decoded = percentDecodeOnce(pathname);
    return removeDotSegments(decoded);
  } catch (error) {
    if (error instanceof BadEscapeError) {
      return null;
    }
    throw error;
  }
}

/**
 * Segment-wise prefix comparison: every segment of `prefixPath` must equal
 * the leading segments of `targetPath`. Comparing whole segments means
 * `/app` does not match `/apple`, while `/app` does match `/app/x.js`.
 */
export function pathPrefixMatch(prefixPath: string, targetPath: string): boolean {
  if (prefixPath === "/") {
    return true;
  }
  const prefixSegments = prefixPath.split("/");
  const targetSegments = targetPath.split("/");
  while (prefixSegments.length > 0 && prefixSegments[prefixSegments.length - 1] === "") {
    prefixSegments.pop();
  }
  if (prefixSegments.length > targetSegments.length) {
    return false;
  }
  return prefixSegments.every((segment, index) => segment === targetSegments[index]);
}
