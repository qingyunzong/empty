/**
 * Parser for linear constraints over integer variables.
 *
 * Supported syntax (all numbers are arbitrary-precision integers):
 *   inequalities : 2*x + 3 <= 10        (<, <=, >, >=, also unicode ≤ ≥)
 *   equalities   : 3*x - 12 == 0
 *   congruences  : (2*x + 1) % 6 == 4   or   2*x + 1 == 4 (mod 6)   or  2*x + 1 ≡ 4 (mod 6)
 *
 * Expressions must be linear: a product of two variable-containing
 * expressions is rejected. Strict inequalities are normalized to
 * non-strict ones by integer shifting (a*x + b < 0  <=>  a*x + b + 1 <= 0),
 * so no floating-point bound conversion ever takes place.
 */

export class ParseError extends Error {}

export interface LinExpr {
  /** variable name -> coefficient (zero coefficients are never stored) */
  coefs: Map<string, bigint>;
  konst: bigint;
}

export type Constraint =
  | { kind: "ineq"; expr: LinExpr; raw: string } // expr <= 0
  | { kind: "eq"; expr: LinExpr; raw: string } // expr == 0
  | { kind: "cong"; expr: LinExpr; modulus: bigint; raw: string }; // expr ≡ 0 (mod modulus)

/* ------------------------------ tokenizer ------------------------------ */

type Tok =
  | { t: "num"; v: bigint; pos: number }
  | { t: "ident"; v: string; pos: number }
  | { t: "punct"; v: string; pos: number };

const REL_OPS = new Set(["<", "<=", ">", ">=", "==", "≤", "≥", "≡"]);

function tokenize(input: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  while (i < input.length) {
    const ch = input[i]!;
    if (/\s/.test(ch)) {
      i++;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let j = i;
      while (j < input.length && /[0-9]/.test(input[j]!)) j++;
      toks.push({ t: "num", v: BigInt(input.slice(i, j)), pos: i });
      i = j;
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let j = i;
      while (j < input.length && /[A-Za-z0-9_]/.test(input[j]!)) j++;
      toks.push({ t: "ident", v: input.slice(i, j), pos: i });
      i = j;
      continue;
    }
    const two = input.slice(i, i + 2);
    if (two === "!=") {
      throw new ParseError(`operator '!=' is not supported (position ${i})`);
    }
    if (two === "<=" || two === ">=" || two === "==") {
      toks.push({ t: "punct", v: two, pos: i });
      i += 2;
      continue;
    }
    if ("+-*%(),<>".includes(ch) || ch === "≤" || ch === "≥" || ch === "≡") {
      toks.push({ t: "punct", v: ch, pos: i });
      i++;
      continue;
    }
    throw new ParseError(`unexpected character '${ch}' at position ${i}`);
  }
  return toks;
}

/* --------------------------------- AST --------------------------------- */

type Ast =
  | { kind: "num"; value: bigint }
  | { kind: "var"; name: string }
  | { kind: "add" | "sub" | "mul"; left: Ast; right: Ast }
  | { kind: "neg"; arg: Ast }
  | { kind: "mod"; arg: Ast; modulus: Ast };

class ExprParser {
  private pos = 0;
  constructor(
    private readonly toks: Tok[],
    private readonly input: string,
  ) {}

  get done(): boolean {
    return this.pos >= this.toks.length;
  }

  peekTok(): Tok | undefined {
    return this.toks[this.pos];
  }

  advance(): void {
    this.pos++;
  }

  private peek(): Tok | undefined {
    return this.toks[this.pos];
  }

  private next(): Tok {
    const t = this.toks[this.pos];
    if (!t) throw new ParseError("unexpected end of input");
    this.pos++;
    return t;
  }

  atPunct(v: string): boolean {
    const t = this.peek();
    return t !== undefined && t.t === "punct" && t.v === v;
  }

  expectPunct(v: string): void {
    if (!this.atPunct(v)) {
      throw new ParseError(
        `expected '${v}' at position ${this.peek()?.pos ?? this.input.length}`,
      );
    }
    this.pos++;
  }

  parseExpr(): Ast {
    let node = this.parseMul();
    for (;;) {
      if (this.atPunct("+")) {
        this.pos++;
        node = { kind: "add", left: node, right: this.parseMul() };
      } else if (this.atPunct("-")) {
        this.pos++;
        node = { kind: "sub", left: node, right: this.parseMul() };
      } else {
        return node;
      }
    }
  }

  private parseMul(): Ast {
    let node = this.parseUnary();
    for (;;) {
      if (this.atPunct("*")) {
        this.pos++;
        node = { kind: "mul", left: node, right: this.parseUnary() };
      } else if (this.atPunct("%")) {
        this.pos++;
        node = { kind: "mod", arg: node, modulus: this.parseUnary() };
      } else {
        return node;
      }
    }
  }

  private parseUnary(): Ast {
    if (this.atPunct("-")) {
      this.pos++;
      return { kind: "neg", arg: this.parseUnary() };
    }
    if (this.atPunct("+")) {
      this.pos++;
      return this.parseUnary();
    }
    return this.parsePrimary();
  }

