import type { LiveQuery, LiveCallback, WatchOptions } from "./live.js";
import { createLiveQuery, destroyLiveQuery, applyBatchToQuery, notifyQuery } from "./live.js";

export class ElementNode {
  readonly tag: string;
  parent: ElementNode | null = null;
  readonly children: ElementNode[] = [];
  readonly attributes: Map<string, string> = new Map();

  constructor(tag: string) {
    this.tag = tag;
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }
}

/** A recorded mutation. Mutations apply to the tree immediately and are
 *  queued here so live queries can be updated in batches. */
export type Mutation =
  | { readonly kind: "insert"; readonly parent: ElementNode; readonly node: ElementNode }
  | { readonly kind: "remove"; readonly node: ElementNode; readonly removedNodes: readonly ElementNode[] }
  | { readonly kind: "attr"; readonly node: ElementNode; readonly name: string };

/** Preorder (document order) traversal of the subtree rooted at `node`, inclusive. */
export function* preorder(node: ElementNode): Generator<ElementNode> {
  yield node;
  for (const child of node.children) {
    yield* preorder(child);
  }
}

/** True when `node` is `scope` itself or a descendant of `scope`. */
export function isWithin(node: ElementNode, scope: ElementNode): boolean {
  let cur: ElementNode | null = node;
  while (cur !== null) {
    if (cur === scope) return true;
    cur = cur.parent;
  }
  return false;
}

function collectSubtree(node: ElementNode, out: ElementNode[]): void {
  out.push(node);
  for (const child of node.children) collectSubtree(child, out);
}

export class Document {
  readonly root: ElementNode;

  private pending: Mutation[] = [];
  private flushing = false;
  private flushScheduled = false;
  private readonly queries = new Set<LiveQuery>();
  private idleWaiters: Array<() => void> = [];

  constructor(rootTag = "html") {
    this.root = new ElementNode(rootTag);
  }

  createElement(tag: string, attrs?: Record<string, string>): ElementNode {
    const node = new ElementNode(tag);
    if (attrs) {
      for (const [k, v] of Object.entries(attrs)) node.attributes.set(k, v);
    }
    return node;
  }

  /** Append `child` under `parent`. If `child` is already attached it is moved. */
  appendChild(parent: ElementNode, child: ElementNode): void {
    if (child.parent !== null) this.removeChild(child);
    child.parent = parent;
    parent.children.push(child);
    this.record({ kind: "insert", parent, node: child });
  }

  /** Detach `node` (and its subtree) from its parent. */
  removeChild(node: ElementNode): void {
    const parent = node.parent;
    if (parent === null) {
      throw new Error("node is not attached");
    }
    const removedNodes: ElementNode[] = [];
    collectSubtree(node, removedNodes);
    const idx = parent.children.indexOf(node);
    parent.children.splice(idx, 1);
    node.parent = null;
    this.record({ kind: "remove", node, removedNodes });
  }

  setAttribute(node: ElementNode, name: string, value: string): void {
    if (node.attributes.get(name) === value) return;
    node.attributes.set(name, value);
    this.record({ kind: "attr", node, name });
  }

  removeAttribute(node: ElementNode, name: string): void {
    if (!node.attributes.has(name)) return;
    node.attributes.delete(name);
    this.record({ kind: "attr", node, name });
  }

  /**
   * Watch `selector` within `scope` (defaults to the document root).
   * The callback fires once per mutation batch with the membership diff.
   */
  watch(selector: string, callback?: LiveCallback, options?: WatchOptions): LiveQuery {
    const query = createLiveQuery(this, selector, options?.scope ?? this.root, callback, options);
    this.queries.add(query);
    return query;
  }

  /** Stop updating and notifying this query. */
  unwatch(query: LiveQuery): void {
    if (this.queries.delete(query)) destroyLiveQuery(query);
  }

  /** Process all queued mutations, notifying live queries batch by batch.
   *  Mutations made from inside callbacks are queued into the next batch. */
  flush(): void {
    if (this.flushing) return; // reentrant flush: the outer loop picks up new mutations
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        const queries = [...this.queries];
        for (const q of queries) applyBatchToQuery(q, batch);
        for (const q of queries) {
          if (this.queries.has(q)) notifyQuery(q);
        }
      }
    } finally {
      this.flushing = false;
    }
    const waiters = this.idleWaiters;
    this.idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves once every queued mutation (including ones scheduled from
   *  callbacks) has been processed. Mutations auto-schedule a microtask flush,
   *  so callers may simply mutate and `await doc.whenIdle()`. */
  whenIdle(): Promise<void> {
    if (this.pending.length === 0 && !this.flushing) return Promise.resolve();
    return new Promise((resolve) => {
      this.idleWaiters.push(resolve);
    });
  }

  private record(m: Mutation): void {
    this.pending.push(m);
    if (!this.flushing && !this.flushScheduled) {
      this.flushScheduled = true;
      queueMicrotask(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }
}
