/** Core type language: variables, functions, lists. */

export type Type =
  | { readonly kind: "var"; readonly id: number }
  | { readonly kind: "fun"; readonly arg: Type; readonly ret: Type }
  | { readonly kind: "list"; readonly elem: Type };

export const tvar = (id: number): Type => ({ kind: "var", id });
export const tfun = (arg: Type, ret: Type): Type => ({ kind: "fun", arg, ret });
export const tlist = (elem: Type): Type => ({ kind: "list", elem });

/** Structural equality on (fully resolved) types. */
export function typeEquals(a: Type, b: Type): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "var":
      return a.id === (b as { id: number }).id;
    case "fun": {
      const bb = b as { arg: Type; ret: Type };
      return typeEquals(a.arg, bb.arg) && typeEquals(a.ret, bb.ret);
    }
    case "list":
      return typeEquals(a.elem, (b as { elem: Type }).elem);
  }
}

export function showType(t: Type): string {
  switch (t.kind) {
    case "var":
      return `t${t.id}`;
    case "fun":
      return `(${showType(t.arg)} -> ${showType(t.ret)})`;
    case "list":
      return `[${showType(t.elem)}]`;
  }
}

/** Deep freeze so snapshots can never be mutated, even by library users. */
export function deepFreezeType(t: Type): Type {
  switch (t.kind) {
    case "var":
      return Object.freeze({ kind: "var", id: t.id });
    case "fun":
      return Object.freeze({
        kind: "fun",
        arg: deepFreezeType(t.arg),
        ret: deepFreezeType(t.ret),
      });
    case "list":
      return Object.freeze({ kind: "list", elem: deepFreezeType(t.elem) });
  }
}
