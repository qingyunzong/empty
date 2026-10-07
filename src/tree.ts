export interface El {
  readonly uid: number;
  tag: string;
  classes: Set<string>;
  attrs: Map<string, string>;
  children: El[];
  parent: El | null;
}

let nextUid = 1;

export function createElement(
  tag: string,
  opts: { classes?: string[]; attrs?: Record<string, string> } = {},
): El {
  return {
    uid: nextUid++,
    tag,
    classes: new Set(opts.classes ?? []),
    attrs: new Map(Object.entries(opts.attrs ?? {})),
    children: [],
    parent: null,
  };
}

export function isAncestorOf(maybeAncestor: El, node: El): boolean {
  for (let cur: El | null = node; cur !== null; cur = cur.parent) {
    if (cur === maybeAncestor) return true;
  }
  return false;
}

function assertInsertable(parent: El, child: El): void {
  if (child === parent || isAncestorOf(child, parent)) {
    throw new Error("insert would create a cycle");
  }
}

function detachFromParent(child: El): void {
  const old = child.parent;
  if (old !== null) {
    const idx = old.children.indexOf(child);
    if (idx >= 0) old.children.splice(idx, 1);
    child.parent = null;
  }
}

/** Appends child to parent; an already-attached child is moved. */
export function appendChild(parent: El, child: El): void {
  assertInsertable(parent, child);
  detachFromParent(child);
  child.parent = parent;
  parent.children.push(child);
}

/** Inserts child before ref (or appends when ref is null); moves if attached. */
export function insertBefore(parent: El, child: El, ref: El | null): void {
  if (ref === null) {
    appendChild(parent, child);
    return;
  }
  if (ref === child) return; // DOM semantics: no-op
  assertInsertable(parent, child);
  if (ref.parent !== parent) throw new Error("ref is not a child of parent");
  detachFromParent(child);
  child.parent = parent;
  parent.children.splice(parent.children.indexOf(ref), 0, child);
}

export function removeChild(parent: El, child: El): El {
  if (child.parent !== parent) throw new Error("child is not a child of parent");
  detachFromParent(child);
  return child;
}

/** Depth-first pre-order traversal (document order). */
export function* walk(root: El): Generator<El> {
  yield root;
  for (const child of root.children) {
    yield* walk(child);
  }
}
