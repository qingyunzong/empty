'use strict';

const { AuditError } = require('./errors');

const MAX_RULE_LENGTH = 80;
const MAX_CP = 0x10ffff;

const UNSUPPORTED_METACHARS = new Set(['.', '+', '{', '}', '^', '$']);

function bad(message) {
  throw new AuditError('BAD_REGEX', message);
}

// Restricted audit regex:
//   union   := concat ('|' concat)*
//   concat  := repeat*
//   repeat  := atom ('*' | '?')*
//   atom    := '(' union ')' | class | escape | literal
//   class   := '[' '^'? (char | char '-' char)* ']'
// Literals, character classes, concatenation, union, star, parens and '?'
// are supported. Backreferences (\1 .. \9) and any other construct are
// rejected with BAD_REGEX.
function parseRegex(src) {
  if (typeof src !== 'string') bad('rule must be a string');
  if (src.length === 0) bad('rule is empty');
  if (src.length > MAX_RULE_LENGTH) {
    bad(`rule exceeds ${MAX_RULE_LENGTH} characters (got ${src.length})`);
  }

  let pos = 0;
  const atEnd = () => pos >= src.length;
  const peek = () => src[pos];

  function parseEscape() {
    pos++; // consume backslash
    if (atEnd()) bad('trailing backslash');
    const c = src[pos++];
    if (c >= '0' && c <= '9') bad(`backreference \\${c} is not allowed`);
    if ((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z')) {
      bad(`unsupported escape \\${c}`);
    }
    return c.codePointAt(0);
  }

  function readClassChar() {
    if (peek() === '\\') return parseEscape();
    return src[pos++].codePointAt(0);
  }

  function parseClass() {
    pos++; // consume '['
    let negated = false;
    if (peek() === '^') {
      negated = true;
      pos++;
    }
    const items = [];
    for (;;) {
      if (atEnd()) bad('unterminated character class');
      if (peek() === ']') {
        pos++;
        break;
      }
      const lo = readClassChar();
      if (!atEnd() && peek() === '-' && pos + 1 < src.length && src[pos + 1] !== ']') {
        pos++; // consume '-'
        if (atEnd()) bad('unterminated character class');
        const hi = readClassChar();
        if (hi < lo) {
          bad(`invalid range ${String.fromCodePoint(lo)}-${String.fromCodePoint(hi)}`);
        }
        items.push([lo, hi]);
      } else {
        items.push([lo, lo]);
      }
    }
    return { type: 'class', intervals: normalizeClass(items, negated) };
  }

  function parseAtom() {
    if (atEnd()) bad('unexpected end of rule');
    const c = peek();
    if (c === '(') {
      pos++;
      const node = parseUnion();
      if (atEnd() || peek() !== ')') bad("unbalanced '('");
      pos++;
      return node;
    }
    if (c === '[') return parseClass();
    if (c === '\\') return { type: 'char', code: parseEscape() };
    if (c === '*' || c === '?' || c === '|') bad(`unexpected '${c}' at position ${pos}`);
    if (UNSUPPORTED_METACHARS.has(c)) bad(`unsupported construct '${c}' at position ${pos}`);
    pos++;
    return { type: 'char', code: c.codePointAt(0) };
  }

  function parseRepeat() {
    let node = parseAtom();
    while (!atEnd() && (peek() === '*' || peek() === '?')) {
      const op = src[pos++];
      node = op === '*' ? { type: 'star', child: node } : { type: 'opt', child: node };
    }
    return node;
  }

  function parseConcat() {
    const parts = [];
    while (!atEnd() && peek() !== '|' && peek() !== ')') parts.push(parseRepeat());
    if (parts.length === 0) return { type: 'empty' };
    if (parts.length === 1) return parts[0];
    return { type: 'concat', parts };
  }

  function parseUnion() {
    const options = [parseConcat()];
    while (!atEnd() && peek() === '|') {
      pos++;
      options.push(parseConcat());
    }
    if (options.length === 1) return options[0];
    return { type: 'union', options };
  }

  const ast = parseUnion();
  if (!atEnd()) bad(`unexpected '${peek()}' at position ${pos}`);
  return ast;
}

// Merge sorted/unsorted ranges into disjoint sorted intervals; if negated,
// complement over the full code point range [0, MAX_CP].
function normalizeClass(items, negated) {
  const sorted = items.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const merged = [];
  for (const [lo, hi] of sorted) {
    const last = merged[merged.length - 1];
    if (last && lo <= last[1] + 1) {
      if (hi > last[1]) last[1] = hi;
    } else {
      merged.push([lo, hi]);
    }
  }
  if (!negated) return merged;
  const out = [];
  let next = 0;
  for (const [lo, hi] of merged) {
    if (lo > next) out.push([next, lo - 1]);
    next = Math.max(next, hi + 1);
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
}

module.exports = { parseRegex, MAX_RULE_LENGTH, MAX_CP };
