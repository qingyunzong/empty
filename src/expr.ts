// Boolean expression AST, parser, and two independent evaluators:
//  - maskOf:     bigint truth-mask over all 2^n assignments (used by the solver)
//  - evalNaive:  plain per-assignment recursive evaluation (used by the verifier)
// Keeping the two implementations separate lets `verify` cross-check `solve`.

export type Expr =
  | { kind: "const"; value: boolean }
  | { kind: "var"; name: string }
  | { kind: "not"; arg: Expr }
  | { kind: "and"; left: Expr; right: Expr }
  | { kind: "or"; left: Expr; right: Expr }
  | { kind: "xor"; left: Expr; right: Expr }
  | { kind: "imp"; left: Expr; right: Expr }
  | { kind: "iff"; left: Expr; right: Expr };

export class ParseError extends Error {}

type Token =
  | { t: "ident"; text: string }
  | { t: "op"; text: string }
  | { t: "lparen" }
  | { t: "rparen" };

function tokenize(src: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i++;
      continue;
    }
    if (ch === "(") {
      tokens.push({ t: "lparen" });
      i++;
      continue;
    }
    if (ch === ")") {
      tokens.push({ t: "rparen" });
      i++;
      continue;
    }
    if (src.startsWith("<->", i)) {
      tokens.push({ t: "op", text: "<->" });
      i += 3;
      continue;
    }
    if (src.startsWith("->", i)) {
      tokens.push({ t: "op", text: "->" });
      i += 2;
      continue;
    }
    if (src.startsWith("&&", i) || src.startsWith("||", i)) {
      tokens.push({ t: "op", text: src.slice(i, i + 2) });
      i += 2;
      continue;
    }
    if (ch === "&" || ch === "|" || ch === "^" || ch === "!" || ch === "~") {
      tokens.push({ t: "op", text: ch });
      i++;
      continue;
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
      let j = i;
      while (j < src.length && /[A-Za-z0-9_]/.test(src[j])) j++;
      tokens.push({ t: "ident", text: src.slice(i, j) });
      i = j;
      continue;
    }
    throw new ParseError(`unexpected character '${ch}' at position ${i}`);
  }
  return tokens;
}

// Precedence (loosest to tightest): <-> , -> , | / xor , & , ! , atoms.
export function parseExpr(src: string): Expr {
  const tokens = tokenize(src);
  let pos = 0;

  const peek = (): Token | undefined => tokens[pos];
  const takeOp = (...texts: string[]): string | null => {
    const tok = peek();
    if (tok && tok.t === "op" && texts.includes(tok.text)) {
      pos++;
      return tok.text;
    }
    if (tok && tok.t === "ident") {
      const kw = tok.text.toLowerCase();
      if (texts.includes(kw)) {
        pos++;
        return kw;
      }
    }
    return null;
  };

  const parseIff = (): Expr => {
    let left = parseImp();
    while (takeOp("<->", "iff") !== null) {
      left = { kind: "iff", left, right: parseImp() };
    }
    return left;
  };
  const parseImp = (): Expr => {
    const left = parseOr();
    if (takeOp("->", "implies") !== null) {
      return { kind: "imp", left, right: parseImp() }; // right associative
    }
    return left;
  };
  const parseOr = (): Expr => {
    let left = parseAnd();
    for (;;) {
      if (takeOp("|", "||", "or") !== null) {
        left = { kind: "or", left, right: parseAnd() };
      } else if (takeOp("^", "xor") !== null) {
        left = { kind: "xor", left, right: parseAnd() };
      } else {
        return left;
      }
    }
  };
  const parseAnd = (): Expr => {
    let left = parseUnary();
    while (takeOp("&", "&&", "and") !== null) {
      left = { kind: "and", left, right: parseUnary() };
    }
    return left;
  };
  const parseUnary = (): Expr => {
    if (takeOp("!", "~", "not") !== null) {
      return { kind: "not", arg: parseUnary() };
    }
    return parseAtom();
  };
  const parseAtom = (): Expr => {
    const tok = peek();
    if (!tok) throw new ParseError("unexpected end of expression");
    if (tok.t === "lparen") {
      pos++;
      const inner = parseIff();
      const closing = peek();
      if (!closing || closing.t !== "rparen") throw new ParseError("missing closing parenthesis");
      pos++;
      return inner;
    }
    if (tok.t === "ident") {
      pos++;
      const lower = tok.text.toLowerCase();
      if (lower === "true" || tok.text === "1") return { kind: "const", value: true };
      if (lower === "false" || tok.text === "0") return { kind: "const", value: false };
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tok.text)) {
        throw new ParseError(`invalid variable name '${tok.text}'`);
      }
      return { kind: "var", name: tok.text };
    }
    throw new ParseError(`unexpected token '${tok.t === "op" ? tok.text : tok.t}'`);
  };

  const result = parseIff();
  if (pos !== tokens.length) {
    throw new ParseError(`trailing tokens after complete expression (token ${pos + 1} of ${tokens.length})`);
  }
  return result;
}

