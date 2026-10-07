import { compareAddrStr } from './address.js';

export type ErrKind = '#DIV/0!' | '#CYCLE!' | '#ERROR!';

export type Value =
  | { ok: true; v: number }
  | { ok: false; kind: ErrKind; source: string };

export function intVal(v: number): Value {
  return { ok: true, v: Math.trunc(v) };
}

export function errVal(kind: ErrKind, source: string): Value {
  return { ok: false, kind, source };
}

export function isErr(v: Value): v is { ok: false; kind: ErrKind; source: string } {
  return !v.ok;
}

/** 两个错误合并：保留来源地址最小者。 */
export function minError(a: Value, b: Value): Value {
  if (!isErr(a)) return b;
  if (!isErr(b)) return a;
  return compareAddrStr(a.source, b.source) <= 0 ? a : b;
}

export function formatValue(v: Value): string {
  return v.ok ? `INT ${v.v}` : `ERR ${v.kind}@${v.source}`;
}
