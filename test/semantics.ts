/**
 * Independent semantic-equivalence oracle used only by tests.
 *
 * It deliberately uses different algorithms than src/cacheKey.ts
 * (segment-stack path canonicalization, regex-driven percent decoding,
 * its own list/cookie item parser) so the exhaustive test cross-checks
 * the library against a separately written interpretation of the same
 * semantic contract:
 *
 *   Two requests are semantically equivalent (with respect to a keyed
 *   header allowlist) iff
 *     - methods are equal case-insensitively,
 *     - paths are equal per RFC 3986 (unreserved decoding, hex case,
 *       dot-segment removal),
 *     - queries are both absent or equal per percent-encoding
 *       normalization,
 *     - for every keyed header name, the ordered list of semantic items
 *       (comma-separated, or ";"-separated cookie pairs) is equal,
 *       ignoring OWS and empty items.
 *   Non-keyed headers never affect equivalence.
 */
import type { RawRequest } from '../src/cacheKey.js';

function toPairs(headers: RawRequest['headers']): Array<[string, string]> {
  if (headers === undefined) return [];
  if (Array.isArray(headers)) {
    return (headers as ReadonlyArray<readonly [string, string]>).map(([n, v]) => [n, v]);
  }
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(headers)) {
    if (Array.isArray(value)) {
      for (const v of value) out.push([name, v]);
    } else {
      out.push([name, value as string]);
    }
  }
  return out;
}

function decodeUnreserved(input: string): string {
  return input.replace(/%([0-9A-Fa-f]{2})/g, (whole, hex: string) => {
    const ch = String.fromCharCode(parseInt(hex, 16));
    return /[A-Za-z0-9._~-]/.test(ch) ? ch : '%' + hex.toUpperCase();
  });
}

/** Segment-stack canonicalization (different algorithm than the library). */
function canonicalPath(path: string): string {
  if (path === '*') return '*';
  const decoded = decodeUnreserved(path);
  const stack: string[] = [];
  for (const segment of decoded.split('/')) {
    if (segment === '.') continue;
    if (segment === '..') {
      if (stack.length > 1 || (stack.length === 1 && stack[0] !== '')) stack.pop();
      continue;
    }
    stack.push(segment);
  }
  let result = stack.join('/');
  if (/\/(\.|\.\.)?$/.test(decoded) && !result.endsWith('/')) result += '/';
  return result === '' ? '/' : result;
}

function canonicalQuery(query: string | null): string | null {
  return query === null ? null : decodeUnreserved(query);
}

function splitTarget(target: string): { path: string; query: string | null } {
  const q = target.indexOf('?');
  return q === -1
    ? { path: target, query: null }
    : { path: target.slice(0, q), query: target.slice(q + 1) };
}

/** Quote-aware whitespace collapse, implemented independently. */
function collapseWs(input: string): string {
  let out = '';
  let inQuote = false;
  let space = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i]!;
    if (inQuote) {
      out += c;
      if (c === '\\' && i + 1 < input.length) out += input[++i]!;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === ' ' || c === '\t') {
      space = out.length > 0;
      continue;
    }
    if (space) {
      out += ' ';
      space = false;
    }
    if (c === '"') inQuote = true;
    out += c;
  }
  return out;
}

function listItems(value: string): string[] {
  const items: string[] = [];
  let current = '';
  let inQuote = false;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (inQuote) {
      current += c;
      if (c === '\\' && i + 1 < value.length) current += value[++i]!;
      else if (c === '"') inQuote = false;
      continue;
    }
    if (c === '"') {
      inQuote = true;
      current += c;
    } else if (c === ',') {
      items.push(current);
      current = '';
    } else {
      current += c;
    }
  }
  items.push(current);
  return items.map(collapseWs).filter((item) => item.length > 0);
}

function cookieItems(value: string): string[] {
  return value
    .split(';')
    .map(collapseWs)
    .filter((pair) => pair.length > 0);
}

function semanticItems(name: string, value: string): string[] {
  return name === 'cookie' ? cookieItems(value) : listItems(value);
}

function keyedHeaderMap(pairs: Array<[string, string]>, keyHeaders: ReadonlySet<string>): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (!keyHeaders.has(lower)) continue;
    const items = semanticItems(lower, value);
    const existing = map.get(lower);
    if (existing) existing.push(...items);
    else map.set(lower, [...items]);
  }
  return map;
}

function headerMapsEqual(a: Map<string, string[]>, b: Map<string, string[]>): boolean {
  const aNonEmpty = [...a.entries()].filter(([, items]) => items.length > 0);
  const bNonEmpty = [...b.entries()].filter(([, items]) => items.length > 0);
  if (aNonEmpty.length !== bNonEmpty.length) return false;
  for (const [name, items] of aNonEmpty) {
    const other = b.get(name);
    if (!other || other.length !== items.length) return false;
    for (let i = 0; i < items.length; i++) {
      if (items[i] !== other[i]) return false;
    }
  }
  return true;
}

export function semanticallyEquivalent(a: RawRequest, b: RawRequest, keyHeaders: readonly string[]): boolean {
  if (a.method.toUpperCase() !== b.method.toUpperCase()) return false;
  const ta = splitTarget(a.target);
  const tb = splitTarget(b.target);
  if (canonicalPath(ta.path) !== canonicalPath(tb.path)) return false;
  if (canonicalQuery(ta.query) !== canonicalQuery(tb.query)) return false;
  const keySet = new Set([...keyHeaders].map((h) => h.toLowerCase()));
  return headerMapsEqual(keyedHeaderMap(toPairs(a.headers), keySet), keyedHeaderMap(toPairs(b.headers), keySet));
}
