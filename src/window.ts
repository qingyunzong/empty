/**
 * Fixed-size sliding window over integer-valued events, kept as an immutable
 * (persistent) state object. Every operation returns a new state; the input
 * state is never mutated, so any previously returned state stays a readable
 * snapshot.
 */
import { Node, insert, remove, select, sizeOf, toArray } from './treap.js';
import { quantileRank } from './quantile.js';

export interface WindowState {
  readonly capacity: number;
  /** Event ids in arrival order, oldest first. */
  readonly order: readonly number[];
  /** eventId -> current value. */
  readonly values: ReadonlyMap<number, number>;
  /** Persistent order-statistics index over the values currently in the window. */
  readonly root: Node | undefined;
}

export function createWindow(capacity: number): WindowState {
  if (!Number.isSafeInteger(capacity) || capacity < 1) {
    throw new RangeError(`capacity must be a positive integer, got ${capacity}`);
  }
  return { capacity, order: [], values: new Map(), root: undefined };
}

export function size(state: WindowState): number {
  return sizeOf(state.root);
}

/** Add an event; when the window is full the oldest event is evicted first. */
export function addEvent(state: WindowState, eventId: number, value: number): WindowState {
  if (state.values.has(eventId)) {
    throw new Error(`duplicate event id ${eventId}`);
  }
  let { order, values, root } = state;
  if (order.length === state.capacity) {
    const oldest = order[0];
    root = remove(root, values.get(oldest)!);
    const next = new Map(values);
    next.delete(oldest);
    values = next;
    order = order.slice(1);
  }
  const nextValues = new Map(values);
  nextValues.set(eventId, value);
  return {
    capacity: state.capacity,
    order: [...order, eventId],
    values: nextValues,
    root: insert(root, value),
  };
}

/** Delete an event by id. Unknown ids are a no-op (same state returned). */
export function removeEvent(state: WindowState, eventId: number): WindowState {
  const value = state.values.get(eventId);
  if (value === undefined) return state;
  const values = new Map(state.values);
  values.delete(eventId);
  return {
    capacity: state.capacity,
    order: state.order.filter((id) => id !== eventId),
    values,
    root: remove(state.root, value),
  };
}

/**
 * Correct the value of an event by id. Unknown ids and no-op corrections
 * return the same state.
 */
export function correctEvent(state: WindowState, eventId: number, value: number): WindowState {
  const old = state.values.get(eventId);
  if (old === undefined || old === value) return state;
  const values = new Map(state.values);
  values.set(eventId, value);
  return {
    capacity: state.capacity,
    order: state.order,
    values,
    root: insert(remove(state.root, old), value),
  };
}

/**
 * Value at rank ceil(p*n) for rational p = pNum/pDen; p = 0 gives the
 * minimum. Returns null for an empty window.
 */
export function quantile(state: WindowState, pNum: number, pDen: number): number | null {
  const n = sizeOf(state.root);
  if (n === 0) return null;
  return select(state.root!, quantileRank(pNum, pDen, n));
}

/** Sorted contents of the window, duplicates expanded. */
export function toSortedArray(state: WindowState): number[] {
  return toArray(state.root);
}
