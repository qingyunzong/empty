export type BinOp = 'add' | 'sub' | 'mul' | 'div';

export type Expr =
  | { readonly kind: 'lit'; readonly value: number }
  | { readonly kind: BinOp; readonly left: Expr; readonly right: Expr }
  | { readonly kind: 'var'; readonly name: string }
  | { readonly kind: 'let'; readonly name: string; readonly value: Expr; readonly body: Expr };

export const lit = (value: number): Expr => ({ kind: 'lit', value });

export const bin = (kind: BinOp, left: Expr, right: Expr): Expr => ({ kind, left, right });
export const add = (left: Expr, right: Expr): Expr => bin('add', left, right);
export const sub = (left: Expr, right: Expr): Expr => bin('sub', left, right);
export const mul = (left: Expr, right: Expr): Expr => bin('mul', left, right);
export const div = (left: Expr, right: Expr): Expr => bin('div', left, right);

export const variable = (name: string): Expr => ({ kind: 'var', name });

/** Recursive let: `name` is in scope inside its own definition, like letrec. */
export const letIn = (name: string, value: Expr, body: Expr): Expr => ({
  kind: 'let',
  name,
  value,
  body,
});
