/**
 * A convergent (CRDT-style) ordered list.
 *
 * - Elements have stable IDs that are never reused; deletion leaves a
 *   tombstone and never frees the ID.
 * - Moves are expressed as versioned position records: `{ version, frac }`
 *   where `version` is a Lamport-style operation ID and `frac` is a dense
 *   fractional index key. Only the highest-version record wins.
 * - A delete records the causal frontier of move versions it observed
 *   (`seenMoves`). A move that is causally older than a delete of the same
 *   element can never resurrect it; a move concurrent with a delete wins.
 * - Concurrent moves are resolved deterministically by operation ID
 *   (highest `(clock, replica)` wins) on every replica.
 * - Operations may arrive out of order and may be re-applied; every replica
 *   that applies the same set of operations converges to the same list, and
 *   each element appears at most once.
 */

import { fracBetween } from "./fraction.js";

export type ReplicaId = string;
export type ElementId = string;

/** Lamport-style operation ID; also the version of a position record. */
export interface OpId {
  clock: number;
  replica: ReplicaId;
}

/** A versioned position record produced by a move (or the initial insert). */
export interface PositionRecord {
  version: OpId;
  frac: string;
}

export type Op =
  | InsertOp
  | MoveOp
  | DeleteOp;

export interface InsertOp {
  kind: "insert";
  id: ElementId;
  value: unknown;
  at: PositionRecord;
}

export interface MoveOp {
  kind: "move";
  id: ElementId;
  at: PositionRecord;
}

export interface DeleteOp {
  kind: "delete";
  id: ElementId;
  opId: OpId;
  /** Move versions the deleter had observed: the delete's causal frontier. */
  seenMoves: OpId[];
}

export interface Entry<T = unknown> {
  id: ElementId;
  value: T;
}

export function opIdKey(id: OpId): string {
  return `${id.clock}:${id.replica}`;
}

/** Total order on operation IDs: Lamport clock, then replica name. */
export function compareOpId(a: OpId, b: OpId): number {
  if (a.clock !== b.clock) return a.clock - b.clock;
  return a.replica < b.replica ? -1 : a.replica > b.replica ? 1 : 0;
}

interface DeleteRecord {
  opId: OpId;
  /** Move versions this delete causally observed (its frontier). */
  seenMoves: Set<string>;
}

interface ElementState {
  value: unknown;
  inserted: boolean;
  /** Highest-version position record applied so far. */
  winner: PositionRecord | undefined;
  /** Every move version ever applied locally (delete causal context). */
  seenMoves: Set<string>;
  /** Tombstones; deletes never remove state and never free the ID. */
  deletes: DeleteRecord[];
}

export class CrdtList<T = unknown> {
  private readonly replica: ReplicaId;
  private clock = 0;
  private counter = 0;
  private readonly elements = new Map<ElementId, ElementState>();
  private readonly oplog: Op[] = [];

  constructor(replica: ReplicaId) {
    this.replica = replica;
  }

  // ---------------------------------------------------------------- local ops

  /** Insert `value` at `index` (default: end). Returns the new ID and op. */
  insert(value: T, index?: number): { id: ElementId; op: InsertOp } {
    const id: ElementId = `${this.replica}#${this.counter++}`;
    const at = this.mintPosition(undefined, index);
    const op: InsertOp = { kind: "insert", id, value, at };
    this.apply(op);
    return { id, op };
  }

  /** Move an existing element to `index` (default: end). */
  move(id: ElementId, index?: number): MoveOp {
    const state = this.requireState(id);
    if (!state.inserted) throw new Error(`unknown element: ${id}`);
    const at = this.mintPosition(id, index);
    const op: MoveOp = { kind: "move", id, at };
    this.apply(op);
    return op;
  }

  /** Delete an element. The ID stays reserved forever (tombstone). */
  delete(id: ElementId): DeleteOp {
    const state = this.requireState(id);
    if (!state.inserted) throw new Error(`unknown element: ${id}`);
    const op: DeleteOp = {
      kind: "delete",
      id,
      opId: this.tick(),
      seenMoves: [...state.seenMoves].map(parseOpIdKey),
    };
    this.apply(op);
    return op;
  }

  // --------------------------------------------------------------- merging

  /**
   * Apply an operation in any order. Returns true if it changed local
   * state. Idempotent: re-applying the same op returns false.
   */
  apply(op: Op): boolean {
    if (this.applyInner(op)) {
      this.oplog.push(op);
      return true;
    }
    return false;
  }

