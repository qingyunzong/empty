import { Node, IdGen, Op } from './ast';

/** Deterministic seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const OPS: Op[] = ['add', 'sub', 'mul', 'div', 'mod'];
const VARS = ['a', 'b', 'c'];

function pick<T>(rand: () => number, xs: T[]): T {
  return xs[Math.floor(rand() * xs.length)];
}

function genLit(rand: () => number): bigint {
  if (rand() < 0.1) {
    // Occasionally large magnitudes to exercise big arithmetic.
    return BigInt(Math.floor(rand() * 2 ** 50)) * (rand() < 0.5 ? 1n : -1n);
  }
  return BigInt(Math.floor(rand() * 7) - 3); // -3..3, includes 0
}

/** Random small expression tree, depth-bounded. */
export function genTree(rand: () => number, ids: IdGen, depth: number): Node {
  if (depth <= 0) {
    return rand() < 0.6
      ? { kind: 'lit', id: ids.next(), value: genLit(rand) }
      : { kind: 'var', id: ids.next(), name: pick(rand, VARS) };
  }
  const r = rand();
  if (r < 0.18) return { kind: 'lit', id: ids.next(), value: genLit(rand) };
  if (r < 0.32) return { kind: 'var', id: ids.next(), name: pick(rand, VARS) };
  if (r < 0.68) {
    if (rand() < 0.35) {
      // Duplicate a subtree (fresh ids) to give CSE something to share.
      const sub = genTree(rand, ids, depth - 1);
      return {
        kind: 'bin', id: ids.next(), op: pick(rand, OPS),
        left: sub, right: cloneFresh(sub, ids),
      };
    }
    return {
      kind: 'bin', id: ids.next(), op: pick(rand, OPS),
      left: genTree(rand, ids, depth - 1), right: genTree(rand, ids, depth - 1),
    };
  }
  if (r < 0.84) return { kind: 'log', id: ids.next(), expr: genTree(rand, ids, depth - 1) };
  return {
    kind: 'if', id: ids.next(),
    cond: genTree(rand, ids, depth - 1),
    then: genTree(rand, ids, depth - 1),
    else: genTree(rand, ids, depth - 1),
  };
}

/** Random inputs for the fixed variable set. */
export function genInput(rand: () => number): Record<string, bigint> {
  const input: Record<string, bigint> = {};
  for (const name of VARS) input[name] = genLit(rand);
  return input;
}

/** Deep-copy a subtree, assigning fresh node ids. */
export function cloneFresh(node: Node, ids: IdGen): Node {
  const copy: Node = { ...node, id: ids.next() } as Node;
  switch (copy.kind) {
    case 'log': case 'bind': copy.expr = cloneFresh(copy.expr, ids); break;
    case 'bin':
      copy.left = cloneFresh(copy.left, ids);
      copy.right = cloneFresh(copy.right, ids);
      break;
    case 'if':
      copy.cond = cloneFresh(copy.cond, ids);
      copy.then = cloneFresh(copy.then, ids);
      copy.else = cloneFresh(copy.else, ids);
      break;
    default: break;
  }
  return copy;
}
