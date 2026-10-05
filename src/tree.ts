/**
 * DOM-like tree model. No browser objects involved.
 *
 * Mutations (insert / move / remove / attribute & class changes) emit events
 * that bubble up the parent chain, so an index attached to the root observes
 * every change anywhere in its subtree.
 */

export type TreeEvent =
  | { type: "inserted"; node: El; parent: El; index: number }
  | { type: "removed"; node: El; parent: El; index: number }
  | { type: "changed"; node: El };

export type TreeListener = (event: TreeEvent) => void;

let nextUid = 1;

export class El {
  readonly uid: number = nextUid++;
  tag: string;
  readonly classes: Set<string>;
  readonly attrs: Map<string, string>;
  parent: El | null = null;
  readonly children: El[] = [];
  private readonly listeners = new Set<TreeListener>();

  constructor(
    tag: string,
    opts: { classes?: string[]; attrs?: Record<string, string> } = {},
  ) {
    this.tag = tag;
    this.classes = new Set(opts.classes ?? []);
    this.attrs = new Map(Object.entries(opts.attrs ?? {}));
  }

  /** Subscribe to events originating at this element or any descendant. */
  on(listener: TreeListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: TreeEvent): void {
    let cur: El | null = this;
    while (cur !== null) {
      for (const l of [...cur.listeners]) l(event);
      cur = cur.parent;
    }
  }

  private isAncestorOf(other: El): boolean {
    let cur: El | null = other;
    while (cur !== null) {
      if (cur === this) return true;
      cur = cur.parent;
    }
    return false;
  }

  /** Insert `child` at `index` (defaults to end). Detaches it from any previous parent first (move semantics). */
  insertAt(child: El, index: number = this.children.length): El {
    if (child === this || child.isAncestorOf(this)) {
      throw new Error("insert would create a cycle");
    }
    if (index < 0 || index > this.children.length) {
      throw new RangeError(`insert index out of range: ${index}`);
    }
    if (child.parent !== null) child.parent.removeChild(child);
    if (index > this.children.length) index = this.children.length;
    this.children.splice(index, 0, child);
    child.parent = this;
    child.emit({ type: "inserted", node: child, parent: this, index });
    return child;
  }

  appendChild(child: El): El {
    return this.insertAt(child, this.children.length);
  }

  removeChild(child: El): El {
    const index = this.children.indexOf(child);
    if (index < 0) throw new Error("not a child of this element");
    // Emit BEFORE detaching so the event still bubbles to the old root and
    // indexes attached there can drop the whole subtree.
    child.emit({ type: "removed", node: child, parent: this, index });
    this.children.splice(index, 1);
    child.parent = null;
    return child;
  }

  remove(): void {
    if (this.parent !== null) this.parent.removeChild(this);
  }

  setAttr(name: string, value: string): void {
    this.attrs.set(name, value);
    this.emit({ type: "changed", node: this });
  }

  removeAttr(name: string): void {
    if (this.attrs.delete(name)) this.emit({ type: "changed", node: this });
  }

  addClass(name: string): void {
    if (!this.classes.has(name)) {
      this.classes.add(name);
      this.emit({ type: "changed", node: this });
    }
  }

  removeClass(name: string): void {
    if (this.classes.delete(name)) this.emit({ type: "changed", node: this });
  }

  /** 1-based position among element siblings (what :nth-child uses). */
  siblingIndex(): number {
    if (this.parent === null) return 0;
    return this.parent.children.indexOf(this) + 1;
  }

  describe(): string {
    const cls = [...this.classes].map((c) => `.${c}`).join("");
    return `<${this.tag}${cls}#${this.uid}>`;
  }
}

/** Depth-first pre-order traversal (document order). */
export function* walk(root: El): Generator<El> {
  yield root;
  for (const child of root.children) yield* walk(child);
}

export function treeSize(root: El): number {
  let n = 0;
  for (const _ of walk(root)) n++;
  return n;
}
