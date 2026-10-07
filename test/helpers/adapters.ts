import { Fnv1aAdapter, type HashAdapter } from '../../src/hash.js';
import { Ring, vnodeInputs, type NodeSpec } from '../../src/ring.js';
import { Gate } from './sync.js';

/** Every input hashes to the same value: total collision. */
export class ConstantAdapter implements HashAdapter {
  constructor(private readonly value: number) {}
  hash(): number {
    return this.value;
  }
}

/** Hashes land on a tiny set of values: heavy, deliberate collisions. */
export class FewValuesAdapter implements HashAdapter {
  private readonly fnv = new Fnv1aAdapter();
  constructor(private readonly values: number[]) {}
  hash(input: string): number {
    return this.values[this.fnv.hash(input) % this.values.length];
  }
}

/** Deterministic pseudo-random adapter, seeded for reproducibility. */
export function makeRandomAdapter(seed: number): HashAdapter {
  return {
    hash(input: string): number {
      let h = seed >>> 0;
      for (let i = 0; i < input.length; i++) {
        h ^= input.charCodeAt(i);
        h = Math.imul(h, 0x01000193);
        h ^= h >>> 13;
      }
      h = Math.imul(h ^ (h >>> 16), 0x45d9f3b);
      return (h ^ (h >>> 16)) >>> 0;
    },
  };
}

/**
 * Async adapter whose hash calls block on per-input gates until the test
 * opens them. Records every call and every observed abort signal.
 */
export class BlockingAdapter implements HashAdapter {
  readonly calls: string[] = [];
  readonly aborts: string[] = [];
  private readonly gates = new Map<string, Gate>();

  constructor(private readonly inner: (input: string) => number) {}

  hash(input: string, signal?: AbortSignal): Promise<number> {
    this.calls.push(input);
    signal?.addEventListener('abort', () => this.aborts.push(input), { once: true });
    return this.gateFor(input)
      .wait()
      .then(() => this.inner(input));
  }

  open(input?: string): void {
    if (input === undefined) {
      for (const gate of this.gates.values()) gate.open();
    } else {
      this.gateFor(input).open();
    }
  }

  private gateFor(input: string): Gate {
    let gate = this.gates.get(input);
    if (!gate) {
      gate = new Gate();
      this.gates.set(input, gate);
    }
    return gate;
  }
}

/** Build a ring synchronously straight from a hash function. */
export function buildRingSync(hashFn: (input: string) => number, nodes: readonly NodeSpec[]): Ring {
  const inputs = vnodeInputs(nodes);
  return new Ring(
    inputs.map((vnode) => ({
      hash: hashFn(vnode.input),
      nodeId: vnode.nodeId,
      replicaIndex: vnode.replicaIndex,
    })),
  );
}
