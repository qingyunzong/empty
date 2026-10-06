import type { Scope } from './scope';

export type Expr =
  | { kind: 'lit'; value: unknown }
  | { kind: 'ref'; name: string }
  | { kind: 'get'; obj: Expr; key: Expr }
  | { kind: 'call'; fn: Expr; args: Expr[] }
  | { kind: 'arr'; items: Expr[] }
  | { kind: 'obj'; props: { key: string; value: Expr }[] };

export const lit = (value: unknown): Expr => ({ kind: 'lit', value });
export const ref = (name: string): Expr => ({ kind: 'ref', name });
export const get = (obj: Expr, key: Expr): Expr => ({ kind: 'get', obj, key });
export const call = (fn: Expr, ...args: Expr[]): Expr => ({ kind: 'call', fn, args });
export const arr = (...items: Expr[]): Expr => ({ kind: 'arr', items });
export const obj = (props: Record<string, Expr>): Expr => ({
  kind: 'obj',
  props: Object.entries(props).map(([key, value]) => ({ key, value })),
});

export function evalExpr(scope: Scope, expr: Expr): unknown {
  switch (expr.kind) {
    case 'lit':
      return expr.value;
    case 'ref':
      return scope.get(expr.name);
    case 'get': {
      const target = evalExpr(scope, expr.obj);
      const key = evalExpr(scope, expr.key);
      if (target === null || target === undefined) {
        throw new TypeError(`cannot read property ${String(key)} of ${target}`);
      }
      return (target as Record<PropertyKey, unknown>)[key as PropertyKey];
    }
    case 'call': {
      const fn = evalExpr(scope, expr.fn);
      if (typeof fn !== 'function') throw new TypeError('expression is not callable');
      const args = expr.args.map((arg) => evalExpr(scope, arg));
      return (fn as (...xs: unknown[]) => unknown)(...args);
    }
    case 'arr':
      return expr.items.map((item) => evalExpr(scope, item));
    case 'obj': {
      const out: Record<string, unknown> = {};
      for (const prop of expr.props) out[prop.key] = evalExpr(scope, prop.value);
      return out;
    }
  }
}
