import { isUnreservedByte, isValidEscape } from './percent.js';

export class CanonicalizationError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(message);
    this.name = 'CanonicalizationError';
    this.offset = offset;
  }
}

export interface Span {
  start: number;
  end: number; // exclusive
}

export interface DerivationStep {
  type:
    | 'decode-unreserved'
    | 'normalize-escape-case'
    | 'remove-dot-segment'
    | 'sort-query-params'
    | 'preserve-duplicate-key';
  offset: number; // offset in the original URL where the step applies
  message: string;
  data?: Record<string, unknown>;
}

export interface QueryParamMapping {
  origIndex: number; // position among original query pairs (0-based)
  canonIndex: number; // position among sorted canonical pairs (0-based)
  key: string; // canonical key
  value: string; // canonical value ('' when the pair had no '=')
  hasEquals: boolean;
  origPair: Span;
  origKey: Span;
  origValue: Span | null;
  canonPair: Span;
  canonKey: Span;
  canonValue: Span | null;
}

export interface Canonicalization {
  raw: string;
  canonical: string;
  canonicalBytes: Buffer;
  canonicalPath: string;
  canonicalQuery: string | null;
  // canonical offset -> original span (null for synthetic chars such as
  // re-ordered '&' separators)
  canonToOrig: Array<Span | null>;
  // original offset -> canonical offset, or -1 when the character was
  // removed by normalization (e.g. dot segments)
  origToCanon: Int32Array;
  params: QueryParamMapping[]; // in canonical (sorted) order
  steps: DerivationStep[];
}

// One canonical output character and where it came from.
interface OutChar {
  ch: string;
  src: number; // original offset, -1 for synthetic characters
  len: number; // number of original characters consumed (1 or 3)
}

interface UrlParts {
  prefixEnd: number; // length of the "scheme://authority" prefix (0 if none)
  pathStart: number;
  pathEnd: number;
  hasQuery: boolean;
  queryPos: number; // index of '?' (-1 when absent)
  queryStart: number;
  queryEnd: number;
  hasFragment: boolean;
  fragPos: number; // index of '#' (-1 when absent)
}

function splitUrl(raw: string): UrlParts {
  const fragPos = raw.indexOf('#');
  const regionEnd = fragPos === -1 ? raw.length : fragPos;
  const q = raw.indexOf('?');
  const hasQuery = q !== -1 && q < regionEnd;
  const pathEnd = hasQuery ? q : regionEnd;
  const prefix = /^[A-Za-z][A-Za-z0-9+.-]*:\/\/[^/?#]*/.exec(raw);
  const prefixEnd = prefix ? prefix[0].length : 0;
  return {
    prefixEnd,
    pathStart: prefixEnd,
    pathEnd,
    hasQuery,
    queryPos: hasQuery ? q : -1,
    queryStart: hasQuery ? q + 1 : -1,
    queryEnd: hasQuery ? regionEnd : -1,
    hasFragment: fragPos !== -1,
    fragPos,
  };
}

// Percent pass: decode unreserved-only escapes, uppercase the hex of every
// escape that remains, reject malformed escapes for the whole input.
function percentNormalize(raw: string, base: number, steps: DerivationStep[]): OutChar[] {
  const out: OutChar[] = [];
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (c !== '%') {
      out.push({ ch: c, src: base + i, len: 1 });
      continue;
    }
    const triplet = raw.slice(i + 1, i + 3);
    if (triplet.length < 2 || !isValidEscape(triplet)) {
      throw new CanonicalizationError(
        `invalid percent escape at offset ${base + i}: %${triplet}`,
        base + i,
      );
    }
    const byte = parseInt(triplet, 16);
    if (isUnreservedByte(byte)) {
      const decoded = String.fromCharCode(byte);
      out.push({ ch: decoded, src: base + i, len: 3 });
      steps.push({
        type: 'decode-unreserved',
        offset: base + i,
        message: `%${triplet} decodes to unreserved '${decoded}'`,
      });
    } else {
      const upper = triplet.toUpperCase();
      out.push(
        { ch: '%', src: base + i, len: 1 },
        { ch: upper[0], src: base + i + 1, len: 1 },
        { ch: upper[1], src: base + i + 2, len: 1 },
      );
      if (upper !== triplet) {
        steps.push({
          type: 'normalize-escape-case',
          offset: base + i,
          message: `%${triplet} uppercased to %${upper} (reserved/non-ASCII byte stays encoded)`,
        });
      }
    }
    i += 2;
  }
  return out;
}

