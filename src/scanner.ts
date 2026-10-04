/**
 * Incremental JSON scanner.
 *
 * Accepts input in arbitrary chunks (feed()) and emits tokens with absolute
 * offsets into the concatenated input. Escape sequences may span chunk
 * boundaries: the scanner keeps its state between feed() calls, so a chunk
 * may end in the middle of `\u0041` or right after a backslash.
 */

export type Token =
  | { type: 'punct'; value: '{' | '}' | '[' | ']' | ':' | ','; start: number; end: number }
  | { type: 'string'; start: number; end: number; decoded: string }
  | { type: 'number'; start: number; end: number }
  | { type: 'literal'; value: true | false | null; start: number; end: number };

export class JsonSyntaxError extends Error {
  readonly offset: number;
  constructor(message: string, offset: number) {
    super(`${message} (offset ${offset})`);
    this.name = 'JsonSyntaxError';
    this.offset = offset;
  }
}

type State = 'value' | 'string' | 'escape' | 'unicode' | 'number' | 'literal';

const NUMBER_CHARS = new Set('0123456789+-.eE');
const NUMBER_RE = /^-?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/;
const HEX_RE = /^[0-9a-fA-F]$/;
const LITERALS = ['true', 'false', 'null'] as const;

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

function isHighSurrogate(unit: number): boolean {
  return unit >= 0xd800 && unit <= 0xdbff;
}

function isLowSurrogate(unit: number): boolean {
  return unit >= 0xdc00 && unit <= 0xdfff;
}

export class Scanner {
  private buffer = '';
  private pos = 0;
  private state: State = 'value';
  private tokenStart = 0;
  private decoded: string[] = [];
  private pendingHigh: number | null = null;
  private hexDigits = '';
  private numberText = '';
  private literalText = '';

  /** Append a chunk of input and return any tokens completed by it. */
  feed(chunk: string): Token[] {
    this.buffer += chunk;
    return this.scan(false);
  }

  /** Flush at end of input. Throws if a token is left incomplete. */
  end(): Token[] {
    const tokens = this.scan(true);
    switch (this.state) {
      case 'value':
        break;
      case 'number':
        tokens.push(this.finishNumber());
        break;
      case 'literal':
        if (this.isCompleteLiteral(this.literalText)) {
          tokens.push(this.finishLiteral());
        } else {
          throw new JsonSyntaxError(`invalid literal ${JSON.stringify(this.literalText)}`, this.tokenStart);
        }
        break;
      default:
        throw new JsonSyntaxError('unterminated string', this.tokenStart);
    }
    return tokens;
  }

  /** The full input received so far. */
  getText(): string {
    return this.buffer;
  }

  private scan(eof: boolean): Token[] {
    const tokens: Token[] = [];
    const buf = this.buffer;
    while (this.pos < buf.length) {
      const c = buf[this.pos] as string;
      switch (this.state) {
        case 'value':
          this.scanValueChar(c, tokens);
          break;
        case 'string':
          this.scanStringChar(c, tokens);
          break;
        case 'escape':
          this.scanEscapeChar(c);
          break;
        case 'unicode':
          this.scanUnicodeChar(c);
          break;
        case 'number':
          if (NUMBER_CHARS.has(c)) {
            this.numberText += c;
            this.pos++;
          } else {
            tokens.push(this.finishNumber());
          }
          break;
        case 'literal':
          if (c >= 'a' && c <= 'z') {
            this.literalText += c;
            this.pos++;
            if (this.isCompleteLiteral(this.literalText)) {
              tokens.push(this.finishLiteral());
            } else if (!LITERALS.some((lit) => lit.startsWith(this.literalText))) {
              throw new JsonSyntaxError(`invalid literal ${JSON.stringify(this.literalText)}`, this.tokenStart);
            }
          } else if (this.isCompleteLiteral(this.literalText)) {
            tokens.push(this.finishLiteral());
          } else {
            throw new JsonSyntaxError(`invalid literal ${JSON.stringify(this.literalText)}`, this.tokenStart);
          }
          break;
      }
    }
    void eof;
    return tokens;
  }

