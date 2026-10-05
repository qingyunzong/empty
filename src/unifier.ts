import { Type, tvar, deepFreezeType, showType } from "./types.js";

export interface Constraint {
  readonly id: number;
  readonly name: string;
  readonly left: Type;
  readonly right: Type;
}

export type UnifyFailureReason = "occurs" | "shape-mismatch";

export interface UnifyError {
  readonly reason: UnifyFailureReason;
  readonly left: Type;
  readonly right: Type;
  readonly message: string;
}

/** Minimal conflicting constraint chain, ordered by constraint id. */
export interface ConflictChain {
  readonly constraintIds: readonly number[];
  readonly reason: UnifyFailureReason;
  readonly message: string;
}

export type AddResult =
  | { readonly ok: true; readonly id: number }
  | { readonly ok: false; readonly conflict: ConflictChain };

/** Immutable view of the substitution at a past point in time. */
export interface Snapshot {
  /** Fully resolve a type against the frozen substitution. */
  resolve(t: Type): Type;
  /** Frozen variable bindings captured at snapshot time. */
  bindings(): ReadonlyMap<number, Type>;
}

type Subst = Map<number, Type>;

function resolveIn(subst: Subst, t: Type): Type {
  // Path compression: the "cached" fast path of the main unifier.
  let cur = t;
  while (cur.kind === "var" && subst.has(cur.id)) {
    cur = subst.get(cur.id)!;
  }
  if (t.kind === "var" && cur !== t) subst.set(t.id, cur);
  return cur;
}

/** The single, unified occurs check used by every binding site. */
function occursIn(subst: Subst, varId: number, t: Type): boolean {
  const r = resolveIn(subst, t);
  switch (r.kind) {
    case "var":
      return r.id === varId;
    case "fun":
      return occursIn(subst, varId, r.arg) || occursIn(subst, varId, r.ret);
    case "list":
      return occursIn(subst, varId, r.elem);
  }
}

function bindVar(subst: Subst, varId: number, t: Type): UnifyError | null {
  if (occursIn(subst, varId, t)) {
    return {
      reason: "occurs",
      left: tvar(varId),
      right: t,
      message: `occurs check failed: t${varId} occurs in ${showType(t)}`,
    };
  }
  subst.set(varId, t);
  return null;
}

function unifyIn(subst: Subst, a: Type, b: Type): UnifyError | null {
  const ra = resolveIn(subst, a);
  const rb = resolveIn(subst, b);
  if (ra.kind === "var" && rb.kind === "var" && ra.id === rb.id) return null;
  if (ra.kind === "var") return bindVar(subst, ra.id, rb);
  if (rb.kind === "var") return bindVar(subst, rb.id, ra);
  if (ra.kind !== rb.kind) {
    return {
      reason: "shape-mismatch",
      left: ra,
      right: rb,
      message: `cannot unify ${showType(ra)} with ${showType(rb)}`,
    };
  }
  if (ra.kind === "fun" && rb.kind === "fun") {
    return unifyIn(subst, ra.arg, rb.arg) ?? unifyIn(subst, ra.ret, rb.ret);
  }
  if (ra.kind === "list" && rb.kind === "list") {
    return unifyIn(subst, ra.elem, rb.elem);
  }
  return null;
}

/** Replay constraints in id order into a fresh substitution. */
function checkSet(constraints: readonly Constraint[]): UnifyError | null {
  const subst: Subst = new Map();
  const sorted = [...constraints].sort((x, y) => x.id - y.id);
  for (const c of sorted) {
    const err = unifyIn(subst, c.left, c.right);
    if (err) return err;
  }
  return null;
}

/**
 * Greedy 1-minimal failing subset: removing any single remaining
 * constraint makes the set unifiable again. Returned in id order.
 */
