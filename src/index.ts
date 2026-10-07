import type { El } from "./tree.js";
import {
  appendChild as treeAppendChild,
  insertBefore as treeInsertBefore,
  removeChild as treeRemoveChild,
  createElement,
  walk,
} from "./tree.js";
import { parseSelectorList, type Compound, type SelectorList } from "./selector.js";
import { matchesComplex, queryScan, type Nav } from "./query.js";

function setAdd<K>(map: Map<K, Set<El>>, key: K, el: El): void {
  let set = map.get(key);
  if (set === undefined) {
    set = new Set();
    map.set(key, set);
  }
  set.add(el);
}

function setDelete<K>(map: Map<K, Set<El>>, key: K, el: El): void {
  const set = map.get(key);
  if (set !== undefined) {
    set.delete(el);
    if (set.size === 0) map.delete(key);
  }
}

/**
 * Incremental index over the tree. Mirrors parent/child relations and keeps
 * tag, class and attribute lookup sets. Mutations must leave no stale
 * entries: detaching a subtree erases every trace of it, and moving a node
 * re-links only the moved root.
 */
export class Index {
  readonly all = new Set<El>();
  readonly parent = new Map<El, El | null>();
  readonly children = new Map<El, El[]>();
  readonly byTag = new Map<string, Set<El>>();
  readonly byClass = new Map<string, Set<El>>();
  readonly byAttr = new Map<string, Set<El>>();

  readonly nav: Nav = {
    parentOf: (el) => (this.parent.has(el) ? this.parent.get(el)! : null),
    childrenOf: (el) => this.children.get(el) ?? [],
  };

  attachInitial(root: El): void {
    if (this.all.size !== 0) throw new Error("index is not empty");
    this.registerSubtree(root);
  }

  private registerSubtree(root: El): void {
    for (const el of walk(root)) {
      this.all.add(el);
      this.parent.set(el, el.parent);
      this.children.set(el, [...el.children]);
      setAdd(this.byTag, el.tag, el);
      for (const cls of el.classes) setAdd(this.byClass, cls, el);
      for (const name of el.attrs.keys()) setAdd(this.byAttr, name, el);
    }
  }

  private unregisterSubtree(root: El): void {
    for (const el of walk(root)) {
      this.all.delete(el);
      this.parent.delete(el);
      this.children.delete(el);
      setDelete(this.byTag, el.tag, el);
      for (const cls of el.classes) setDelete(this.byClass, cls, el);
      for (const name of el.attrs.keys()) setDelete(this.byAttr, name, el);
    }
  }

  /** Syncs the index after child was inserted into parent before ref (tree op already done). */
  attach(child: El, parent: El, ref: El | null): void {
    const oldParent = this.parent.get(child);
    if (oldParent !== undefined && oldParent !== null) {
      const siblings = this.children.get(oldParent)!;
      const idx = siblings.indexOf(child);
      if (idx >= 0) siblings.splice(idx, 1);
    }
    if (!this.all.has(child)) {
      this.registerSubtree(child);
    }
    const siblings = this.children.get(parent);
    if (siblings === undefined) throw new Error("parent is not indexed");
    const refIdx = ref === null ? -1 : siblings.indexOf(ref);
    if (refIdx < 0) siblings.push(child);
    else siblings.splice(refIdx, 0, child);
    this.parent.set(child, parent);
  }

  /** Syncs the index after child (and its subtree) was removed from the tree. */
  detach(child: El): void {
    const oldParent = this.parent.get(child);
    if (oldParent !== undefined && oldParent !== null) {
      const siblings = this.children.get(oldParent)!;
      const idx = siblings.indexOf(child);
      if (idx >= 0) siblings.splice(idx, 1);
    }
    this.unregisterSubtree(child);
  }

  private candidates(c: Compound): ReadonlySet<El> {
    let best: Set<El> | undefined;
    const consider = (set: Set<El> | undefined): boolean => {
      if (set === undefined) return true;
      if (best === undefined || set.size < best.size) best = set;
      return false;
    };
    if (c.tag !== null && consider(this.byTag.get(c.tag))) return EMPTY;
    for (const cls of c.classes) {
      if (consider(this.byClass.get(cls))) return EMPTY;
    }
    for (const cond of c.attrs) {
      if (consider(this.byAttr.get(cond.name))) return EMPTY;
    }
    return best ?? this.all;
  }

  private documentOrder(root: El): Map<El, number> {
    const order = new Map<El, number>();
    let counter = 0;
    const dfs = (el: El): void => {
      order.set(el, counter++);
      for (const child of this.children.get(el) ?? []) dfs(child);
    };
    dfs(root);
    return order;
  }

  query(root: El, list: SelectorList): El[] {
    const matched = new Set<El>();
    for (const sel of list) {
      const last = sel.parts[sel.parts.length - 1]!;
      for (const cand of this.candidates(last)) {
        if (matchesComplex(cand, sel, this.nav)) matched.add(cand);
      }
    }
    const order = this.documentOrder(root);
    return [...matched].sort((x, y) => order.get(x)! - order.get(y)!);
  }
}

const EMPTY: ReadonlySet<El> = new Set();

/** Document wrapper: keeps the live tree and the incremental index in sync. */
export class Document {
  readonly root: El;
  readonly index = new Index();

  constructor() {
    this.root = createElement("#root");
    this.index.attachInitial(this.root);
  }

  appendChild(parent: El, child: El): void {
    treeAppendChild(parent, child);
    this.index.attach(child, parent, null);
  }

  insertBefore(parent: El, child: El, ref: El | null): void {
    if (ref !== null && ref === child) return; // no-op, mirrors tree
    treeInsertBefore(parent, child, ref);
    this.index.attach(child, parent, ref);
  }

  removeChild(parent: El, child: El): El {
    const removed = treeRemoveChild(parent, child);
    this.index.detach(child);
    return removed;
  }

  /** Indexed query (under test). */
  query(selector: string): El[] {
    return this.index.query(this.root, parseSelectorList(selector));
  }

  /** Full-scan reference query (ground truth). */
  queryScan(selector: string): El[] {
    return queryScan(this.root, parseSelectorList(selector));
  }
}
