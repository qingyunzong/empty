export type Expr =
  | { kind: 'num'; value: number }
  | { kind: 'ref'; ref: string }
  | { kind: 'neg'; operand: Expr }
  | { kind: 'bin'; op: '+' | '-' | '*' | '/'; left: Expr; right: Expr }
  | { kind: 'if'; cond: Expr; thenBranch: Expr; elseBranch: Expr };

export class ParseError extends Error {}

type Token =
  | { t: 'num'; value: number }
  | { t: 'ref'; name: string }
  | { t: 'if' }
  | { t: 'op'; op: '+' | '-' | '*' | '/' }
  | { t: 'lparen' }
  | { t: 'rparen' }
  | { t: 'comma' }
  | { t: 'end' };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r') {
      i++;
      continue;
    }
    if (ch >= '0' && ch <= '9') {
      let j = i;
      while (j < src.length && src[j] >= '0' && src[j] <= '9') j++;
      if (j < src.length && src[j] === '.') {
        throw new ParseError(`only integers are supported (position ${j})`);
      }
      tokens.push({ t: 'num', value: parseInt(src.slice(i, j), 10) });
      i = j;
      continue;
    }
    if ((ch >= 'A' && ch <= 'Z') || (ch >= 'a' && ch <= 'z')) {
      let j = i;
      while (j < src.length && /[A-Za-z]/.test(src[j])) j++;
      const word = src.slice(i, j);
      let k = j;
      while (k < src.length && src[k] >= '0' && src[k] <= '9') k++;
      if (k > j) {
        tokens.push({ t: 'ref', name: (word + src.slice(j, k)).toUpperCase() });
        i = k;
        continue;
      }
      if (word.toUpperCase() === 'IF') {
        tokens.push({ t: 'if' });
        i = j;
        continue;
      }
      throw new ParseError(`unknown identifier "${word}" (position ${i})`);
    }
    if (ch === '+' || ch === '-' || ch === '*' || ch === '/') {
      tokens.push({ t: 'op', op: ch });
      i++;
      continue;
    }
    if (ch === '(') {
      tokens.push({ t: 'lparen' });
      i++;
      continue;
    }
    if (ch === ')') {
      tokens.push({ t: 'rparen' });
      i++;
      continue;
    }
    if (ch === ',') {
      tokens.push({ t: 'comma' });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character "${ch}" (position ${i})`);
  }
  tokens.push({ t: 'end' });
  return tokens;
}

class Parser {
  private pos = 0;
  constructor(private tokens: Token[]) {}

  private peek(): Token {
    return this.tokens[this.pos];
  }

  next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(t: Token['t'], what: string): Token {
    const tok = this.next();
    if (tok.t !== t) throw new ParseError(`expected ${what}, got ${describe(tok)}`);
    return tok;
  }

  parseExpr(): Expr {
    return this.parseAddSub();
  }

  private parseAddSub(): Expr {
    let left = this.parseMulDiv();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'op' && (tok.op === '+' || tok.op === '-')) {
        this.next();
        left = { kind: 'bin', op: tok.op, left, right: this.parseMulDiv() };
      } else {
        return left;
      }
    }
  }

  private parseMulDiv(): Expr {
    let left = this.parseUnary();
    for (;;) {
      const tok = this.peek();
      if (tok.t === 'op' && (tok.op === '*' || tok.op === '/')) {
        this.next();
        left = { kind: 'bin', op: tok.op, left, right: this.parseUnary() };
      } else {
        return left;
      }
    }
  }

  private parseUnary(): Expr {
    const tok = this.peek();
    if (tok.t === 'op' && tok.op === '-') {
      this.next();
      return { kind: 'neg', operand: this.parseUnary() };
    }
    if (tok.t === 'op' && tok.op === '+') {
      this.next();
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Expr {
    const tok = this.next();
    switch (tok.t) {
      case 'num':
        return { kind: 'num', value: tok.value };
      case 'ref':
        return { kind: 'ref', ref: tok.name };
      case 'if': {
        this.expect('lparen', '"(" after IF');
        const cond = this.parseExpr();
        this.expect('comma', '"," in IF');
        const thenBranch = this.parseExpr();
        this.expect('comma', '"," in IF');
        const elseBranch = this.parseExpr();
        this.expect('rparen', '")" to close IF');
        return { kind: 'if', cond, thenBranch, elseBranch };
      }
      case 'lparen': {
        const inner = this.parseExpr();
        this.expect('rparen', '")"');
        return inner;
      }
      default:
        throw new ParseError(`unexpected ${describe(tok)}`);
    }
  }
}

function describe(tok: Token): string {
  switch (tok.t) {
    case 'num':
      return `number ${tok.value}`;
    case 'ref':
      return `cell ${tok.name}`;
    case 'if':
      return 'IF';
    case 'op':
      return `"${tok.op}"`;
    case 'lparen':
      return '"("';
    case 'rparen':
      return '")"';
    case 'comma':
      return '","';
    case 'end':
      return 'end of input';
  }
}

export function parseFormula(src: string): Expr {
  const parser = new Parser(tokenize(src));
  const expr = parser.parseExpr();
  const tok = parser.next();
  if (tok.t !== 'end') throw new ParseError(`unexpected trailing ${describe(tok)}`);
  return expr;
}

export function collectRefs(expr: Expr, out: Set<string> = new Set()): Set<string> {
  switch (expr.kind) {
    case 'num':
      return out;
    case 'ref':
      out.add(expr.ref);
      return out;
    case 'neg':
      return collectRefs(expr.operand, out);
    case 'bin':
      collectRefs(expr.left, out);
      return collectRefs(expr.right, out);
    case 'if':
      collectRefs(expr.cond, out);
      collectRefs(expr.thenBranch, out);
      return collectRefs(expr.elseBranch, out);
  }
}