export function minimizeConflict(constraints: readonly Constraint[]): ConflictChain {
  const firstError = checkSet(constraints);
  if (!firstError) {
    throw new Error("minimizeConflict called on a unifiable constraint set");
  }
  let work = [...constraints];
  let i = 0;
  while (i < work.length) {
    const candidate = [...work.slice(0, i), ...work.slice(i + 1)];
    if (checkSet(candidate) !== null) {
      work = candidate; // still fails without it: drop permanently
    } else {
      i++;
    }
  }
  work.sort((x, y) => x.id - y.id);
  const err = checkSet(work)!;
  return {
    constraintIds: work.map((c) => c.id),
    reason: err.reason,
    message: `minimal conflict chain [${work.map((c) => `#${c.id}`).join(", ")}]: ${err.message}`,
  };
}

export class Unifier {
  private constraints: Constraint[] = [];
  private subst: Subst = new Map();
  private nextId = 1;

  /** Add a named constraint. On failure nothing is stored; a minimal conflict chain is returned. */
  add(name: string, left: Type, right: Type): AddResult {
    const constraint: Constraint = { id: this.nextId++, name, left, right };
    const err = unifyIn(this.subst, left, right);
    if (err) {
      // The failed attempt may have polluted the substitution; rebuild it.
      this.rebuild();
      const conflict = minimizeConflict([...this.constraints, constraint]);
      return { ok: false, conflict };
    }
    this.constraints.push(constraint);
    return { ok: true, id: constraint.id };
  }

  /** Undo every constraint carrying this name. Returns removed ids. */
  undo(name: string): number[] {
    const removed = this.constraints.filter((c) => c.name === name).map((c) => c.id);
    if (removed.length === 0) return [];
    this.constraints = this.constraints.filter((c) => c.name !== name);
    this.rebuild();
    return removed;
  }

  undoById(id: number): boolean {
    const before = this.constraints.length;
    this.constraints = this.constraints.filter((c) => c.id !== id);
    if (this.constraints.length === before) return false;
    this.rebuild();
    return true;
  }

  /** Resolve a type against the current (live) substitution. */
  resolve(t: Type): Type {
    const r = resolveIn(this.subst, t);
    switch (r.kind) {
      case "var":
        return r;
      case "fun":
        return { kind: "fun", arg: this.resolve(r.arg), ret: this.resolve(r.ret) };
      case "list":
        return { kind: "list", elem: this.resolve(r.elem) };
    }
  }

  /** Capture an immutable snapshot; later adds/undos never affect it. */
  snapshot(): Snapshot {
    const frozen = new Map<number, Type>();
    for (const id of this.knownVars()) {
      frozen.set(id, deepFreezeType(this.resolve(tvar(id))));
    }
    const resolveFrozen = (t: Type): Type => {
      const walk = (x: Type): Type => {
        switch (x.kind) {
          case "var":
            return frozen.get(x.id) ?? deepFreezeType(tvar(x.id));
          case "fun":
            return deepFreezeType({ kind: "fun", arg: walk(x.arg), ret: walk(x.ret) });
          case "list":
            return deepFreezeType({ kind: "list", elem: walk(x.elem) });
        }
      };
      return walk(t);
    };
    return {
      resolve: resolveFrozen,
      bindings: () => new Map(frozen),
    };
  }

  constraintCount(): number {
    return this.constraints.length;
  }

  listConstraints(): readonly Constraint[] {
    return this.constraints;
  }

  private knownVars(): Set<number> {
    const out = new Set<number>();
    const visit = (t: Type): void => {
      switch (t.kind) {
        case "var":
          out.add(t.id);
          break;
        case "fun":
          visit(t.arg);
          visit(t.ret);
          break;
        case "list":
          visit(t.elem);
          break;
      }
    };
    for (const c of this.constraints) {
      visit(c.left);
      visit(c.right);
    }
    for (const t of this.subst.values()) visit(t);
    return out;
  }

  private rebuild(): void {
    this.subst = new Map();
    const sorted = [...this.constraints].sort((x, y) => x.id - y.id);
    for (const c of sorted) {
      const err = unifyIn(this.subst, c.left, c.right);
      if (err) {
        // Invariant: stored constraints are always jointly unifiable.
        throw new Error(`internal inconsistency while rebuilding: ${err.message}`);
      }
    }
  }
}
