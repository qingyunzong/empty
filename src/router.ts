import { Fnv1aAdapter, type HashAdapter } from './hash.js';
import { Ring, vnodeInputs, type NodeSpec } from './ring.js';

/** An immutable, published ring configuration. */
export interface RingVersion {
  readonly version: number;
  readonly nodes: readonly NodeSpec[];
  readonly ring: Ring;
}

interface InflightEntry {
  promise: Promise<number>;
  refs: number;
  controller: AbortController;
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

/**
 * A read cursor. It pins the ring version that was current when the cursor
 * was acquired, so it keeps routing with the old configuration even after
 * newer versions are published.
 */
export class Cursor {
  constructor(
    private readonly snapshot: RingVersion,
    private readonly adapter: HashAdapter,
  ) {}

  get version(): number {
    return this.snapshot.version;
  }

  get nodes(): readonly NodeSpec[] {
    return this.snapshot.nodes;
  }

  get ring(): Ring {
    return this.snapshot.ring;
  }

  async route(key: string): Promise<string | undefined> {
    const hash = await this.adapter.hash(key);
    return this.snapshot.ring.owner(hash);
  }

  async routeReplicas(key: string, count: number): Promise<string[]> {
    const hash = await this.adapter.hash(key);
    return this.snapshot.ring.owners(hash, count);
  }
}

/**
 * Versioned consistent-hash router.
 *
 * Every `setNodes` call (membership or weight change) builds a new ring
 * asynchronously and publishes it as a new version. A superseded build is
 * cancelled: its in-flight hash computations are aborted once no remaining
 * build references them, and its results can never enter a newer ring —
 * publication is guarded by the epoch counter.
 *
 * Hash computations are shared: concurrent builds requesting the same vnode
 * input share one underlying adapter call, and completed hashes are cached
 * (adapters are pure functions of their input).
 */
export class Router {
  private epoch = 0;
  private currentVersion: RingVersion = { version: 0, nodes: [], ring: new Ring([]) };
  private readonly cache = new Map<string, number>();
  private readonly inflight = new Map<string, InflightEntry>();
  private pending: AbortController | null = null;
  private lastBuild: Promise<void> = Promise.resolve();
  private lastError: unknown = null;

  constructor(private readonly adapter: HashAdapter = new Fnv1aAdapter()) {}

  get current(): RingVersion {
    return this.currentVersion;
  }

  acquireCursor(): Cursor {
    return new Cursor(this.currentVersion, this.adapter);
  }

  /** Start building a new ring version; returns its version number. */
  setNodes(nodes: readonly NodeSpec[]): number {
    this.epoch++;
    const epoch = this.epoch;
    const previous = this.pending;
    const controller = new AbortController();
    this.pending = controller;
    const snapshot = nodes
      .map((node) => ({ id: node.id, weight: node.weight }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    // Start the new build before cancelling the old one so that in-flight
    // hash computations shared by both stay alive (refcounted sharing).
    this.lastBuild = this.build(snapshot, epoch, controller.signal).then(
      (ring) => {
        if (ring !== null && epoch === this.epoch) {
          this.currentVersion = { version: epoch, nodes: snapshot, ring };
        }
      },
      (err: unknown) => {
        if (!isAbortError(err)) this.lastError = err;
      },
    );
    previous?.abort();
    return epoch;
  }

  /** Resolves once the latest build has settled; rethrows build failures. */
  async idle(): Promise<void> {
    for (;;) {
      const build = this.lastBuild;
      await build;
      if (build === this.lastBuild) break;
    }
    if (this.lastError !== null) {
      const err = this.lastError;
      this.lastError = null;
      throw err;
    }
  }

  private async build(nodes: NodeSpec[], epoch: number, signal: AbortSignal): Promise<Ring | null> {
    const inputs = vnodeInputs(nodes);
    const hashes = await Promise.all(inputs.map((vnode) => this.acquire(vnode.input, signal)));
    if (signal.aborted || epoch !== this.epoch) return null;
    return new Ring(
      inputs.map((vnode, i) => ({ hash: hashes[i], nodeId: vnode.nodeId, replicaIndex: vnode.replicaIndex })),
    );
  }

  /**
   * Hash one vnode input, sharing in-flight computations and caching
   * completed ones. The returned promise rejects with AbortError when
   * `signal` fires; the underlying computation is aborted only once its
   * last reference is released.
   */
  private acquire(input: string, signal: AbortSignal): Promise<number> {
    const cached = this.cache.get(input);
    if (cached !== undefined) return Promise.resolve(cached);

    let entry = this.inflight.get(input);
    if (entry === undefined) {
      const controller = new AbortController();
      const promise = Promise.resolve().then(() => this.adapter.hash(input, controller.signal));
      const created: InflightEntry = { promise, refs: 0, controller };
      this.inflight.set(input, created);
      promise.then(
        (hash) => {
          if (this.inflight.get(input) === created) {
            this.cache.set(input, hash);
            this.inflight.delete(input);
          }
        },
        () => {
          if (this.inflight.get(input) === created) this.inflight.delete(input);
        },
      );
      entry = created;
    }
    const current = entry;
    current.refs++;

    return new Promise<number>((resolve, reject) => {
      let settled = false;
      const release = (): void => {
        current.refs--;
        if (current.refs === 0 && this.inflight.get(input) === current) {
          // Last consumer gone and the computation is still in flight:
          // cancel the shared computation itself.
          this.inflight.delete(input);
          current.controller.abort();
        }
      };
      const onAbort = (): void => {
        if (settled) return;
        settled = true;
        release();
        reject(new DOMException(`hash computation for "${input}" was cancelled`, 'AbortError'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });
      current.promise.then(
        (hash) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release();
          resolve(hash);
        },
        (err: unknown) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener('abort', onAbort);
          release();
          reject(err);
        },
      );
    });
  }
}
