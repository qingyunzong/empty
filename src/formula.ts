import { Addr, parseAddr } from './address.js';
import { Value, errVal, intVal, isErr, minError } from './value.js';

export type Ast =
  | { t: 'num'; v: number }
  | { t: 'ref'; addr: Addr }
  | { t: 'neg'; e: Ast }
  | { t: 'bin'; op: '+' | '-' | '*' | '/'; l: Ast; r: Ast }
  | { t: 'if'; c: Ast; a: Ast; b: Ast };

export class ParseError extends Error {}

type Tok =
  | { t: 'num'; v: number }
  | { t: 'ident'; s: string }
  | { t: 'op'; s: string };

function tokenize(src: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') { i++; continue; }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      toks.push({ t: 'num', v: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9]/.test(src[j])) j++;
      toks.push({ t: 'ident', s: src.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/(),'.includes(ch)) {
      toks.push({ t: 'op', s: ch });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character: ${ch}`);
  }
  return toks;
}

class Parser {
  private pos = 0;
  constructor(private toks: Tok[]) {}

  private peek(): Tok | null {
    return this.pos < this.toks.length ? this.toks[this.pos] : null;
  }

  private expectOp(s: string): void {
    const t = this.peek();
    if (!t || t.t !== 'op' || t.s !== s) throw new ParseError(`expected '${s}'`);
    this.pos++;
  }

  parseExpr(): Ast {
    let left = this.parseTerm();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.s === '+' || t.s === '-')) {
        this.pos++;
        left = { t: 'bin', op: t.s, l: left, r: this.parseTerm() };
      } else {
        return left;
      }
    }
  }

  private parseTerm(): Ast {
    let left = this.parseFactor();
    for (;;) {
      const t = this.peek();
      if (t && t.t === 'op' && (t.s === '*' || t.s === '/')) {
        this.pos++;
        left = { t: 'bin', op: t.s, l: left, r: this.parseFactor() };
      } else {
        return left;
      }
    }
  }

  private parseFactor(): Ast {
    const t = this.peek();
    if (!t) throw new ParseError('unexpected end of formula');
    if (t.t === 'num') { this.pos++; return { t: 'num', v: t.v }; }
    if (t.t === 'op' && t.s === '-') { this.pos++; return { t: 'neg', e: this.parseFactor() }; }
    if (t.t === 'op' && t.s === '(') {
      this.pos++;
      const e = this.parseExpr();
      this.expectOp(')');
      return e;
    }
    if (t.t === 'ident') {
      this.pos++;
      if (t.s.toUpperCase() === 'IF') {
        this.expectOp('(');
        const c = this.parseExpr();
        this.expectOp(',');
        const a = this.parseExpr();
        this.expectOp(',');
        const b = this.parseExpr();
        this.expectOp(')');
        return { t: 'if', c, a, b };
      }
      const addr = parseAddr(t.s);
      if (!addr) throw new ParseError(`bad cell reference: ${t.s}`);
      return { t: 'ref', addr };
    }
    throw new ParseError(`unexpected token`);
  }

  parseAll(): Ast {
    const e = this.parseExpr();
    if (this.pos !== this.toks.length) throw new ParseError('trailing tokens');
    return e;
  }
}

/** 解析公式文本（可带前导 '='），语法错误抛 ParseError。 */
export function parse(src: string): Ast {
  const text = src.startsWith('=') ? src.slice(1) : src;
  return new Parser(tokenize(text)).parseAll();
}

/**
 * 求值。read 由宿主提供：返回被引用单元格的值，并（在增量引擎中）记录依赖边。
 * self 为当前单元格地址（规范字符串），用作本单元格新产生错误的来源。
 */
export function evaluate(ast: Ast, self: string, read: (addr: Addr) => Value): Value {
  switch (ast.t) {
    case 'num':
      return intVal(ast.v);
    case 'ref':
      return read(ast.addr);
    case 'neg': {
      const v = evaluate(ast.e, self, read);
      return isErr(v) ? v : intVal(-v.v);
    }
    case 'bin': {
      const l = evaluate(ast.l, self, read);
      const r = evaluate(ast.r, self, read);
      if (isErr(l) || isErr(r)) return minError(l, r);
      switch (ast.op) {
        case '+': return intVal(l.v + r.v);
        case '-': return intVal(l.v - r.v);
        case '*': return intVal(l.v * r.v);
        case '/':
          if (r.v === 0) return errVal('#DIV/0!', self);
          return intVal(Math.trunc(l.v / r.v));
      }
      break;
    }
    case 'if': {
      const c = evaluate(ast.c, self, read);
      if (isErr(c)) return c;
      // 动态条件：只求值被选中分支，未选中分支不产生依赖、不传播错误。
      return evaluate(c.v !== 0 ? ast.a : ast.b, self, read);
    }
  }
}
