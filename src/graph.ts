/**
 * Replicated graph with observed-remove edge semantics.
 *
 * - addEdge mints a unique tag per add operation.
 * - removeEdge only removes the tags observed at removal time.
 * - Concurrent adds survive a concurrent remove (add-wins per tag).
 * - Operations are idempotent and commutative, so replicas converge
 *   under out-of-order and duplicate delivery.
 * - Removed tags are kept as tombstones so a remove that arrives
 *   before its add still wins once the add is delivered.
 */

export type NodeId = string;
export type Tag = string;

export interface AddEdgeOp {
  readonly kind: "add";
  readonly from: NodeId;
  readonly to: NodeId;
  readonly tag: Tag;
}

export interface RemoveEdgeOp {
  readonly kind: "remove";
  readonly from: NodeId;
  readonly to: NodeId;
  readonly tags: readonly Tag[];
}

export type EdgeOp = AddEdgeOp | RemoveEdgeOp;

export class GraphReplica {
  readonly replicaId: string;
  private counter = 0;
  private readonly edges = new Map<NodeId, Map<NodeId, Set<Tag>>>();
  private readonly removedTags = new Set<Tag>();

  constructor(replicaId: string) {
    this.replicaId = replicaId;
  }

  addEdge(from: NodeId, to: NodeId): AddEdgeOp {
    this.counter += 1;
    const op: AddEdgeOp = {
      kind: "add",
      from,
      to,
      tag: `${this.replicaId}#${this.counter}`,
    };
    this.apply(op);
    return op;
  }

  removeEdge(from: NodeId, to: NodeId): RemoveEdgeOp | null {
    const observed = this.tagsOf(from, to);
    if (observed.length === 0) return null;
    const op: RemoveEdgeOp = { kind: "remove", from, to, tags: observed };
    this.apply(op);
    return op;
  }

  apply(op: EdgeOp): void {
    if (op.kind === "add") {
      if (this.removedTags.has(op.tag)) return;
      this.tagSet(op.from, op.to, true).add(op.tag);
    } else {
      for (const tag of op.tags) this.removedTags.add(tag);
      const tags = this.tagSet(op.from, op.to, false);
      if (!tags) return;
      for (const tag of op.tags) tags.delete(tag);
      if (tags.size === 0) {
        const row = this.edges.get(op.from);
        row?.delete(op.to);
        if (row && row.size === 0) this.edges.delete(op.from);
      }
    }
  }

  hasEdge(from: NodeId, to: NodeId): boolean {
    return this.tagsOf(from, to).length > 0;
  }

  tagsOf(from: NodeId, to: NodeId): readonly Tag[] {
    const tags = this.tagSet(from, to, false);
    return tags ? [...tags].sort() : [];
  }

  nodes(): NodeId[] {
    const all = new Set<NodeId>();
    for (const [from, row] of this.edges) {
      all.add(from);
      for (const to of row.keys()) all.add(to);
    }
    return [...all].sort();
  }

  /** Visible-edge projection: an edge exists iff at least one tag remains. */
  project(): Map<NodeId, NodeId[]> {
    const projection = new Map<NodeId, NodeId[]>();
    for (const [from, row] of this.edges) {
      projection.set(
        from,
        [...row.keys()].sort(),
      );
    }
    return projection;
  }

  /** Canonical serialization used to assert convergence across replicas. */
  fingerprint(): string {
    const parts: string[] = [];
    for (const from of [...this.edges.keys()].sort()) {
      const row = this.edges.get(from)!;
      for (const to of [...row.keys()].sort()) {
        parts.push(`${from}->${to}:[${[...row.get(to)!].sort().join(",")}]`);
      }
    }
    return `${parts.join("|")}~removed:[${[...this.removedTags].sort().join(",")}]`;
  }

  private tagSet(from: NodeId, to: NodeId, create: true): Set<Tag>;
  private tagSet(from: NodeId, to: NodeId, create: false): Set<Tag> | undefined;
  private tagSet(from: NodeId, to: NodeId, create: boolean): Set<Tag> | undefined {
    let row = this.edges.get(from);
    if (!row) {
      if (!create) return undefined;
      row = new Map();
      this.edges.set(from, row);
    }
    let tags = row.get(to);
    if (!tags) {
      if (!create) return undefined;
      tags = new Set();
      row.set(to, tags);
    }
    return tags;
  }
}
