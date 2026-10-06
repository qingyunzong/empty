import { AsyncHashAdapter } from './hash.js';
import { NodeConfig, Ring, VirtualNode, expandNodes } from './ring.js';

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

interface Inflight {
  promise: Promise<number>;
  subscribers: number;
  controller: AbortController;
  settled: boolean;
}

export class SharedHashComputer {
  private readonly inflight = new Map<string, Inflight>();

  constructor(private readonly adapter: AsyncHashAdapter) {}

  get inflightCount(): number {
    return this.inflight.size;
  }

  compute(key: string, signal: AbortSignal): Promise<number> {
    if (signal.aborted) return Promise.reject(new AbortError());
    let entry = this.inflight.get(key);
    if (!entry) {
      const controller = new AbortController();
      const created: Inflight = {
        promise: Promise.resolve().then(() => this.adapter.hash(key, controller.signal)),
        subscribers: 0,
        controller,
        settled: false,
      };
      created.promise.then(
        () => {
          created.settled = true;
        },
        () => {
          created.settled = true;
        },
      );
      this.inflight.set(key, created);
      entry = created;
    }
    const current = entry;
    current.subscribers++;
    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const cleanup = () => {
        if (settled) return;
        settled = true;
        current.subscribers--;
        signal.removeEventListener('abort', onAbort);
        if (current.subscribers === 0) {
          if (!current.settled) current.controller.abort();
          if (this.inflight.get(key) === current) this.inflight.delete(key);
        }
      };
      const onAbort = () => {
        cleanup();
        reject(new AbortError());
      };
      signal.addEventListener('abort', onAbort, { once: true });
      current.promise.then(
        (value) => {
          cleanup();
          resolve(value);
        },
        (error: unknown) => {
          cleanup();
          reject(error);
        },
      );
    });
  }
}

export interface BuildHandle {
  readonly promise: Promise<Ring>;
  cancel(): void;
}

export class RingBuilder {
  private epoch = 0;
  private current: AbortController | null = null;

  constructor(
    private readonly computer: SharedHashComputer,
    private readonly replicasPerWeight: number = 16,
  ) {
    if (!Number.isInteger(replicasPerWeight) || replicasPerWeight <= 0) {
      throw new RangeError('replicasPerWeight must be a positive integer');
    }
  }

  build(nodes: NodeConfig[], version: number): BuildHandle {
    const myEpoch = ++this.epoch;
    this.current?.abort();
    const controller = new AbortController();
    this.current = controller;

    const promise = (async (): Promise<Ring> => {
      const specs = expandNodes(nodes, this.replicasPerWeight);
      try {
        const hashes = await Promise.all(specs.map((s) => this.computer.compute(s.key, controller.signal)));
        if (myEpoch !== this.epoch) throw new StaleBuildError();
        const vnodes: VirtualNode[] = specs.map((s, i) => ({
          hash: hashes[i],
          nodeId: s.nodeId,
          replica: s.replica,
        }));
        return Ring.create(version, vnodes);
      } catch (error) {
        if (myEpoch !== this.epoch) throw new StaleBuildError();
        throw error;
      }
    })();

    return { promise, cancel: () => controller.abort() };
  }
}
