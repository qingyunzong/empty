import { createHash } from "node:crypto";

/**
 * Binary Merkle trie over the bit-string of each key's hash.
 *
 * - Leaf nodes carry exactly one (key, valueHash) pair.
 * - Inner nodes sit at a fixed depth; bit `depth` of a key's hash selects
 *   the left (0) or right (1) child.
 * - Empty subtrees are represented by `null` and hash to `null`.
 *
 * Because the shape of the trie is a pure function of the key set, two
 * replicas can compare trees node-by-node: equal hashes mean equal content,
 * and only differing subtrees need further inspection.
 */

export type ValueHash = string;

export interface LeafNode {
  readonly type: "leaf";
  readonly key: string;
  readonly valueHash: ValueHash;
  readonly hash: string;
}

export interface InnerNode {
  readonly type: "inner";
  readonly depth: number;
  readonly left: TreeNode | null;
  readonly right: TreeNode | null;
  readonly hash: string;
}

export type TreeNode = LeafNode | InnerNode;

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

export function hashKey(key: string): string {
  return sha256(`key:${key}`);
}

export function hashLeaf(key: string, valueHash: ValueHash): string {
  return sha256(`leaf:${key}:${valueHash}`);
}

export function hashNode(
  depth: number,
  leftHash: string | null,
  rightHash: string | null,
): string {
  return sha256(`node:${depth}:${leftHash ?? "-"}:${rightHash ?? "-"}`);
}

/** Extract bit `depth` (0 = most significant) from a hex key hash. */
export function bitOf(keyHashHex: string, depth: number): 0 | 1 {
  const nibble = keyHashHex[depth >> 2];
  if (nibble === undefined) {
    throw new RangeError(`bit depth ${depth} exceeds key hash length`);
  }
  const byte = parseInt(nibble, 16);
  return ((byte >> (3 - (depth & 3))) & 1) as 0 | 1;
}

interface Item {
  key: string;
  valueHash: ValueHash;
  keyHash: string;
}

/** Build the Merkle trie for a key -> valueHash map. `null` = empty tree. */
export function buildTree(
  entries: ReadonlyMap<string, ValueHash>,
): TreeNode | null {
  const items: Item[] = [];
  for (const [key, valueHash] of entries) {
    items.push({ key, valueHash, keyHash: hashKey(key) });
  }
  return build(items, 0);
}

function build(items: Item[], depth: number): TreeNode | null {
  if (items.length === 0) return null;
  if (items.length === 1) {
    const item = items[0]!;
    return {
      type: "leaf",
      key: item.key,
      valueHash: item.valueHash,
      hash: hashLeaf(item.key, item.valueHash),
    };
  }
  const leftItems: Item[] = [];
  const rightItems: Item[] = [];
  for (const item of items) {
    (bitOf(item.keyHash, depth) === 0 ? leftItems : rightItems).push(item);
  }
  const left = build(leftItems, depth + 1);
  const right = build(rightItems, depth + 1);
  return {
    type: "inner",
    depth,
    left,
    right,
    hash: hashNode(depth, left?.hash ?? null, right?.hash ?? null),
  };
}

/** All keys stored under a subtree (used for removal plans). */
export function collectKeys(node: TreeNode | null, out: string[] = []): string[] {
  if (node === null) return out;
  if (node.type === "leaf") {
    out.push(node.key);
    return out;
  }
  collectKeys(node.left, out);
  collectKeys(node.right, out);
  return out;
}

/** Find the leaf for `key` inside a subtree, or `null` if absent. */
export function findLeaf(
  node: TreeNode | null,
  key: string,
  depth = 0,
): LeafNode | null {
  const keyHash = hashKey(key);
  let current = node;
  let d = depth;
  while (current !== null) {
    if (current.type === "leaf") {
      return current.key === key ? current : null;
    }
    current = bitOf(keyHash, d) === 0 ? current.left : current.right;
    d += 1;
  }
  return null;
}
