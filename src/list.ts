import {
  OpId,
  VersionVector,
  compareOpIds,
  isCausallyDominated,
  mergeVersionVectors,
  opIdToString,
} from './opid.js';
import { comparePositions, keyBetween } from './position.js';

/** Stable element ID. Never reused, never released by delete. */
export type ElementId = string;

/** A versioned position record: where an element sits, stamped by the op that put it there. */
export interface PositionRecord {
  readonly key: string;
  readonly version: OpId;
}

export interface DeleteRecord {
  readonly version: OpId;
  /** Causal knowledge of the deleting replica at delete time. */
  readonly causalContext: VersionVector;
}

/** Operations are the unit of synchronization between replicas. */
export type Op<T> =
  | { readonly kind: 'insert'; readonly id: OpId; readonly elementId: ElementId; readonly value: T; readonly key: string }
  | { readonly kind: 'move'; readonly id: OpId; readonly elementId: ElementId; readonly key: string }
  | { readonly kind: 'delete'; readonly id: OpId; readonly elementId: ElementId; readonly causalContext: VersionVector };

interface ElementState<T> {
  readonly id: ElementId;
  readonly value: T;
  position: PositionRecord;
  deleted: DeleteRecord | null;
}

function mergeDeleteRecords(a: DeleteRecord | null, b: DeleteRecord): DeleteRecord {
  if (a === null) return b;
  return {
    version: compareOpIds(a.version, b.version) >= 0 ? a.version : b.version,
    causalContext: mergeVersionVectors(a.causalContext, b.causalContext),
  };
}

/**
 * A convergent list CRDT.
 *
 * - Elements have stable IDs (the insert op's ID), never reused.
 * - Moves are versioned position records; the record with the greatest
 *   operation ID wins, so concurrent moves resolve deterministically.
 * - Deletes are tombstones: the ID is retained forever.
 * - A move causally dominated by a delete is dropped and can never
 *   resurrect the element.
 * - `apply` is idempotent and order-independent, so merging op streams in
 *   any order converges, and each element appears at most once.
 */
export class ListCRDT<T> {
  private readonly replica: string;
  private counter = 0;
  private readonly elements = new Map<ElementId, ElementState<T>>();
  private readonly pendingMoves = new Map<ElementId, PositionRecord[]>();
  private readonly pendingDeletes = new Map<ElementId, DeleteRecord[]>();
  private readonly maxSeen = new Map<string, number>();
  private readonly localOps: Op<T>[] = [];

  constructor(replicaId: string) {
    this.replica = replicaId;
  }

  // ------------------------------------------------------------------ queries

  /** Number of visible (non-deleted) elements. */
  get size(): number {
    return this.visibleStates().length;
  }

  /** Materialized list entries in order. Each element appears at most once. */
  entries(): { id: ElementId; value: T }[] {
    return this.visibleStates().map((el) => ({ id: el.id, value: el.value }));
  }

  toArray(): T[] {
    return this.entries().map((e) => e.value);
  }

  /** Value of a visible element, or undefined if unknown or deleted. */
  get(id: ElementId): T | undefined {
    const el = this.elements.get(id);
    return el && !el.deleted ? el.value : undefined;
  }

  /** True if the ID is known, including as a tombstone. */
  has(id: ElementId): boolean {
    return this.elements.has(id);
  }

  /** True if the element was deleted (tombstone retained, ID not released). */
  isDeleted(id: ElementId): boolean {
    return this.elements.get(id)?.deleted != null;
  }

  /** All known IDs, including tombstones. */
  knownIds(): ElementId[] {
    return [...this.elements.keys()];
  }

  /** Ops generated locally, in causal order — the payload to ship to peers. */
  getLocalOps(): readonly Op<T>[] {
    return this.localOps;
  }

  // --------------------------------------------------------------- mutations

  /** Insert `value` at `index` (default: end). Returns the new stable element ID. */
  insert(value: T, index?: number): ElementId {
    const id = this.nextOpId();
    const key = this.keyAt(index);
    const elementId = opIdToString(id);
    const op: Op<T> = { kind: 'insert', id, elementId, value, key };
    this.localOps.push(op);
    this.apply(op);
    return elementId;
  }

  /** Move a visible element to `index` in the list-without-itself. */
  move(elementId: ElementId, index: number): void {
    const el = this.elements.get(elementId);
    if (!el || el.deleted) {
      throw new Error(`cannot move unknown or deleted element: ${elementId}`);
    }
    const id = this.nextOpId();
    const key = this.keyAt(index, elementId);
    const op: Op<T> = { kind: 'move', id, elementId, key };
    this.localOps.push(op);
    this.apply(op);
  }

