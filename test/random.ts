/** Seeded PRNG + random object-graph and mutation-script generators. */

export type Rng = () => number;

export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(rng: Rng, items: readonly T[]): T {
  const v = items[Math.floor(rng() * items.length)];
  if (v === undefined) throw new Error("pick from empty list");
  return v;
}

const KEY_POOL = ["a", "b", "c", "d", "e", "name", "value", "next", "left", "right"];

function randomPrimitive(rng: Rng): string | number | boolean | null {
  switch (Math.floor(rng() * 5)) {
    case 0:
      return null;
    case 1:
      return Math.floor(rng() * 1000);
    case 2:
      return rng() < 0.5;
    case 3:
      return `s${Math.floor(rng() * 100)}`;
    default:
      return rng() < 0.5 ? 0 : 1;
  }
}

/**
 * Generate a random object graph with records, arrays, primitives,
 * shared references (aliases) and cycles.
 */
export function randomGraph(rng: Rng, nodeCount: number): Record<string, unknown> {
  const pool: object[] = [];
  for (let i = 0; i < nodeCount; i++) {
    pool.push(i > 0 && rng() < 0.25 ? [] : {});
  }
  const randomRef = (): unknown => {
    // Bias towards primitives so graphs stay finite and readable.
    if (rng() < 0.45) return randomPrimitive(rng);
    return pick(rng, pool);
  };
  for (const node of pool) {
    if (Array.isArray(node)) {
      const len = Math.floor(rng() * 4);
      for (let i = 0; i < len; i++) node.push(randomRef());
    } else {
      const rec = node as Record<string, unknown>;
      const keys = [...KEY_POOL].sort(() => rng() - 0.5);
      const fieldCount = Math.floor(rng() * 5);
      for (let i = 0; i < fieldCount; i++) {
        const key = keys[i];
        if (key !== undefined) rec[key] = randomRef();
      }
    }
  }
  const root = pool[0];
  if (root === undefined || Array.isArray(root)) {
    throw new Error("unreachable: pool[0] must be a record");
  }
  return root as Record<string, unknown>;
}

export type Mutation =
  | { readonly op: "set-primitive"; readonly target: number; readonly key: string }
  | { readonly op: "set-ref"; readonly target: number; readonly key: string; readonly to: number }
  | { readonly op: "delete"; readonly target: number; readonly key: string }
  | { readonly op: "add-object"; readonly target: number; readonly key: string };

/**
 * Generate a random mutation script over object indices (indices into the
 * deterministic BFS listing of a graph), so the same script can be replayed
 * on any structurally identical copy.
 */
export function randomMutations(rng: Rng, objectCount: number, count: number): Mutation[] {
  const out: Mutation[] = [];
  for (let i = 0; i < count; i++) {
    const target = Math.floor(rng() * objectCount);
    const key = pick(rng, KEY_POOL);
    switch (Math.floor(rng() * 4)) {
      case 0:
        out.push({ op: "set-primitive", target, key });
        break;
      case 1:
        out.push({ op: "set-ref", target, key, to: Math.floor(rng() * objectCount) });
        break;
      case 2:
        out.push({ op: "delete", target, key });
        break;
      default:
        out.push({ op: "add-object", target, key });
        break;
    }
  }
  return out;
}

/** Apply a mutation script to a graph given its BFS object listing. */
export function applyMutations(objects: object[], mutations: Mutation[], rng: Rng): void {
  for (const m of mutations) {
    const target = objects[m.target] as Record<string, unknown> | undefined;
    if (target === undefined || Array.isArray(target)) continue;
    switch (m.op) {
      case "set-primitive":
        target[m.key] = randomPrimitive(rng);
        break;
      case "set-ref": {
        const to = objects[m.to];
        if (to !== undefined) target[m.key] = to;
        break;
      }
      case "delete":
        delete target[m.key];
        break;
      case "add-object":
        target[m.key] = { fresh: Math.floor(rng() * 1000) };
        break;
    }
  }
}
