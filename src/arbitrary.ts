// Arbitraries: random generation + one-step shrinking + input contract.
//
// Invariants every Arbitrary must uphold:
//   - shrink(v) only emits values that satisfy contract()
//   - generate() only emits values that satisfy contract()
// The shrink engine additionally filters candidates through contract(),
// so every value ever tested (and the final minimal counterexample)
// satisfies the input contract.

import { Rng } from "./rng";

export interface Arbitrary<T> {
  generate(rng: Rng, size: number): T;
  shrink(value: T): T[];
  contract(value: T): boolean;
}

export function arbitrary<T>(
  generate: (rng: Rng, size: number) => T,
  shrink: (value: T) => T[],
  contract: (value: T) => boolean = () => true,
): Arbitrary<T> {
  return { generate, shrink, contract };
}

export class GenerationError extends Error {}

// ---------------------------------------------------------------- integers

export function integer(min: number, max: number): Arbitrary<number> {
  if (min > max) throw new Error(`integer: min ${min} > max ${max}`);
  const target = min <= 0 && max >= 0 ? 0 : min;
  return arbitrary(
    (rng) => rng.int(min, max),
    (v) => {
      if (!Number.isInteger(v) || v < min || v > max || v === target) return [];
      const out: number[] = [target];
      const delta = v - target;
      let half = Math.floor(Math.abs(delta) / 2);
      while (half >= 1) {
        out.push(v - Math.sign(delta) * half);
        half = Math.floor(half / 2);
      }
      return out.filter((x) => x !== v && x >= min && x <= max);
    },
    (v) => Number.isInteger(v) && v >= min && v <= max,
  );
}

// ------------------------------------------------------------------ arrays

export interface ArrayOptions {
  minLength?: number;
  maxLength?: number;
}

// Length-reduction candidates shared by arrays and operation histories.
export function shrinkSequence<T>(arr: T[], minLength: number): T[][] {
  const out: T[][] = [];
  const n = arr.length;
  if (n <= minLength) return out;
  out.push(arr.slice(0, minLength));
  let chunk = Math.max(1, Math.floor(n / 2));
  while (chunk >= 1) {
    for (let i = 0; i + chunk <= n; i += chunk) {
      const cand = arr.slice(0, i).concat(arr.slice(i + chunk));
      if (cand.length >= minLength) out.push(cand);
    }
    chunk = Math.floor(chunk / 2);
  }
  return out;
}

export function arrayOf<T>(
  elem: Arbitrary<T>,
  opts: ArrayOptions = {},
): Arbitrary<T[]> {
  const minLength = opts.minLength ?? 0;
  const maxLength = opts.maxLength ?? Number.MAX_SAFE_INTEGER;
  return arbitrary(
    (rng, size) => {
      const hi = Math.max(minLength, Math.min(maxLength, size));
      const n = rng.int(minLength, hi);
      const out: T[] = [];
      for (let i = 0; i < n; i++) out.push(elem.generate(rng, size));
      return out;
    },
    (arr) => {
      const out = shrinkSequence(arr, minLength);
      for (let i = 0; i < arr.length; i++) {
        for (const s of elem.shrink(arr[i])) {
          const cand = arr.slice();
          cand[i] = s;
          out.push(cand);
        }
      }
      return out;
    },
    (arr) =>
      Array.isArray(arr) &&
      arr.length >= minLength &&
      arr.length <= maxLength &&
      arr.every((x) => elem.contract(x)),
  );
}

// Sorted numeric sequences: the canonical example of a non-trivial input
// contract. Element shrinks that would break ordering are filtered out.
export function sortedArrayOf(
  elem: Arbitrary<number>,
  opts: ArrayOptions = {},
): Arbitrary<number[]> {
  const base = arrayOf(elem, opts);
  const isSorted = (a: number[]): boolean =>
    a.every((x, i) => i === 0 || a[i - 1] <= x);
  return arbitrary(
    (rng, size) => base.generate(rng, size).sort((a, b) => a - b),
    (arr) => base.shrink(arr).filter(isSorted),
    (arr) => base.contract(arr) && isSorted(arr),
  );
}

// ------------------------------------------------------------------- trees

export interface TreeNode<V> {
  value: V;
  children: TreeNode<V>[];
}

export interface TreeOptions {
  maxDepth: number;
  maxBranch: number;
}

