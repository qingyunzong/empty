/**
 * HTTP cache key library.
 *
 * Builds a canonical cache key from an HTTP request by normalizing:
 *   - the HTTP method (token-validated, uppercased),
 *   - the request target path (RFC 3986 percent-encoding normalization +
 *     dot-segment removal) and query (percent-encoding normalization only),
 *   - an allowlist of header fields (name lowercased, OWS trimmed, list
 *     items normalized, duplicates merged per RFC 7230 / RFC 6265 rules).
 *
 * Safety contract:
 *   - Header names/values containing CR or LF are rejected (header
 *     injection / response splitting), as are other control characters.
 *   - The serialized key is injective (length-prefixed encoding): two
 *     requests share a key only if every normalized component is identical.
 *   - Fields that are NOT part of the key (non-allowlisted headers) are
 *     still validated and are retained in `audit.ignored` together with
 *     their original source position, for auditability.
 */

const HEADER_NAME_RE = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;
const UNRESERVED_RE = /^[A-Za-z0-9._~-]$/;
const HEX_RE = /^[0-9A-Fa-f]$/;

/** Headers whose duplicates merge with "; " instead of ", " (RFC 6265 §5.4). */
const SEMICOLON_SEPARATED: ReadonlySet<string> = new Set(['cookie']);
/** Headers that must never be merged; duplicates among keyed fields are rejected. */
const NOT_MERGEABLE: ReadonlySet<string> = new Set(['set-cookie']);

export class CacheKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheKeyError';
  }
}

export type HeaderTuple = readonly [name: string, value: string];

export interface RawRequest {
  readonly method: string;
  /** Origin-form request target: path plus optional query, e.g. "/a/b?x=1". */
  readonly target: string;
  /** Raw headers as [name, value] tuples (preserves duplicates) or a record. */
  readonly headers?: readonly HeaderTuple[] | Readonly<Record<string, string | readonly string[]>>;
}

export interface CacheKeyOptions {
  /** Header names (case-insensitive) that participate in the cache key. */
  readonly keyHeaders: readonly string[];
}

export interface IgnoredField {
  readonly kind: 'header';
  /** Header name with original casing. */
  readonly name: string;
  readonly value: string;
  /** Provenance, e.g. "headers[3]" or "headers.Accept[1]". */
  readonly source: string;
}

export interface NormalizedRequest {
  readonly method: string;
  readonly path: string;
  readonly query: string | null;
  /** Keyed headers, sorted by lowercased name, duplicates merged. */
  readonly headers: readonly HeaderTuple[];
}

export interface CacheKeyResult {
  /** Canonical, injective serialization of the normalized request. */
  readonly key: string;
  readonly normalized: NormalizedRequest;
  readonly audit: { readonly ignored: readonly IgnoredField[] };
}

interface SourcedHeader {
  readonly name: string;
  readonly value: string;
  readonly source: string;
}

function toSourcedHeaders(headers: RawRequest['headers']): SourcedHeader[] {
  if (headers === undefined) return [];
  if (Array.isArray(headers)) {
    return (headers as readonly HeaderTuple[]).map((tuple, index) => {
      const [name, value] = tuple;
      if (typeof name !== 'string' || typeof value !== 'string') {
        throw new CacheKeyError(`headers[${index}] must be a [string, string] tuple`);
      }
      return { name, value, source: `headers[${index}]` };
    });
  }
  const out: SourcedHeader[] = [];
  for (const [name, value] of Object.entries(headers)) {
    if (typeof value === 'string') {
      out.push({ name, value, source: `headers.${name}` });
    } else if (Array.isArray(value)) {
      value.forEach((v, index) => {
        if (typeof v !== 'string') {
          throw new CacheKeyError(`headers.${name}[${index}] must be a string`);
        }
        out.push({ name, value: v, source: `headers.${name}[${index}]` });
      });
    } else {
      throw new CacheKeyError(`headers.${name} must be a string or an array of strings`);
    }
  }
  return out;
}

function validateHeaderName(name: string, source: string): void {
  if (!HEADER_NAME_RE.test(name)) {
    throw new CacheKeyError(`invalid header name ${JSON.stringify(name)} at ${source}`);
  }
}

