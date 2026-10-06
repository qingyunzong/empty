import {
  bitOf,
  collectKeys,
  findLeaf,
  hashKey,
  type TreeNode,
  type ValueHash,
} from "./merkle.js";
import { buildTree } from "./merkle.js";
import type { Path, RemoteNode, RemoteStore } from "./remote.js";

/**
 * The minimal set of changes the local replica must apply to converge
 * with the remote: keys to pull (missing or stale values) and local keys
 * to remove (absent on the remote).
 */
export interface PullPlan {
  /** Remote version the plan was computed against. */
  readonly version: number;
  /** Keys whose (new) values must be fetched from the remote. */
  readonly pull: readonly string[];
  /** Local keys that no longer exist on the remote. */
  readonly remove: readonly string[];
}

/** Thrown when the remote version changes underneath a running branch. */
export class VersionChanged extends Error {
  constructor(readonly version: number) {
    super(`remote version changed to ${version}`);
    this.name = "VersionChanged";
  }
}

interface PlanBuffer {
  pull: string[];
  remove: string[];
}

/**
 * Compute the minimal pull plan between the local entries and the remote.
 *
 * The whole sync is one branch rooted at the tree root; see `syncBranch`
 * for the per-branch restart semantics.
 */
export async function computePullPlan(
  remote: RemoteStore,
  localEntries: ReadonlyMap<string, ValueHash>,
): Promise<PullPlan> {
  const localTree = buildTree(localEntries);
  const result = await syncBranch(remote, [], localTree);
  result.pull.sort();
  result.remove.sort();
  return result;
}

/**
 * Sync one branch (subtree) rooted at `path`.
 *
 * The first fetch of the branch root pins a remote version. Every
 * subsequent fetch inside the branch must report the same version; if the
 * remote version changes mid-branch, all partial results gathered for the
 * branch are discarded and the branch restarts from its root against the
 * new version. A final re-fetch of the branch root guards against a
 * version change that happens after the last inner fetch.
 */
export async function syncBranch(
  remote: RemoteStore,
  path: Path,
  localNode: TreeNode | null,
): Promise<PullPlan & PlanBuffer> {
  for (;;) {
    const root = await remote.fetchNode(path);
    const version = root.version;
    const buffer: PlanBuffer = { pull: [], remove: [] };
    try {
      await walk(remote, path, localNode, root.node, version, buffer);
      const check = await remote.fetchNode(path);
      if (check.version !== version) throw new VersionChanged(check.version);
      return { version, pull: buffer.pull, remove: buffer.remove };
    } catch (error) {
      if (error instanceof VersionChanged) continue; // restart this branch
      throw error;
    }
  }
}

function remoteHash(node: RemoteNode): string | null {
  return node.type === "empty" ? null : node.hash;
}

async function walk(
  remote: RemoteStore,
  path: Path,
  localNode: TreeNode | null,
  remoteNode: RemoteNode,
  version: number,
  buffer: PlanBuffer,
): Promise<void> {
  const localHash = localNode?.hash ?? null;
  if (localHash === remoteHash(remoteNode)) return; // identical subtree

  if (remoteNode.type === "empty") {
    // Remote has nothing here: every local key below is stale.
    collectKeys(localNode, buffer.remove);
    return;
  }

  if (remoteNode.type === "leaf") {
    const localLeaf = findLeaf(localNode, remoteNode.key, path.length);
    if (localLeaf === null || localLeaf.valueHash !== remoteNode.valueHash) {
      buffer.pull.push(remoteNode.key);
    }
    // Any other local key in this subtree is absent on the remote.
    for (const key of collectKeys(localNode)) {
      if (key !== remoteNode.key) buffer.remove.push(key);
    }
    return;
  }

  // Remote is an inner node: descend only into children whose hashes
  // differ. A local leaf is projected onto the child its key hash selects.
  let localLeft: TreeNode | null = null;
  let localRight: TreeNode | null = null;
  if (localNode !== null) {
    if (localNode.type === "inner") {
      localLeft = localNode.left;
      localRight = localNode.right;
    } else {
      const bit = bitOf(hashKey(localNode.key), path.length);
      if (bit === 0) localLeft = localNode;
      else localRight = localNode;
    }
  }

  // The inner node's response already carries child hashes, so equal
  // children are pruned without spending a fetch on them: only differing
  // subtrees are ever pulled.
  if ((localLeft?.hash ?? null) !== remoteNode.leftHash) {
    await walkChild(remote, path, 0, localLeft, version, buffer);
  }
  if ((localRight?.hash ?? null) !== remoteNode.rightHash) {
    await walkChild(remote, path, 1, localRight, version, buffer);
  }
}

async function walkChild(
  remote: RemoteStore,
  path: Path,
  bit: 0 | 1,
  localNode: TreeNode | null,
  version: number,
  buffer: PlanBuffer,
): Promise<void> {
  const childPath: Path = [...path, bit];
  const response = await remote.fetchNode(childPath);
  if (response.version !== version) {
    throw new VersionChanged(response.version);
  }
  await walk(remote, childPath, localNode, response.node, version, buffer);
}