export function treeOf<V>(
  leaf: Arbitrary<V>,
  opts: TreeOptions,
): Arbitrary<TreeNode<V>> {
  const { maxDepth, maxBranch } = opts;

  const make = (depth: number): Arbitrary<TreeNode<V>> =>
    arbitrary(
      (rng, size) => {
        const value = leaf.generate(rng, size);
        const children: TreeNode<V>[] = [];
        if (depth > 0) {
          const count = rng.int(0, maxBranch);
          for (let i = 0; i < count; i++) {
            children.push(make(depth - 1).generate(rng, size));
          }
        }
        return { value, children };
      },
      (node) => {
        const out: TreeNode<V>[] = [];
        // 1. collapse to a subtree
        for (const c of node.children) out.push(c);
        // 2. shrink the payload
        for (const s of leaf.shrink(node.value)) {
          out.push({ value: s, children: node.children });
        }
        // 3. shrink the child list (remove children, shrink grandchildren)
        if (depth > 0) {
          const childList = arrayOf(make(depth - 1), {
            minLength: 0,
            maxLength: maxBranch,
          });
          for (const cs of childList.shrink(node.children)) {
            out.push({ value: node.value, children: cs });
          }
        }
        return out;
      },
      (node) => treeContract(node, leaf, maxDepth, maxBranch, 0),
    );

  return make(maxDepth);
}

function treeContract<V>(
  node: TreeNode<V>,
  leaf: Arbitrary<V>,
  maxDepth: number,
  maxBranch: number,
  depth: number,
): boolean {
  if (depth > maxDepth) return false;
  if (!leaf.contract(node.value)) return false;
  if (!Array.isArray(node.children) || node.children.length > maxBranch) {
    return false;
  }
  return node.children.every((c) =>
    treeContract(c, leaf, maxDepth, maxBranch, depth + 1),
  );
}

// -------------------------------------------------------------- suchThat

export function suchThat<T>(
  arb: Arbitrary<T>,
  pred: (v: T) => boolean,
  maxTries = 100,
): Arbitrary<T> {
  return arbitrary(
    (rng, size) => {
      for (let i = 0; i < maxTries; i++) {
        const v = arb.generate(rng, size);
        if (pred(v)) return v;
      }
      throw new GenerationError(
        `suchThat: no satisfying value in ${maxTries} tries`,
      );
    },
    (v) => arb.shrink(v).filter(pred),
    (v) => arb.contract(v) && pred(v),
  );
}

// ---------------------------------------------------- operation histories

export interface Command<M, A> {
  name: string;
  args: Arbitrary<A>;
  precondition(model: M, args: A): boolean;
  next(model: M, args: A): M;
}

export interface Op {
  name: string;
  args: unknown;
}

export interface HistoryOptions {
  maxLength?: number;
  maxTriesPerOp?: number;
}

// Generates sequences of operations that are valid by construction:
// replaying them from the initial model never violates a precondition.
// Shrinking (op removal, argument shrinking) only emits sequences that
// remain replayable, so the input contract is preserved end to end.
export function historyOf<M>(
  commands: Command<M, any>[],
  initModel: () => M,
  opts: HistoryOptions = {},
): Arbitrary<Op[]> {
  const maxLength = opts.maxLength ?? 20;
  const maxTries = opts.maxTriesPerOp ?? 25;
  const byName = new Map<string, Command<M, any>>();
  for (const c of commands) byName.set(c.name, c);

  const replay = (ops: Op[]): M | null => {
    let model = initModel();
    for (const op of ops) {
      const cmd = byName.get(op.name);
      if (!cmd) return null;
      if (!cmd.precondition(model, op.args)) return null;
      model = cmd.next(model, op.args);
    }
    return model;
  };
  const valid = (ops: Op[]): boolean => replay(ops) !== null;

  return arbitrary(
    (rng, size) => {
      const ops: Op[] = [];
      let model = initModel();
      const target = rng.int(1, Math.max(1, Math.min(maxLength, size * 2)));
      for (let i = 0; i < target; i++) {
        let placed = false;
        for (let t = 0; t < maxTries && !placed; t++) {
          const cmd = commands[rng.int(0, commands.length - 1)];
          const args = cmd.args.generate(rng, size);
          if (cmd.precondition(model, args)) {
            ops.push({ name: cmd.name, args });
            model = cmd.next(model, args);
            placed = true;
          }
        }
        if (!placed) break;
      }
      return ops;
    },
    (ops) => {
      const out: Op[][] = shrinkSequence(ops, 0);
      for (let i = 0; i < ops.length; i++) {
        const cmd = byName.get(ops[i].name);
        if (!cmd) continue;
        for (const s of cmd.args.shrink(ops[i].args)) {
          const cand = ops.slice();
          cand[i] = { name: ops[i].name, args: s };
          out.push(cand);
        }
      }
      return out.filter(valid);
    },
    (ops) => Array.isArray(ops) && ops.length <= maxLength && valid(ops),
  );
}
