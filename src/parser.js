// Pratt parser for the rules DSL.
//
// Grammar:
//   program     := statement*
//   statement   := 'let' IDENT '=' expr NEWLINE
//                | 'alert' IDENT 'level' IDENT 'on' deviceSelector 'when' expr NEWLINE
//   deviceSelector := 'devices' '(' (IDENT | REGEX (',' (IDENT | REGEX))*)? ')'
//   expr        := or
//   or          := and ('or' and)*
//   and         := not ('and' not)*
//   not         := 'not' not | comparison
//   comparison  := primary (('>'|'<'|'>='|'<='|'=='|'!=') primary)? ('for' DURATION)?
//   primary     := NUMBER | IDENT | '(' expr ')'

import { tokenize } from './lexer.js';

export class ParseError extends Error {
  constructor(message, line, col) {
    super(message);
    this.name = 'ParseError';
    this.line = line;
    this.col = col;
  }
}

const CMP_OPS = new Set(['>', '<', '>=', '<=', '==', '!=']);

export function parse(source) {
  const tokens = tokenize(source);
  let pos = 0;

  const peek = () => tokens[pos];
  const next = () => tokens[pos++];
  const fail = (msg, tok = peek()) => { throw new ParseError(msg, tok.line, tok.col); };
  const skipNewlines = () => { while (peek().type === 'NEWLINE') pos++; };

  const expectKeyword = (word) => {
    const t = peek();
    if (t.type !== 'KEYWORD' || t.value !== word) fail(`expected '${word}', got '${t.value ?? t.type}'`, t);
    return next();
  };
  const expectIdent = (what) => {
    const t = peek();
    if (t.type !== 'IDENT') fail(`expected ${what}, got '${t.value ?? t.type}'`, t);
    return next();
  };
  const expectPunct = (p) => {
    const t = peek();
    if (t.type !== 'PUNCT' || t.value !== p) fail(`expected '${p}', got '${t.value ?? t.type}'`, t);
    return next();
  };

  // ---- Pratt expression parser ----
  // Binding powers: or=1, and=2, not=3 (prefix), comparison=4.
  function parseExpr(minBp) {
    let left = parsePrefix();
    for (;;) {
      const t = peek();
      if (t.type === 'KEYWORD' && (t.value === 'or' || t.value === 'and')) {
        const bp = t.value === 'or' ? 1 : 2;
        if (bp < minBp) break;
        next();
        const right = parseExpr(bp + 1);
        left = { kind: t.value, left, right, line: t.line, col: t.col };
        continue;
      }
      if (t.type === 'OP' && CMP_OPS.has(t.value)) {
        const bp = 4;
        if (bp < minBp) break;
        next();
        const right = parseExpr(bp + 1);
        left = { kind: 'cmp', op: t.value, left, right, line: t.line, col: t.col };
        // 'for' binds directly to a comparison: temp > 80C for 5m
        const f = peek();
        if (f.type === 'KEYWORD' && f.value === 'for') {
          next();
          const d = peek();
          if (d.type !== 'DURATION') fail(`expected duration like 5m after 'for'`, d);
          next();
          left = { kind: 'for', ms: d.ms, duration: `${d.value}${d.unit}`, expr: left, line: f.line, col: f.col };
        }
        continue;
      }
      break;
    }
    return left;
  }

  function parsePrefix() {
    const t = peek();
    if (t.type === 'KEYWORD' && t.value === 'not') {
      next();
      const expr = parseExpr(3);
      return { kind: 'not', expr, line: t.line, col: t.col };
    }
    return parsePrimary();
  }

  function parsePrimary() {
    const t = peek();
    if (t.type === 'NUMBER') {
      next();
      return { kind: 'num', value: t.value, unit: t.unit, line: t.line, col: t.col };
    }
    if (t.type === 'IDENT') {
      next();
      return { kind: 'ident', name: t.value, line: t.line, col: t.col };
    }
    if (t.type === 'PUNCT' && t.value === '(') {
      next();
      const inner = parseExpr(0);
      expectPunct(')');
      return inner;
    }
    fail(`expected expression, got '${t.value ?? t.type}'`, t);
  }

  // ---- statements ----
  function parseStatement() {
    const t = peek();
    if (t.type === 'KEYWORD' && t.value === 'let') {
      next();
      const name = expectIdent('alias name');
      const eq = peek();
      if (eq.type !== 'OP' || eq.value !== '=') fail(`expected '=' after let ${name.value}`, eq);
      next();
      const expr = parseExpr(0);
      return { kind: 'let', name: name.value, expr, line: t.line, col: t.col };
    }
    if (t.type === 'KEYWORD' && t.value === 'alert') {
      next();
      const name = expectIdent('rule name');
      expectKeyword('level');
      const level = expectIdent('alert level');
      expectKeyword('on');
      expectKeyword('devices');
      expectPunct('(');
      const idents = [];
      const regexes = [];
      if (!(peek().type === 'PUNCT' && peek().value === ')')) {
        for (;;) {
          const d = peek();
          if (d.type === 'IDENT') { idents.push({ value: d.value, line: d.line, col: d.col }); next(); }
          else if (d.type === 'REGEX') { regexes.push({ value: d.value, line: d.line, col: d.col }); next(); }
          else fail(`expected device id or regex in devices(...)`, d);
          if (peek().type === 'PUNCT' && peek().value === ',') { next(); continue; }
          break;
        }
      }
      const close = expectPunct(')');
      expectKeyword('when');
      const expr = parseExpr(0);
      return {
        kind: 'rule',
        name: name.value,
        level: { value: level.value, line: level.line, col: level.col },
        devices: { idents, regexes, line: close.line, col: close.col },
        expr,
        line: t.line,
        col: t.col,
      };
    }
    fail(`expected 'let' or 'alert', got '${t.value ?? t.type}'`, t);
  }

  const statements = [];
  for (;;) {
    skipNewlines();
    if (peek().type === 'EOF') break;
    const stmt = parseStatement();
    statements.push(stmt);
    const t = peek();
    if (t.type !== 'NEWLINE' && t.type !== 'EOF') {
      fail(`expected end of line, got '${t.value ?? t.type}'`, t);
    }
  }
  return { kind: 'program', statements };
}
