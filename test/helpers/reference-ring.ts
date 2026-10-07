import { compareVNodes, type VNode } from '../../src/ring.js';

/**
 * Fully-sorted reference ring used to cross-check the optimized Ring.
 * Same total order, but lookups are plain linear scans.
 */
export class ReferenceRing {
  readonly vnodes: readonly VNode[];

  constructor(vnodes: readonly VNode[]) {
    this.vnodes = vnodes.slice().sort(compareVNodes);
  }

  owner(hash: number): string | undefined {
    if (this.vnodes.length === 0) return undefined;
    for (const vnode of this.vnodes) {
      if (vnode.hash >= hash) return vnode.nodeId;
    }
    return this.vnodes[0].nodeId;
  }

  owners(hash: number, count: number): string[] {
    const n = this.vnodes.length;
    if (n === 0 || count <= 0) return [];
    let start = 0;
    while (start < n && this.vnodes[start].hash < hash) start++;
    if (start === n) start = 0;
    const seen = new Set<string>();
    for (let i = 0; i < n && seen.size < count; i++) {
      seen.add(this.vnodes[(start + i) % n].nodeId);
    }
    return [...seen];
  }
}
