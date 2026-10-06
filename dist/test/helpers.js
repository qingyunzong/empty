import assert from 'node:assert/strict';
import { intervalContains } from '../src/migration.js';
import { compareVnodes } from '../src/ring.js';
export class Deferred {
    promise;
    resolve;
    reject;
    constructor() {
        this.promise = new Promise((resolve, reject) => {
            this.resolve = resolve;
            this.reject = reject;
        });
    }
}
export class BarrierHashAdapter {
    hashFn;
    calls = [];
    aborts = [];
    pending = new Map();
    constructor(hashFn) {
        this.hashFn = hashFn;
    }
    hash(input, signal) {
        this.calls.push(input);
        signal.addEventListener('abort', () => {
            this.aborts.push(input);
        }, { once: true });
        const deferred = new Deferred();
        const list = this.pending.get(input);
        if (list)
            list.push(deferred);
        else
            this.pending.set(input, [deferred]);
        return deferred.promise;
    }
    get pendingCount() {
        let count = 0;
        for (const list of this.pending.values())
            count += list.length;
        return count;
    }
    release(input) {
        const list = this.pending.get(input);
        if (!list)
            throw new Error(`no pending hash computation for ${input}`);
        this.pending.delete(input);
        for (const deferred of list)
            deferred.resolve(this.hashFn(input) >>> 0);
    }
    releaseMatching(predicate) {
        for (const input of [...this.pending.keys()]) {
            if (predicate(input))
                this.release(input);
        }
    }
    releaseAll() {
        this.releaseMatching(() => true);
    }
}
export async function waitFor(condition, description = 'condition') {
    const deadline = Date.now() + 5000;
    while (!condition()) {
        if (Date.now() > deadline)
            throw new Error(`timed out waiting for ${description}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}
export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
export class MapAdapter {
    entries;
    fallback;
    constructor(entries, fallback) {
        this.entries = entries;
        this.fallback = fallback;
    }
    hash(input) {
        const mapped = this.entries[input];
        return mapped !== undefined ? mapped >>> 0 : this.fallback.hash(input);
    }
}
export class ReferenceRing {
    vnodes;
    constructor(specs, adapter) {
        this.vnodes = specs
            .map((spec) => ({ hash: adapter.hash(spec.key) >>> 0, nodeId: spec.nodeId, replica: spec.replica }))
            .sort(compareVnodes);
    }
    ownerOfHash(keyHash) {
        if (this.vnodes.length === 0)
            return undefined;
        for (const vnode of this.vnodes) {
            if (vnode.hash >= keyHash)
                return vnode.nodeId;
        }
        return this.vnodes[0].nodeId;
    }
    replicasOfHash(keyHash, count) {
        if (count <= 0 || this.vnodes.length === 0)
            return [];
        let start = this.vnodes.findIndex((vnode) => vnode.hash >= keyHash);
        if (start === -1)
            start = 0;
        const result = [];
        for (let i = 0; i < this.vnodes.length && result.length < count; i++) {
            const nodeId = this.vnodes[(start + i) % this.vnodes.length].nodeId;
            if (!result.includes(nodeId))
                result.push(nodeId);
        }
        return result;
    }
}
export function assertPlanExact(plan, oldRing, newRing) {
    const boundaries = new Set([0, 0xffffffff]);
    for (const point of oldRing.ownershipPoints())
        boundaries.add(point.hash);
    for (const point of newRing.ownershipPoints())
        boundaries.add(point.hash);
    const samples = new Set();
    for (const boundary of boundaries) {
        samples.add(boundary);
        samples.add((boundary + 1) >>> 0);
    }
    for (const keyHash of samples) {
        const oldOwner = oldRing.ownerOfHash(keyHash) ?? null;
        const newOwner = newRing.ownerOfHash(keyHash) ?? null;
        const covering = plan.filter((iv) => intervalContains(iv, keyHash));
        if (oldOwner === newOwner) {
            assert.strictEqual(covering.length, 0, `key ${keyHash} unchanged but covered by plan`);
        }
        else {
            assert.strictEqual(covering.length, 1, `key ${keyHash} changed but not covered exactly once`);
            assert.strictEqual(covering[0].from, oldOwner);
            assert.strictEqual(covering[0].to, newOwner);
        }
    }
}
