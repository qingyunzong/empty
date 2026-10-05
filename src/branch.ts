/**
 * Branches, merges and conflicted corrections over the sliding window.
 *
 * A branch is a named, atomically-published pointer to an immutable state.
 * Publishing swaps a single reference (atomic in Node's single-threaded
 * event loop); every previously published state stays readable forever
 * because the underlying order-statistics index is persistent.
 *
 * Merging two branches that forked from the same base applies every
 * correction both sides agree on, and turns same-event/different-value
 * corrections into conflicts. While conflicts are unresolved, rank and
 * quantile queries report a certain part plus tight uncertain bounds.
 */

import {
  Tree,
  insert,
  remove,
  size as treeSize,
  rankOf as treeRankOf,
  kth as treeKth,
} from "./order-stats-tree.js";
import { Rational, quantileRank } from "./rational.js";
import {
  WindowState,
  addEvent,
  correctEvent,
  quantile as windowQuantile,
  rankOf as windowRankOf,
} from "./window.js";

export interface Conflict {
  readonly id: number;
  readonly leftValue: number;
  readonly rightValue: number;
}

export interface RankBounds {
  /** Elements certainly smaller than the query value. */
  readonly certain: number;
  /** Tight lower bound on the rank over all resolutions. */
  readonly low: number;
  /** Tight upper bound on the rank over all resolutions. */
  readonly high: number;
}

export interface QuantileBounds {
  readonly low: number | null;
  readonly high: number | null;
}

/**
 * A merged state with zero or more unresolved conflicts. Immutable: resolve()
 * returns a new view (or a final WindowState) and never mutates this one.
 */
export class MergedView {
  readonly kind = "merged" as const;
  readonly capacity: number;
  /** Live event order, identical on both merged sides. */
  readonly queue: readonly number[];
  /** Order-statistics index over certain (non-conflicted) values only. */
  readonly certainRoot: Tree;
  /** id -> value for events whose value is certain. */
  readonly certainValues: ReadonlyMap<number, number>;
  readonly conflicts: readonly Conflict[];

  constructor(
    capacity: number,
    queue: readonly number[],
    certainRoot: Tree,
    certainValues: ReadonlyMap<number, number>,
    conflicts: readonly Conflict[],
  ) {
    this.capacity = capacity;
    this.queue = queue;
    this.certainRoot = certainRoot;
    this.certainValues = certainValues;
    this.conflicts = conflicts;
  }

  /** Total number of live elements (certain + conflicted). */
  get size(): number {
    return treeSize(this.certainRoot) + this.conflicts.length;
  }

  conflictFor(id: number): Conflict | undefined {
    return this.conflicts.find((c) => c.id === id);
  }

  /**
   * Rank bounds for `value`: how many live elements are strictly smaller.
   * `certain` counts only certain elements; [low, high] additionally accounts
   * for every conflicted element depending on how it resolves.
   */
  rankOfBounds(value: number): RankBounds {
    const certain = treeRankOf(this.certainRoot, value);
    let low = certain;
    let high = certain;
    for (const c of this.conflicts) {
      const leftLess = c.leftValue < value;
      const rightLess = c.rightValue < value;
      if (leftLess && rightLess) {
        low += 1;
        high += 1;
      } else if (leftLess || rightLess) {
        high += 1;
      }
    }
    return { certain, low, high };
  }

  /**
   * Bounds on the p-quantile value over all resolutions. The rank
   * ceil(p * n) is resolution-independent (n is fixed), and the k-th order
   * statistic is monotone in each element, so the extremes are attained when
   * every conflict takes its smaller (resp. larger) side. Empty window
   * yields { low: null, high: null }.
   */
  quantileBounds(p: Rational): QuantileBounds {
    const n = this.size;
    if (n === 0) return { low: null, high: null };
    const rank = quantileRank(p, n);
    let loTree = this.certainRoot;
    let hiTree = this.certainRoot;
    for (const c of this.conflicts) {
      loTree = insert(loTree, Math.min(c.leftValue, c.rightValue));
      hiTree = insert(hiTree, Math.max(c.leftValue, c.rightValue));
    }
    return { low: treeKth(loTree, rank), high: treeKth(hiTree, rank) };
  }

