/**
 * Minimal element tree model with batched, observable mutations.
 *
 * All structural/attribute mutations go through an Engine so that live
 * queries can be updated incrementally in well-defined batches.
 */

export type MutationKind = 'append' | 'remove' | 'set-attr' | 'remove-attr';

export interface Mutation {
  kind: MutationKind;
  node: ElementNode;
  name?: string;
}

export class ElementNode {
  readonly tag: string;
  readonly attributes = new Map<string, string>();
  readonly children: ElementNode[] = [];
  parent: ElementNode | null = null;

  constructor(tag: string, attributes?: Record<string, string>) {
    this.tag = tag;
    if (attributes) {
      for (const [k, v] of Object.entries(attributes)) this.attributes.set(k, v);
    }
  }

  getAttribute(name: string): string | undefined {
    return this.attributes.get(name);
  }

  /** Depth-first document order, self first. */
  *descendants(): Generator<ElementNode> {
    for (const child of this.children) {
      yield child;
      yield* child.descendants();
    }
  }

  /** Self plus all descendants, in document order. */
  *selfAndDescendants(): Generator<ElementNode> {
    yield this;
    yield* this.descendants();
  }

  isAttachedTo(root: ElementNode): boolean {
    let node: ElementNode | null = this;
    while (node) {
      if (node === root) return true;
      node = node.parent;
    }
    return false;
  }
}

export type MutationListener = (mutations: readonly Mutation[]) => void;

/**
 * Applies mutations to the tree and batches notifications.
 *
 * Mutations are applied to the tree immediately, but listeners are only
 * notified when the current batch is flushed. A flush is scheduled on a
 * microtask automatically; `flush()` may be called to run synchronously.
 * Mutations issued from inside a listener (reentrant) are queued and
 * delivered in the next batch, never the one currently being delivered.
 */
export class Engine {
  private pending: Mutation[] = [];
  private listeners = new Set<MutationListener>();
  private flushing = false;
  private scheduled = false;
  private waiters: Array<() => void> = [];

  onMutations(listener: MutationListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  appendChild(parent: ElementNode, child: ElementNode): void {
    if (child.parent) this.removeChild(child);
    parent.children.push(child);
    child.parent = parent;
    this.record({ kind: 'append', node: child });
  }

  removeChild(node: ElementNode): void {
    const parent = node.parent;
    if (!parent) throw new Error('node has no parent');
    const index = parent.children.indexOf(node);
    if (index < 0) throw new Error('node is not a child of its parent');
    parent.children.splice(index, 1);
    node.parent = null;
    this.record({ kind: 'remove', node });
  }

  setAttribute(node: ElementNode, name: string, value: string): void {
    node.attributes.set(name, value);
    this.record({ kind: 'set-attr', node, name });
  }

  removeAttribute(node: ElementNode, name: string): void {
    node.attributes.delete(name);
    this.record({ kind: 'remove-attr', node, name });
  }

  private record(mutation: Mutation): void {
    this.pending.push(mutation);
    if (!this.flushing) this.schedule();
  }

  private schedule(): void {
    if (this.scheduled) return;
    this.scheduled = true;
    queueMicrotask(() => {
      this.scheduled = false;
      this.flush();
    });
  }

  /**
   * Deliver all queued mutations. Reentrant mutations recorded during
   * listener callbacks are delivered in a follow-up batch within the same
   * flush call (each batch is a separate listener invocation).
   */
  flush(): void {
    if (this.flushing) return;
    this.flushing = true;
    try {
      while (this.pending.length > 0) {
        const batch = this.pending;
        this.pending = [];
        for (const listener of [...this.listeners]) listener(batch);
      }
    } finally {
      this.flushing = false;
      const waiters = this.waiters;
      this.waiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** Resolves once every mutation queued so far has been delivered. */
  settled(): Promise<void> {
    if (this.pending.length === 0 && !this.flushing) return Promise.resolve();
    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
