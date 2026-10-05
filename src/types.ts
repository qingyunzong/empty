// Core type terms for the inference library.
//
// Every `Type` node is deeply frozen at construction time, so any type value
// (including snapshots handed out earlier) is immutable: once created it can
// never change, and callers can share nodes freely.

export interface TVar {
  readonly kind: "var";
  readonly id: number;
}

export interface TFun {
  readonly kind: "fun";
  readonly param: Type;
  readonly result: Type;
}

export interface TList {
  readonly kind: "list";
  readonly elem: Type;
}

export type Type = TVar | TFun | TList;

function deepFreezeType(t: Type): void {
  if (!Object.isFrozen(t)) {
    if (t.kind === "fun") {
      deepFreezeType(t.param);
      deepFreezeType(t.result);
    } else if (t.kind === "list") {
      deepFreezeType(t.elem);
    }
    Object.freeze(t);
  }
}

export function tvar(id: number): TVar {
  if (!Number.isInteger(id) || id < 0) {
    throw new RangeError(`type variable id must be a non-negative integer, got ${id}`);
  }
  const t: TVar = { kind: "var", id };
  Object.freeze(t);
  return t;
}

export function tfun(param: Type, result: Type): TFun {
  const t: TFun = { kind: "fun", param, result };
  deepFreezeType(t);
  return t;
}

export function tlist(elem: Type): TList {
  const t: TList = { kind: "list", elem };
  deepFreezeType(t);
  return t;
}

/** Structural equality on (frozen) type terms. */
export function equalType(a: Type, b: Type): boolean {
  if (a === b) return true;
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "var":
      return a.id === (b as TVar).id;
    case "fun":
      return equalType(a.param, (b as TFun).param) && equalType(a.result, (b as TFun).result);
    case "list":
      return equalType(a.elem, (b as TList).elem);
  }
}

export function typeToString(t: Type): string {
  switch (t.kind) {
    case "var":
      return `t${t.id}`;
    case "fun":
      return `(${typeToString(t.param)} -> ${typeToString(t.result)})`;
    case "list":
      return `[${typeToString(t.elem)}]`;
  }
}

/** All variable ids occurring in a type, sorted ascending, duplicates removed. */
export function collectVars(t: Type): number[] {
  const acc = new Set<number>();
  const walk = (n: Type): void => {
    switch (n.kind) {
      case "var":
        acc.add(n.id);
        return;
      case "fun":
        walk(n.param);
        walk(n.result);
        return;
      case "list":
        walk(n.elem);
        return;
    }
  };
  walk(t);
  return [...acc].sort((x, y) => x - y);
}
