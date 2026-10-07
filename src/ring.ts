export interface NodeSpec {
  id: string;
  /** Number of virtual nodes this physical node contributes to the ring. */
  weight: number;
}

export interface VNode {
  hash: number;
  nodeId: string;
  replicaIndex: number;
}

/**
 * Total order for vnodes: hash first; on hash collision, node id; then
 * replica index. This makes deliberately-colliding adapters deterministic.
 */
export function compareVNodes(a: VNode, b: VNode): number {
  if (a.hash !== b.hash) return a.hash - b.hash;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  return a.replicaIndex - b.replicaIndex;
}

export interface VNodeInput {
  input: string;
  nodeId: string;
  replicaIndex: number;
}

/** The adapter inputs a ring build hashes: "<nodeId>#<replicaIndex>". */
export function vnodeInputs(nodes: readonly NodeSpec[]): VNodeInput[] {
  const out: VNodeInput[] = [];
  for (const node of nodes) {
    if (!Number.isInteger(node.weight) || node.weight < 1) {
      throw new Error(`invalid weight for node "${node.id}": ${node.weight}`);
    }
    for (let replica = 0; replica < node.weight; replica++) {
      out.push({ input: `${node.id}#${replica}`, nodeId: node.id, replicaIndex: replica });
    }
  }
  return out;
}

/**
 * Immutable virtual-node ring. Vnodes are sorted by (hash, nodeId,
 * replicaIndex); lookups are binary searches for the successor vnode,
 * wrapping around the end of the ring.
 */
export class Ring {
  readonly vnodes: readonly VNode[];

  constructor(vnodes: VNode[]) {
    this.vnodes = vnodes.slice().sort(compareVNodes);
  }

  get isEmpty(): boolean {
    return this.vnodes.length === 0;
  }

  get nodeIds(): string[] {
    const ids = new Set<string>();
    for (const vnode of this.vnodes) ids.add(vnode.nodeId);
    return [...ids].sort();
  }

  /** Owner of a key hash: the successor vnode's physical node. */
  owner(hash: number): string | undefined {
    if (this.vnodes.length === 0) return undefined;
    return this.vnodes[this.successorIndex(hash)].nodeId;
  }

  /**
   * Up to `count` distinct physical nodes, walking clockwise from the key's
   * successor vnode. Replicas never repeat a physical node.
   */
  owners(hash: number, count: number): string[] {
    const n = this.vnodes.length;
    if (n === 0 || count <= 0) return [];
    const seen = new Set<string>();
    const start = this.successorIndex(hash);
    for (let i = 0; i < n && seen.size < count; i++) {
      seen.add(this.vnodes[(start + i) % n].nodeId);
    }
    return [...seen];
  }

  /** Index of the first vnode with hash >= `hash`, wrapping to index 0. */
  private successorIndex(hash: number): number {
    let lo = 0;
    let hi = this.vnodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.vnodes[mid].hash < hash) lo = mid + 1;
      else hi = mid;
    }
    return lo === this.vnodes.length ? 0 : lo;
  }
}