  private applyInner(op: Op): boolean {
    switch (op.kind) {
      case "insert": {
        const state = this.stateFor(op.id);
        this.observe(op.at.version.clock);
        const moved = this.applyPosition(state, op.at);
        if (!state.inserted) {
          state.inserted = true;
          state.value = op.value;
          return true;
        }
        return moved;
      }
      case "move": {
        const state = this.stateFor(op.id);
        this.observe(op.at.version.clock);
        return this.applyPosition(state, op.at);
      }
      case "delete": {
        const state = this.stateFor(op.id);
        this.observe(op.opId.clock);
        const key = opIdKey(op.opId);
        if (state.deletes.some((d) => opIdKey(d.opId) === key)) return false;
        state.deletes.push({
          opId: op.opId,
          seenMoves: new Set(op.seenMoves.map(opIdKey)),
        });
        return true;
      }
    }
  }

  /** Apply a batch of ops in any order. Returns how many changed state. */
  merge(ops: Iterable<Op>): number {
    let accepted = 0;
    for (const op of ops) if (this.apply(op)) accepted++;
    return accepted;
  }

  /** Every op this replica has issued or accepted, in arrival order. */
  ops(): readonly Op[] {
    return this.oplog;
  }

  // ---------------------------------------------------------------- queries

  /** Materialized list order: one entry per live element, at most once. */
  entries(): Entry<T>[] {
    return this.visibleStates().map(([id, s]) => ({ id, value: s.value as T }));
  }

  values(): T[] {
    return this.entries().map((e) => e.value);
  }

  ids(): ElementId[] {
    return this.entries().map((e) => e.id);
  }

  /** True if the ID is reserved (known), even if currently deleted. */
  has(id: ElementId): boolean {
    return this.elements.has(id);
  }

  /** True if the element is currently live (inserted and not deleted). */
  isLive(id: ElementId): boolean {
    const s = this.elements.get(id);
    return s !== undefined && s.inserted && !this.isDeleted(s);
  }

  get size(): number {
    return this.visibleStates().length;
  }

  // -------------------------------------------------------------- internals

  private tick(): OpId {
    this.clock++;
    return { clock: this.clock, replica: this.replica };
  }

  private observe(clock: number): void {
    if (clock > this.clock) this.clock = clock;
  }

  private stateFor(id: ElementId): ElementState {
    let s = this.elements.get(id);
    if (!s) {
      s = {
        value: undefined,
        inserted: false,
        winner: undefined,
        seenMoves: new Set(),
        deletes: [],
      };
      this.elements.set(id, s);
    }
    return s;
  }

  private requireState(id: ElementId): ElementState {
    const s = this.elements.get(id);
    if (!s) throw new Error(`unknown element: ${id}`);
    return s;
  }

  private applyPosition(state: ElementState, at: PositionRecord): boolean {
    const key = opIdKey(at.version);
    if (state.seenMoves.has(key)) return false; // already applied
    state.seenMoves.add(key);
    if (state.winner === undefined || compareOpId(at.version, state.winner.version) > 0) {
      state.winner = at;
    }
    return true;
  }

  /**
   * An element is deleted iff some tombstone causally observed the
   * currently winning position record. Moves concurrent with every
   * tombstone (not in any `seenMoves`) keep the element alive.
   */
  private isDeleted(state: ElementState): boolean {
    if (state.winner === undefined) return false;
    const w = opIdKey(state.winner.version);
    return state.deletes.some((d) => d.seenMoves.has(w));
  }

  private visibleStates(): [ElementId, ElementState][] {
    const out: [ElementId, ElementState][] = [];
    for (const [id, s] of this.elements) {
      if (s.inserted && s.winner !== undefined && !this.isDeleted(s)) {
        out.push([id, s]);
      }
    }
    out.sort((x, y) => {
      const a = x[1].winner!;
      const b = y[1].winner!;
      if (a.frac !== b.frac) return a.frac < b.frac ? -1 : 1;
      return compareOpId(a.version, b.version);
    });
    return out;
  }

  /** Mint a fresh versioned position record for a move to `index`. */
  private mintPosition(exclude: ElementId | undefined, index?: number): PositionRecord {
    const visible = this.visibleStates()
      .filter(([id]) => id !== exclude)
      .map(([, s]) => s.winner!.frac);
    const i = Math.max(0, Math.min(index ?? visible.length, visible.length));
    const left = i > 0 ? visible[i - 1]! : "";
    let right = i < visible.length ? visible[i]! : "";
    // Concurrent inserts can mint identical fracs; if both neighbours share
    // one, there is no key strictly between them — mint after the run instead.
    if (left !== "" && left === right) right = "";
    return { version: this.tick(), frac: fracBetween(left, right) };
  }
}

function parseOpIdKey(key: string): OpId {
  const sep = key.indexOf(":");
  return { clock: Number(key.slice(0, sep)), replica: key.slice(sep + 1) };
}
