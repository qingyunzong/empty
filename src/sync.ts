import { EMPTY_HASH, hashValue } from './hash.js';
import type { Diff } from './reference.js';
import type { NodeResponse, ReplicaServer } from './server.js';
import { buildTrie, childAt, collectKeys, findValueHash, type TrieNode } from './trie.js';

export interface PullPlan extends Diff {
  /** Remote version the plan is consistent with. */
  version: number;
  /** Branch restarts caused by mid-sync version changes. */
  restarts: number;
  /** Number of getNode RPCs issued (minimality metric). */
  requests: number;
}

const MAX_RESTARTS = 32;

class VersionChanged extends Error {}

/**
 * Computes the minimal pull plan between the local replica and the remote
 * server. Only subtrees whose hashes differ are descended into; identical
 * subtrees cost zero RPCs beyond the parent fetch. The sync pins the remote
 * version at each branch root; if the version changes mid-branch, that branch
 * is restarted from its root, and a final root re-check guarantees the whole
 * plan is consistent with `plan.version`.
 */
export function computePullPlan(local: Map<string, string>, server: ReplicaServer): PullPlan {
  const localHashed = new Map<string, string>();
  for (const [key, value] of local) localHashed.set(key, hashValue(value));
  const localRoot = buildTrie(localHashed);

  const plan: PullPlan = { pull: [], remove: [], version: 0, restarts: 0, requests: 0 };

  const fetchNode = (path: string): NodeResponse => {
    plan.requests += 1;
    return server.getNode(path);
  };

  /** Walks one branch with a freshly pinned version; retries the branch on version change. */
  const syncBranch = (path: string, localNode: TrieNode | null): { diff: Diff; version: number } => {
    for (let attempt = 0; ; attempt += 1) {
      const resp = fetchNode(path);
      try {
        return { diff: descend(resp, path, localNode, resp.version), version: resp.version };
      } catch (err) {
        if (!(err instanceof VersionChanged)) throw err;
        plan.restarts += 1;
        if (attempt >= MAX_RESTARTS) throw new Error('remote version unstable: too many restarts');
      }
    }
  };

  const descend = (resp: NodeResponse, path: string, localNode: TrieNode | null, version: number): Diff => {
    const localHash = localNode?.hash ?? EMPTY_HASH;
    if (resp.hash === localHash) return { pull: [], remove: [] };
    if (resp.hash === EMPTY_HASH) return { pull: [], remove: collectKeys(localNode) };
    if (resp.leaf) {
      const leaf = resp.leaf;
      const pull = findValueHash(localNode, leaf.key, path.length) === leaf.valueHash ? [] : [leaf.key];
      const remove = collectKeys(localNode).filter((key) => key !== leaf.key);
      return { pull, remove };
    }
    const diff: Diff = { pull: [], remove: [] };
    for (const bit of [0, 1] as const) {
      const childLocal = childAt(localNode, bit, path.length);
      const childHash = resp.children![bit].hash;
      if (childHash === (childLocal?.hash ?? EMPTY_HASH)) continue; // identical subtree: no RPC
      const child = syncBranch(path + bit, childLocal);
      if (child.version !== version) throw new VersionChanged();
      diff.pull.push(...child.diff.pull);
      diff.remove.push(...child.diff.remove);
    }
    return diff;
  };

  for (let attempt = 0; ; attempt += 1) {
    const { diff, version } = syncBranch('', localRoot);
    const check = fetchNode('');
    if (check.version === version) {
      plan.pull = diff.pull.sort();
      plan.remove = diff.remove.sort();
      plan.version = version;
      return plan;
    }
    plan.restarts += 1;
    if (attempt >= MAX_RESTARTS) throw new Error('remote version unstable: too many restarts');
  }
}

/** Applies a plan to the local replica by pulling values from the server. */
export function applyPullPlan(
  local: Map<string, string>,
  server: ReplicaServer,
  plan: PullPlan,
): void {
  const values = server.pull(plan.pull);
  for (const [key, value] of Object.entries(values)) local.set(key, value);
  for (const key of plan.remove) local.delete(key);
}
