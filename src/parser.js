'use strict';

class ParseError extends Error {
  constructor(message, line, col) {
    super(message + ' (line ' + line + ', column ' + col + ')');
    this.name = 'ParseError';
  }
}

const KEYWORDS = new Set([
  'evidence', 'rule', 'claim', 'alias', 'revoke', 'undo', 'redo', 'requires',
]);

function tokenize(source) {
  const tokens = [];
  let i = 0;
  let line = 1;
  let col = 1;
  while (i < source.length) {
    const ch = source[i];
    if (ch === '\n') { line += 1; col = 1; i += 1; continue; }
    if (ch === ' ' || ch === '\t' || ch === '\r') { i += 1; col += 1; continue; }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') { i += 1; col += 1; }
      continue;
    }
    if (ch === '|' && source[i + 1] === '>') {
      tokens.push({ type: 'op', value: '|>', line, col });
      i += 2; col += 2; continue;
    }
    if ('{}()=&'.includes(ch)) {
      tokens.push({ type: 'punct', value: ch, line, col });
      i += 1; col += 1; continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < source.length && /[A-Za-z0-9_]/.test(source[j])) j += 1;
      const word = source.slice(i, j);
      tokens.push({ type: KEYWORDS.has(word) ? 'kw' : 'ident', value: word, line, col });
      col += j - i; i = j; continue;
    }
    throw new ParseError('unexpected character ' + JSON.stringify(ch), line, col);
  }
  tokens.push({ type: 'eof', value: '<end of input>', line, col });
  return tokens;
}

// Binding powers: requires (loosest) < |> < & (tightest).
const BINDING_POWER = { requires: 1, '|>': 2, '&': 3 };

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }

  peek() { return this.tokens[this.pos]; }

  next() { const t = this.tokens[this.pos]; this.pos += 1; return t; }

  fail(message, token) {
    const t = token || this.peek();
    throw new ParseError(message, t.line, t.col);
  }

  expect(value) {
    const t = this.next();
    if (t.value !== value) this.fail('expected "' + value + '" but found "' + t.value + '"', t);
    return t;
  }

  expectIdent() {
    const t = this.next();
    if (t.type !== 'ident') this.fail('expected an identifier but found "' + t.value + '"', t);
    return t.value;
  }

  parseProgram() {
    const body = [];
    while (this.peek().type !== 'eof') body.push(this.parseStatement());
    return body;
  }

  parseStatement() {
    const t = this.peek();
    if (t.type === 'kw') {
      switch (t.value) {
        case 'evidence':
        case 'rule':
          this.next();
          return { kind: 'declare', declType: t.value, name: this.expectIdent() };
        case 'claim': {
          this.next();
          const name = this.expectIdent();
          this.expect('=');
          return { kind: 'claim', name, expr: this.parseExpr(0) };
        }
        case 'alias': {
          this.next();
          const name = this.expectIdent();
          this.expect('=');
          return { kind: 'alias', name, expr: this.parseExpr(0) };
        }
        case 'revoke':
          this.next();
          return { kind: 'revoke', name: this.expectIdent() };
        case 'undo':
          this.next();
          return { kind: 'undo' };
        case 'redo':
          this.next();
          return { kind: 'redo' };
        default:
          break;
      }
    }
    if (t.value === '{') {
      this.next();
      const body = [];
      while (this.peek().value !== '}') {
        if (this.peek().type === 'eof') this.fail('unterminated block, missing "}"', t);
        body.push(this.parseStatement());
      }
      this.next();
      return { kind: 'block', body };
    }
    this.fail('unexpected token "' + t.value + '"', t);
    return null;
  }

  // Pratt parser: parseAtom is the prefix, infix operators loop on binding power.
  parseExpr(minBp) {
    let left = this.parseAtom();
    for (;;) {
      const t = this.peek();
      let op = null;
      if (t.type === 'kw' && t.value === 'requires') op = 'requires';
      else if (t.type === 'op' && t.value === '|>') op = '|>';
      else if (t.type === 'punct' && t.value === '&') op = '&';
      if (op === null) break;
      const bp = BINDING_POWER[op];
      if (bp < minBp) break;
      this.next();
      const right = this.parseExpr(bp + 1);
      left = { kind: 'bin', op, left, right };
    }
    return left;
  }

  parseAtom() {
    const t = this.next();
    if (t.type === 'ident') return { kind: 'ref', name: t.value };
    if (t.value === '(') {
      const expr = this.parseExpr(0);
      this.expect(')');
      return expr;
    }
    this.fail('expected an expression but found "' + t.value + '"', t);
    return null;
  }
}

function parse(source) {
  return new Parser(tokenize(source)).parseProgram();
}

module.exports = { tokenize, Parser, parse, ParseError, BINDING_POWER };