export function varsOf(expr: Expr): string[] {
  const out = new Set<string>();
  const walk = (e: Expr): void => {
    switch (e.kind) {
      case "var":
        out.add(e.name);
        break;
      case "not":
        walk(e.arg);
        break;
      case "and":
      case "or":
      case "xor":
      case "imp":
      case "iff":
        walk(e.left);
        walk(e.right);
        break;
      case "const":
        break;
    }
  };
  walk(expr);
  return [...out].sort();
}

// Independent naive evaluator (used by the verifier and the proof-tree builder).
export function evalNaive(expr: Expr, get: (name: string) => boolean): boolean {
  switch (expr.kind) {
    case "const":
      return expr.value;
    case "var":
      return get(expr.name);
    case "not":
      return !evalNaive(expr.arg, get);
    case "and":
      return evalNaive(expr.left, get) && evalNaive(expr.right, get);
    case "or":
      return evalNaive(expr.left, get) || evalNaive(expr.right, get);
    case "xor":
      return evalNaive(expr.left, get) !== evalNaive(expr.right, get);
    case "imp":
      return !evalNaive(expr.left, get) || evalNaive(expr.right, get);
    case "iff":
      return evalNaive(expr.left, get) === evalNaive(expr.right, get);
  }
}

// Bit `a` of a mask corresponds to assignment index `a` (0 .. 2^n - 1), where
// variable j in the sorted variable list takes bit (n-1-j) of `a`. Ascending
// assignment index is therefore lexicographic order (false < true, first
// variable most significant), which is what makes "lowest set bit" equal to
// the lexicographically smallest satisfying assignment.
export function fullMask(n: number): bigint {
  return (1n << (1n << BigInt(n))) - 1n;
}

export function varMask(varIndex: number, n: number): bigint {
  const run = 1 << (n - 1 - varIndex);
  let mask = ((1n << BigInt(run)) - 1n) << BigInt(run); // one 0^run 1^run block
  let len = 2 * run;
  const total = 1 << n;
  while (len < total) {
    mask |= mask << BigInt(len);
    len *= 2;
  }
  return mask;
}

export function maskOf(expr: Expr, vars: string[]): bigint {
  const n = vars.length;
  const full = fullMask(n);
  const index = new Map(vars.map((v, i) => [v, i]));
  const go = (e: Expr): bigint => {
    switch (e.kind) {
      case "const":
        return e.value ? full : 0n;
      case "var": {
        const i = index.get(e.name);
        if (i === undefined) throw new Error(`variable '${e.name}' not in variable list`);
        return varMask(i, n);
      }
      case "not":
        return full ^ go(e.arg);
      case "and":
        return go(e.left) & go(e.right);
      case "or":
        return go(e.left) | go(e.right);
      case "xor":
        return go(e.left) ^ go(e.right);
      case "imp":
        return (full ^ go(e.left)) | go(e.right);
      case "iff":
        return full ^ (go(e.left) ^ go(e.right));
    }
  };
  return go(expr);
}

export function exprToString(expr: Expr): string {
  switch (expr.kind) {
    case "const":
      return expr.value ? "true" : "false";
    case "var":
      return expr.name;
    case "not":
      return `!${atom(expr.arg)}`;
    case "and":
      return `${atom(expr.left)} & ${atom(expr.right)}`;
    case "or":
      return `${atom(expr.left)} | ${atom(expr.right)}`;
    case "xor":
      return `${atom(expr.left)} ^ ${atom(expr.right)}`;
    case "imp":
      return `${atom(expr.left)} -> ${atom(expr.right)}`;
    case "iff":
      return `${atom(expr.left)} <-> ${atom(expr.right)}`;
  }
}

function atom(expr: Expr): string {
  return expr.kind === "const" || expr.kind === "var" || expr.kind === "not"
    ? exprToString(expr)
    : `(${exprToString(expr)})`;
}
