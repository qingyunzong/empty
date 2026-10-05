// Unification engine.
//
// - One shared occurs check (`occurs`) is used by every unification path:
//   the incremental cached `ConstraintStore` and the from-scratch "no-cache"
//   unifier `unifyAll`.
// - Substitutions map variable ids to frozen type terms.
// - Snapshots handed out by `ConstraintStore.snapshot()` are immutable views
//   over a private copy: older snapshots never change.

import { Type, TVar, tvar, equalType, typeToString } from "./types.js";

export type Subst = Map<number, Type>;

export type UnifyErrorKind = "occurs" | "mismatch";

export interface UnifyErrorInfo {
  readonly kind: UnifyErrorKind;
  /** The two (partially resolved) types that could not be unified. */
  readonly left: Type;
  readonly right: Type;
  /** For occurs failures, the variable that would occur in its own binding. */
  readonly variable?: number;
}

export class UnifyError extends Error {
  readonly info: UnifyErrorInfo;
  constructor(info: UnifyErrorInfo) {
    super(
      info.kind === "occurs"
        ? `occurs check failed: t${info.variable} occurs in ${typeToString(info.right)}`
        : `cannot unify ${typeToString(info.left)} with ${typeToString(info.right)}`,
    );
    this.name = "UnifyError";
    this.info = info;
  }
}

/** Follow substitution links for a variable; non-variables are returned as-is. */
export function chase(t: Type, subst: Subst): Type {
  let cur = t;
  const seen = new Set<number>();
  while (cur.kind === "var" && subst.has(cur.id)) {
    if (seen.has(cur.id)) break; // defensive; occurs check forbids cycles
    seen.add(cur.id);
    cur = subst.get(cur.id)!;
  }
  return cur;
}

/**
 * The unified occurs check: does variable `id` occur in `t` after resolving
 * through `subst`? Shared by every unification entry point.
 */
export function occurs(id: number, t: Type, subst: Subst): boolean {
  const r = chase(t, subst);
  switch (r.kind) {
    case "var":
      return r.id === id;
    case "fun":
      return occurs(id, r.param, subst) || occurs(id, r.result, subst);
    case "list":
      return occurs(id, r.elem, subst);
  }
}

function bind(v: TVar, t: Type, subst: Subst): void {
  if (occurs(v.id, t, subst)) {
    throw new UnifyError({ kind: "occurs", left: v, right: t, variable: v.id });
  }
  subst.set(v.id, t);
}

/**
 * Unify `a` with `b`, extending `subst` in place.
 * Throws `UnifyError` on occurs-check or constructor-mismatch failure.
 */
export function unify(a: Type, b: Type, subst: Subst): void {
  const ra = chase(a, subst);
  const rb = chase(b, subst);
  if (ra === rb) return;
  if (ra.kind === "var" && rb.kind === "var" && ra.id === rb.id) return;
  if (ra.kind === "var") {
    bind(ra, rb, subst);
    return;
  }
  if (rb.kind === "var") {
    bind(rb, ra, subst);
    return;
  }
  if (ra.kind !== rb.kind) {
    throw new UnifyError({ kind: "mismatch", left: ra, right: rb });
  }
  switch (ra.kind) {
    case "fun":
      unify(ra.param, (rb as typeof ra).param, subst);
      unify(ra.result, (rb as typeof ra).result, subst);
      return;
    case "list":
      unify(ra.elem, (rb as typeof ra).elem, subst);
      return;
  }
}

/**
 * Fully expand a type under `subst` (small-term expansion): every variable is
 * replaced by its binding recursively. Terminates because the occurs check
 * keeps substitutions acyclic. The result is a fresh frozen term.
 */
export function expand(t: Type, subst: Subst): Type {
  const r = chase(t, subst);
  switch (r.kind) {
    case "var":
      return tvar(r.id);
    case "fun":
      return Object.freeze({
        kind: "fun",
        param: expand(r.param, subst),
        result: expand(r.result, subst),
      }) as Type;
    case "list":
      return Object.freeze({ kind: "list", elem: expand(r.elem, subst) }) as Type;
  }
}

export interface NamedConstraint {
  readonly id: number;
  readonly name: string;
  readonly lhs: Type;
  readonly rhs: Type;
}

/**
 * The no-cache unifier: solve a set of constraints from an empty substitution,
 * applied in ascending constraint-id order. Used as the ground-truth oracle
 * and for recomputation after revocation.
 */
export function unifyAll(constraints: readonly NamedConstraint[]): Subst {
  const subst: Subst = new Map();
  const ordered = [...constraints].sort((x, y) => x.id - y.id);
  for (const c of ordered) {
    unify(c.lhs, c.rhs, subst);
  }
  return subst;
}

/** A minimal, ID-ordered chain of constraints that still conflicts. */
export interface ConflictChain {
  readonly reason: UnifyErrorInfo;
  /** 1-minimal: removing any single constraint makes the set solvable. */
  readonly constraints: readonly NamedConstraint[];
}

