import {
  Expr, Span, constExpr, varExpr, binExpr, logExpr, ifExpr, letExpr, BinOp,
} from './ast.js';

interface Tok {
  t: 'num' | 'ident' | 'sym';
  v: string;
  start: number;
  end: number;
}

const KEYWORDS = new Set(['let', 'in', 'if', 'log']);

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  const re = /\s*(?:(\d+)|([a-zA-Z_][a-zA-Z0-9_]*)|([()=,+\-*/%]))/gy;
  let pos = 0;
  while (pos < src.length) {
    re.lastIndex = pos;
    const m = re.exec(src);
    if (!m || m.index !== pos) {
      throw new SyntaxError(`unexpected character at offset ${pos}: ${JSON.stringify(src[pos])}`);
    }
    const [whole, num, ident, sym] = m;
    const start = pos + (whole as string).search(/\S/);
    const end = pos + (whole as string).length;
    if (num !== undefined) toks.push({ t: 'num', v: num, start, end });
    else if (ident !== undefined) toks.push({ t: 'ident', v: ident, start, end });
    else toks.push({ t: 'sym', v: sym as string, start, end });
    pos = re.lastIndex;
  }
  return toks;
}

export function parse(src: string): Expr {
  const toks = tokenize(src);
  let pos = 0;

  function peek(): Tok | undefined {
    return toks[pos];
  }
  function next(): Tok {
    const t = toks[pos];
    if (!t) throw new SyntaxError('unexpected end of input');
    pos++;
    return t;
  }
  function expectSym(v: string): Tok {
    const t = next();
    if (t.t !== 'sym' || t.v !== v) throw new SyntaxError(`expected '${v}' at offset ${t.start}`);
    return t;
  }
  function isKeyword(t: Tok | undefined, kw: string): boolean {
    return t !== undefined && t.t === 'ident' && t.v === kw;
  }

  function parseExpr(): Expr {
    return parseAdd();
  }

  function parseAdd(): Expr {
    let left = parseMul();
    for (;;) {
      const t = peek();
      if (t && t.t === 'sym' && (t.v === '+' || t.v === '-')) {
        next();
        const right = parseMul();
        left = binExpr(t.v as BinOp, left, right, { start: left.span.start, end: right.span.end });
      } else {
        return left;
      }
    }
  }

  function parseMul(): Expr {
    let left = parseUnary();
    for (;;) {
      const t = peek();
      if (t && t.t === 'sym' && (t.v === '*' || t.v === '/' || t.v === '%')) {
        next();
        const right = parseUnary();
        left = binExpr(t.v as BinOp, left, right, { start: left.span.start, end: right.span.end });
      } else {
        return left;
      }
    }
  }

  function parseUnary(): Expr {
    const t = peek();
    if (t && t.t === 'sym' && t.v === '-') {
      next();
      const operand = parseUnary();
      const span: Span = { start: t.start, end: operand.span.end };
      return binExpr('-', constExpr(0, { start: t.start, end: t.end }), operand, span);
    }
    return parseAtom();
  }

  function parseAtom(): Expr {
    const t = next();
    if (t.t === 'num') return constExpr(Number(t.v), { start: t.start, end: t.end });
    if (t.t === 'ident') {
      if (t.v === 'let') {
        const nameTok = next();
        if (nameTok.t !== 'ident' || KEYWORDS.has(nameTok.v)) {
          throw new SyntaxError(`expected variable name at offset ${nameTok.start}`);
        }
        expectSym('=');
        const value = parseExpr();
        const inTok = next();
        if (!isKeyword(inTok, 'in')) throw new SyntaxError(`expected 'in' at offset ${inTok.start}`);
        const body = parseExpr();
        return letExpr(nameTok.v, value, body, { start: t.start, end: body.span.end });
      }
      if (t.v === 'if') {
        expectSym('(');
        const cond = parseExpr();
        expectSym(',');
        const then = parseExpr();
        expectSym(',');
        const els = parseExpr();
        const close = expectSym(')');
        return ifExpr(cond, then, els, { start: t.start, end: close.end });
      }
      if (t.v === 'log') {
        expectSym('(');
        const inner = parseExpr();
        const close = expectSym(')');
        return logExpr(inner, { start: t.start, end: close.end });
      }
      if (KEYWORDS.has(t.v)) throw new SyntaxError(`unexpected keyword '${t.v}' at offset ${t.start}`);
      return varExpr(t.v, { start: t.start, end: t.end });
    }
    if (t.t === 'sym' && t.v === '(') {
      const inner = parseExpr();
      expectSym(')');
      return inner;
    }
    throw new SyntaxError(`unexpected token '${t.v}' at offset ${t.start}`);
  }

  const expr = parseExpr();
  if (pos !== toks.length) {
    throw new SyntaxError(`trailing input at offset ${(toks[pos] as Tok).start}`);
  }
  return expr;
}
