/**
 * Three-way merge of collaborative tree edits.
 *
 * Both sides (left / right) produced an ordered op log against a common base
 * tree. Ops are keyed by node ID: a `move` reparents one node, a `delete`
 * tombstones a subtree root (the subtree itself is preserved, never dropped).
 *
 * Merge rule per node ID: right's final parent wins when right changed it,
 * otherwise left's, otherwise the base parent. Each side's log is validated
 * on its own, so every applied move is individually legal (acyclic). Two
 * legal moves from opposite sides can still combine into a cycle; every
 * cycle is broken by cancelling its lowest-priority edge (priority, then
 * opId) and attaching full evidence. A cancelled edge falls back to the
 * losing side's value when that side also changed the node, else to the
 * base parent.
 */

import {
  findCycle,
  isSelfOrAncestor,
  subtreeOf,
  type NodeId,
  type Tree,
} from "./tree.js";

export type Side = "left" | "right";

export interface MoveOp {
  readonly kind: "move";
  readonly opId: string;
  readonly priority: number;
  readonly nodeId: NodeId;
  readonly newParentId: NodeId;
}

export interface DeleteOp {
  readonly kind: "delete";
  readonly opId: string;
  readonly priority: number;
  readonly nodeId: NodeId;
}

export type TreeOp = MoveOp | DeleteOp;

export function move(opId: string, priority: number, nodeId: NodeId, newParentId: NodeId): MoveOp {
  return { kind: "move", opId, priority, nodeId, newParentId };
}

export function del(opId: string, priority: number, nodeId: NodeId): DeleteOp {
  return { kind: "delete", opId, priority, nodeId };
}

export interface RejectedOp {
  readonly op: TreeOp;
  readonly reason: string;
}

interface SideState {
  readonly parent: Map<NodeId, NodeId | null>;
  /** Last legal move op responsible for a node's current parent. */
  readonly edgeOp: Map<NodeId, MoveOp>;
  readonly tombstones: Set<NodeId>;
  readonly rejected: RejectedOp[];
}

/** Apply one side's op log in order against the base tree, rejecting illegal ops. */
function applySide(base: Tree, ops: readonly TreeOp[]): SideState {
  const parent = new Map(base.parent);
  const edgeOp = new Map<NodeId, MoveOp>();
  const tombstones = new Set<NodeId>();
  const deletedRoots: NodeId[] = [];
  const rejected: RejectedOp[] = [];

  const view = (): Tree => ({ rootId: base.rootId, parent });

  for (const op of ops) {
    if (op.kind === "move") {
      const reason = checkMove(view(), base.rootId, op);
      if (reason !== null) {
        rejected.push({ op, reason });
        continue;
      }
      parent.set(op.nodeId, op.newParentId);
      edgeOp.set(op.nodeId, op);
    } else {
      if (!parent.has(op.nodeId)) {
        rejected.push({ op, reason: `delete: unknown node ${op.nodeId}` });
        continue;
      }
      if (op.nodeId === base.rootId) {
        rejected.push({ op, reason: "delete: cannot delete the root" });
        continue;
      }
      deletedRoots.push(op.nodeId);
    }
  }

  // Tombstone the whole subtree of every deleted root, as it stands in this
  // side's final tree. Tombstoned nodes stay in the tree.
  for (const id of deletedRoots) {
    for (const member of subtreeOf(view(), id)) tombstones.add(member);
  }
  return { parent, edgeOp, tombstones, rejected };
}

function checkMove(tree: Tree, rootId: NodeId, op: MoveOp): string | null {
  if (!tree.parent.has(op.nodeId)) return `move: unknown node ${op.nodeId}`;
  if (op.nodeId === rootId) return "move: cannot move the root";
  if (!tree.parent.has(op.newParentId)) return `move: unknown parent ${op.newParentId}`;
  if (op.newParentId === op.nodeId) return "move: node cannot be its own parent";
  if (isSelfOrAncestor(tree, op.nodeId, op.newParentId)) {
    return `move: ${op.newParentId} is inside the subtree of ${op.nodeId}`;
  }
  return null;
}

/** One candidate parent for a node, ordered by preference. */
interface EdgeChoice {
  readonly parentId: NodeId | null;
  readonly op: MoveOp | null; // null => base edge, never cancelled while an op edge remains
  readonly side: Side | null;
}

export interface EdgeSnapshot {
  readonly nodeId: NodeId;
  readonly parentId: NodeId | null;
  readonly opId: string | null;
  readonly priority: number | null;
  readonly side: Side | null;
}

export interface CycleBreakEvidence {
  /** Cycle nodes in edge order: cycle[i]'s parent is cycle[i+1]. */
  readonly cycle: NodeId[];
  /** The cancelled (lowest-priority) edge. */
  readonly cancelled: {
    readonly nodeId: NodeId;
    readonly fromParentId: NodeId | null;
    readonly opId: string;
    readonly priority: number;
    readonly side: Side;
  };
  /** What the node's parent fell back to. */
  readonly revertedTo: {
    readonly parentId: NodeId | null;
    readonly source: Side | "base";
    readonly opId: string | null;
  };
  /** Every edge of the cycle with its provenance, for audit. */
  readonly candidates: EdgeSnapshot[];
  readonly reason: string;
}

export interface ConflictRecord {
  readonly nodeId: NodeId;
  readonly left: { readonly opId: string; readonly parentId: NodeId };
  readonly right: { readonly opId: string; readonly parentId: NodeId };
  readonly winner: Side;
}

