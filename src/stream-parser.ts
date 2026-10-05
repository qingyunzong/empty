import { DuplicateKeyError, JsonSyntaxError } from './errors.js';
import { canonicalPointer } from './json-pointer.js';

export interface MaskSpan {
  start: number;
  end: number;
}

type StateKind =
  | 'value'
  | 'string'
  | 'number'
  | 'literal'
  | 'objectKeyOrEnd'
  | 'objectKey'
  | 'objectColon'
  | 'arrayValueOrEnd'
  | 'objectCommaOrEnd'
  | 'arrayCommaOrEnd'
  | 'end';

interface ObjectFrame {
  type: 'object';
  segments: string[];
  keys: Set<string>;
  currentKey: string;
}

interface ArrayFrame {
  type: 'array';
  segments: string[];
  index: number;
}

type Frame = ObjectFrame | ArrayFrame;

const NUMBER_CHARS = new Set([
  '0', '1', '2', '3', '4', '5', '6', '7', '8', '9',
  '-', '+', '.', 'e', 'E',
]);
const NUMBER_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;
const SIMPLE_ESCAPES: Record<string, string> = {
  '"': '"',
  '\\': '\\',
  '/': '/',
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
};

function isWhitespace(ch: string): boolean {
  return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function hexValue(ch: string): number {
  if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
  if (ch >= 'a' && ch <= 'f') return ch.charCodeAt(0) - 87;
  if (ch >= 'A' && ch <= 'F') return ch.charCodeAt(0) - 55;
  return -1;
}

/**
 * Incremental, byte-preserving JSON parser.
 *
 * The parser accepts input in arbitrarily sized chunks (string escapes,
 * including \uXXXX sequences, may straddle chunk boundaries) and validates
 * the full JSON grammar. Object keys are decoded and compared per object;
 * a duplicate decoded key aborts parsing with DuplicateKeyError before any
 * downstream masking output is produced.
 *
 * Values whose canonical JSON pointer is in `targets` are reported as
 * character spans into the joined input; everything else is left untouched
 * so callers can copy non-target bytes verbatim (number lexemes, string
 * escapes, whitespace and key order are never re-serialized).
 */
export class StreamJsonParser {
  private buffer = '';
  private pos = 0;
  private finalized = false;
  private state: StateKind = 'value';
  private readonly stack: Frame[] = [];
  private readonly spans: MaskSpan[] = [];
  private activeMask: { depth: number; start: number } | null = null;

  private stringIsKey = false;
  private stringStart = 0;
  private keyChars = '';
  private escape: 'none' | 'simple' | 'unicode' = 'none';
  private unicodeValue = 0;
  private unicodeDigits = 0;

  private numberStart = 0;

  private literalWord = '';
  private literalMatched = 0;

  constructor(private readonly targets: ReadonlySet<string>) {}

  get input(): string {
    return this.buffer;
  }

  get maskSpans(): readonly MaskSpan[] {
    return this.spans;
  }

  write(chunk: string): void {
    if (this.finalized) {
      throw new Error('write() after end()');
    }
    this.buffer += chunk;
    this.advance();
  }

  end(): void {
    if (this.finalized) {
      throw new Error('end() called twice');
    }
    this.finalized = true;
    this.advance();
    if (this.state !== 'end') {
      throw new JsonSyntaxError('Unexpected end of input', this.pos);
    }
  }

  private advance(): void {
    for (;;) {
      if (this.pos >= this.buffer.length) {
        if (!this.finalized) {
          return;
        }
        switch (this.state) {
          case 'number':
            this.finishNumber(this.pos);
            continue;
          case 'string':
            throw new JsonSyntaxError('Unterminated string', this.stringStart);
          case 'literal':
            throw new JsonSyntaxError('Unexpected end of input in literal', this.pos);
          default:
            return;
        }
      }
      const ch = this.buffer[this.pos] as string;
      switch (this.state) {
        case 'value':
          this.stateValue(ch);
          break;
        case 'objectKeyOrEnd':
          this.stateObjectKeyOrEnd(ch);
          break;
        case 'objectKey':
          this.stateObjectKey(ch);
          break;
        case 'objectColon':
          this.stateObjectColon(ch);
          break;
        case 'arrayValueOrEnd':
          this.stateArrayValueOrEnd(ch);
          break;
        case 'objectCommaOrEnd':
          this.stateObjectCommaOrEnd(ch);
          break;
        case 'arrayCommaOrEnd':
          this.stateArrayCommaOrEnd(ch);
          break;
        case 'string':
          this.stateString();
          break;
        case 'number':
          this.stateNumber();
          break;
        case 'literal':
          this.stateLiteral();
          break;
        case 'end':
          if (isWhitespace(ch)) {
            this.pos++;
            break;
          }
          throw new JsonSyntaxError(
            'Unexpected non-whitespace character after JSON value',
            this.pos,
          );
      }
    }
  }

  private currentValueSegments(): string[] {
    const top = this.stack[this.stack.length - 1];
    if (top === undefined) {
      return [];
    }
    if (top.type === 'object') {
      return [...top.segments, top.currentKey];
    }
    return [...top.segments, String(top.index)];
  }

  private onValueStart(segments: readonly string[], offset: number): void {
    if (this.activeMask !== null || this.targets.size === 0) {
      return;
    }
    if (this.targets.has(canonicalPointer(segments))) {
      this.activeMask = { depth: this.stack.length, start: offset };
    }
  }

  private onValueEnd(offset: number): void {
    if (this.activeMask !== null && this.activeMask.depth === this.stack.length) {
      this.spans.push({ start: this.activeMask.start, end: offset });
      this.activeMask = null;
    }
  }

  private afterValue(): void {
    if (this.stack.length === 0) {
      this.state = 'end';
      return;
    }
    const top = this.stack[this.stack.length - 1] as Frame;
    this.state = top.type === 'object' ? 'objectCommaOrEnd' : 'arrayCommaOrEnd';
  }

  private closeContainer(): void {
    this.stack.pop();
    this.onValueEnd(this.pos);
    this.afterValue();
  }

  private beginString(isKey: boolean): void {
    this.stringIsKey = isKey;
    this.stringStart = this.pos;
    this.keyChars = '';
    this.escape = 'none';
    this.state = 'string';
    this.pos++;
  }

  private stateValue(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    const segments = this.currentValueSegments();
    switch (ch) {
      case '{':
        this.onValueStart(segments, this.pos);
        this.stack.push({ type: 'object', segments, keys: new Set(), currentKey: '' });
        this.state = 'objectKeyOrEnd';
        this.pos++;
        return;
      case '[':
        this.onValueStart(segments, this.pos);
        this.stack.push({ type: 'array', segments, index: 0 });
        this.state = 'arrayValueOrEnd';
        this.pos++;
        return;
      case '"':
        this.onValueStart(segments, this.pos);
        this.beginString(false);
        return;
      case 't':
      case 'f':
      case 'n':
        this.onValueStart(segments, this.pos);
        this.literalWord = ch === 't' ? 'true' : ch === 'f' ? 'false' : 'null';
        this.literalMatched = 0;
        this.state = 'literal';
        return;
      default:
        if (ch === '-' || isDigit(ch)) {
          this.onValueStart(segments, this.pos);
          this.numberStart = this.pos;
          this.state = 'number';
          return;
        }
        throw new JsonSyntaxError(`Unexpected character ${JSON.stringify(ch)}`, this.pos);
    }
  }

  private stateObjectKeyOrEnd(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    if (ch === '}') {
      this.pos++;
      this.closeContainer();
      return;
    }
    if (ch === '"') {
      this.beginString(true);
      return;
    }
    throw new JsonSyntaxError('Expected object key or "}"', this.pos);
  }

  private stateObjectKey(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    if (ch === '"') {
      this.beginString(true);
      return;
    }
    throw new JsonSyntaxError('Expected object key after ","', this.pos);
  }

  private stateObjectColon(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    if (ch === ':') {
      this.pos++;
      this.state = 'value';
      return;
    }
    throw new JsonSyntaxError('Expected ":" after object key', this.pos);
  }

  private stateArrayValueOrEnd(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    if (ch === ']') {
      this.pos++;
      this.closeContainer();
      return;
    }
    this.state = 'value';
  }

  private stateObjectCommaOrEnd(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    if (ch === ',') {
      this.pos++;
      this.state = 'objectKey';
      return;
    }
    if (ch === '}') {
      this.pos++;
      this.closeContainer();
      return;
    }
    throw new JsonSyntaxError('Expected "," or "}" in object', this.pos);
  }

  private stateArrayCommaOrEnd(ch: string): void {
    if (isWhitespace(ch)) {
      this.pos++;
      return;
    }
    const top = this.stack[this.stack.length - 1] as Frame;
    if (ch === ',') {
      if (top.type !== 'array') {
        throw new Error('parser bug: comma state without array frame');
      }
      top.index++;
      this.pos++;
      this.state = 'value';
      return;
    }
    if (ch === ']') {
      this.pos++;
      this.closeContainer();
      return;
    }
    throw new JsonSyntaxError('Expected "," or "]" in array', this.pos);
  }

  private stateString(): void {
    const buf = this.buffer;
    while (this.pos < buf.length) {
      const ch = buf[this.pos] as string;
      if (this.escape === 'unicode') {
        const code = hexValue(ch);
        if (code < 0) {
          throw new JsonSyntaxError('Invalid \\u escape in string', this.pos);
        }
        this.unicodeValue = this.unicodeValue * 16 + code;
        this.unicodeDigits++;
        this.pos++;
        if (this.unicodeDigits === 4) {
          if (this.stringIsKey) {
            this.keyChars += String.fromCharCode(this.unicodeValue);
          }
          this.escape = 'none';
        }
        continue;
      }
      if (this.escape === 'simple') {
        if (ch === 'u') {
          this.escape = 'unicode';
          this.unicodeValue = 0;
          this.unicodeDigits = 0;
          this.pos++;
          continue;
        }
        const mapped = SIMPLE_ESCAPES[ch];
        if (mapped === undefined) {
          throw new JsonSyntaxError(`Invalid escape \\${ch} in string`, this.pos);
        }
        if (this.stringIsKey) {
          this.keyChars += mapped;
        }
        this.escape = 'none';
        this.pos++;
        continue;
      }
      if (ch === '\\') {
        this.escape = 'simple';
        this.pos++;
        continue;
      }
      if (ch === '"') {
        this.pos++;
        this.finishString();
        return;
      }
      if (ch < ' ') {
        throw new JsonSyntaxError('Unescaped control character in string', this.pos);
      }
      if (this.stringIsKey) {
        this.keyChars += ch;
      }
      this.pos++;
    }
  }

  private finishString(): void {
    if (!this.stringIsKey) {
      this.onValueEnd(this.pos);
      this.afterValue();
      return;
    }
    const frame = this.stack[this.stack.length - 1];
    if (frame === undefined || frame.type !== 'object') {
      throw new Error('parser bug: key string without object frame');
    }
    const key = this.keyChars;
    if (frame.keys.has(key)) {
      throw new DuplicateKeyError(canonicalPointer(frame.segments), key, this.stringStart);
    }
    frame.keys.add(key);
    frame.currentKey = key;
    this.state = 'objectColon';
  }

  private stateNumber(): void {
    const buf = this.buffer;
    while (this.pos < buf.length && NUMBER_CHARS.has(buf[this.pos] as string)) {
      this.pos++;
    }
    if (this.pos >= buf.length && !this.finalized) {
      return;
    }
    this.finishNumber(this.pos);
  }

  private finishNumber(end: number): void {
    const lexeme = this.buffer.slice(this.numberStart, end);
    if (!NUMBER_RE.test(lexeme)) {
      throw new JsonSyntaxError(`Invalid number ${JSON.stringify(lexeme)}`, this.numberStart);
    }
    this.onValueEnd(end);
    this.afterValue();
  }

  private stateLiteral(): void {
    while (this.literalMatched < this.literalWord.length) {
      if (this.pos >= this.buffer.length) {
        if (this.finalized) {
          throw new JsonSyntaxError('Unexpected end of input in literal', this.pos);
        }
        return;
      }
      if (this.buffer[this.pos] !== this.literalWord[this.literalMatched]) {
        throw new JsonSyntaxError(
          `Invalid literal, expected ${JSON.stringify(this.literalWord)}`,
          this.pos,
        );
      }
      this.pos++;
      this.literalMatched++;
    }
    this.onValueEnd(this.pos);
    this.afterValue();
  }
}