function validateFieldValueChars(value: string, source: string): void {
  for (let i = 0; i < value.length; i++) {
    const code = value.charCodeAt(i);
    if (code === 0x0d || code === 0x0a) {
      throw new CacheKeyError(`header value contains CR/LF (possible header injection) at ${source}`);
    }
    if ((code < 0x20 && code !== 0x09) || code === 0x7f) {
      throw new CacheKeyError(`header value contains a control character at ${source}`);
    }
  }
}

function normalizeMethod(method: string): string {
  if (typeof method !== 'string' || !HEADER_NAME_RE.test(method)) {
    throw new CacheKeyError(`invalid HTTP method: ${JSON.stringify(method)}`);
  }
  return method.toUpperCase();
}

function splitTarget(target: string): { path: string; query: string | null } {
  if (typeof target !== 'string' || target.length === 0) {
    throw new CacheKeyError('request target must be a non-empty string');
  }
  for (let i = 0; i < target.length; i++) {
    const code = target.charCodeAt(i);
    if (code <= 0x20 || code === 0x7f) {
      throw new CacheKeyError(`request target contains whitespace or control characters: ${JSON.stringify(target)}`);
    }
  }
  const q = target.indexOf('?');
  const path = q === -1 ? target : target.slice(0, q);
  const query = q === -1 ? null : target.slice(q + 1);
  if (path !== '' && path !== '*' && !path.startsWith('/')) {
    throw new CacheKeyError(`request target must be origin-form (start with '/'): ${JSON.stringify(target)}`);
  }
  return { path, query };
}

/**
 * RFC 3986 §6.2.2: percent-encoding normalization. Hex digits are uppercased
 * and triplets denoting unreserved characters are decoded. Anything else is
 * preserved byte-for-byte. Malformed triplets are rejected.
 */
function normalizePercent(input: string, context: string): string {
  let out = '';
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (c !== '%') {
      out += c;
      continue;
    }
    if (i + 2 >= input.length || !HEX_RE.test(input[i + 1]!) || !HEX_RE.test(input[i + 2]!)) {
      throw new CacheKeyError(`malformed percent-encoding in ${context}: ${JSON.stringify(input)}`);
    }
    const hex = input.slice(i + 1, i + 3).toUpperCase();
    const decoded = String.fromCharCode(parseInt(hex, 16));
    out += UNRESERVED_RE.test(decoded) ? decoded : '%' + hex;
    i += 2;
  }
  return out;
}

function removeLastSegment(output: string): string {
  const index = output.lastIndexOf('/');
  return index === -1 ? '' : output.slice(0, index);
}

/** RFC 3986 §5.2.4 dot-segment removal. */
function removeDotSegments(path: string): string {
  let buf = path;
  let output = '';
  while (buf.length > 0) {
    if (buf.startsWith('../')) {
      buf = buf.slice(3);
    } else if (buf.startsWith('./')) {
      buf = buf.slice(2);
    } else if (buf.startsWith('/./')) {
      buf = '/' + buf.slice(3);
    } else if (buf === '/.') {
      buf = '/';
    } else if (buf.startsWith('/../')) {
      buf = '/' + buf.slice(4);
      output = removeLastSegment(output);
    } else if (buf === '/..') {
      buf = '/';
      output = removeLastSegment(output);
    } else if (buf === '.' || buf === '..') {
      buf = '';
    } else {
      const start = buf.startsWith('/') ? 1 : 0;
      const next = buf.indexOf('/', start);
      if (next === -1) {
        output += buf;
        buf = '';
      } else {
        output += buf.slice(0, next);
        buf = buf.slice(next);
      }
    }
  }
  return output;
}

function normalizePath(rawPath: string): string {
  if (rawPath === '*') return '*';
  const normalized = removeDotSegments(normalizePercent(rawPath, 'path'));
  return normalized === '' ? '/' : normalized;
}

/** Split a header field value into list items on top-level commas (quote-aware). */
function splitListItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (inQuote) {
      current += c;
      if (c === '\\' && i + 1 < value.length) {
        current += value[++i];
      } else if (c === '"') {
        inQuote = false;
      }
      continue;
    }
    if (c === '"') {
      inQuote = true;
      current += c;
      continue;
    }
    if (c === ',') {
      items.push(current);
      current = '';
      continue;
    }
    current += c;
  }
  items.push(current);
  return items;
}

