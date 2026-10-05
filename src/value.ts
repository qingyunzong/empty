import { compareAddr, formatAddr, type Addr } from './address.js';

export type ErrorCode = 'DIV/0' | 'EMPTY';

export type Value =
  | { kind: 'int'; value: number }
  | { kind: 'error'; code: ErrorCode; origin: Addr };

export function intValue(n: number): Value {
  return { kind: 'int', value: n };
}

export function errorValue(code: ErrorCode, origin: Addr): Value {
  return { kind: 'error', code, origin };
}

/**
 * Error propagation rule: when several errors meet, the one with the
 * minimal origin address (row-major order) wins.
 */
export function minError(a: Value, b: Value): Value {
  if (a.kind === 'error' && b.kind === 'error') {
    return compareAddr(a.origin, b.origin) <= 0 ? a : b;
  }
  return a.kind === 'error' ? a : b;
}

export function valueEquals(a: Value, b: Value): boolean {
  if (a.kind === 'int' && b.kind === 'int') return a.value === b.value;
  if (a.kind === 'error' && b.kind === 'error') {
    return (
      a.code === b.code &&
      a.origin.row === b.origin.row &&
      a.origin.col === b.origin.col
    );
  }
  return false;
}

export function formatValue(v: Value): string {
  return v.kind === 'int' ? String(v.value) : `#${v.code}!@${formatAddr(v.origin)}`;
}
