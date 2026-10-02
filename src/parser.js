'use strict';

// Tokenizer + Pratt parser for the evidence-chain script language.
//
// Statements:
//   evidence NAME
//   rule NAME
//   alias NAME = expr
//   claim NAME = expr
//   { statement* }
//
// Expressions (Pratt, left-associative, ascending binding power):
//   requires (1)  |> (2)  & (3)   parentheses   identifiers

const KEYWORDS = new Set(['evidence', 'rule', 'claim', 'alias', 'requires']);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    if (ch === '#') { while (i < source.length && source[i] !== '\n') i += 1; continue; }
    if (ch === '|' && source[i + 1] === '>') {
      tokens.push({ type: 'op', value: '|>' });
      i += 2;
      continue;
    }
    if ('&=(){}'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'kw' : 'ident', value: word });
      i = j;
      continue;
    }
    throw new SyntaxError(`unexpected character ${JSON.stringify(ch)} at offset ${i}`);
  }
  tokens.push({ type: 'eof', value: '<eof>' });
  return tokens;
}

const INFIX_BP = { requires: 1, '|>': 2, '&': 3 };

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() {
    return this.tokens[this.pos];
  }

  next() {
    const tok = this.tokens[this.pos];
    this.pos += 1;
    return tok;
  }

  expect(value) {
    const tok = this.next();
    if (tok.value !== value) {
      throw new SyntaxError(`expected ${JSON.stringify(value)} but found ${JSON.stringify(tok.value)}`);
    }
    return tok;
  }

  expectIdent() {
    const tok = this.next();
    if (tok.type !== 'ident') {
      throw new SyntaxError(`expected identifier but found ${JSON.stringify(tok.value)}`);
    }
    return tok.value;
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== 'eof') body.push(this.parseStatement());
    return { kind: 'block', label: '<root>', body };
  }

  parseStatement() {
    const tok = this.peek();
    if (tok.type === 'kw') {
      if (tok.value === 'evidence' || tok.value === 'rule') {
        this.next();
        return { kind: `${tok.value}Decl`, name: this.expectIdent() };
      }
      if (tok.value === 'alias' || tok.value === 'claim') {
        this.next();
        const name = this.expectIdent();
        this.expect('=');
        return { kind: `${tok.value}Decl`, name, expr: this.parseExpr(0) };
      }
      throw new SyntaxError(`unexpected keyword ${JSON.stringify(tok.value)}`);
    }
    if (tok.value === '{') {
      this.next();
      const body = [];
      while (this.peek().value !== '}') {
        if (this.peek().type === 'eof') throw new SyntaxError('unterminated block: missing }');
        body.push(this.parseStatement());
      }
      this.next();
      return { kind: 'block', label: null, body };
    }
    throw new SyntaxError(`unexpected token ${JSON.stringify(tok.value)}`);
  }

  // Pratt expression parser: `requires` < `|>` < `&`, all left-associative.
  parseExpr(minBp) {
    let left = this.parsePrimary();
    for (;;) {
      const tok = this.peek();
      const bp = Object.prototype.hasOwnProperty.call(INFIX_BP, tok.value)
        ? INFIX_BP[tok.value]
        : undefined;
      if (bp === undefined || bp <= minBp) return left;
      const op = tok.value;
      this.next();
      const right = this.parseExpr(bp);
      left = { kind: 'bin', op, left, right };
    }
  }

  parsePrimary() {
    const tok = this.next();
    if (tok.type === 'ident') return { kind: 'ref', name: tok.value };
    if (tok.value === '(') {
      const inner = this.parseExpr(0);
      this.expect(')');
      return inner;
    }
    throw new SyntaxError(`expected expression but found ${JSON.stringify(tok.value)}`);
  }
}

function parse(source) {
  return new Parser(tokenize(source)).parseProgram();
}

// Parse a standalone expression (used to re-check normalized terms).
function parseExpr(source) {
  const parser = new Parser(tokenize(source));
  const expr = parser.parseExpr(0);
  if (parser.peek().type !== 'eof') {
    throw new SyntaxError(`trailing input after expression: ${JSON.stringify(parser.peek().value)}`);
  }
  return expr;
}

module.exports = { tokenize, parse, parseExpr };
