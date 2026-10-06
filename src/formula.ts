export type BinOp = "+" | "-" | "*" | "/" | "=" | "<>" | "<" | "<=" | ">" | ">=";

export type Expr =
  | { type: "num"; value: number }
  | { type: "ref"; ref: string }
  | { type: "neg"; operand: Expr }
  | { type: "bin"; op: BinOp; left: Expr; right: Expr }
  | { type: "if"; cond: Expr; then: Expr; otherwise: Expr };

export class ParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ParseError";
  }
}

export function normalizeRef(ref: string): string {
  if (!/^[A-Za-z]+[0-9]+$/.test(ref)) {
    throw new ParseError(`invalid cell reference: ${ref}`);
  }
  return ref.toUpperCase();
}

type Token =
  | { t: "num"; v: number }
  | { t: "ref"; v: string }
  | { t: "op"; v: BinOp }
  | { t: "if" }
  | { t: "lparen" }
  | { t: "rparen" }
  | { t: "comma" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    const rest = src.slice(i);
    let m: RegExpMatchArray | null;
    if ((m = rest.match(/^[0-9]+/))) {
      tokens.push({ t: "num", v: parseInt(m[0], 10) });
      i += m[0].length;
    } else if ((m = rest.match(/^[A-Za-z]+[0-9]+/))) {
      tokens.push({ t: "ref", v: m[0].toUpperCase() });
      i += m[0].length;
    } else if ((m = rest.match(/^IF(?![A-Za-z0-9])/i))) {
      tokens.push({ t: "if" });
      i += m[0].length;
    } else if (rest.startsWith("<>") || rest.startsWith("<=") || rest.startsWith(">=")) {
      tokens.push({ t: "op", v: rest.slice(0, 2) as BinOp });
      i += 2;
    } else if ("+-*/=<>".includes(ch)) {
      tokens.push({ t: "op", v: ch as BinOp });
      i += 1;
    } else if (ch === "(") {
      tokens.push({ t: "lparen" });
      i++;
    } else if (ch === ")") {
      tokens.push({ t: "rparen" });
      i++;
    } else if (ch === ",") {
      tokens.push({ t: "comma" });
      i++;
    } else {
      throw new ParseError(`unexpected character '${ch}' at position ${i}`);
    }
  }
  return tokens;
}

export function parseFormula(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const next = (): Token => {
    const tok = tokens[pos];
    if (tok === undefined) throw new ParseError("unexpected end of formula");
    pos++;
    return tok;
  };
  const expect = (t: Token["t"]): void => {
    const tok = next();
    if (tok.t !== t) throw new ParseError(`expected ${t}, got ${tok.t}`);
  };

  function parseExpr(): Expr {
    return parseComparison();
  }

  function parseComparison(): Expr {
    let left = parseAdditive();
    const tok = peek();
    if (tok && tok.t === "op" && ["=", "<>", "<", "<=", ">", ">="].includes(tok.v)) {
      next();
      const right = parseAdditive();
      left = { type: "bin", op: tok.v as BinOp, left, right };
    }
    return left;
  }

  function parseAdditive(): Expr {
    let left = parseTerm();
    for (;;) {
      const tok = peek();
      if (tok && tok.t === "op" && (tok.v === "+" || tok.v === "-")) {
        next();
        left = { type: "bin", op: tok.v, left, right: parseTerm() };
      } else {
        return left;
      }
    }
  }

  function parseTerm(): Expr {
    let left = parseFactor();
    for (;;) {
      const tok = peek();
      if (tok && tok.t === "op" && (tok.v === "*" || tok.v === "/")) {
        next();
        left = { type: "bin", op: tok.v, left, right: parseFactor() };
      } else {
        return left;
      }
    }
  }

  function parseFactor(): Expr {
    const tok = peek();
    if (tok && tok.t === "op" && tok.v === "-") {
      next();
      return { type: "neg", operand: parseFactor() };
    }
    return parsePrimary();
  }

  function parsePrimary(): Expr {
    const tok = next();
    switch (tok.t) {
      case "num":
        return { type: "num", value: tok.v };
      case "ref":
        return { type: "ref", ref: tok.v };
      case "if": {
        expect("lparen");
        const cond = parseExpr();
        expect("comma");
        const then = parseExpr();
        expect("comma");
        const otherwise = parseExpr();
        expect("rparen");
        return { type: "if", cond, then, otherwise };
      }
      case "lparen": {
        const inner = parseExpr();
        expect("rparen");
        return inner;
      }
      default:
        throw new ParseError(`unexpected token ${tok.t}`);
    }
  }

  const expr = parseExpr();
  if (pos !== tokens.length) {
    throw new ParseError(`trailing tokens in formula: ${src}`);
  }
  return expr;
}

export function exprToString(expr: Expr): string {
  switch (expr.type) {
    case "num":
      return String(expr.value);
    case "ref":
      return expr.ref;
    case "neg":
      return `-${exprToString(expr.operand)}`;
    case "bin":
      return `(${exprToString(expr.left)} ${expr.op} ${exprToString(expr.right)})`;
    case "if":
      return `IF(${exprToString(expr.cond)}, ${exprToString(expr.then)}, ${exprToString(expr.otherwise)})`;
  }
}
