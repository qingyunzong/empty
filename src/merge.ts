import { Artifact, Manifest, indexById, sameArtifact, sortById } from "./model.js";
import { PlanOp } from "./plan.js";

export type Side = "ours" | "theirs";

export type Conflict =
  | {
      readonly type: "delete-modify";
      readonly id: string;
      readonly ancestor: Artifact;
      readonly changed: Artifact;
      readonly changedSide: Side;
    }
  | {
      readonly type: "add-add";
      readonly id: string;
      readonly ours: Artifact;
      readonly theirs: Artifact;
    }
  | {
      readonly type: "digest";
      readonly id: string;
      readonly ancestor: Artifact;
      readonly ours: Artifact;
      readonly theirs: Artifact;
    }
  | {
      readonly type: "move-move";
      readonly id: string;
      readonly ancestor: Artifact;
      readonly ours: Artifact;
      readonly theirs: Artifact;
    }
  | {
      readonly type: "path-collision";
      readonly path: string;
      readonly ids: ReadonlyArray<string>;
      readonly artifacts: ReadonlyArray<Artifact>;
    };

export interface MergeResult {
  /** Auto-merged entries, sorted by id. Ids involved in conflicts are excluded. */
  readonly merged: Artifact[];
  /** All conflicts detected, in deterministic order. */
  readonly conflicts: Conflict[];
  /**
   * Reversible plan transforming `ancestor` into `merged`
   * (covers only auto-merged entries; conflicted ids are untouched).
   */
  readonly plan: PlanOp[];
}

interface PerIdOutcome {
  readonly result?: Artifact | undefined;
  readonly op?: PlanOp | undefined;
  readonly conflict?: Conflict | undefined;
}

/** Diff a kept entry against its ancestor version into a plan op, if changed. */
function diffOp(ancestor: Artifact, next: Artifact): PlanOp | undefined {
  if (sameArtifact(ancestor, next)) {
    return undefined;
  }
  if (ancestor.digest === next.digest) {
    return { op: "move", id: next.id, from: ancestor.path, to: next.path };
  }
  return { op: "update", id: next.id, from: ancestor, to: next };
}

/**
 * Independent per-id merge rule. Given the ancestor/ours/theirs versions of a
 * single object id, decide the merged entry, the plan op, or a conflict.
 */
function mergeOne(
  id: string,
  ancestor: Artifact | undefined,
  ours: Artifact | undefined,
  theirs: Artifact | undefined,
): PerIdOutcome {
  // Deleted on both sides.
  if (ancestor && !ours && !theirs) {
    return { op: { op: "remove", id, previous: ancestor } };
  }
  // Deleted on one side only.
  if (ancestor && ours && !theirs) {
    if (sameArtifact(ancestor, ours)) {
      return { op: { op: "remove", id, previous: ancestor } };
    }
    return {
      conflict: { type: "delete-modify", id, ancestor, changed: ours, changedSide: "ours" },
    };
  }
  if (ancestor && !ours && theirs) {
    if (sameArtifact(ancestor, theirs)) {
      return { op: { op: "remove", id, previous: ancestor } };
    }
    return {
      conflict: { type: "delete-modify", id, ancestor, changed: theirs, changedSide: "theirs" },
    };
  }
  // Added on one side only.
  if (!ancestor && ours && !theirs) {
    return { result: ours, op: { op: "add", artifact: ours } };
  }
  if (!ancestor && !ours && theirs) {
    return { result: theirs, op: { op: "add", artifact: theirs } };
  }
  // Added on both sides.
  if (!ancestor && ours && theirs) {
    if (sameArtifact(ours, theirs)) {
      return { result: ours, op: { op: "add", artifact: ours } };
    }
    return { conflict: { type: "add-add", id, ours, theirs } };
  }
  // Present on all three sides.
  if (ancestor && ours && theirs) {
    if (sameArtifact(ours, theirs)) {
      return { result: ours, op: diffOp(ancestor, ours) };
    }
    if (sameArtifact(ancestor, ours)) {
      return { result: theirs, op: diffOp(ancestor, theirs) };
    }
    if (sameArtifact(ancestor, theirs)) {
      return { result: ours, op: diffOp(ancestor, ours) };
    }
    // Both sides changed the same id.
    if (ours.digest !== theirs.digest) {
      return { conflict: { type: "digest", id, ancestor, ours, theirs } };
    }
    // Same digest on both sides, but both moved it to different paths.
    return { conflict: { type: "move-move", id, ancestor, ours, theirs } };
  }
  // Unreachable: id came from the union of the three manifests.
  throw new Error(`no merge rule matched for id ${id}`);
}

/**
 * Three-way merge of artifact manifests.
 *
 * - Identity is the object id: a path change between ancestor and a branch is
 *   recognized as a move of the same object, not a delete+add.
 * - Both sides changing an id to different digests is a `digest` conflict;
 *   the same digest merges cleanly.
 * - Two different ids ending up at the same path is a `path-collision`
 *   conflict; colliding entries are withheld from `merged` (no auto-overwrite).
 */
export function mergeManifests(
  ancestor: Manifest,
  ours: Manifest,
  theirs: Manifest,
): MergeResult {
  const ancestorById = indexById(ancestor);
  const oursById = indexById(ours);
  const theirsById = indexById(theirs);

  const ids = new Set<string>([
    ...ancestorById.keys(),
    ...oursById.keys(),
    ...theirsById.keys(),
  ]);

  const merged: Artifact[] = [];
  const conflicts: Conflict[] = [];
  const plan: PlanOp[] = [];

  for (const id of [...ids].sort()) {
    const outcome = mergeOne(id, ancestorById.get(id), oursById.get(id), theirsById.get(id));
    if (outcome.conflict) {
      conflicts.push(outcome.conflict);
      continue;
    }
    if (outcome.result) {
      merged.push(outcome.result);
    }
    if (outcome.op) {
      plan.push(outcome.op);
    }
  }

  // Path-collision pass: never let two ids silently share one path.
  const byPath = new Map<string, Artifact[]>();
  for (const artifact of merged) {
    const group = byPath.get(artifact.path);
    if (group) {
      group.push(artifact);
    } else {
      byPath.set(artifact.path, [artifact]);
    }
  }
  const collidedIds = new Set<string>();
  for (const [path, group] of [...byPath.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (group.length > 1) {
      const groupIds = group.map((artifact) => artifact.id).sort();
      conflicts.push({ type: "path-collision", path, ids: groupIds, artifacts: sortById(group) });
      for (const id of groupIds) {
        collidedIds.add(id);
      }
    }
  }

  const finalMerged = merged.filter((artifact) => !collidedIds.has(artifact.id));
  const finalPlan = plan.filter((op) => {
    switch (op.op) {
      case "add":
        return !collidedIds.has(op.artifact.id);
      case "remove":
      case "move":
      case "update":
        return !collidedIds.has(op.id);
    }
  });

  return { merged: finalMerged, conflicts, plan: finalPlan };
}
