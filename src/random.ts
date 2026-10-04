import {
  Expr, BinOp,
  constExpr, varExpr, binExpr, logExpr, ifExpr, letExpr, cloneExpr,
  isPure, freeVars, countNodes,
} from './ast.js';

/** Deterministic seeded PRNG (mulberry32). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DUMMY_SPAN = { start: 0, end: 0 };

/**
 * Generate a random small expression tree. Pure, closed subtrees are pooled
 * and occasionally reused so that common subexpressions actually occur.
 * Division/modulo right-hand sides are biased toward small constants so
 * integer errors happen regularly.
 */
export function generate(rng: () => number, maxDepth = 4): Expr {
  const pool: Expr[] = [];
  let letCount = 0;

  const pick = <T>(arr: T[]): T => arr[Math.floor(rng() * arr.length)] as T;

  function gen(depth: number, env: string[]): Expr {
    if (depth <= 0 || rng() < 0.22) {
      if (env.length > 0 && rng() < 0.45) return varExpr(pick(env), DUMMY_SPAN);
      return constExpr(Math.floor(rng() * 10), DUMMY_SPAN);
    }
    if (pool.length > 0 && rng() < 0.25) {
      return cloneExpr(pick(pool));
    }
    const choice = rng();
    let node: Expr;
    if (choice < 0.55) {
      const op = pick(['+', '-', '*', '/', '%', '/', '%'] as BinOp[]);
      const left = gen(depth - 1, env);
      const right = (op === '/' || op === '%') && rng() < 0.4
        ? constExpr(Math.floor(rng() * 3), DUMMY_SPAN)
        : gen(depth - 1, env);
      node = binExpr(op, left, right, DUMMY_SPAN);
    } else if (choice < 0.7) {
      node = logExpr(gen(depth - 1, env), DUMMY_SPAN);
    } else if (choice < 0.85) {
      node = ifExpr(gen(depth - 1, env), gen(depth - 1, env), gen(depth - 1, env), DUMMY_SPAN);
    } else {
      const name = `v${letCount++}`;
      const value = gen(depth - 1, env);
      const body = gen(depth - 1, [...env, name]);
      node = letExpr(name, value, body, DUMMY_SPAN);
    }
    if (isPure(node) && freeVars(node).size === 0) {
      const size = countNodes(node);
      if (size >= 3 && size <= 12) pool.push(node);
    }
    return node;
  }

  return gen(maxDepth, []);
}
