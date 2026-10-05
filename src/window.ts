/**
 * Fixed-capacity sliding window over integer-valued events.
 *
 * The state is immutable: every mutating operation returns a new WindowState
 * and never touches the old one. The multiset of live values lives in a
 * persistent order-statistics tree, so arbitrary historical states remain
 * fully queryable (snapshots) at O(1) cost to keep around.
 */

import {
  Tree,
  insert,
  remove,
  size as treeSize,
  countOf as treeCountOf,
  rankOf as treeRankOf,
  kth as treeKth,
  toSortedArray as treeToSortedArray,
} from "./order-stats-tree.js";
import { Rational, quantileRank } from "./rational.js";

export interface WindowState {
  readonly capacity: number;
  /** Persistent order-statistics index over the live values. */
  readonly root: Tree;
  /** Live event ids in arrival order (oldest first). */
  readonly queue: readonly number[];
  /** Live event id -> current value. */
  readonly values: ReadonlyMap<number, number>;
}

export function createWindow(capacity: number): WindowState {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive safe integer, got ${capacity}`);
  }
  return { capacity, root: null, queue: [], values: new Map() };
}

export function size(state: WindowState): number {
  return treeSize(state.root);
}

export function has(state: WindowState, id: number): boolean {
  return state.values.has(id);
}

function rebuild(
  state: WindowState,
  root: Tree,
  queue: readonly number[],
  values: ReadonlyMap<number, number>,
): WindowState {
  return { capacity: state.capacity, root, queue, values };
}

/**
 * Append an event. When the window is full, the oldest event is evicted and
 * its value deleted from the index. Ids must be unique among live events.
 */
export function addEvent(state: WindowState, id: number, value: number): WindowState {
  if (!Number.isSafeInteger(id)) throw new RangeError(`id must be a safe integer, got ${id}`);
  if (state.values.has(id)) {
    throw new Error(`event id ${id} is already live in the window`);
  }
  let root = state.root;
  let queue: readonly number[] = state.queue;
  let values: ReadonlyMap<number, number> = state.values;
  if (queue.length >= state.capacity) {
    const evictedId = queue[0] as number;
    const evictedValue = values.get(evictedId) as number;
    root = remove(root, evictedValue);
    queue = queue.slice(1);
    const next = new Map(values);
    next.delete(evictedId);
    values = next;
  }
  root = insert(root, value);
  const nextValues = new Map(values);
  nextValues.set(id, value);
  return rebuild(state, root, [...queue, id], nextValues);
}

/**
 * Correct the value of a live event in place (its position in the sliding
 * order is unchanged). Correcting an unknown or already-evicted id fails.
 */
export function correctEvent(state: WindowState, id: number, value: number): WindowState {
  const old = state.values.get(id);
  if (old === undefined) {
    throw new Error(`cannot correct event ${id}: not live in the window`);
  }
  if (old === value) return state;
  const root = insert(remove(state.root, old), value);
  const values = new Map(state.values);
  values.set(id, value);
  return rebuild(state, root, state.queue, values);
}

/**
 * p-quantile of the live values: the element of rank ceil(p * n) in sorted
 * order (1-indexed); p = 0 yields the minimum. Returns null for an empty
 * window.
 */
export function quantile(state: WindowState, p: Rational): number | null {
  const n = treeSize(state.root);
  if (n === 0) return null;
  return treeKth(state.root, quantileRank(p, n));
}

/** Number of live elements strictly smaller than `value`. */
export function rankOf(state: WindowState, value: number): number {
  return treeRankOf(state.root, value);
}

/** Multiplicity of `value` among live elements. */
export function countOf(state: WindowState, value: number): number {
  return treeCountOf(state.root, value);
}

/** Sorted copy of the live values (duplicates repeated). */
export function toSortedArray(state: WindowState): number[] {
  return treeToSortedArray(state.root);
}
