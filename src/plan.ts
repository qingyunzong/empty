import { Artifact, Manifest, indexById, sortById } from "./model.js";

/**
 * Reversible plan operations. Every op carries enough information to be
 * inverted exactly, so `revertPlan(applyPlan(base, plan), plan)` restores
 * `base` for any conflict-free merge result.
 */
export type PlanOp =
  | { readonly op: "add"; readonly artifact: Artifact }
  | { readonly op: "remove"; readonly id: string; readonly previous: Artifact }
  | { readonly op: "move"; readonly id: string; readonly from: string; readonly to: string }
  | { readonly op: "update"; readonly id: string; readonly from: Artifact; readonly to: Artifact };

/** Invert a single op. */
export function invertOp(op: PlanOp): PlanOp {
  switch (op.op) {
    case "add":
      return { op: "remove", id: op.artifact.id, previous: op.artifact };
    case "remove":
      return { op: "add", artifact: op.previous };
    case "move":
      return { op: "move", id: op.id, from: op.to, to: op.from };
    case "update":
      return { op: "update", id: op.id, from: op.to, to: op.from };
  }
}

/** Invert a whole plan (reverse order, each op inverted). */
export function invertPlan(plan: ReadonlyArray<PlanOp>): PlanOp[] {
  return [...plan].reverse().map(invertOp);
}

/** Apply a plan to a manifest, returning a new manifest sorted by id. */
export function applyPlan(manifest: Manifest, plan: ReadonlyArray<PlanOp>): Artifact[] {
  const byId = indexById(manifest);
  for (const op of plan) {
    switch (op.op) {
      case "add": {
        if (byId.has(op.artifact.id)) {
          throw new Error(`cannot add ${op.artifact.id}: id already present`);
        }
        byId.set(op.artifact.id, op.artifact);
        break;
      }
      case "remove": {
        if (!byId.delete(op.id)) {
          throw new Error(`cannot remove ${op.id}: id not present`);
        }
        break;
      }
      case "move": {
        const current = byId.get(op.id);
        if (!current) {
          throw new Error(`cannot move ${op.id}: id not present`);
        }
        byId.set(op.id, { ...current, path: op.to });
        break;
      }
      case "update": {
        if (!byId.has(op.id)) {
          throw new Error(`cannot update ${op.id}: id not present`);
        }
        byId.set(op.id, op.to);
        break;
      }
    }
  }
  return sortById([...byId.values()]);
}

/** Apply the inverse of `plan` to `manifest`, restoring the pre-merge state. */
export function revertPlan(manifest: Manifest, plan: ReadonlyArray<PlanOp>): Artifact[] {
  return applyPlan(manifest, invertPlan(plan));
}
