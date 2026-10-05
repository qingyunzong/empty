/**
 * Persistent (immutable) order-statistics treap.
 *
 * Every mutation path-copies only the nodes on the affected spine, so old
 * roots keep referring to a valid, unchanged snapshot (structural sharing).
 * Each node stores:
 *   - count: multiplicity of `key` (duplicate integers share one node)
 *   - size:  total number of elements in the subtree, counting multiplicity
 * which gives O(log n) expected rank/select (order statistics).
 */

export interface Node {
  readonly key: number;
  readonly count: number;
  readonly size: number;
  readonly prio: number;
  readonly left?: Node;
  readonly right?: Node;
}

export function sizeOf(node: Node | undefined): number {
  return node === undefined ? 0 : node.size;
}

/** Deterministic priority from the key, so a given multiset always yields the same tree shape. */
function prioOf(key: number): number {
  let h = (key | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
  h ^= h >>> 16;
  return h >>> 0;
}

function mk(key: number, count: number, prio: number, left?: Node, right?: Node): Node {
  return { key, count, prio, left, right, size: sizeOf(left) + sizeOf(right) + count };
}

/** Insert one occurrence of `key`; returns the new root. */
export function insert(root: Node | undefined, key: number): Node {
  if (root === undefined) return mk(key, 1, prioOf(key));
  if (key === root.key) {
    return mk(root.key, root.count + 1, root.prio, root.left, root.right);
  }
  if (key < root.key) {
    const left = insert(root.left, key);
    const n = mk(root.key, root.count, root.prio, left, root.right);
    if (left.prio < n.prio) {
      // rotate right: promote the new left child above n
      return mk(left.key, left.count, left.prio, left.left, mk(n.key, n.count, n.prio, left.right, n.right));
    }
    return n;
  }
  const right = insert(root.right, key);
  const n = mk(root.key, root.count, root.prio, root.left, right);
  if (right.prio < n.prio) {
    // rotate left: promote the new right child above n
    return mk(right.key, right.count, right.prio, mk(n.key, n.count, n.prio, n.left, right.left), right.right);
  }
  return n;
}

/** Remove one occurrence of `key` (must exist); returns the new root. */
export function remove(root: Node | undefined, key: number): Node | undefined {
  if (root === undefined) return undefined;
  if (key < root.key) {
    return mk(root.key, root.count, root.prio, remove(root.left, key), root.right);
  }
  if (key > root.key) {
    return mk(root.key, root.count, root.prio, root.left, remove(root.right, key));
  }
  if (root.count > 1) {
    return mk(root.key, root.count - 1, root.prio, root.left, root.right);
  }
  return removeRoot(root);
}

/** Delete the key stored at `root` by rotating it down until it becomes a leaf. */
function removeRoot(root: Node): Node | undefined {
  if (root.left === undefined) return root.right;
  if (root.right === undefined) return root.left;
  if (root.left.prio < root.right.prio) {
    const child = root.left;
    const demoted = mk(root.key, root.count, root.prio, child.right, root.right);
    return mk(child.key, child.count, child.prio, child.left, removeRoot(demoted));
  }
  const child = root.right;
  const demoted = mk(root.key, root.count, root.prio, root.left, child.left);
  return mk(child.key, child.count, child.prio, removeRoot(demoted), child.right);
}

/** Value at 1-based `rank` in sorted order (rank 1 = minimum). */
export function select(root: Node, rank: number): number {
  let node: Node | undefined = root;
  let r = rank;
  while (node !== undefined) {
    const leftSize = sizeOf(node.left);
    if (r <= leftSize) {
      node = node.left;
      continue;
    }
    if (r <= leftSize + node.count) return node.key;
    r -= leftSize + node.count;
    node = node.right;
  }
  throw new RangeError(`rank ${rank} out of bounds (size ${root.size})`);
}

/** Number of elements strictly less than `key`. */
export function countLess(root: Node | undefined, key: number): number {
  let node = root;
  let acc = 0;
  while (node !== undefined) {
    if (key <= node.key) {
      node = node.left;
      continue;
    }
    acc += sizeOf(node.left) + node.count;
    node = node.right;
  }
  return acc;
}

/** Multiplicity of `key`. */
export function countOf(root: Node | undefined, key: number): number {
  let node = root;
  while (node !== undefined) {
    if (key === node.key) return node.count;
    node = key < node.key ? node.left : node.right;
  }
  return 0;
}

/** Sorted elements, duplicates expanded. */
export function toArray(root: Node | undefined): number[] {
  const out: number[] = [];
  const stack: Node[] = [];
  let node = root;
  while (node !== undefined || stack.length > 0) {
    while (node !== undefined) {
      stack.push(node);
      node = node.left;
    }
    const top = stack.pop()!;
    for (let i = 0; i < top.count; i++) out.push(top.key);
    node = top.right;
  }
  return out;
}
