import type { Env } from './env.ts';

export type Expr =
  | { readonly kind: 'lit'; readonly value: unknown }
  | { readonly kind: 'ref'; readonly name: string }
  | { readonly kind: 'effect'; readonly label: string; readonly value: unknown };

export const lit = (value: unknown): Expr => ({ kind: 'lit', value });

export const ref = (name: string): Expr => ({ kind: 'ref', name });

export const effect = (label: string, value: unknown): Expr => ({
  kind: 'effect',
  label,
  value,
});

export function evalExpr(expr: Expr, env: Env): unknown {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'ref':
      return env.read(expr.name);
    case 'effect':
      env.log(`eval:${expr.label}`);
      return expr.value;
  }
}
