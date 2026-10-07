export type BinOp = "add" | "sub" | "mul" | "div";

export type Expr =
  | { readonly kind: "lit"; readonly value: number }
  | { readonly kind: "bin"; readonly op: BinOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: "var"; readonly name: string }
  | { readonly kind: "let"; readonly name: string; readonly value: Expr; readonly body: Expr };

export const lit = (value: number): Expr => ({ kind: "lit", value });

export const bin = (op: BinOp, left: Expr, right: Expr): Expr => ({
  kind: "bin",
  op,
  left,
  right,
});

export const add = (left: Expr, right: Expr): Expr => bin("add", left, right);
export const sub = (left: Expr, right: Expr): Expr => bin("sub", left, right);
export const mul = (left: Expr, right: Expr): Expr => bin("mul", left, right);
export const div = (left: Expr, right: Expr): Expr => bin("div", left, right);

export const v = (name: string): Expr => ({ kind: "var", name });

export const letIn = (name: string, value: Expr, body: Expr): Expr => ({
  kind: "let",
  name,
  value,
  body,
});
