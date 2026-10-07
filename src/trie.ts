import { EMPTY_HASH, hashInternal, hashLeaf, keyBit, maxDepth } from './hash.js';

export interface TrieNode {
  hash: string;
  leaf: { key: string; valueHash: string } | null;
  children: [TrieNode | null, TrieNode | null] | null;
}

/**
 * Builds a binary Merkle trie over the key set. A node at depth d groups all
 * keys whose sha256 prefix shares the same d bits, so both replicas derive the
 * identical shape for the identical key set and can compare nodes by path.
 */
export function buildTrie(entries: Iterable<[string, string]>, depth = 0): TrieNode | null {
  const items = [...entries];
  if (items.length === 0) return null;
  if (items.length === 1) {
    const [key, valueHash] = items[0];
    return { hash: hashLeaf(key, valueHash), leaf: { key, valueHash }, children: null };
  }
  if (depth >= maxDepth()) throw new Error('key hash prefix exhausted (sha256 collision?)');
  const left: [string, string][] = [];
  const right: [string, string][] = [];
  for (const item of items) (keyBit(item[0], depth) === 0 ? left : right).push(item);
  const leftNode = buildTrie(left, depth + 1);
  const rightNode = buildTrie(right, depth + 1);
  return {
    hash: hashInternal(leftNode?.hash ?? EMPTY_HASH, rightNode?.hash ?? EMPTY_HASH),
    leaf: null,
    children: [leftNode, rightNode],
  };
}

export function collectKeys(node: TrieNode | null, out: string[] = []): string[] {
  if (!node) return out;
  if (node.leaf) out.push(node.leaf.key);
  if (node.children) {
    collectKeys(node.children[0], out);
    collectKeys(node.children[1], out);
  }
  return out;
}

/** Local subtree aligned with a remote child at `depth`: leaves are pushed down by key bit. */
export function childAt(node: TrieNode | null, bit: 0 | 1, depth: number): TrieNode | null {
  if (!node) return null;
  if (node.children) return node.children[bit];
  if (node.leaf) return keyBit(node.leaf.key, depth) === bit ? node : null;
  return null;
}

/** Looks up a key's value hash inside a local subtree, following key bits from `depth`. */
export function findValueHash(node: TrieNode | null, key: string, depth = 0): string | undefined {
  let current = node;
  let d = depth;
  while (current) {
    if (current.leaf) return current.leaf.key === key ? current.leaf.valueHash : undefined;
    if (!current.children) return undefined;
    current = current.children[keyBit(key, d)];
    d += 1;
  }
  return undefined;
}