// RFC 3986 section 5.2.4 remove_dot_segments, keeping per-character origins.
function removeDotSegments(input: OutChar[], steps: DerivationStep[]): OutChar[] {
  const out: OutChar[] = [];
  let i = 0;
  const startsWith = (s: string): boolean => {
    for (let k = 0; k < s.length; k++) {
      if (i + k >= input.length || input[i + k].ch !== s[k]) return false;
    }
    return true;
  };
  const dropLastSegment = (): void => {
    while (out.length > 0 && out[out.length - 1].ch !== '/') out.pop();
    if (out.length > 0) out.pop(); // the preceding '/'
  };
  const step = (segment: string): void => {
    steps.push({
      type: 'remove-dot-segment',
      offset: input[i].src,
      message: `dot segment '${segment}' removed`,
      data: { segment },
    });
  };
  while (i < input.length) {
    if (startsWith('../')) {
      step('../');
      i += 2;
    } else if (startsWith('./')) {
      step('./');
      i += 2;
    } else if (startsWith('/./')) {
      step('/./');
      i += 2; // the remaining '/' starts the next segment
    } else if (startsWith('/.') && i + 2 === input.length) {
      step('/.');
      out.push({ ch: '/', src: input[i].src, len: 1 });
      i += 2;
    } else if (startsWith('/../')) {
      step('/../');
      dropLastSegment();
      i += 3;
    } else if (startsWith('/..') && i + 3 === input.length) {
      step('/..');
      dropLastSegment();
      out.push({ ch: '/', src: input[i].src, len: 1 });
      i += 3;
    } else if (input[i].ch === '.' && i + 1 === input.length) {
      step('.');
      i += 1;
    } else if (input[i].ch === '.' && input[i + 1]?.ch === '.' && i + 2 === input.length) {
      step('..');
      i += 2;
    } else {
      if (input[i].ch === '/') {
        out.push(input[i]);
        i++;
      }
      while (i < input.length && input[i].ch !== '/') {
        out.push(input[i]);
        i++;
      }
    }
  }
  return out;
}

interface RawPair {
  index: number;
  pairStart: number;
  pairEnd: number;
  keyStart: number;
  keyEnd: number;
  hasEq: boolean;
  valueStart: number;
  valueEnd: number;
}

function splitQueryPairs(raw: string, start: number, end: number): RawPair[] {
  const pairs: RawPair[] = [];
  let pairStart = start;
  let index = 0;
  const push = (pairEnd: number): void => {
    let eq = -1;
    for (let k = pairStart; k < pairEnd; k++) {
      if (raw[k] === '=') {
        eq = k;
        break;
      }
    }
    const hasEq = eq !== -1;
    pairs.push({
      index: index++,
      pairStart,
      pairEnd,
      keyStart: pairStart,
      keyEnd: hasEq ? eq : pairEnd,
      hasEq,
      valueStart: hasEq ? eq + 1 : pairEnd,
      valueEnd: pairEnd,
    });
  };
  for (let k = start; k < end; k++) {
    if (raw[k] === '&') {
      push(k);
      pairStart = k + 1;
    }
  }
  push(end);
  return pairs;
}

function compareBytes(a: Buffer, b: Buffer): number {
  return Buffer.compare(a, b);
}

