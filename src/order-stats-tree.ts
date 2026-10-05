/**
 * Persistent (immutable, path-copied) order-statistics tree.
 *
 * A treap keyed by integer value with deterministic priorities derived from
 * the key, so a given multiset always produces the same shape. Every update
 * returns a new root; previously returned roots remain valid forever, which
 * is what makes snapshots and branch merges cheap and safe.
 *
 * Each node stores:
 *  - count: multiplicity of its key (duplicate values are supported),
 *  - size:  total number of elements in the subtree (sum of counts),
 * which gives O(log n) rank-of and kth-element queries.
 */

export interface TreeNode {
  readonly key: number;
  readonly count: number;
  readonly size: number;
  readonly prio: number;
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
}

export type Tree = TreeNode | null;

/** Deterministic 32-bit priority for an integer key (splitmix-style mix). */
function priorityOf(key: number): number {
  // Fold the (possibly >32-bit, possibly negative) safe integer into 64 bits.
  let lo = key % 0x100000000;
  if (lo < 0) lo += 0x100000000;
  let hi = Math.floor((key - lo) / 0x100000000) % 0x100000000;
  if (hi < 0) hi += 0x100000000;
  let z = (lo + 0x9e3779b9) >>> 0;
  z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
  z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
  z = (z ^ (z >>> 15)) >>> 0;
  let w = (hi + 0x85ebca6b) >>> 0;
  w = Math.imul(w ^ (w >>> 16), 0x21f0aaad);
  w = Math.imul(w ^ (w >>> 15), 0x735a2d97);
  w = (w ^ (w >>> 15)) >>> 0;
  return (z ^ Math.imul(w, 0x9e3779b9)) >>> 0;
}

function sizeOf(t: Tree): number {
  return t === null ? 0 : t.size;
}

function node(
  key: number,
  count: number,
  prio: number,
  left: Tree,
  right: Tree,
): TreeNode {
  return { key, count, prio, left, right, size: count + sizeOf(left) + sizeOf(right) };
}

function rotateRight(t: TreeNode): TreeNode {
  const l = t.left as TreeNode;
  const newRight = node(t.key, t.count, t.prio, l.right, t.right);
  return node(l.key, l.count, l.prio, l.left, newRight);
}

function rotateLeft(t: TreeNode): TreeNode {
  const r = t.right as TreeNode;
  const newLeft = node(t.key, t.count, t.prio, t.left, r.left);
  return node(r.key, r.count, r.prio, newLeft, r.right);
}

/** Insert one occurrence of `key`; returns a new root. */
export function insert(t: Tree, key: number): Tree {
  if (!Number.isSafeInteger(key)) {
    throw new RangeError(`key must be a safe integer, got ${key}`);
  }
  return insertRec(t, key, priorityOf(key));
}

function insertRec(t: Tree, key: number, prio: number): TreeNode {
  if (t === null) return node(key, 1, prio, null, null);
  if (key === t.key) return node(key, t.count + 1, t.prio, t.left, t.right);
  if (key < t.key) {
    const left = insertRec(t.left, key, prio);
    const me = node(t.key, t.count, t.prio, left, t.right);
    return left.prio < me.prio ? rotateRight(me) : me;
  }
  const right = insertRec(t.right, key, prio);
  const me = node(t.key, t.count, t.prio, t.left, right);
  return right.prio < me.prio ? rotateLeft(me) : me;
}

/** Remove one occurrence of `key`; returns a new root. Throws if absent. */
export function remove(t: Tree, key: number): Tree {
  if (countOf(t, key) === 0) {
    throw new Error(`cannot remove absent key ${key}`);
  }
  return removeRec(t as TreeNode, key);
}

function removeRec(t: TreeNode, key: number): Tree {
  if (key < t.key) {
    return node(t.key, t.count, t.prio, removeRec(t.left as TreeNode, key), t.right);
  }
  if (key > t.key) {
    return node(t.key, t.count, t.prio, t.left, removeRec(t.right as TreeNode, key));
  }
  if (t.count > 1) return node(t.key, t.count - 1, t.prio, t.left, t.right);
  return mergeTrees(t.left, t.right);
}

/** Merge two treaps where every key in `l` is smaller than every key in `r`. */
function mergeTrees(l: Tree, r: Tree): Tree {
  if (l === null) return r;
  if (r === null) return l;
  if (l.prio < r.prio) {
    return node(l.key, l.count, l.prio, l.left, mergeTrees(l.right, r));
  }
  return node(r.key, r.count, r.prio, mergeTrees(l, r.left), r.right);
}

/** Total number of elements (counting duplicates). */
export function size(t: Tree): number {
  return sizeOf(t);
}

/** Multiplicity of `key`. */
export function countOf(t: Tree, key: number): number {
  let cur = t;
  while (cur !== null) {
    if (key === cur.key) return cur.count;
    cur = key < cur.key ? cur.left : cur.right;
  }
  return 0;
}

/** Number of elements strictly smaller than `key`. */
export function rankOf(t: Tree, key: number): number {
  let rank = 0;
  let cur = t;
  while (cur !== null) {
    if (key <= cur.key) {
      cur = cur.left;
    } else {
      rank += sizeOf(cur.left) + cur.count;
      cur = cur.right;
    }
  }
  return rank;
}

/** Number of elements less than or equal to `key`. */
export function countLE(t: Tree, key: number): number {
  return rankOf(t, key) + countOf(t, key);
}

/**
 * The `rank`-th smallest element, 1-indexed: kth(t, 1) is the minimum.
 * Throws RangeError when rank is outside [1, size].
 */
export function kth(t: Tree, rank: number): number {
  if (!Number.isSafeInteger(rank) || rank < 1 || rank > sizeOf(t)) {
    throw new RangeError(`rank ${rank} out of bounds for size ${sizeOf(t)}`);
  }
  let cur = t;
  let r = rank;
  while (cur !== null) {
    const leftSize = sizeOf(cur.left);
    if (r <= leftSize) {
      cur = cur.left;
    } else if (r <= leftSize + cur.count) {
      return cur.key;
    } else {
      r -= leftSize + cur.count;
      cur = cur.right;
    }
  }
  throw new RangeError(`rank ${rank} out of bounds`);
}

/** Minimum element, or null when the tree is empty. */
export function min(t: Tree): number | null {
  let cur = t;
  if (cur === null) return null;
  while (cur.left !== null) cur = cur.left;
  return cur.key;
}

/** Maximum element, or null when the tree is empty. */
export function max(t: Tree): number | null {
  let cur = t;
  if (cur === null) return null;
  while (cur.right !== null) cur = cur.right;
  return cur.key;
}

/** Sorted array of all elements (duplicates repeated). For tests/debugging. */
export function toSortedArray(t: Tree): number[] {
  const out: number[] = [];
  const walk = (n: Tree): void => {
    if (n === null) return;
    walk(n.left);
    for (let i = 0; i < n.count; i++) out.push(n.key);
    walk(n.right);
  };
  walk(t);
  return out;
}