/**
 * Greedy minimization of a failing constraint set.
 *
 * Scans from the highest id downward, dropping every constraint whose removal
 * keeps the set unsolvable. Because unification failure is monotone under
 * supersets, the result is 1-minimal and is returned sorted by ascending id.
 */
export function minimizeConflict(constraints: readonly NamedConstraint[]): ConflictChain {
  let current = [...constraints].sort((x, y) => x.id - y.id);
  let reason = failureReason(current);
  if (reason === null) {
    throw new Error("minimizeConflict: constraint set is solvable, no conflict to minimize");
  }
  for (let i = current.length - 1; i >= 0; i--) {
    const candidate = [...current.slice(0, i), ...current.slice(i + 1)];
    const candidateReason = failureReason(candidate);
    if (candidateReason !== null) {
      current = candidate;
      reason = candidateReason;
    }
  }
  return { reason, constraints: Object.freeze(current.slice()) };
}

function failureReason(constraints: readonly NamedConstraint[]): UnifyErrorInfo | null {
  try {
    unifyAll(constraints);
    return null;
  } catch (e) {
    if (e instanceof UnifyError) return e.info;
    throw e;
  }
}

/** Immutable snapshot of a substitution. Values are frozen type terms. */
export class SubstSnapshot {
  readonly #entries: ReadonlyMap<number, Type>;
  constructor(entries: ReadonlyMap<number, Type>) {
    this.#entries = new Map(entries);
    Object.freeze(this);
  }
  get size(): number {
    return this.#entries.size;
  }
  has(id: number): boolean {
    return this.#entries.has(id);
  }
  get(id: number): Type | undefined {
    return this.#entries.get(id);
  }
  keys(): IterableIterator<number> {
    return this.#entries.keys();
  }
  entries(): IterableIterator<[number, Type]> {
    return this.#entries.entries();
  }
  /** Fully expand a type under this snapshot. */
  expand(t: Type): Type {
    return expand(t, this.#entries as Subst);
  }
}

export type AddResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly id: number; readonly conflict: ConflictChain };

/**
 * Incremental constraint store with named, revocable constraints.
 *
 * Maintains a cached substitution extended on every successful `add`. A
 * failed `add` leaves the store untouched and reports a minimal ID-ordered
 * conflict chain. `revoke` removes a named constraint and recomputes the
 * cache with the no-cache unifier.
 */
export class ConstraintStore {
  readonly #constraints: NamedConstraint[] = [];
  readonly #byName = new Map<string, NamedConstraint>();
  #subst: Subst = new Map();
  #nextId = 1;

  get size(): number {
    return this.#constraints.length;
  }

  list(): readonly NamedConstraint[] {
    return Object.freeze(this.#constraints.slice());
  }

  /**
   * Add a named equality `lhs ~ rhs`. Names must be unique.
   * On failure the store is unchanged and the result carries the minimal
   * conflict chain (which always includes the new constraint).
   */
  add(name: string, lhs: Type, rhs: Type): AddResult {
    if (this.#byName.has(name)) {
      throw new Error(`duplicate constraint name: ${name}`);
    }
    const constraint: NamedConstraint = Object.freeze({
      id: this.#nextId++,
      name,
      lhs,
      rhs,
    });
    const trial: Subst = new Map(this.#subst);
    try {
      unify(lhs, rhs, trial);
    } catch (e) {
      if (!(e instanceof UnifyError)) throw e;
      const conflict = minimizeConflict([...this.#constraints, constraint]);
      return { ok: false, id: constraint.id, conflict };
    }
    this.#subst = trial;
    this.#constraints.push(constraint);
    this.#byName.set(name, constraint);
    return { ok: true, id: constraint.id };
  }

  /** Remove a constraint by name; returns false if no such constraint. */
  revoke(name: string): boolean {
    const target = this.#byName.get(name);
    if (target === undefined) return false;
    this.#byName.delete(name);
    const idx = this.#constraints.indexOf(target);
    this.#constraints.splice(idx, 1);
    this.#subst = unifyAll(this.#constraints);
    return true;
  }

  /** Fully expand a type under the current cached substitution. */
  expand(t: Type): Type {
    return expand(t, this.#subst);
  }

  /** Look up a variable's fully expanded binding, if any. */
  lookup(id: number): Type | undefined {
    const bound = this.#subst.get(id);
    return bound === undefined ? undefined : this.expand(bound);
  }

  /** Immutable snapshot of the current substitution. */
  snapshot(): SubstSnapshot {
    return new SubstSnapshot(this.#subst);
  }
}

/** Structural equality of two types as seen under a substitution. */
export function equalUnder(a: Type, b: Type, subst: Subst): boolean {
  return equalType(expand(a, subst), expand(b, subst));
}
