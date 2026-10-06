export function compareVnodes(a, b) {
    if (a.hash !== b.hash)
        return a.hash - b.hash;
    if (a.nodeId !== b.nodeId)
        return a.nodeId < b.nodeId ? -1 : 1;
    return a.replica - b.replica;
}
export function vnodeKey(nodeId, replica) {
    return `${nodeId}#${replica}`;
}
export function expandNodes(nodes, replicasPerWeight) {
    const specs = [];
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
    version;
    vnodes;
    distinctHashes;
    distinctOwners;
    constructor(version, vnodes, distinctHashes, distinctOwners) {
        this.version = version;
        this.vnodes = vnodes;
        this.distinctHashes = distinctHashes;
        this.distinctOwners = distinctOwners;
    }
    static empty(version) {
        return new Ring(version, [], [], []);
    }
    static create(version, vnodes) {
        const sorted = [...vnodes].sort(compareVnodes);
        const distinctHashes = [];
        const distinctOwners = [];
        for (const vnode of sorted) {
            if (distinctHashes[distinctHashes.length - 1] !== vnode.hash) {
                distinctHashes.push(vnode.hash);
                distinctOwners.push(vnode.nodeId);
            }
        }
        return new Ring(version, sorted, distinctHashes, distinctOwners);
    }
    get size() {
        return this.vnodes.length;
    }
    get isEmpty() {
        return this.vnodes.length === 0;
    }
    ownerOfHash(keyHash) {
        if (this.distinctHashes.length === 0)
            return undefined;
        let lo = 0;
        let hi = this.distinctHashes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.distinctHashes[mid] < keyHash)
                lo = mid + 1;
            else
                hi = mid;
        }
        if (lo === this.distinctHashes.length)
            lo = 0;
        return this.distinctOwners[lo];
    }
    replicasOfHash(keyHash, count) {
        if (count <= 0 || this.vnodes.length === 0)
            return [];
        let lo = 0;
        let hi = this.vnodes.length;
        while (lo < hi) {
            const mid = (lo + hi) >>> 1;
            if (this.vnodes[mid].hash < keyHash)
                lo = mid + 1;
            else
                hi = mid;
        }
        if (lo === this.vnodes.length)
            lo = 0;
        const result = [];
        const seen = new Set();
        for (let i = 0; i < this.vnodes.length && result.length < count; i++) {
            const vnode = this.vnodes[(lo + i) % this.vnodes.length];
            if (!seen.has(vnode.nodeId)) {
                seen.add(vnode.nodeId);
                result.push(vnode.nodeId);
            }
        }
        return result;
    }
    ownershipPoints() {
        return this.distinctHashes.map((hash, i) => ({ hash, nodeId: this.distinctOwners[i] }));
    }
}