  private parsePrimary(): Ast {
    const t = this.next();
    if (t.t === "num") return { kind: "num", value: t.v };
    if (t.t === "ident") return { kind: "var", name: t.v };
    if (t.t === "punct" && t.v === "(") {
      const e = this.parseExpr();
      this.expectPunct(")");
      return e;
    }
    throw new ParseError(`unexpected token at position ${t.pos}`);
  }
}

/* --------------------------- linear expression ------------------------- */

function addLin(a: LinExpr, b: LinExpr): LinExpr {
  const coefs = new Map(a.coefs);
  for (const [v, c] of b.coefs) {
    const sum = (coefs.get(v) ?? 0n) + c;
    if (sum === 0n) coefs.delete(v);
    else coefs.set(v, sum);
  }
  return { coefs, konst: a.konst + b.konst };
}

function scaleLin(e: LinExpr, k: bigint): LinExpr {
  if (k === 0n) return { coefs: new Map(), konst: 0n };
  const coefs = new Map<string, bigint>();
  for (const [v, c] of e.coefs) coefs.set(v, c * k);
  return { coefs, konst: e.konst * k };
}

function subLin(a: LinExpr, b: LinExpr): LinExpr {
  return addLin(a, scaleLin(b, -1n));
}

function toLinear(node: Ast): LinExpr {
  switch (node.kind) {
    case "num":
      return { coefs: new Map(), konst: node.value };
    case "var":
      return { coefs: new Map([[node.name, 1n]]), konst: 0n };
    case "neg":
      return scaleLin(toLinear(node.arg), -1n);
    case "add":
      return addLin(toLinear(node.left), toLinear(node.right));
    case "sub":
      return subLin(toLinear(node.left), toLinear(node.right));
    case "mul": {
      const l = toLinear(node.left);
      const r = toLinear(node.right);
      if (l.coefs.size === 0) return scaleLin(r, l.konst);
      if (r.coefs.size === 0) return scaleLin(l, r.konst);
      throw new ParseError("non-linear term: product of two variable expressions");
    }
    case "mod":
      throw new ParseError("'%' (mod) is only allowed at the top level of a comparison");
  }
}

function constantModulus(node: Ast): bigint {
  const lin = toLinear(node);
  if (lin.coefs.size !== 0) throw new ParseError("modulus must be a constant");
  if (lin.konst <= 0n) throw new ParseError("modulus must be a positive integer");
  return lin.konst;
}

/* ------------------------------ constraint ----------------------------- */

export function parseConstraint(input: string): Constraint {
  const p = new ExprParser(tokenize(input), input);
  const left = p.parseExpr();

  const relTok = p.peekTok();
  if (!relTok || relTok.t !== "punct" || !REL_OPS.has(relTok.v)) {
    throw new ParseError(
      `expected a relational operator (<, <=, >, >=, ==) at position ${relTok?.pos ?? input.length}`,
    );
  }
  p.advance();
  const rel = relTok.v === "≤" ? "<=" : relTok.v === "≥" ? ">=" : relTok.v;
  const right = p.parseExpr();

  let suffixMod: bigint | null = null;
  if (p.atPunct("(")) {
    p.expectPunct("(");
    const idTok = readIdent(p);
    if (idTok !== "mod") throw new ParseError("expected 'mod' inside '(...)' suffix");
    suffixMod = constantModulus(p.parseExpr());
    p.expectPunct(")");
  }
  if (!p.done) throw new ParseError("unexpected trailing input");

  if (suffixMod !== null) {
    if (rel !== "==" && rel !== "≡") {
      throw new ParseError("'(mod m)' suffix requires '==' or '≡'");
    }
    return {
      kind: "cong",
      expr: subLin(toLinear(left), toLinear(right)),
      modulus: suffixMod,
      raw: input,
    };
  }

  if (left.kind === "mod" || right.kind === "mod") {
    if (rel !== "==" && rel !== "≡") {
      throw new ParseError("congruence requires '==' (e.g. 'expr % m == r')");
    }
    const modSide = (left.kind === "mod" ? left : right) as Ast & { kind: "mod" };
    const other = left.kind === "mod" ? right : left;
    return {
      kind: "cong",
      expr: subLin(toLinear(modSide.arg), toLinear(other)),
      modulus: constantModulus(modSide.modulus),
      raw: input,
    };
  }

  if (rel === "≡") throw new ParseError("'≡' requires a '(mod m)' suffix");

  const diff = subLin(toLinear(left), toLinear(right));
  switch (rel) {
    case "<=":
      return { kind: "ineq", expr: diff, raw: input };
    case "<":
      // a*x + b < 0  <=>  a*x + b + 1 <= 0   (exact integer shift, no floats)
      return { kind: "ineq", expr: addLin(diff, { coefs: new Map(), konst: 1n }), raw: input };
    case ">=":
      return { kind: "ineq", expr: scaleLin(diff, -1n), raw: input };
    case ">":
      return {
        kind: "ineq",
        expr: addLin(scaleLin(diff, -1n), { coefs: new Map(), konst: 1n }),
        raw: input,
      };
    case "==":
      return { kind: "eq", expr: diff, raw: input };
    default:
      throw new ParseError(`unsupported relational operator '${rel}'`);
  }
}

function readIdent(p: ExprParser): string {
  const t = p.peekTok();
  if (!t || t.t !== "ident") {
    throw new ParseError(`expected identifier at position ${t?.pos ?? "end"}`);
  }
  p.advance();
  return t.v;
}
