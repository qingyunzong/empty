'use strict';

// Restricted regular-expression parser.
// Supported constructs: literals, character classes ([abc], [a-z], [^...]),
// concatenation, union (|), star (*), optional (?), and parentheses.
// Everything else (backreferences, +, {n}, ., ^, $, ...) is rejected with
// code BAD_REGEX. Rules are limited to MAX_RULE_LENGTH characters.

const MAX_RULE_LENGTH = 80;
const MAX_CP = 0x10ffff;

class RegexError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RegexError';
    this.code = 'BAD_REGEX';
  }
}

const UNSUPPORTED = new Set(['+', '{', '}', '.', '^', '$']);
const ESCAPABLE = new Set(['|', '*', '?', '(', ')', '[', ']', '\\', '+', '{', '}', '.', '^', '$', '-']);

function normalizeRanges(ranges) {
  const sorted = ranges.map(([lo, hi]) => [lo, hi]).sort((x, y) => x[0] - y[0] || x[1] - y[1]);
  const out = [];
  for (const [lo, hi] of sorted) {
    const last = out[out.length - 1];
    if (last && lo <= last[1] + 1) last[1] = Math.max(last[1], hi);
    else out.push([lo, hi]);
  }
  return out;
}

function complementRanges(ranges) {
  const out = [];
  let next = 0;
  for (const [lo, hi] of ranges) {
    if (lo > next) out.push([next, lo - 1]);
    next = hi + 1;
  }
  if (next <= MAX_CP) out.push([next, MAX_CP]);
  return out;
}

class Parser {
  constructor(pattern) {
    this.pattern = pattern;
    this.pos = 0;
  }

  peek() {
    return this.pattern[this.pos];
  }

  readCp() {
    const cp = this.pattern.codePointAt(this.pos);
    this.pos += cp > 0xffff ? 2 : 1;
    return cp;
  }

  readEscapedCp() {
    if (this.pos >= this.pattern.length) throw new RegexError('trailing backslash');
    const cp = this.readCp();
    const ch = String.fromCodePoint(cp);
    if (cp >= 0x30 && cp <= 0x39) throw new RegexError('backreferences are not supported');
    if (!ESCAPABLE.has(ch)) throw new RegexError(`unsupported escape '\\${ch}'`);
    return cp;
  }

  parse() {
    const node = this.parseUnion();
    if (this.pos < this.pattern.length) {
      throw new RegexError(`unexpected '${this.peek()}' at position ${this.pos}`);
    }
    return node;
  }

  parseUnion() {
    const options = [this.parseConcat()];
    while (this.peek() === '|') {
      this.pos++;
      options.push(this.parseConcat());
    }
    return options.length === 1 ? options[0] : { type: 'union', options };
  }

  parseConcat() {
    const parts = [];
    while (this.pos < this.pattern.length && this.peek() !== '|' && this.peek() !== ')') {
      parts.push(this.parsePostfix());
    }
    if (parts.length === 0) return { type: 'eps' };
    return parts.length === 1 ? parts[0] : { type: 'concat', parts };
  }

  parsePostfix() {
    let node = this.parseAtom();
    for (;;) {
      const ch = this.peek();
      if (ch === '*') {
        this.pos++;
        node = { type: 'star', node };
      } else if (ch === '?') {
        this.pos++;
        node = { type: 'maybe', node };
      } else {
        return node;
      }
    }
  }

  parseAtom() {
    const ch = this.peek();
    if (ch === undefined) throw new RegexError('unexpected end of pattern');
    if (ch === '(') {
      this.pos++;
      const node = this.parseUnion();
      if (this.peek() !== ')') throw new RegexError(`unclosed '(' at position ${this.pos}`);
      this.pos++;
      return node;
    }
    if (ch === '[') return this.parseClass();
    if (ch === '*' || ch === '?') {
      throw new RegexError(`'${ch}' has nothing to repeat at position ${this.pos}`);
    }
    if (UNSUPPORTED.has(ch)) {
      throw new RegexError(`unsupported construct '${ch}' at position ${this.pos}`);
    }
    if (ch === '\\') {
      this.pos++;
      const cp = this.readEscapedCp();
      return { type: 'class', ranges: [[cp, cp]] };
    }
    const cp = this.readCp();
    return { type: 'class', ranges: [[cp, cp]] };
  }

  readClassChar() {
    if (this.pos >= this.pattern.length) throw new RegexError('unclosed character class');
    if (this.pattern[this.pos] === '\\') {
      this.pos++;
      return this.readEscapedCp();
    }
    return this.readCp();
  }

  parseClass() {
    this.pos++; // consume '['
    let negate = false;
    if (this.peek() === '^') {
      negate = true;
      this.pos++;
    }
    const ranges = [];
    let first = true;
    for (;;) {
      if (this.pos >= this.pattern.length) throw new RegexError('unclosed character class');
      if (this.peek() === ']' && !first) {
        this.pos++;
        break;
      }
      first = false;
      const lo = this.readClassChar();
      if (
        this.peek() === '-' &&
        this.pos + 1 < this.pattern.length &&
        this.pattern[this.pos + 1] !== ']'
      ) {
        this.pos++; // consume '-'
        const hi = this.readClassChar();
        if (hi < lo) throw new RegexError('invalid range: lo > hi');
        ranges.push([lo, hi]);
      } else {
        ranges.push([lo, lo]);
      }
    }
    if (ranges.length === 0) throw new RegexError('empty character class');
    const norm = normalizeRanges(ranges);
    return { type: 'class', ranges: negate ? complementRanges(norm) : norm };
  }
}

function parse(pattern) {
  if (typeof pattern !== 'string') throw new RegexError('rule must be a string');
  if (pattern.length > MAX_RULE_LENGTH) {
    throw new RegexError(`rule exceeds ${MAX_RULE_LENGTH} characters`);
  }
  return new Parser(pattern).parse();
}

module.exports = { parse, RegexError, normalizeRanges, complementRanges, MAX_RULE_LENGTH, MAX_CP };