  /** Delete an element. The ID is tombstoned, never released. */
  delete(elementId: ElementId): void {
    const el = this.elements.get(elementId);
    if (!el || el.deleted) {
      throw new Error(`cannot delete unknown or deleted element: ${elementId}`);
    }
    const id = this.nextOpId();
    const causalContext: VersionVector = {};
    for (const [replica, counter] of this.maxSeen) causalContext[replica] = counter;
    const op: Op<T> = { kind: 'delete', id, elementId, causalContext };
    this.localOps.push(op);
    this.apply(op);
  }

  // ------------------------------------------------------------------ merge

  /** Merge one operation. Idempotent and safe to call in any order. */
  apply(op: Op<T>): void {
    this.observe(op.id);
    switch (op.kind) {
      case 'insert':
        this.applyInsert(op);
        break;
      case 'move':
        this.applyMove(op.elementId, { key: op.key, version: op.id });
        break;
      case 'delete':
        this.applyDelete(op.elementId, { version: op.id, causalContext: op.causalContext });
        break;
    }
  }

  /** Merge a batch of operations, in any order. */
  applyAll(ops: Iterable<Op<T>>): void {
    for (const op of ops) this.apply(op);
  }

  // ---------------------------------------------------------------- internals

  private nextOpId(): OpId {
    this.counter += 1;
    this.maxSeen.set(this.replica, this.counter);
    return { replica: this.replica, counter: this.counter };
  }

  private observe(id: OpId): void {
    const seen = this.maxSeen.get(id.replica) ?? 0;
    if (id.counter > seen) this.maxSeen.set(id.replica, id.counter);
  }

  private visibleStates(): ElementState<T>[] {
    const visible = [...this.elements.values()].filter((el) => !el.deleted);
    visible.sort((x, y) => comparePositions(x.position.key, x.id, y.position.key, y.id));
    return visible;
  }

  private keyAt(index?: number, exclude?: ElementId): string {
    const visible = this.visibleStates().filter((el) => el.id !== exclude);
    const i = index === undefined ? visible.length : Math.max(0, Math.min(index, visible.length));
    const prev = i > 0 ? visible[i - 1]!.position.key : null;
    const next = i < visible.length ? visible[i]!.position.key : null;
    return keyBetween(prev, next);
  }

  private applyInsert(op: Extract<Op<T>, { kind: 'insert' }>): void {
    if (this.elements.has(op.elementId)) return; // idempotent
    const state: ElementState<T> = {
      id: op.elementId,
      value: op.value,
      position: { key: op.key, version: op.id },
      deleted: null,
    };
    const deletes = this.pendingDeletes.get(op.elementId);
    if (deletes) {
      for (const d of deletes) state.deleted = mergeDeleteRecords(state.deleted, d);
      this.pendingDeletes.delete(op.elementId);
    }
    const moves = this.pendingMoves.get(op.elementId);
    if (moves) {
      for (const m of moves) this.considerMove(state, m);
      this.pendingMoves.delete(op.elementId);
    }
    this.elements.set(op.elementId, state);
  }

  private applyMove(elementId: ElementId, record: PositionRecord): void {
    const state = this.elements.get(elementId);
    if (!state) {
      // Out-of-order delivery: buffer until the insert arrives.
      const buf = this.pendingMoves.get(elementId) ?? [];
      if (!buf.some((r) => compareOpIds(r.version, record.version) === 0)) buf.push(record);
      this.pendingMoves.set(elementId, buf);
      return;
    }
    this.considerMove(state, record);
  }

  private considerMove(state: ElementState<T>, record: PositionRecord): void {
    // A move causally dominated by the delete is an "old move": it must not
    // resurrect (or even reposition) an element deleted causally after it.
    if (state.deleted && isCausallyDominated(record.version, state.deleted.causalContext)) return;
    // Concurrent position records: the greatest operation ID wins.
    if (compareOpIds(record.version, state.position.version) > 0) {
      state.position = record;
    }
  }

  private applyDelete(elementId: ElementId, record: DeleteRecord): void {
    const state = this.elements.get(elementId);
    if (!state) {
      // Out-of-order delivery: buffer until the insert arrives.
      const buf = this.pendingDeletes.get(elementId) ?? [];
      buf.push(record);
      this.pendingDeletes.set(elementId, buf);
      return;
    }
    state.deleted = mergeDeleteRecords(state.deleted, record);
  }
}
