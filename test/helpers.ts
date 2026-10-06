import { Change, ObjectState, SyncEngine } from "../src/index";

/** Deterministic PRNG so every "random" test is reproducible. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function shuffle<T>(items: T[], rand: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    const tmp = out[i]!;
    out[i] = out[j]!;
    out[j] = tmp;
  }
  return out;
}

/**
 * Build the canonical ordered stream: `keys` objects, each with a chain of
 * `chainLength` changes (versions 1..n, prev = version - 1), mixing puts
 * and deletes. Deletes are real chain links: the chain continues after them.
 */
export function makeStream(
  keys: number,
  chainLength: number,
  rand: () => number,
): Change<string>[] {
  const stream: Change<string>[] = [];
  for (let k = 0; k < keys; k++) {
    const key = `obj-${k}`;
    for (let v = 1; v <= chainLength; v++) {
      const isDelete = rand() < 0.25;
      stream.push(
        isDelete
          ? { key, version: v, prev: v - 1, op: "delete" }
          : { key, version: v, prev: v - 1, op: "put", value: `${key}@v${v}` },
      );
    }
  }
  return stream;
}

/**
 * Offer changes to the engine, retrying backpressured ones while progress
 * is possible. Returns the changes that could not be accepted yet (their
 * predecessors have not shown up); for a complete causal stream this is
 * always empty. Mirrors a sender that backs off and retries later.
 */
export function feed<V>(engine: SyncEngine<V>, changes: Change<V>[]): Change<V>[] {
  let remaining = [...changes];
  for (;;) {
    const retry: Change<V>[] = [];
    let progress = false;
    for (const change of remaining) {
      const status = engine.receive(change);
      if (status === "backpressure") {
        retry.push(change);
      } else if (status === "applied" || status === "buffered") {
        progress = true;
      } else {
        throw new Error(`unexpected status "${status}" for ${JSON.stringify(change)}`);
      }
    }
    if (retry.length === 0) return [];
    if (!progress) return retry;
    remaining = retry;
  }
}

/** Feed a complete causal stream: every change must eventually be accepted. */
export function feedComplete<V>(engine: SyncEngine<V>, changes: Change<V>[]): void {
  const leftover = feed(engine, changes);
  if (leftover.length > 0) {
    throw new Error(`complete stream left ${leftover.length} changes unaccepted`);
  }
}

/** Reference model: applies the canonical ordered stream directly. */
export class ReferenceModel<V> {
  private readonly state = new Map<string, ObjectState<V>>();
  private readonly cursors = new Map<string, number>();

  applyOrdered(stream: Change<V>[]): void {
    for (const change of stream) {
      if (change.op === "put") {
        this.state.set(change.key, {
          value: change.value as V,
          version: change.version,
        });
      } else {
        this.state.delete(change.key);
      }
      this.cursors.set(change.key, change.version);
    }
  }

  cursorOf(key: string): number {
    return this.cursors.get(key) ?? 0;
  }

  sortedState(): Array<readonly [string, ObjectState<V>]> {
    return [...this.state.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
  }

  keys(): string[] {
    return [...this.cursors.keys()].sort();
  }
}

export function engineState<V>(
  engine: SyncEngine<V>,
): Array<readonly [string, ObjectState<V>]> {
  return [...engine.entries()].sort(([a], [b]) => (a < b ? -1 : 1));
}
