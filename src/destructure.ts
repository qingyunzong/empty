import { evalExpr, type Expr } from './expr';
import type { Pattern } from './pattern';
import type { Scope } from './scope';

type Binding = [name: string, value: unknown];

/**
 * Destructuring assignment with two-phase semantics:
 *
 *   Phase 1: evaluate the RHS exactly once, then walk the pattern
 *            left-to-right (depth-first), reading properties/elements
 *            and evaluating default expressions. All results are
 *            collected into a pending binding list.
 *   Phase 2: commit every binding to the scope, in pattern order.
 *
 * If anything in phase 1 throws, no binding is written (atomicity).
 * A default applies only when the matched value is `undefined`
 * (missing); `null` is preserved as-is.
 */
export function destructureAssign(scope: Scope, pattern: Pattern, rhs: Expr): void {
  const root = evalExpr(scope, rhs);
  const pending: Binding[] = [];
  collect(scope, pattern, root, pending);
  for (const [name, value] of pending) scope.set(name, value);
}

function collect(scope: Scope, pattern: Pattern, value: unknown, out: Binding[]): void {
  if (value === undefined && pattern.default !== undefined) {
    value = evalExpr(scope, pattern.default);
  }
  switch (pattern.kind) {
    case 'ident':
      out.push([pattern.name, value]);
      return;
    case 'array': {
      const items = toArray(value);
      pattern.elements.forEach((element, index) => {
        if (element !== null) collect(scope, element, items[index], out);
      });
      if (pattern.rest) out.push([pattern.rest.name, items.slice(pattern.elements.length)]);
      return;
    }
    case 'object': {
      const source = toObject(value);
      const used = new Set<string>();
      for (const { key, value: sub } of pattern.props) {
        used.add(key);
        collect(scope, sub, (source as Record<string, unknown>)[key], out);
      }
      if (pattern.rest) {
        const restObj: Record<string, unknown> = {};
        for (const key of Object.keys(source)) {
          if (!used.has(key)) restObj[key] = (source as Record<string, unknown>)[key];
        }
        out.push([pattern.rest.name, restObj]);
      }
      return;
    }
  }
}

function toObject(value: unknown): object {
  if (value === null || value === undefined) {
    throw new TypeError('cannot destructure null or undefined');
  }
  return value as object;
}

function toArray(value: unknown): unknown[] {
  toObject(value);
  if (!Array.isArray(value)) throw new TypeError('array pattern requires an array value');
  return value;
}