/** Collapse runs of SP/HTAB to a single space and trim, outside quoted strings. */
function collapseWhitespace(item: string): string {
  let out = '';
  let inQuote = false;
  let pending = false;
  for (let i = 0; i < item.length; i++) {
    const c = item[i]!;
    if (inQuote) {
      out += c;
      if (c === '\\' && i + 1 < item.length) {
        out += item[++i];
      } else if (c === '"') {
        inQuote = false;
      }
      continue;
    }
    if (c === ' ' || c === '\t') {
      pending = out.length > 0;
      continue;
    }
    if (pending) {
      out += ' ';
      pending = false;
    }
    if (c === '"') inQuote = true;
    out += c;
  }
  return out;
}

/**
 * List-valued header normalization (RFC 7230 §7): split on top-level commas,
 * normalize whitespace inside items, drop empty items (they carry no
 * semantics), rejoin with ", ".
 */
function normalizeListValue(value: string): string {
  return splitListItems(value)
    .map(collapseWhitespace)
    .filter((item) => item.length > 0)
    .join(', ');
}

/** Cookie normalization (RFC 6265): pairs split on ";", trimmed, rejoined with "; ". */
function normalizeCookieValue(value: string): string {
  return value
    .split(';')
    .map(collapseWhitespace)
    .filter((pair) => pair.length > 0)
    .join('; ');
}

function normalizeFieldValue(name: string, value: string): string {
  return SEMICOLON_SEPARATED.has(name) ? normalizeCookieValue(value) : normalizeListValue(value);
}

/** Length-prefixed part encoding: unambiguous and injective. */
function encodePart(part: string): string {
  return `${part.length}:${part}`;
}

/**
 * Build the cache key for a request.
 *
 * @throws {CacheKeyError} on malformed method/target, CR/LF or control
 *   characters in any header (keyed or not), invalid header names, malformed
 *   percent-encoding, or unmergeable duplicate keyed headers.
 */
export function buildCacheKey(request: RawRequest, options: CacheKeyOptions): CacheKeyResult {
  const keyNames = new Set<string>();
  for (const name of options.keyHeaders) {
    validateHeaderName(name, 'options.keyHeaders');
    keyNames.add(name.toLowerCase());
  }

  const method = normalizeMethod(request.method);
  const { path: rawPath, query: rawQuery } = splitTarget(request.target);
  const path = normalizePath(rawPath);
  const query = rawQuery === null ? null : normalizePercent(rawQuery, 'query');

  const grouped = new Map<string, string[]>();
  const ignored: IgnoredField[] = [];
  for (const { name, value, source } of toSourcedHeaders(request.headers)) {
    validateHeaderName(name, source);
    validateFieldValueChars(value, source);
    const lower = name.toLowerCase();
    if (!keyNames.has(lower)) {
      ignored.push({ kind: 'header', name, value, source });
      continue;
    }
    const list = grouped.get(lower);
    if (list) {
      list.push(value);
    } else {
      grouped.set(lower, [value]);
    }
  }

  const normalizedHeaders: HeaderTuple[] = [];
  const sortedNames = [...grouped.keys()].sort();
  for (const name of sortedNames) {
    const values = grouped.get(name)!;
    if (NOT_MERGEABLE.has(name) && values.length > 1) {
      throw new CacheKeyError(`header "${name}" occurred ${values.length} times and must not be merged`);
    }
    const separator = SEMICOLON_SEPARATED.has(name) ? '; ' : ', ';
    const merged = values
      .map((v) => normalizeFieldValue(name, v))
      .filter((v) => v.length > 0)
      .join(separator);
    // A keyed header that normalizes to no semantic items (e.g. "Accept: ,")
    // is treated as absent, matching the semantic contract.
    if (merged === '') continue;
    normalizedHeaders.push([name, merged]);
  }

  const keyParts: string[] = [method, path, query === null ? 'N' : `Q${query}`];
  for (const [name, value] of normalizedHeaders) {
    keyParts.push(name, value);
  }
  const key = 'ckv1|' + keyParts.map(encodePart).join('|');

  return {
    key,
    normalized: { method, path, query, headers: normalizedHeaders },
    audit: { ignored },
  };
}

/** Two requests hit the same cache entry iff their keys are identical. */
export function cacheKeyEquals(a: CacheKeyResult, b: CacheKeyResult): boolean {
  return a.key === b.key;
}
