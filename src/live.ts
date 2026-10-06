/**
 * Live queries: incremental, batched maintenance of match sets.
 *
 * - Mutations are delivered by the Engine in batches; each batch produces
 *   at most one diff (added/removed) and one new immutable Snapshot.
 * - Old snapshots are preserved forever in `history` and never mutated.
 * - Invalidation is conservative and always includes descendant-combinator
 *   effects: an attribute change on a node dirties its whole subtree,
 *   because that node may participate as a descendant-ancestor in chains
 *   matching arbitrarily deep nodes.
 * - Mutations issued from inside a diff listener are queued by the Engine
 *   and arrive as a separate later batch, so listeners never observe a
 *   half-updated state.
 * - `verify()` recomputes the full match set with the naive recursive
 *   reference implementation and compares it against the incrementally
 *   maintained state.
 */

import { ElementNode, Engine, type Mutation } from './dom.js';
import { Plan } from './plan.js';
import { referenceQuery } from './reference.js';

export interface Snapshot {
  readonly version: number;
  /** Matching nodes in document order. Frozen. */
  readonly nodes: readonly ElementNode[];
}

export interface Diff {
  /** In document order. */
  readonly added: readonly ElementNode[];
  /** In the order the nodes appeared in the previous snapshot. */
  readonly removed: readonly ElementNode[];
  readonly snapshot: Snapshot;
}

export type DiffListener = (diff: Diff) => void;

export class LiveQuery {
  private readonly matched = new Set<ElementNode>();
  private readonly diffListeners = new Set<DiffListener>();
  private readonly unsubscribeEngine: () => void;
  private readonly snapshots: Snapshot[] = [];
  private version = 0;
  private readonly engine: Engine;
  private readonly root: ElementNode;
  readonly plan: Plan;

  constructor(engine: Engine, root: ElementNode, plan: Plan) {
    this.engine = engine;
    this.root = root;
    this.plan = plan;
    for (const node of plan.query(root)) this.matched.add(node);
    this.snapshots.push(this.takeSnapshot());
    this.unsubscribeEngine = engine.onMutations((batch) => this.handleBatch(batch));
  }

  /** Current immutable snapshot. */
  snapshot(): Snapshot {
    return this.snapshots[this.snapshots.length - 1]!;
  }

  /** All snapshots ever produced, oldest first. Never mutated in place. */
  history(): readonly Snapshot[] {
    return this.snapshots;
  }

  onDiff(listener: DiffListener): () => void {
    this.diffListeners.add(listener);
    return () => this.diffListeners.delete(listener);
  }

  dispose(): void {
    this.unsubscribeEngine();
    this.diffListeners.clear();
  }

  private takeSnapshot(): Snapshot {
    const nodes: ElementNode[] = [];
    for (const node of this.root.selfAndDescendants()) {
      if (this.matched.has(node)) nodes.push(node);
    }
    return Object.freeze({
      version: this.version,
      nodes: Object.freeze(nodes.slice()),
    });
  }

  private handleBatch(mutations: readonly Mutation[]): void {
    const dirty = new Set<ElementNode>();
    for (const mutation of mutations) {
      // Every mutation kind dirties the node's whole subtree:
      // - append: brand-new nodes may match.
      // - remove: matched nodes inside leave the scope.
      // - attr change: the node itself may flip, and any descendant whose
      //   chain reaches this node through a descendant/child combinator
      //   may flip too.
      for (const node of mutation.node.selfAndDescendants()) dirty.add(node);
    }

    const added: ElementNode[] = [];
    const removedSet = new Set<ElementNode>();

    // Re-evaluate dirty attached nodes in document order.
    for (const node of this.root.selfAndDescendants()) {
      if (!dirty.has(node)) continue;
      const now = this.plan.matches(node, this.root);
      const was = this.matched.has(node);
      if (now && !was) {
        this.matched.add(node);
        added.push(node);
      } else if (!now && was) {
        this.matched.delete(node);
        removedSet.add(node);
      }
    }
    // Dirty nodes that left the scope entirely (removed subtrees).
    for (const node of dirty) {
      if (this.matched.has(node) && !node.isAttachedTo(this.root)) {
        this.matched.delete(node);
        removedSet.add(node);
      }
    }

    if (added.length === 0 && removedSet.size === 0) return;

    // Order removals by their position in the previous snapshot.
    const previous = this.snapshot().nodes;
    const removed: ElementNode[] = [];
    for (const node of previous) {
      if (removedSet.has(node)) removed.push(node);
    }
    for (const node of removedSet) {
      if (!previous.includes(node)) removed.push(node);
    }

    this.version++;
    const snapshot = this.takeSnapshot();
    this.snapshots.push(snapshot);
    const diff: Diff = Object.freeze({
      added: Object.freeze(added),
      removed: Object.freeze(removed),
      snapshot,
    });
    for (const listener of [...this.diffListeners]) listener(diff);
  }

  /**
   * Full-match reference verification: recompute the expected match set
   * with the naive recursive reference and compare against the
   * incrementally maintained state. Throws on any divergence.
   */
  verify(): void {
    const expected = referenceQuery(this.root, this.plan.source);
    const actual = this.snapshot().nodes;
    const expectedSet = new Set(expected);
    const actualSet = new Set(actual);
    const missing = expected.filter((n) => !actualSet.has(n));
    const extra = actual.filter((n) => !expectedSet.has(n));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(
        `live query diverged from reference for "${this.plan.source}": ` +
          `missing=${missing.map(describe)} extra=${extra.map(describe)}`,
      );
    }
  }
}

function describe(node: ElementNode): string {
  const attrs = [...node.attributes.entries()]
    .map(([k, v]) => `[${k}=${v}]`)
    .join('');
  return `${node.tag}${attrs}`;
}
