import { Ring, expandNodes } from './ring.js';
export class StaleBuildError extends Error {
    constructor() {
        super('build superseded by a newer ring version');
        this.name = 'StaleBuildError';
    }
}
export class AbortError extends Error {
    constructor() {
        super('operation aborted');
        this.name = 'AbortError';
    }
}
export class SharedHashComputer {
    adapter;
    inflight = new Map();
    constructor(adapter) {
        this.adapter = adapter;
    }
    get inflightCount() {
        return this.inflight.size;
    }
    compute(key, signal) {
        if (signal.aborted)
            return Promise.reject(new AbortError());
        let entry = this.inflight.get(key);
        if (!entry) {
            const controller = new AbortController();
            const created = {
                promise: Promise.resolve().then(() => this.adapter.hash(key, controller.signal)),
                subscribers: 0,
                controller,
                settled: false,
            };
            created.promise.then(() => {
                created.settled = true;
            }, () => {
                created.settled = true;
            });
            this.inflight.set(key, created);
            entry = created;
        }
        const current = entry;
        current.subscribers++;
        return new Promise((resolve, reject) => {
            let settled = false;
            const cleanup = () => {
                if (settled)
                    return;
                settled = true;
                current.subscribers--;
                signal.removeEventListener('abort', onAbort);
                if (current.subscribers === 0) {
                    if (!current.settled)
                        current.controller.abort();
                    if (this.inflight.get(key) === current)
                        this.inflight.delete(key);
                }
            };
            const onAbort = () => {
                cleanup();
                reject(new AbortError());
            };
            signal.addEventListener('abort', onAbort, { once: true });
            current.promise.then((value) => {
                cleanup();
                resolve(value);
            }, (error) => {
                cleanup();
                reject(error);
            });
        });
    }
}
export class RingBuilder {
    computer;
    replicasPerWeight;
    epoch = 0;
    current = null;
    constructor(computer, replicasPerWeight = 16) {
        this.computer = computer;
        this.replicasPerWeight = replicasPerWeight;
        if (!Number.isInteger(replicasPerWeight) || replicasPerWeight <= 0) {
            throw new RangeError('replicasPerWeight must be a positive integer');
        }
    }
    build(nodes, version) {
        const myEpoch = ++this.epoch;
        this.current?.abort();
        const controller = new AbortController();
        this.current = controller;
        const promise = (async () => {
            const specs = expandNodes(nodes, this.replicasPerWeight);
            try {
                const hashes = await Promise.all(specs.map((s) => this.computer.compute(s.key, controller.signal)));
                if (myEpoch !== this.epoch)
                    throw new StaleBuildError();
                const vnodes = specs.map((s, i) => ({
                    hash: hashes[i],
                    nodeId: s.nodeId,
                    replica: s.replica,
                }));
                return Ring.create(version, vnodes);
            }
            catch (error) {
                if (myEpoch !== this.epoch)
                    throw new StaleBuildError();
                throw error;
            }
        })();
        return { promise, cancel: () => controller.abort() };
    }
}
