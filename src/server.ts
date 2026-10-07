import { EMPTY_HASH, hashValue } from './hash.js';
import { buildTrie, type TrieNode } from './trie.js';

export interface NodeResponse {
  version: number;
  hash: string;
  leaf: { key: string; valueHash: string } | null;
  children: [{ hash: string }, { hash: string }] | null;
}

/**
 * Simulated remote replica. Every mutation bumps `version` and rebuilds the
 * hash tree. `getNode(path)` is the sync RPC: `path` is a bit string ('0'/'1')
 * from the root; unknown prefixes resolve to the empty subtree.
 */
export class ReplicaServer {
  private store = new Map<string, string>();
  private version = 0;
  private root: TrieNode | null = null;
  /** Test hook: invoked before every RPC, may mutate the server. */
  beforeRequest: ((path: string) => void) | null = null;

  constructor(initial?: Record<string, string>) {
    if (initial) for (const [key, value] of Object.entries(initial)) this.store.set(key, value);
    this.rebuild();
  }

  private rebuild(): void {
    const hashed = new Map<string, string>();
    for (const [key, value] of this.store) hashed.set(key, hashValue(value));
    this.root = buildTrie(hashed);
  }

  get currentVersion(): number {
    return this.version;
  }

  set(key: string, value: string): void {
    this.store.set(key, value);
    this.version += 1;
    this.rebuild();
  }

  delete(key: string): void {
    if (this.store.delete(key)) {
      this.version += 1;
      this.rebuild();
    }
  }

  getNode(path: string): NodeResponse {
    if (this.beforeRequest) this.beforeRequest(path);
    let node = this.root;
    for (const ch of path) {
      if (!node?.children) return emptyResponse(this.version);
      node = node.children[ch === '1' ? 1 : 0];
    }
    if (!node) return emptyResponse(this.version);
    return {
      version: this.version,
      hash: node.hash,
      leaf: node.leaf,
      children: node.children
        ? [
            { hash: node.children[0]?.hash ?? EMPTY_HASH },
            { hash: node.children[1]?.hash ?? EMPTY_HASH },
          ]
        : null,
    };
  }

  pull(keys: Iterable<string>): Record<string, string> {
    const out: Record<string, string> = {};
    for (const key of keys) {
      const value = this.store.get(key);
      if (value !== undefined) out[key] = value;
    }
    return out;
  }

  snapshot(): Map<string, string> {
    return new Map(this.store);
  }
}

function emptyResponse(version: number): NodeResponse {
  return { version, hash: EMPTY_HASH, leaf: null, children: null };
}
