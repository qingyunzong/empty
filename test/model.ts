/**
 * Independent reference model used to cross-check FixtureStore:
 * a plain recursive deep copy plus a bijective structural equality that
 * validates the exact sharing topology (aliases and cycles) of two graphs.
 */

export function refDeepCopy<T>(root: T): T {
  const seen = new Map<object, unknown>();
  const walk = (v: unknown): unknown => {
    if (typeof v !== "object" || v === null) return v;
    const hit = seen.get(v);
    if (hit !== undefined) return hit;
    const copy: Record<string, unknown> = Array.isArray(v)
      ? ([] as unknown as Record<string, unknown>)
      : {};
    seen.set(v, copy);
    for (const k of Object.keys(v)) {
      copy[k] = walk((v as Record<string, unknown>)[k]);
    }
    return copy;
  };
  return walk(root) as T;
}

/**
 * Structural equality for cyclic graphs. Two graphs are equal only if their
 * sharing structure is isomorphic: aliased nodes on one side must map to
 * aliased nodes on the other (checked bijectively).
 */
export function refEqual(a: unknown, b: unknown): boolean {
  const fwd = new Map<object, object>();
  const bwd = new Map<object, object>();
  const walk = (x: unknown, y: unknown): boolean => {
    const xo = typeof x === "object" && x !== null;
    const yo = typeof y === "object" && y !== null;
    if (xo !== yo) return false;
    if (!xo || !yo) return Object.is(x, y);
    if (Array.isArray(x) !== Array.isArray(y)) return false;
    const mapped = fwd.get(x);
    if (mapped !== undefined) return mapped === y;
    if (bwd.has(y)) return false;
    fwd.set(x, y);
    bwd.set(y, x);
    const kx = Object.keys(x);
    const ky = Object.keys(y);
    if (kx.length !== ky.length) return false;
    if (Array.isArray(x) && (x as unknown[]).length !== (y as unknown[]).length) {
      return false;
    }
    for (const k of kx) {
      if (!Object.prototype.hasOwnProperty.call(y, k)) return false;
      if (
        !walk(
          (x as Record<string, unknown>)[k],
          (y as Record<string, unknown>)[k],
        )
      ) {
        return false;
      }
    }
    return true;
  };
  return walk(a, b);
}
/** Deterministic PRNG (mulberry32) so test runs are reproducible. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type AnyObj = Record<string, unknown>;

/**
 * Generate a random object graph with shared subobjects (aliases) and
 * cycles. Returns the root plus the flat list of reachable nodes (BFS order
 * from root) so tests can address nodes by index.
 */
export function randomGraph(rand: () => number): { root: AnyObj; nodes: AnyObj[] } {
  const nodeCount = 3 + Math.floor(rand() * 8);
  const pool: AnyObj[] = [];
  for (let i = 0; i < nodeCount; i++) {
    pool.push((rand() < 0.3 ? [] : {}) as AnyObj);
  }
  const root: AnyObj = {};
  pool.push(root);

  const scalar = (): unknown => {
    const r = rand();
    if (r < 0.25) return Math.floor(rand() * 100);
    if (r < 0.5) return `s${Math.floor(rand() * 1000)}`;
    if (r < 0.75) return rand() < 0.5;
    return null;
  };

  for (const node of pool) {
    const fieldCount = Math.floor(rand() * 5);
    for (let f = 0; f < fieldCount; f++) {
      const key = `k${Math.floor(rand() * 6)}`;
      if (rand() < 0.45) {
        node[key] = pool[Math.floor(rand() * pool.length)]; // alias or cycle
      } else {
        node[key] = scalar();
      }
    }
    if (Array.isArray(node)) {
      const n = Math.floor(rand() * 4);
      for (let i = 0; i < n; i++) {
        node.push(rand() < 0.5 ? scalar() : pool[Math.floor(rand() * pool.length)]);
      }
    }
  }

  return { root, nodes: collectNodes(root) };
}

/** Collect nodes reachable from root in deterministic BFS order. */
export function collectNodes(root: AnyObj): AnyObj[] {
  const reachable: AnyObj[] = [];
  const seen = new Set<object>();
  const queue: AnyObj[] = [root];
  while (queue.length > 0) {
    const node = queue.shift()!;
    if (seen.has(node)) continue;
    seen.add(node);
    reachable.push(node);
    for (const k of Object.keys(node)) {
      const v = node[k];
      if (typeof v === "object" && v !== null) queue.push(v as AnyObj);
    }
  }
  return reachable;
}

export type Edit =
  | { kind: "setScalar"; nodeIdx: number; key: string; value: unknown }
  | { kind: "setRef"; nodeIdx: number; key: string; targetIdx: number }
  | { kind: "setFresh"; nodeIdx: number; key: string }
  | { kind: "delete"; nodeIdx: number; key: string };

/**
 * Generate edits that are mutually non-conflicting across sides: `tag` makes
 * every introduced key unique to one side.
 */
export function randomEdits(
  rand: () => number,
  nodeCount: number,
  tag: string,
  count: number,
): Edit[] {
  const edits: Edit[] = [];
  for (let i = 0; i < count; i++) {
    const nodeIdx = Math.floor(rand() * nodeCount);
    const key = `${tag}${i}`;
    const r = rand();
    if (r < 0.4) {
      edits.push({ kind: "setScalar", nodeIdx, key, value: Math.floor(rand() * 1000) });
    } else if (r < 0.7) {
      edits.push({ kind: "setRef", nodeIdx, key, targetIdx: Math.floor(rand() * nodeCount) });
    } else {
      edits.push({ kind: "setFresh", nodeIdx, key });
    }
  }
  return edits;
}

/** Apply edits to a graph, resolving node indices against `nodes`. */
export function applyEdits(nodes: AnyObj[], edits: Edit[]): void {
  for (const edit of edits) {
    const node = nodes[edit.nodeIdx];
    switch (edit.kind) {
      case "setScalar":
        node[edit.key] = edit.value;
        break;
      case "setRef":
        node[edit.key] = nodes[edit.targetIdx];
        break;
      case "setFresh":
        node[edit.key] = { fresh: true, nested: { n: 1 } };
        break;
      case "delete":
        delete node[edit.key];
        break;
    }
  }
}
