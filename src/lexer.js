// Lexer for the linck rule DSL.
// Produces tokens lazily so the parser can re-scan regex literals (`/.../`)
// in positions where a key pattern is expected.

export class DslError extends Error {
  constructor(message, line, col) {
    super(`line ${line}: ${message}`);
    this.name = 'DslError';
    this.line = line;
    this.col = col;
    this.isDslError = true;
  }
}

const PUNCT2 = ['->', '==', '!=', '<=', '>=', '=~'];
const PUNCT1 = new Set('(){}.,:=<>+-*/%'.split(''));

function isIdentStart(c) {
  return (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || c === '_';
}
function isIdentPart(c) {
  return isIdentStart(c) || (c >= '0' && c <= '9');
}
function isDigit(c) {
  return c >= '0' && c <= '9';
}

export class Lexer {
  constructor(src) {
    this.src = src;
    this.pos = 0;
    this.line = 1;
    this.col = 1;
    this.peeked = null;
  }

  error(msg) {
    throw new DslError(msg, this.line, this.col);
  }

  cur() {
    return this.pos < this.src.length ? this.src[this.pos] : undefined;
  }

  advance() {
    const c = this.src[this.pos++];
    if (c === '\n') {
      this.line++;
      this.col = 1;
    } else {
      this.col++;
    }
    return c;
  }

  peek() {
    if (!this.peeked) this.peeked = this.readToken();
    return this.peeked;
  }

  next() {
    const t = this.peek();
    this.peeked = null;
    return t;
  }

  skipTrivia() {
    for (;;) {
      const c = this.cur();
      if (c === ' ' || c === '\t' || c === '\r' || c === '\n') {
        this.advance();
      } else if (c === '#') {
        while (this.cur() !== undefined && this.cur() !== '\n') this.advance();
      } else if (c === '/' && this.src[this.pos + 1] === '/') {
        while (this.cur() !== undefined && this.cur() !== '\n') this.advance();
      } else {
        return;
      }
    }
  }

  readToken() {
    this.skipTrivia();
    const line = this.line;
    const col = this.col;
    const off = this.pos;
    const c = this.cur();
    if (c === undefined) return { t: 'eof', v: null, line, col, off };

    if (isDigit(c)) {
      let text = '';
      while (isDigit(this.cur())) text += this.advance();
      if (this.cur() === '.' && isDigit(this.src[this.pos + 1])) {
        text += this.advance();
        while (isDigit(this.cur())) text += this.advance();
      }
      return { t: 'num', v: Number(text), line, col, off };
    }

    if (c === '"') {
      this.advance();
      let out = '';
      for (;;) {
        const d = this.cur();
        if (d === undefined || d === '\n') this.error('unterminated string literal');
        if (d === '"') {
          this.advance();
          break;
        }
        if (d === '\\') {
          this.advance();
          const e = this.cur();
          if (e === undefined) this.error('unterminated string literal');
          const map = { n: '\n', t: '\t', r: '\r', '"': '"', '\\': '\\', '/': '/' };
          if (!(e in map)) this.error(`unknown escape \\${e}`);
          out += map[e];
          this.advance();
        } else {
          out += this.advance();
        }
      }
      return { t: 'str', v: out, line, col, off };
    }

    if (isIdentStart(c)) {
      let text = '';
      while (isIdentPart(this.cur())) text += this.advance();
      // Hyphens may join identifier segments (e.g. happens-before), but a
      // trailing '-' not followed by an ident char ends the identifier so
      // that `a- 1` still lexes as subtraction.
      while (this.cur() === '-' && isIdentPart(this.src[this.pos + 1])) {
        text += this.advance();
        while (isIdentPart(this.cur())) text += this.advance();
      }
      return { t: 'ident', v: text, line, col, off };
    }

    const two = this.src.slice(this.pos, this.pos + 2);
    if (PUNCT2.includes(two)) {
      this.advance();
      this.advance();
      return { t: 'punct', v: two, line, col, off };
    }
    if (PUNCT1.has(c)) {
      this.advance();
      return { t: 'punct', v: c, line, col, off };
    }
    this.error(`unexpected character ${JSON.stringify(c)}`);
  }

  // Re-scan a regex literal starting at a previously lexed '/' punct token.
  // Only valid when the peeked token is that '/' token.
  readRegex() {
    const slash = this.peek();
    if (!(slash.t === 'punct' && slash.v === '/')) {
      throw new DslError('expected regex literal', slash.line, slash.col);
    }
    this.pos = slash.off;
    this.line = slash.line;
    this.col = slash.col;
    this.peeked = null;
    this.advance(); // consume '/'
    let out = '';
    for (;;) {
      const c = this.cur();
      if (c === undefined || c === '\n') this.error('unterminated regex literal');
      if (c === '\\') {
        out += this.advance();
        const d = this.cur();
        if (d === undefined) this.error('unterminated regex literal');
        out += this.advance();
        continue;
      }
      if (c === '/') {
        this.advance();
        break;
      }
      out += this.advance();
    }
    return { t: 'regex', v: out, line: slash.line, col: slash.col, off: slash.off };
  }
}