export interface MergeResult {
  readonly tree: Tree;
  readonly tombstones: Set<NodeId>;
  readonly cycleBreaks: CycleBreakEvidence[];
  readonly conflicts: ConflictRecord[];
  readonly rejected: { readonly left: RejectedOp[]; readonly right: RejectedOp[] };
}

function snapshot(nodeId: NodeId, choice: EdgeChoice): EdgeSnapshot {
  return {
    nodeId,
    parentId: choice.parentId,
    opId: choice.op?.opId ?? null,
    priority: choice.op?.priority ?? null,
    side: choice.side,
  };
}

/** Total order for cycle-breaking: lower priority first, then smaller opId. */
export function compareEdgePriority(a: EdgeSnapshot, b: EdgeSnapshot): number {
  const pa = a.priority ?? Number.POSITIVE_INFINITY;
  const pb = b.priority ?? Number.POSITIVE_INFINITY;
  if (pa !== pb) return pa - pb;
  const ia = a.opId ?? "";
  const ib = b.opId ?? "";
  return ia < ib ? -1 : ia > ib ? 1 : 0;
}

export function mergeTrees(base: Tree, leftOps: readonly TreeOp[], rightOps: readonly TreeOp[]): MergeResult {
  const left = applySide(base, leftOps);
  const right = applySide(base, rightOps);

  // Per-node ordered fallback chain: [winner, loser?(if both changed), base].
  const choices = new Map<NodeId, EdgeChoice[]>();
  const conflicts: ConflictRecord[] = [];

  for (const id of base.parent.keys()) {
    if (id === base.rootId) {
      choices.set(id, [{ parentId: null, op: null, side: null }]);
      continue;
    }
    const baseParent = base.parent.get(id) ?? null;
    const leftParent = left.parent.get(id) ?? null;
    const rightParent = right.parent.get(id) ?? null;
    const leftChanged = leftParent !== baseParent;
    const rightChanged = rightParent !== baseParent;

    const chain: EdgeChoice[] = [];
    if (rightChanged) {
      chain.push({ parentId: rightParent, op: right.edgeOp.get(id) ?? null, side: "right" });
    }
    if (leftChanged) {
      chain.push({ parentId: leftParent, op: left.edgeOp.get(id) ?? null, side: "left" });
    }
    chain.push({ parentId: baseParent, op: null, side: null });
    choices.set(id, chain);

    if (leftChanged && rightChanged) {
      conflicts.push({
        nodeId: id,
        left: { opId: left.edgeOp.get(id)?.opId ?? "", parentId: leftParent ?? "" },
        right: { opId: right.edgeOp.get(id)?.opId ?? "", parentId: rightParent ?? "" },
        winner: "right",
      });
    }
  }

  const current = new Map<NodeId, number>(); // node -> index into its chain
  for (const id of choices.keys()) current.set(id, 0);

  const mergedParent = (): Map<NodeId, NodeId | null> => {
    const out = new Map<NodeId, NodeId | null>();
    for (const [id, chain] of choices) {
      out.set(id, chain[current.get(id) ?? 0]?.parentId ?? null);
    }
    return out;
  };

  const cycleBreaks: CycleBreakEvidence[] = [];
  for (;;) {
    const parentMap = mergedParent();
    const cycle = findCycle(parentMap);
    if (cycle === null) break;

    const candidates: EdgeSnapshot[] = cycle.map((id) => {
      const chain = choices.get(id);
      const choice = chain?.[current.get(id) ?? 0];
      return snapshot(id, choice ?? { parentId: null, op: null, side: null });
    });

    // Base edges (opId null) sort last and are never picked while any
    // op-bearing edge remains; a cycle of pure base edges is impossible
    // because the base tree is acyclic.
    let victim: EdgeSnapshot | null = null;
    for (const cand of candidates) {
      if (cand.opId === null) continue;
      if (victim === null || compareEdgePriority(cand, victim) < 0) victim = cand;
    }
    if (victim === null) {
      throw new Error(`unbreakable cycle (no op edge): ${cycle.join(" -> ")}`);
    }
    const victimOpId = victim.opId;
    const victimPriority = victim.priority;
    if (victimOpId === null || victimPriority === null) {
      throw new Error(`unbreakable cycle (no op edge): ${cycle.join(" -> ")}`);
    }

    const nodeId = victim.nodeId;
    const chain = choices.get(nodeId);
    if (!chain) throw new Error(`internal: no choices for ${nodeId}`);
    const nextIndex = (current.get(nodeId) ?? 0) + 1;
    if (nextIndex >= chain.length) throw new Error(`internal: no fallback for ${nodeId}`);
    current.set(nodeId, nextIndex);
    const fallback = chain[nextIndex];
    if (!fallback) throw new Error(`internal: no fallback for ${nodeId}`);

    cycleBreaks.push({
      cycle,
      cancelled: {
        nodeId,
        fromParentId: victim.parentId,
        opId: victimOpId,
        priority: victimPriority,
        side: victim.side ?? "left",
      },
      revertedTo: {
        parentId: fallback.parentId,
        source: fallback.side ?? "base",
        opId: fallback.op?.opId ?? null,
      },
      candidates,
      reason:
        `cycle ${cycle.join(" -> ")} broken by cancelling edge ${nodeId} -> ${victim.parentId} ` +
        `(op ${victimOpId}, priority ${victimPriority}); lowest of ${candidates.length} candidate edges`,
    });
  }

  const tombstones = new Set<NodeId>([...left.tombstones, ...right.tombstones]);
  const tree: Tree = { rootId: base.rootId, parent: mergedParent() };
  return {
    tree,
    tombstones,
    cycleBreaks,
    conflicts,
    rejected: { left: left.rejected, right: right.rejected },
  };
}