  /**
   * Resolve one conflict by choosing a side. Returns a new MergedView, or
   * the final WindowState when this was the last conflict. This view is
   * left untouched.
   */
  resolve(id: number, choice: "left" | "right"): MergedView | WindowState {
    const conflict = this.conflictFor(id);
    if (conflict === undefined) {
      throw new Error(`no unresolved conflict for event ${id}`);
    }
    const chosen = choice === "left" ? conflict.leftValue : conflict.rightValue;
    const certainRoot = insert(this.certainRoot, chosen);
    const certainValues = new Map(this.certainValues);
    certainValues.set(id, chosen);
    const conflicts = this.conflicts.filter((c) => c.id !== id);
    if (conflicts.length === 0) {
      return {
        capacity: this.capacity,
        root: certainRoot,
        queue: this.queue,
        values: certainValues,
      };
    }
    return new MergedView(this.capacity, this.queue, certainRoot, certainValues, conflicts);
  }

  /** All 2^k fully resolved window states (k = number of conflicts). */
  enumerateResolutions(): WindowState[] {
    const out: WindowState[] = [];
    const walk = (view: MergedView, index: number, root: Tree, values: Map<number, number>): void => {
      if (index === view.conflicts.length) {
        out.push({ capacity: view.capacity, root, queue: view.queue, values });
        return;
      }
      const c = view.conflicts[index] as Conflict;
      for (const v of [c.leftValue, c.rightValue]) {
        const nextValues = new Map(values);
        nextValues.set(c.id, v);
        walk(view, index + 1, insert(root, v), nextValues);
      }
    };
    walk(this, 0, this.certainRoot, new Map(this.certainValues));
    return out;
  }
}

export type BranchState = WindowState | MergedView;

export function isMergedView(state: BranchState): state is MergedView {
  return state instanceof MergedView;
}

export class Branch {
  readonly name: string;
  /** Fork point shared with sibling branches; null for a root branch. */
  readonly base: WindowState | null;
  /** True when this branch was forked and may only apply corrections. */
  readonly correctionOnly: boolean;
  /** Number of atomic publishes so far. */
  version = 0;
  private current: BranchState;

  constructor(name: string, initial: BranchState, base: WindowState | null, correctionOnly: boolean) {
    this.name = name;
    this.current = initial;
    this.base = base;
    this.correctionOnly = correctionOnly;
  }

  get state(): BranchState {
    return this.current;
  }

  /** Atomically publish a new state; previously read states stay valid. */
  publish(next: BranchState): void {
    this.current = next;
    this.version += 1;
  }
}

/**
 * Corrections applied between `base` and `state`, as id -> new value.
 * Throws when the branch evolved by anything other than corrections
 * (adds/evictions change the live queue and are not mergeable).
 */
function correctionDiff(base: WindowState, state: WindowState): Map<number, number> {
  const sameQueue =
    state.capacity === base.capacity &&
    state.queue.length === base.queue.length &&
    state.queue.every((id, i) => id === base.queue[i]);
  if (!sameQueue) {
    throw new Error(
      "cannot merge: a branch added or evicted events since the fork point; " +
        "only corrections are mergeable",
    );
  }
  const diff = new Map<number, number>();
  for (const [id, value] of state.values) {
    if (base.values.get(id) !== value) diff.set(id, value);
  }
  return diff;
}

/** Merge two resolved window states that share `base`. Never mutates inputs. */
export function mergeWindows(
  base: WindowState,
  left: WindowState,
  right: WindowState,
): WindowState | MergedView {
  const leftDiff = correctionDiff(base, left);
  const rightDiff = correctionDiff(base, right);
  let root = base.root;
  const values = new Map(base.values);
  const conflicts: Conflict[] = [];
  const ids = new Set<number>([...leftDiff.keys(), ...rightDiff.keys()]);
  for (const id of ids) {
    const inLeft = leftDiff.has(id);
    const inRight = rightDiff.has(id);
    const baseValue = base.values.get(id) as number;
    if (inLeft && inRight) {
      const lv = leftDiff.get(id) as number;
      const rv = rightDiff.get(id) as number;
      if (lv === rv) {
        root = insert(remove(root, baseValue), lv);
        values.set(id, lv);
      } else {
        // Same event, different corrections on the two sides: conflict.
        // The event's contribution leaves the certain index entirely.
        root = remove(root, baseValue);
        values.delete(id);
        conflicts.push({ id, leftValue: lv, rightValue: rv });
      }
    } else {
      const v = (inLeft ? leftDiff.get(id) : rightDiff.get(id)) as number;
      root = insert(remove(root, baseValue), v);
      values.set(id, v);
    }
  }
  if (conflicts.length === 0) {
    return { capacity: base.capacity, root, queue: base.queue, values };
  }
  return new MergedView(base.capacity, base.queue, root, values, conflicts);
}

