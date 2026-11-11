import {
  type OriginParts,
  defaultPortFor,
  normalizePath,
  pathPrefixMatch,
} from "./url.js";

interface KeywordSource {
  kind: "keyword";
  value: "none" | "self";
}

interface SchemeSource {
  kind: "scheme";
  scheme: string;
}

interface HostSource {
  kind: "host";
  scheme?: string;
  wildcard: boolean;
  host: string;
  port?: number;
  pathPrefix?: string;
}

type ParsedSource = KeywordSource | SchemeSource | HostSource;

const HOST_PATTERN =
  /^(?<wildcard>\*\.)?(?<host>[a-zA-Z0-9](?:[a-zA-Z0-9._\-]*[a-zA-Z0-9])?)(?::(?<port>\d+))?(?<path>\/.*)?$/;
const PREFIX_PATTERN = /^(?<scheme>[a-zA-Z][a-zA-Z0-9+.\-]*):(?<slashes>\/\/)?(?<rest>.*)$/;

/**
 * Parse one source expression.
 *  - `scheme:` (nothing after the colon) is a scheme source;
 *  - `scheme://host...` is a host source with an explicit scheme;
 *  - anything before the first colon without `//` (e.g. `cdn.test:8443`) is a
 *    host with a port, not a scheme, so it is re-joined and parsed as a host.
 */
export function parseSource(expression: string): ParsedSource {
  const trimmed = expression.trim();
  const lower = trimmed.toLowerCase();
  if (lower === "'none'" || lower === "none") {
    return { kind: "keyword", value: "none" };
  }
  if (lower === "'self'" || lower === "self") {
    return { kind: "keyword", value: "self" };
  }

  const match = PREFIX_PATTERN.exec(trimmed);
  if (match && match.groups) {
    const { scheme, slashes, rest } = match.groups;
    if (slashes === "//") {
      return parseHost(rest, scheme, expression);
    }
    if (rest === "") {
      return { kind: "scheme", scheme: `${scheme.toLowerCase()}:` };
    }
    return parseHost(`${scheme}:${rest}`, undefined, expression);
  }
  return parseHost(trimmed, undefined, expression);
}

function parseHost(
  rest: string,
  scheme: string | undefined,
  original: string,
): HostSource {
  const hostMatch = HOST_PATTERN.exec(rest);
  if (!hostMatch || !hostMatch.groups) {
    throw new Error(`Invalid host source: ${original}`);
  }
  const { wildcard, host, port, path } = hostMatch.groups;
  const source: HostSource = {
    kind: "host",
    wildcard: wildcard !== undefined,
    host: host.toLowerCase(),
  };
  if (scheme !== undefined) {
    source.scheme = `${scheme.toLowerCase()}:`;
  }
  if (port !== undefined) {
    source.port = Number(port);
  }
  if (path !== undefined) {
    source.pathPrefix = path;
  }
  return source;
}

export interface MatchTarget {
  url: URL;
  origin: OriginParts;
  normalizedPath: string | null;
}

export function matchSource(
  parsed: ParsedSource,
  target: MatchTarget,
  page: OriginParts,
): boolean {
  if (parsed.kind === "keyword") {
    if (parsed.value === "none") {
      return false;
    }
    return (
      target.origin.scheme === page.scheme &&
      target.origin.host === page.host &&
      target.origin.port === page.port
    );
  }

  if (parsed.kind === "scheme") {
    return target.origin.scheme === parsed.scheme;
  }

  if (!hostMatches(parsed, target.origin.host)) {
    return false;
  }

  const expectedScheme = parsed.scheme ?? page.scheme;
  if (target.origin.scheme !== expectedScheme) {
    return false;
  }

  const expectedPort = parsed.port ?? defaultPortFor(expectedScheme) ?? 0;
  if (target.origin.port !== expectedPort) {
    return false;
  }

  if (parsed.pathPrefix !== undefined) {
    if (target.normalizedPath === null) {
      return false;
    }
    const normalizedPrefix = normalizePath(parsed.pathPrefix);
    if (normalizedPrefix === null) {
      return false;
    }
    if (!pathPrefixMatch(normalizedPrefix, target.normalizedPath)) {
      return false;
    }
  }
  return true;
}

/**
 * `*.example.test` matches subdomains only (`a.example.test`,
 * `a.b.example.test`) and never the bare `example.test`.
 */
function hostMatches(source: HostSource, targetHost: string): boolean {
  if (source.wildcard) {
    return (
      targetHost.endsWith(`.${source.host}`) &&
      targetHost.length > source.host.length + 1
    );
  }
  return targetHost === source.host;
}