  private scanValueChar(c: string, tokens: Token[]): void {
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r') {
      this.pos++;
      return;
    }
    if (c === '{' || c === '}' || c === '[' || c === ']' || c === ':' || c === ',') {
      tokens.push({ type: 'punct', value: c, start: this.pos, end: this.pos + 1 });
      this.pos++;
      return;
    }
    if (c === '"') {
      this.state = 'string';
      this.tokenStart = this.pos;
      this.decoded = [];
      this.pendingHigh = null;
      this.pos++;
      return;
    }
    if (NUMBER_CHARS.has(c)) {
      this.state = 'number';
      this.tokenStart = this.pos;
      this.numberText = c;
      this.pos++;
      return;
    }
    if (c >= 'a' && c <= 'z') {
      this.state = 'literal';
      this.tokenStart = this.pos;
      this.literalText = c;
      this.pos++;
      return;
    }
    throw new JsonSyntaxError(`unexpected character ${JSON.stringify(c)}`, this.pos);
  }

  private scanStringChar(c: string, tokens: Token[]): void {
    if (this.pendingHigh !== null && c !== '\\') {
      // The previous \u escape was a high surrogate not followed by \uXXXX.
      this.decoded.push(String.fromCharCode(this.pendingHigh));
      this.pendingHigh = null;
    }
    if (c === '"') {
      const decoded = this.decoded.join('');
      tokens.push({ type: 'string', start: this.tokenStart, end: this.pos + 1, decoded });
      this.state = 'value';
      this.pos++;
      return;
    }
    if (c === '\\') {
      this.state = 'escape';
      this.pos++;
      return;
    }
    if (c < ' ') {
      throw new JsonSyntaxError('unescaped control character in string', this.pos);
    }
    this.decoded.push(c);
    this.pos++;
  }

  private scanEscapeChar(c: string): void {
    if (c === 'u') {
      this.state = 'unicode';
      this.hexDigits = '';
      this.pos++;
      return;
    }
    if (this.pendingHigh !== null) {
      this.decoded.push(String.fromCharCode(this.pendingHigh));
      this.pendingHigh = null;
    }
    const replacement = SIMPLE_ESCAPES[c];
    if (replacement === undefined) {
      throw new JsonSyntaxError(`invalid escape \\${c}`, this.pos - 1);
    }
    this.decoded.push(replacement);
    this.state = 'string';
    this.pos++;
  }

  private scanUnicodeChar(c: string): void {
    if (!HEX_RE.test(c)) {
      throw new JsonSyntaxError('invalid \\u escape', this.pos);
    }
    this.hexDigits += c;
    this.pos++;
    if (this.hexDigits.length < 4) {
      return;
    }
    const unit = parseInt(this.hexDigits, 16);
    if (this.pendingHigh !== null) {
      if (isLowSurrogate(unit)) {
        this.decoded.push(String.fromCharCode(this.pendingHigh, unit));
        this.pendingHigh = null;
      } else {
        this.decoded.push(String.fromCharCode(this.pendingHigh));
        this.pendingHigh = isHighSurrogate(unit) ? unit : null;
        if (this.pendingHigh === null) {
          this.decoded.push(String.fromCharCode(unit));
        }
      }
    } else if (isHighSurrogate(unit)) {
      this.pendingHigh = unit;
    } else {
      this.decoded.push(String.fromCharCode(unit));
    }
    this.state = 'string';
  }

  private finishNumber(): Token {
    if (!NUMBER_RE.test(this.numberText)) {
      throw new JsonSyntaxError(`invalid number ${JSON.stringify(this.numberText)}`, this.tokenStart);
    }
    const token: Token = { type: 'number', start: this.tokenStart, end: this.pos };
    this.state = 'value';
    return token;
  }

  private isCompleteLiteral(text: string): boolean {
    return text === 'true' || text === 'false' || text === 'null';
  }

  private finishLiteral(): Token {
    const value = this.literalText === 'null' ? null : this.literalText === 'true';
    const token: Token = { type: 'literal', value, start: this.tokenStart, end: this.pos };
    this.state = 'value';
    return token;
  }
}
