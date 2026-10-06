import { buildTree, type TreeNode, type ValueHash } from "./merkle.js";

/** A path from the tree root to a node; each element selects a child. */
export type Path = readonly (0 | 1)[];

export type RemoteNode =
  | { readonly type: "empty" }
  | {
      readonly type: "leaf";
      readonly hash: string;
      readonly key: string;
      readonly valueHash: ValueHash;
    }
  | {
      readonly type: "inner";
      readonly hash: string;
      readonly leftHash: string | null;
      readonly rightHash: string | null;
    };

export interface NodeResponse {
  /** Version of the remote object set this node belongs to. */
  readonly version: number;
  readonly node: RemoteNode;
}

/** Minimal interface the syncer needs from a remote replica. */
export interface RemoteStore {
  fetchNode(path: Path): Promise<NodeResponse>;
}

function toRemoteNode(node: TreeNode | null): RemoteNode {
  if (node === null) return { type: "empty" };
  if (node.type === "leaf") {
    return {
      type: "leaf",
      hash: node.hash,
      key: node.key,
      valueHash: node.valueHash,
    };
  }
  return {
    type: "inner",
    hash: node.hash,
    leftHash: node.left?.hash ?? null,
    rightHash: node.right?.hash ?? null,
  };
}

/**
 * In-memory remote replica used for tests and as a reference
 * implementation. `version` increments on every mutation; every
 * `fetchNode` response is tagged with the version it was served from.
 */
export class InMemoryRemote implements RemoteStore {
  private entries: Map<string, ValueHash>;
  private cachedTree: TreeNode | null | undefined;

  version: number;
  fetchCount = 0;
  readonly fetchedPaths: string[] = [];
  /** Test hook invoked inside fetchNode, may mutate the store. */
  onFetch: ((path: Path, store: InMemoryRemote) => void) | undefined;

  constructor(entries: ReadonlyMap<string, ValueHash> = new Map(), version = 1) {
    this.entries = new Map(entries);
    this.version = version;
  }

  get size(): number {
    return this.entries.size;
  }

  snapshot(): Map<string, ValueHash> {
    return new Map(this.entries);
  }

  setEntries(entries: ReadonlyMap<string, ValueHash>): void {
    this.entries = new Map(entries);
    this.cachedTree = undefined;
    this.version += 1;
  }

  set(key: string, valueHash: ValueHash): void {
    this.entries.set(key, valueHash);
    this.cachedTree = undefined;
    this.version += 1;
  }

  delete(key: string): void {
    if (this.entries.delete(key)) {
      this.cachedTree = undefined;
      this.version += 1;
    }
  }

  private tree(): TreeNode | null {
    if (this.cachedTree === undefined) {
      this.cachedTree = buildTree(this.entries);
    }
    return this.cachedTree;
  }

  async fetchNode(path: Path): Promise<NodeResponse> {
    this.fetchCount += 1;
    this.fetchedPaths.push(path.join(""));
    this.onFetch?.(path, this);

    let node = this.tree();
    for (const bit of path) {
      if (node === null || node.type !== "inner") {
        node = null;
        break;
      }
      node = bit === 0 ? node.left : node.right;
    }
    return { version: this.version, node: toRemoteNode(node) };
  }
}
