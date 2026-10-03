// Pratt parser: mass conservation (target), content ranges, cost expressions.
import { Diagnostic } from './lexer.js';

const BIN_BP = { '+': 10, '-': 10, '*': 20, '/': 20 };
const CMP_OPS = new Set(['<', '<=', '>', '>=', '==']);

export function parse(toks, file = '<input>') {
  let pos = 0;
  const peek = () => toks[pos];
  const advance = () => toks[pos++];
  const err = (msg, tk = peek()) => {
    throw new Diagnostic(msg, tk.line, tk.col, file);
  };
  const atPunct = (v) => peek().t === 'punct' && peek().v === v;
  const atKw = (w) => peek().t === 'ident' && peek().v === w;
  const eatPunct = (v) => {
    if (!atPunct(v)) err(`expected '${v}', found '${peek().v || peek().t}'`);
    return advance();
  };
  const eatIdent = () => {
    const tk = advance();
    if (tk.t !== 'ident') err(`expected identifier, found '${tk.v || tk.t}'`, tk);
    return tk;
  };

  function parseExpr(minBp = 0) {
    let left = parsePrefix();
    for (;;) {
      const tk = peek();
      if (tk.t !== 'punct' || !(tk.v in BIN_BP)) break;
      const bp = BIN_BP[tk.v];
      if (bp < minBp) break;
      advance();
      const right = parseExpr(bp + 1);
      left = { kind: 'bin', op: tk.v, left, right, line: tk.line, col: tk.col };
    }
    return left;
  }

  function parsePrefix() {
    const tk = advance();
    if (tk.t === 'num') {
      let unit = null;
      if (peek().t === 'unit') unit = advance().v;
      return { kind: 'num', value: tk.v, unit, line: tk.line, col: tk.col };
    }
    if (tk.t === 'punct' && tk.v === '-') {
      const expr = parsePrefix();
      return { kind: 'neg', expr, line: tk.line, col: tk.col };
    }
    if (tk.t === 'punct' && tk.v === '(') {
      const e = parseExpr();
      eatPunct(')');
      return e;
    }
    if (tk.t === 'ident') {
      if (tk.v === 'grams' && atPunct('(')) {
        advance();
        const name = eatIdent();
        eatPunct(')');
        return { kind: 'grams', name: name.v, line: tk.line, col: tk.col };
      }
      return { kind: 'ref', name: tk.v, line: tk.line, col: tk.col };
    }
    err(`unexpected '${tk.v || tk.t}' in expression`, tk);
  }

  function parseMacro() {
    const kw = advance();
    const name = eatIdent();
    eatPunct('=');
    const expr = parseExpr();
    eatPunct(';');
    return { kind: 'macro', name: name.v, expr, line: kw.line, col: kw.col };
  }

  function parseIngredient() {
    const kw = advance();
    const name = eatIdent();
    eatPunct('{');
    const items = [];
    while (!atPunct('}')) {
      const tk = peek();
      if (tk.t === 'eof') err('unterminated ingredient block', tk);
      if (atKw('macro')) {
        items.push(parseMacro());
        continue;
      }
      if (atKw('indicator')) {
        advance();
        const n = eatIdent();
        eatPunct(':');
        const e = parseExpr();
        eatPunct(';');
        items.push({ kind: 'prop', prop: 'indicator', name: n.v, expr: e, line: tk.line, col: tk.col });
        continue;
      }
      if (atKw('cost') || atKw('stock') || atKw('allergen')) {
        advance();
        eatPunct(':');
        const e = parseExpr();
        eatPunct(';');
        items.push({ kind: 'prop', prop: tk.v, expr: e, line: tk.line, col: tk.col });
        continue;
      }
      err(`unexpected '${tk.v || tk.t}' in ingredient body`, tk);
    }
    advance();
    return { kind: 'ingredient', name: name.v, items, line: kw.line, col: kw.col };
  }

  function parseValueStmt(kindName) {
    const kw = advance();
    eatPunct(':');
    const expr = parseExpr();
    eatPunct(';');
    return { kind: kindName, expr, line: kw.line, col: kw.col };
  }

  function parseConstraint() {
    const kw = advance();
    const la = toks[pos + 1];
    if (peek().t === 'ident' && la && la.t === 'ident' && la.v === 'in') {
      const ind = advance();
      advance();
      eatPunct('[');
      const lo = parseExpr();
      eatPunct(',');
      const hi = parseExpr();
      eatPunct(']');
      eatPunct(';');
      return { kind: 'range', indicator: ind.v, lo, hi, line: kw.line, col: kw.col };
    }
    const left = parseExpr();
    const op = advance();
    if (op.t !== 'punct' || !CMP_OPS.has(op.v)) {
      err(`expected comparison operator, found '${op.v || op.t}'`, op);
    }
    const right = parseExpr();
    eatPunct(';');
    return { kind: 'cmp', op: op.v, left, right, line: kw.line, col: kw.col };
  }

  function parseStmt() {
    const tk = peek();
    if (tk.t === 'eof') err('unexpected end of input', tk);
    if (atKw('macro')) return parseMacro();
    if (atKw('ingredient')) return parseIngredient();
    if (atKw('target')) return parseValueStmt('target');
    if (atKw('step')) return parseValueStmt('step');
    if (atKw('budget')) return parseValueStmt('budget');
    if (atKw('minimize')) {
      advance();
      const w = eatIdent();
      if (w.v !== 'cost') err(`expected 'cost' after 'minimize'`, w);
      eatPunct(';');
      return { kind: 'minimize', line: tk.line, col: tk.col };
    }
    if (atKw('constraint')) return parseConstraint();
    err(`unexpected statement starting with '${tk.v || tk.t}'`, tk);
  }

  const body = [];
  while (peek().t !== 'eof') body.push(parseStmt());
  return { kind: 'program', body };
}
