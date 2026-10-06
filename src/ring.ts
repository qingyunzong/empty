export interface NodeConfig {
  id: string;
  weight: number;
}

export interface VirtualNode {
  hash: number;
  nodeId: string;
  replica: number;
}

export interface VnodeSpec {
  nodeId: string;
  replica: number;
  key: string;
}

export interface OwnershipPoint {
  hash: number;
  nodeId: string;
}

export function compareVnodes(a: VirtualNode, b: VirtualNode): number {
  if (a.hash !== b.hash) return a.hash - b.hash;
  if (a.nodeId !== b.nodeId) return a.nodeId < b.nodeId ? -1 : 1;
  return a.replica - b.replica;
}

export function vnodeKey(nodeId: string, replica: number): string {
  return `${nodeId}#${replica}`;
}

export function expandNodes(nodes: readonly NodeConfig[], replicasPerWeight: number): VnodeSpec[] {
  const specs: VnodeSpec[] = [];
  for (const node of nodes) {
    if (!Number.isInteger(node.weight) || node.weight < 0) {
      throw new RangeError(`weight of node ${node.id} must be a non-negative integer`);
    }
    const replicas = node.weight * replicasPerWeight;
    for (let replica = 0; replica < replicas; replica++) {
      specs.push({ nodeId: node.id, replica, key: vnodeKey(node.id, replica) });
    }
  }
  return specs;
}

export class Ring {
  private constructor(
    readonly version: number,
    readonly vnodes: readonly VirtualNode[],
    private readonly distinctHashes: readonly number[],
    private readonly distinctOwners: readonly string[],
  ) {}

  static empty(version: number): Ring {
    return new Ring(version, [], [], []);
  }

  static create(version: number, vnodes: readonly VirtualNode[]): Ring {
    const sorted = [...vnodes].sort(compareVnodes);
    const distinctHashes: number[] = [];
    const distinctOwners: string[] = [];
    for (const vnode of sorted) {
      if (distinctHashes[distinctHashes.length - 1] !== vnode.hash) {
        distinctHashes.push(vnode.hash);
        distinctOwners.push(vnode.nodeId);
      }
    }
    return new Ring(version, sorted, distinctHashes, distinctOwners);
  }

  get size(): number {
    return this.vnodes.length;
  }

  get isEmpty(): boolean {
    return this.vnodes.length === 0;
  }

  ownerOfHash(keyHash: number): string | undefined {
    if (this.distinctHashes.length === 0) return undefined;
    let lo = 0;
    let hi = this.distinctHashes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.distinctHashes[mid] < keyHash) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.distinctHashes.length) lo = 0;
    return this.distinctOwners[lo];
  }

  replicasOfHash(keyHash: number, count: number): string[] {
    if (count <= 0 || this.vnodes.length === 0) return [];
    let lo = 0;
    let hi = this.vnodes.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (this.vnodes[mid].hash < keyHash) lo = mid + 1;
      else hi = mid;
    }
    if (lo === this.vnodes.length) lo = 0;
    const result: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.vnodes.length && result.length < count; i++) {
      const vnode = this.vnodes[(lo + i) % this.vnodes.length];
      if (!seen.has(vnode.nodeId)) {
        seen.add(vnode.nodeId);
        result.push(vnode.nodeId);
      }
    }
    return result;
  }

  ownershipPoints(): OwnershipPoint[] {
    return this.distinctHashes.map((hash, i) => ({ hash, nodeId: this.distinctOwners[i] }));
  }
}
