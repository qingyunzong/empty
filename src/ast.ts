export type BinOp = "+" | "-" | "*" | "==" | "<";

export type Expr =
  | { tag: "num"; value: number }
  | { tag: "bool"; value: boolean }
  | { tag: "var"; name: string }
  | { tag: "bin"; op: BinOp; left: Expr; right: Expr }
  | { tag: "let"; name: string; init: Expr; body: Expr }
  | { tag: "fun"; name: string | null; params: string[]; body: Expr }
  | { tag: "call"; callee: Expr; args: Expr[] }
  | { tag: "if"; cond: Expr; then: Expr; else: Expr }
  | { tag: "seq"; exprs: Expr[] }
  | { tag: "throw"; value: Expr }
  | {
      tag: "try";
      body: Expr;
      catchParam: string | null;
      catchBody: Expr | null;
      finallyBody: Expr | null;
    };

export const E = {
  num: (value: number): Expr => ({ tag: "num", value }),
  bool: (value: boolean): Expr => ({ tag: "bool", value }),
  var: (name: string): Expr => ({ tag: "var", name }),
  bin: (op: BinOp, left: Expr, right: Expr): Expr => ({ tag: "bin", op, left, right }),
  add: (left: Expr, right: Expr): Expr => E.bin("+", left, right),
  sub: (left: Expr, right: Expr): Expr => E.bin("-", left, right),
  mul: (left: Expr, right: Expr): Expr => E.bin("*", left, right),
  eq: (left: Expr, right: Expr): Expr => E.bin("==", left, right),
  lt: (left: Expr, right: Expr): Expr => E.bin("<", left, right),
  let: (name: string, init: Expr, body: Expr): Expr => ({ tag: "let", name, init, body }),
  fun: (name: string | null, params: string[], body: Expr): Expr => ({
    tag: "fun",
    name,
    params,
    body,
  }),
  call: (callee: Expr, ...args: Expr[]): Expr => ({ tag: "call", callee, args }),
  if: (cond: Expr, then: Expr, otherwise: Expr): Expr => ({
    tag: "if",
    cond,
    then,
    else: otherwise,
  }),
  seq: (...exprs: Expr[]): Expr => ({ tag: "seq", exprs }),
  throw: (value: Expr): Expr => ({ tag: "throw", value }),
  try: (
    body: Expr,
    opts: { catchParam?: string; catchBody?: Expr; finallyBody?: Expr } = {},
  ): Expr => ({
    tag: "try",
    body,
    catchParam: opts.catchParam ?? null,
    catchBody: opts.catchBody ?? null,
    finallyBody: opts.finallyBody ?? null,
  }),
};