export class StatsStore {
  private readonly branches = new Map<string, Branch>();

  private require(name: string): Branch {
    const branch = this.branches.get(name);
    if (branch === undefined) throw new Error(`unknown branch "${name}"`);
    return branch;
  }

  /** Create a root branch holding a fresh empty window. */
  createWindowBranch(name: string, capacity: number): Branch {
    if (this.branches.has(name)) throw new Error(`branch "${name}" already exists`);
    const state: WindowState = {
      capacity,
      root: null,
      queue: [],
      values: new Map(),
    };
    const branch = new Branch(name, state, null, false);
    this.branches.set(name, branch);
    return branch;
  }

  /** Fork a correction-only branch off another branch's current state. */
  fork(name: string, fromName: string): Branch {
    if (this.branches.has(name)) throw new Error(`branch "${name}" already exists`);
    const from = this.require(fromName);
    if (isMergedView(from.state)) {
      throw new Error(`cannot fork "${fromName}": it has unresolved conflicts`);
    }
    const base = from.state;
    const branch = new Branch(name, base, base, true);
    this.branches.set(name, branch);
    return branch;
  }

  getBranch(name: string): Branch {
    return this.require(name);
  }

  /** Current state of a branch; the returned object stays valid forever. */
  snapshot(name: string): BranchState {
    return this.require(name).state;
  }

  addEvent(name: string, id: number, value: number): void {
    const branch = this.require(name);
    if (branch.correctionOnly) {
      throw new Error(`branch "${name}" is a fork and only accepts corrections`);
    }
    if (isMergedView(branch.state)) {
      throw new Error(`branch "${name}" has unresolved conflicts; resolve them first`);
    }
    branch.publish(addEvent(branch.state, id, value));
  }

  correctEvent(name: string, id: number, value: number): void {
    const branch = this.require(name);
    if (isMergedView(branch.state)) {
      throw new Error(`branch "${name}" has unresolved conflicts; resolve them first`);
    }
    branch.publish(correctEvent(branch.state, id, value));
  }

  /**
   * Merge two branches that were forked from the same state and publish the
   * result to `name` (created or replaced). Conflicting corrections stay
   * unresolved in the published MergedView.
   */
  merge(name: string, leftName: string, rightName: string): Branch {
    const left = this.require(leftName);
    const right = this.require(rightName);
    if (left.base === null || left.base !== right.base) {
      throw new Error(`branches "${leftName}" and "${rightName}" do not share a fork point`);
    }
    if (isMergedView(left.state) || isMergedView(right.state)) {
      throw new Error("cannot merge a branch that itself has unresolved conflicts");
    }
    const merged = mergeWindows(left.base, left.state, right.state);
    let branch = this.branches.get(name);
    if (branch === undefined) {
      branch = new Branch(name, merged, left.base, true);
      this.branches.set(name, branch);
    } else {
      branch.publish(merged);
    }
    return branch;
  }

  /**
   * Resolve one conflict on a merged branch and atomically publish the
   * result. When it was the last conflict the branch becomes a plain
   * resolved window. Snapshots taken before the call remain readable.
   */
  resolveConflict(name: string, id: number, choice: "left" | "right"): void {
    const branch = this.require(name);
    if (!isMergedView(branch.state)) {
      throw new Error(`branch "${name}" has no unresolved conflicts`);
    }
    branch.publish(branch.state.resolve(id, choice));
  }

  /**
   * p-quantile of a branch. Returns a plain value (null when empty) for a
   * resolved branch, or tight { low, high } bounds while conflicts are
   * unresolved.
   */
  quantile(name: string, p: Rational): number | null | QuantileBounds {
    const state = this.require(name).state;
    return isMergedView(state) ? state.quantileBounds(p) : windowQuantile(state, p);
  }

  /**
   * Rank of `value` (number of live elements strictly smaller). Returns a
   * plain number for a resolved branch, or a certain part plus tight
   * [low, high] bounds while conflicts are unresolved.
   */
  rankOf(name: string, value: number): number | RankBounds {
    const state = this.require(name).state;
    return isMergedView(state) ? state.rankOfBounds(value) : windowRankOf(state, value);
  }
}
