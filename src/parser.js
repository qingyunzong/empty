import { lex, TokenKind } from './lexer.js';
import { TemplateError, ErrorCode } from './errors.js';

const INFIX_BP = Object.freeze({
  '+': [10, 11],
  '-': [10, 11],
  '*': [20, 21],
  '/': [20, 21],
  '%': [20, 21],
});
const FIELD_BP = 90;
const FILTER_BP = 5;
const PREFIX_BP = 80;

export function parse(source) {
  const parser = new Parser(lex(source));
  return parser.parseTemplate(false);
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    return this.tokens[this.pos++];
  }

  error(code, message) {
    throw new TemplateError(code, `${message} (offset ${this.peek().pos})`);
  }

  expectKind(kind, what) {
    const token = this.next();
    if (token.kind !== kind) {
      this.error(ErrorCode.PARSE_ERROR, `expected ${what}, got "${token.kind}"`);
    }
    return token;
  }

  expectPunct(value) {
    const token = this.next();
    if (token.kind !== TokenKind.PUNCT || token.value !== value) {
      this.error(ErrorCode.PARSE_ERROR, `expected "${value}"`);
    }
  }

  acceptPunct(value) {
    const token = this.peek();
    if (token.kind === TokenKind.PUNCT && token.value === value) {
      this.pos++;
      return true;
    }
    return false;
  }

  expectIdent(what = 'identifier') {
    const token = this.next();
    if (token.kind !== TokenKind.IDENT) {
      this.error(ErrorCode.PARSE_ERROR, `expected ${what}`);
    }
    return token.value;
  }

  parseTemplate(inBlock) {
    const body = [];
    for (;;) {
      const token = this.peek();
      if (token.kind === TokenKind.EOF) {
        if (inBlock) {
          throw new TemplateError(ErrorCode.UNCLOSED_BLOCK, 'scope block is not closed with {% end %}');
        }
        return body;
      }
      if (token.kind === TokenKind.TEXT) {
        this.next();
        body.push({ type: 'text', value: token.value });
        continue;
      }
      if (token.kind === TokenKind.OPEN_EXPR) {
        this.next();
        const expr = this.parseExpr(0);
        this.expectKind(TokenKind.CLOSE_EXPR, '"}}"');
        body.push({ type: 'output', expr });
        continue;
      }
      if (token.kind === TokenKind.OPEN_STMT) {
        this.next();
        const keyword = this.expectIdent('statement keyword');
        if (keyword === 'scope') {
          const expr = this.parseExpr(0);
          this.expectKind(TokenKind.CLOSE_STMT, '"%}"');
          const inner = this.parseTemplate(true);
          body.push({ type: 'scope', expr, body: inner });
          continue;
        }
        if (keyword === 'end') {
          this.expectKind(TokenKind.CLOSE_STMT, '"%}"');
          if (!inBlock) {
            throw new TemplateError(ErrorCode.UNEXPECTED_END, '{% end %} without matching {% scope %}');
          }
          return body;
        }
        this.error(ErrorCode.PARSE_ERROR, `unknown statement "${keyword}"`);
      }
      this.error(ErrorCode.PARSE_ERROR, `unexpected token "${token.kind}"`);
    }
  }

  parseExpr(minBp) {
    let left = this.parsePrefix();
    for (;;) {
      const token = this.peek();
      if (token.kind !== TokenKind.PUNCT) return left;
      if (token.value === '.') {
        if (FIELD_BP < minBp) return left;
        this.next();
        left = { kind: 'field', object: left, name: this.expectIdent('field name') };
        continue;
      }
      if (token.value === '|') {
        if (FILTER_BP < minBp) return left;
        this.next();
        const name = this.expectIdent('filter name');
        const args = [];
        if (this.acceptPunct('(')) {
          if (!this.acceptPunct(')')) {
            args.push(this.parseExpr(0));
            while (this.acceptPunct(',')) args.push(this.parseExpr(0));
            this.expectPunct(')');
          }
        }
        left = { kind: 'filter', name, args, input: left };
        continue;
      }
      const bp = INFIX_BP[token.value];
      if (bp === undefined || bp[0] < minBp) return left;
      this.next();
      const right = this.parseExpr(bp[1]);
      left = { kind: 'binary', op: token.value, left, right };
    }
  }

  parsePrefix() {
    const token = this.next();
    if (token.kind === TokenKind.NUMBER || token.kind === TokenKind.STRING) {
      return { kind: 'literal', value: token.value };
    }
    if (token.kind === TokenKind.IDENT) {
      return { kind: 'var', name: token.value };
    }
    if (token.kind === TokenKind.PUNCT && token.value === '(') {
      const expr = this.parseExpr(0);
      this.expectPunct(')');
      return expr;
    }
    if (token.kind === TokenKind.PUNCT && token.value === '-') {
      return { kind: 'negate', expr: this.parseExpr(PREFIX_BP) };
    }
    this.error(ErrorCode.PARSE_ERROR, `unexpected token "${token.kind}" in expression`);
    return null;
  }
}
