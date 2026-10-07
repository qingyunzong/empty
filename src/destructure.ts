import { evalExpr, type Expr } from './expr.ts';
import type { Env } from './env.ts';
import type { Pattern } from './pattern.ts';

type Binding = readonly [name: string, value: unknown];

export function destructure(pattern: Pattern, source: Expr, env: Env): void {
  const value = evalExpr(source, env);
  const bindings: Binding[] = [];
  collect(pattern, value, env, bindings);
  for (const [name, bound] of bindings) {
    env.write(name, bound);
  }
}

function collect(
  pattern: Pattern,
  value: unknown,
  env: Env,
  out: Binding[],
): void {
  switch (pattern.kind) {
    case 'ident':
      out.push([pattern.name, value]);
      return;
    case 'default': {
      const resolved = value === undefined ? evalExpr(pattern.expr, env) : value;
      collect(pattern.pattern, resolved, env, out);
      return;
    }
    case 'array': {
      const items = requireArray(value);
      for (let i = 0; i < pattern.elements.length; i += 1) {
        const element = pattern.elements[i];
        if (element !== null) {
          collect(element, items[i], env, out);
        }
      }
      if (pattern.rest !== null) {
        collect(pattern.rest, items.slice(pattern.elements.length), env, out);
      }
      return;
    }
    case 'object': {
      const record = requireObject(value);
      const used = new Set<string>();
      for (const { key, value: sub } of pattern.props) {
        used.add(key);
        collect(sub, record[key], env, out);
      }
      if (pattern.rest !== null) {
        const restObj: Record<string, unknown> = {};
        for (const key of Object.keys(record)) {
          if (!used.has(key)) {
            restObj[key] = record[key];
          }
        }
        collect(pattern.rest, restObj, env, out);
      }
      return;
    }
  }
}

function requireObject(value: unknown): Record<string, unknown> {
  if (value === null || value === undefined) {
    throw new TypeError(
      `Cannot destructure ${value === null ? 'null' : 'undefined'} against an object pattern`,
    );
  }
  return value as Record<string, unknown>;
}

function requireArray(value: unknown): unknown[] {
  requireObject(value);
  if (!Array.isArray(value)) {
    throw new TypeError('Cannot destructure a non-array value against an array pattern');
  }
  return value;
}
