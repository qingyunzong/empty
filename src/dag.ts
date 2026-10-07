export type TagId = string | number;

export class UnknownTagError extends Error {
  constructor(public readonly tagId: TagId) {
    super(`unknown tag: ${String(tagId)}`);
    this.name = "UnknownTagError";
  }
}

export class CycleError extends Error {
  constructor(message = "edge batch rejected: it would introduce a cycle") {
    super(message);
    this.name = "CycleError";
  }
}

export type EdgeOp =
  | { type: "add"; parent: TagId; child: TagId }
  | { type: "remove"; parent: TagId; child: TagId };

export function compareTagIds(a: TagId, b: TagId): number {
  if (typeof a === "number" && typeof b === "number") return a - b;
  const sa = String(a);
  const sb = String(b);
  return sa < sb ? -1 : sa > sb ? 1 : 0;
}

type Adjacency = Map<TagId, Set<TagId>>;

function cloneAdjacency(src: Adjacency): Adjacency {
  const copy: Adjacency = new Map();
  for (const [id, next] of src) copy.set(id, new Set(next));
  return copy;
}

function assertAcyclic(children: Adjacency): void {
  const indegree = new Map<TagId, number>();
  for (const id of children.keys()) indegree.set(id, 0);
  for (const next of children.values()) {
    for (const child of next) {
      indegree.set(child, (indegree.get(child) ?? 0) + 1);
    }
  }
  const queue: TagId[] = [];
  for (const [id, deg] of indegree) if (deg === 0) queue.push(id);
  let visited = 0;
  while (queue.length > 0) {
    const id = queue.pop() as TagId;
    visited += 1;
    for (const child of children.get(id) ?? []) {
      const deg = (indegree.get(child) as number) - 1;
      indegree.set(child, deg);
      if (deg === 0) queue.push(child);
    }
  }
  if (visited !== indegree.size) throw new CycleError();
}

/**
 * A taxonomy of tags arranged as a directed acyclic graph.
 * An edge parent -> child means `child` is categorized under `parent`.
 * Every tag is considered an ancestor (and descendant) of itself.
 */
export class TagDag {
  private children: Adjacency = new Map();
  private parents: Adjacency = new Map();

  addTag(id: TagId): void {
    if (!this.children.has(id)) {
      this.children.set(id, new Set());
      this.parents.set(id, new Set());
    }
  }

  hasTag(id: TagId): boolean {
    return this.children.has(id);
  }

  get tagIds(): TagId[] {
    return [...this.children.keys()].sort(compareTagIds);
  }

  private assertTag(id: TagId): void {
    if (!this.children.has(id)) throw new UnknownTagError(id);
  }

  childIds(id: TagId): TagId[] {
    this.assertTag(id);
    return [...(this.children.get(id) as Set<TagId>)].sort(compareTagIds);
  }

  parentIds(id: TagId): TagId[] {
    this.assertTag(id);
    return [...(this.parents.get(id) as Set<TagId>)].sort(compareTagIds);
  }

  addEdge(parent: TagId, child: TagId): void {
    this.applyEdgeBatch([{ type: "add", parent, child }]);
  }

  removeEdge(parent: TagId, child: TagId): void {
    this.applyEdgeBatch([{ type: "remove", parent, child }]);
  }

  /**
   * Applies a batch of edge edits atomically: the whole batch is validated
   * against a scratch copy and rejected (leaving the graph untouched) if any
   * tag is unknown or the resulting graph would contain a cycle.
   */
  applyEdgeBatch(ops: EdgeOp[]): void {
    for (const op of ops) {
      this.assertTag(op.parent);
      this.assertTag(op.child);
    }
    const nextChildren = cloneAdjacency(this.children);
    for (const op of ops) {
      const bucket = nextChildren.get(op.parent) as Set<TagId>;
      if (op.type === "add") bucket.add(op.child);
      else bucket.delete(op.child);
    }
    assertAcyclic(nextChildren);
    const nextParents: Adjacency = new Map();
    for (const id of nextChildren.keys()) nextParents.set(id, new Set());
    for (const [parent, next] of nextChildren) {
      for (const child of next) {
        (nextParents.get(child) as Set<TagId>).add(parent);
      }
    }
    this.children = nextChildren;
    this.parents = nextParents;
  }

  private reachableFrom(start: TagId, next: Adjacency): Set<TagId> {
    const seen = new Set<TagId>([start]);
    const stack: TagId[] = [start];
    while (stack.length > 0) {
      const id = stack.pop() as TagId;
      for (const adjacent of next.get(id) ?? []) {
        if (!seen.has(adjacent)) {
          seen.add(adjacent);
          stack.push(adjacent);
        }
      }
    }
    return seen;
  }

  /** All ancestors of `id`, including `id` itself. */
  ancestorsOf(id: TagId): Set<TagId> {
    this.assertTag(id);
    return this.reachableFrom(id, this.parents);
  }

  /** All descendants of `id`, including `id` itself. */
  descendantsOf(id: TagId): Set<TagId> {
    this.assertTag(id);
    return this.reachableFrom(id, this.children);
  }

  /**
   * All lowest common ancestors of `a` and `b`: common ancestors (a tag is
   * its own ancestor) that have no strictly closer common descendant, i.e.
   * no other common ancestor is a strict descendant of them.
   * The result is sorted by tag id.
   */
  lowestCommonAncestors(a: TagId, b: TagId): TagId[] {
    this.assertTag(a);
    this.assertTag(b);
    const ancestorsA = this.ancestorsOf(a);
    const ancestorsB = this.ancestorsOf(b);
    const common: TagId[] = [];
    for (const id of ancestorsA) if (ancestorsB.has(id)) common.push(id);
    const lowest = common.filter((candidate) => {
      const descendants = this.descendantsOf(candidate);
      return !common.some(
        (other) => other !== candidate && descendants.has(other),
      );
    });
    return lowest.sort(compareTagIds);
  }
}
