import { Type, tvar, typeEquals } from "./types.js";
import type { Constraint } from "./unifier.js";

/**
 * Reference implementation used to cross-check the main Unifier.
 * Deliberately naive: an association-list substitution, full term
 * rewriting on every step, no path compression, no caching of any kind.
 */

type Pair = readonly [number, Type];

function substitute(t: Type, id: number, replacement: Type): Type {
  switch (t.kind) {
    case "var":
      return t.id === id ? replacement : t;
    case "fun":
      return {
        kind: "fun",
        arg: substitute(t.arg, id, replacement),
        ret: substitute(t.ret, id, replacement),
      };
    case "list":
      return { kind: "list", elem: substitute(t.elem, id, replacement) };
  }
}

function applyAll(subst: readonly Pair[], t: Type): Type {
  let out = t;
  for (const [id, replacement] of subst) {
    out = substitute(out, id, replacement);
  }
  return out;
}

function occursNaive(id: number, t: Type): boolean {
  switch (t.kind) {
    case "var":
      return t.id === id;
    case "fun":
      return occursNaive(id, t.arg) || occursNaive(id, t.ret);
    case "list":
      return occursNaive(id, t.elem);
  }
}

export type OracleResult =
  | { readonly ok: true; readonly subst: readonly Pair[] }
  | { readonly ok: false };

/** Unify constraints in id order with the naive algorithm. */
export function oracleUnify(constraints: readonly Constraint[]): OracleResult {
  let subst: Pair[] = [];
  const sorted = [...constraints].sort((x, y) => x.id - y.id);
  for (const c of sorted) {
    const left = applyAll(subst, c.left);
    const right = applyAll(subst, c.right);
    const next = naiveUnify(left, right, subst);
    if (next === null) return { ok: false };
    subst = next;
  }
  return { ok: true, subst };
}

function naiveUnify(a: Type, b: Type, subst: readonly Pair[]): Pair[] | null {
  if (typeEquals(a, b)) return [...subst];
  if (a.kind === "var") {
    if (occursNaive(a.id, b)) return null;
    // Eagerly rewrite every existing binding so nothing is ever cached lazily.
    const extended = subst.map(([id, t]) => [id, substitute(t, a.id, b)] as Pair);
    extended.push([a.id, b]);
    return extended;
  }
  if (b.kind === "var") return naiveUnify(b, a, subst);
  if (a.kind === "fun" && b.kind === "fun") {
    const s1 = naiveUnify(a.arg, b.arg, subst);
    if (s1 === null) return null;
    return naiveUnify(applyAll(s1, a.ret), applyAll(s1, b.ret), s1);
  }
  if (a.kind === "list" && b.kind === "list") {
    return naiveUnify(a.elem, b.elem, subst);
  }
  return null;
}

/** Fully expand a type through an oracle substitution. */
export function oracleExpand(subst: readonly Pair[], t: Type): Type {
  return applyAll(subst, t);
}

/**
 * Small-term expansion check: after a successful unification, both sides
 * of every constraint must expand to structurally identical small terms.
 */
export function expansionHolds(
  constraints: readonly Constraint[],
  subst: readonly Pair[],
): boolean {
  return constraints.every((c) =>
    typeEquals(oracleExpand(subst, c.left), oracleExpand(subst, c.right)),
  );
}

/** Expand a type through the main unifier's live resolution for comparison. */
export function expandWith(resolve: (t: Type) => Type, t: Type): Type {
  return resolve(t);
}

export { tvar };