export function canonicalizeUrl(raw: string): Canonicalization {
  const steps: DerivationStep[] = [];
  const parts = splitUrl(raw);
  const chars: OutChar[] = [];

  for (let i = 0; i < parts.prefixEnd; i++) {
    chars.push({ ch: raw[i], src: i, len: 1 });
  }

  const pathChars = removeDotSegments(
    percentNormalize(raw.slice(parts.pathStart, parts.pathEnd), parts.pathStart, steps),
    steps,
  );
  chars.push(...pathChars);
  const canonicalPath = pathChars.map((c) => c.ch).join('');

  const params: QueryParamMapping[] = [];
  let canonicalQuery: string | null = null;

  if (parts.hasQuery) {
    chars.push({ ch: '?', src: parts.queryPos, len: 1 });
    const queryBase = chars.length;

    const pairs = splitQueryPairs(raw, parts.queryStart, parts.queryEnd);
    interface CanonPair {
      raw: RawPair;
      key: string;
      value: string;
      keyChars: OutChar[];
      valueChars: OutChar[];
      keyBytes: Buffer;
      valueBytes: Buffer;
    }
    const canonPairs: CanonPair[] = pairs.map((pair) => {
      const keyChars = percentNormalize(raw.slice(pair.keyStart, pair.keyEnd), pair.keyStart, steps);
      const valueChars = pair.hasEq
        ? percentNormalize(raw.slice(pair.valueStart, pair.valueEnd), pair.valueStart, steps)
        : [];
      const key = keyChars.map((c) => c.ch).join('');
      const value = valueChars.map((c) => c.ch).join('');
      return {
        raw: pair,
        key,
        value,
        keyChars,
        valueChars,
        keyBytes: Buffer.from(key, 'utf8'),
        valueBytes: Buffer.from(value, 'utf8'),
      };
    });

    // Stable sort by key bytes, then value bytes; duplicates are preserved.
    const sorted = canonPairs.slice().sort((a, b) => {
      const byKey = compareBytes(a.keyBytes, b.keyBytes);
      return byKey !== 0 ? byKey : compareBytes(a.valueBytes, b.valueBytes);
    });

    const order = sorted.map((p) => p.raw.index);
    if (order.some((origIdx, sortedIdx) => origIdx !== sortedIdx)) {
      steps.push({
        type: 'sort-query-params',
        offset: parts.queryStart,
        message: `query pairs sorted by key/value bytes: original order [${order.join(', ')}]`,
        data: { order },
      });
    }

    const keyCounts = new Map<string, number>();
    for (const p of sorted) keyCounts.set(p.key, (keyCounts.get(p.key) ?? 0) + 1);
    for (const [key, count] of keyCounts) {
      if (count > 1) {
        steps.push({
          type: 'preserve-duplicate-key',
          offset: parts.queryStart,
          message: `duplicate key '${key}' preserved (${count} occurrences)`,
          data: { key, count },
        });
      }
    }

    sorted.forEach((pair, canonIndex) => {
      if (canonIndex > 0) chars.push({ ch: '&', src: -1, len: 0 });
      const pairStart = chars.length;
      chars.push(...pair.keyChars);
      const keyEnd = chars.length;
      let valueSpan: Span | null = null;
      if (pair.raw.hasEq) {
        const eqPos = pair.raw.keyEnd;
        chars.push({ ch: '=', src: eqPos, len: 1 });
        const valueStart = chars.length;
        chars.push(...pair.valueChars);
        valueSpan = { start: valueStart, end: chars.length };
      }
      params.push({
        origIndex: pair.raw.index,
        canonIndex,
        key: pair.key,
        value: pair.value,
        hasEquals: pair.raw.hasEq,
        origPair: { start: pair.raw.pairStart, end: pair.raw.pairEnd },
        origKey: { start: pair.raw.keyStart, end: pair.raw.keyEnd },
        origValue: pair.raw.hasEq ? { start: pair.raw.valueStart, end: pair.raw.valueEnd } : null,
        canonPair: { start: pairStart, end: chars.length },
        canonKey: { start: pairStart, end: keyEnd },
        canonValue: valueSpan,
      });
    });

    canonicalQuery = chars
      .slice(queryBase)
      .map((c) => c.ch)
      .join('');
  }

  if (parts.hasFragment) {
    for (let i = parts.fragPos; i < raw.length; i++) {
      chars.push({ ch: raw[i], src: i, len: 1 });
    }
  }

  const canonical = chars.map((c) => c.ch).join('');
  const canonToOrig: Array<Span | null> = chars.map((c) =>
    c.src >= 0 ? { start: c.src, end: c.src + c.len } : null,
  );
  const origToCanon = new Int32Array(raw.length).fill(-1);
  chars.forEach((c, canonOffset) => {
    if (c.src < 0) return;
    for (let o = c.src; o < c.src + c.len; o++) origToCanon[o] = canonOffset;
  });

  return {
    raw,
    canonical,
    canonicalBytes: Buffer.from(canonical, 'utf8'),
    canonicalPath,
    canonicalQuery,
    canonToOrig,
    origToCanon,
    params,
    steps,
  };
}

// Bidirectional mapping accessors.
export function canonicalOffsetToOriginal(c: Canonicalization, offset: number): Span | null {
  if (offset < 0 || offset >= c.canonToOrig.length) return null;
  return c.canonToOrig[offset];
}

export function originalOffsetToCanonical(c: Canonicalization, offset: number): number {
  if (offset < 0 || offset >= c.origToCanon.length) return -1;
  return c.origToCanon[offset];
}
