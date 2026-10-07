/**
 * Reference model: a tombstone linked list with deliberately simple,
 * obviously-correct semantics. The randomized differential test drives the
 * real `Sequence` and this model through identical operation streams and
 * requires identical event sequences, visit results and observable state.
 *
 * The model keeps its slots in a plain array; tombstones are retained
 * exactly while at least one model cursor is anchored on them, mirroring
 * the refcounting discipline of the implementation.
 */

import type { Id, NextResult, SequenceEvent } from "../src/sequence.ts";

interface MSlot<T> {
  slot: number;
  gen: number;
  id: Id;
  value: T;
  alive: boolean;
  refs: number;
}

const HEAD = Symbol("head");
type Anchor<T> = MSlot<T> | typeof HEAD;

export class Model<T> {
  /** @internal */
  slots: Array<MSlot<T>> = [];
  private readonly gens: number[] = [];
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private cursorSeq = 0;
  readonly events: Array<SequenceEvent<T>> = [];
  readonly cursors = new Map<number, ModelCursor<T>>();

  get size(): number {
    return this.slots.filter((s) => s.alive).length;
  }

  get tombstones(): number {
    return this.slots.filter((s) => !s.alive).length;
  }

  ids(): Id[] {
    return this.slots.filter((s) => s.alive).map((s) => s.id);
  }

  private alloc(value: T): MSlot<T> {
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.nextSlot++;
    const gen = (this.gens[slot] ?? 0) + 1;
    this.gens[slot] = gen;
    return { slot, gen, id: `${slot}:${gen}`, value, alive: true, refs: 0 };
  }

  private resolve(id: Id): MSlot<T> {
    const found = this.slots.find((s) => s.alive && s.id === id);
    if (!found) throw new Error(`stale or unknown id: ${JSON.stringify(id)}`);
    return found;
  }

  private insertAt(index: number, value: T): Id {
    const slot = this.alloc(value);
    this.slots.splice(index, 0, slot);
    const before = this.slots[index + 1]?.id ?? null;
    this.events.push({ type: "insert", id: slot.id, value, before });
    return slot.id;
  }

  append(value: T): Id {
    return this.insertAt(this.slots.length, value);
  }

  insertAfter(id: Id, value: T): Id {
    return this.insertAt(this.slots.indexOf(this.resolve(id)) + 1, value);
  }

  insertBefore(id: Id, value: T): Id {
    return this.insertAt(this.slots.indexOf(this.resolve(id)), value);
  }

  remove(id: Id): void {
    const slot = this.resolve(id);
    slot.alive = false;
    slot.value = undefined as T;
    this.freeSlots.push(slot.slot);
    this.events.push({ type: "remove", id });
    if (slot.refs === 0) {
      this.slots.splice(this.slots.indexOf(slot), 1);
    }
  }

  cursor(at?: Id | null): ModelCursor<T> {
    const anchor: Anchor<T> = at == null ? HEAD : this.resolve(at);
    if (anchor !== HEAD) anchor.refs++;
    const cid = this.cursorSeq++;
    const cursor = new ModelCursor<T>(this, cid, anchor);
    this.cursors.set(cid, cursor);
    this.events.push({
      type: "open",
      cursor: cid,
      anchor: anchor === HEAD ? null : anchor.id,
    });
    return cursor;
  }

  /** @internal */
  release(slot: MSlot<T>): void {
    slot.refs--;
    if (!slot.alive && slot.refs === 0) {
      this.slots.splice(this.slots.indexOf(slot), 1);
      this.events.push({ type: "unlink", id: slot.id });
    }
  }
}

export class ModelCursor<T> {
  private isClosed = false;

  /** @internal */
  constructor(
    private readonly model: Model<T>,
    readonly cid: number,
    private anchor: Anchor<T>,
  ) {}

  get closed(): boolean {
    return this.isClosed;
  }

  next(): NextResult<T> {
    if (this.isClosed) throw new Error("cursor is closed");
    const slots = this.model.slots;
    let i = this.anchor === HEAD ? -1 : slots.indexOf(this.anchor as MSlot<T>);
    i++;
    while (i < slots.length && !slots[i]!.alive) i++;
    if (i >= slots.length) {
      this.model.events.push({ type: "end", cursor: this.cid });
      return { done: true };
    }
    const to = slots[i]!;
    to.refs++;
    if (this.anchor !== HEAD) this.model.release(this.anchor as MSlot<T>);
    this.anchor = to;
    this.model.events.push({ type: "visit", cursor: this.cid, id: to.id, value: to.value });
    return { done: false, id: to.id, value: to.value };
  }

  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const anchor = this.anchor;
    if (anchor !== HEAD) this.model.release(anchor as MSlot<T>);
    this.model.events.push({
      type: "close",
      cursor: this.cid,
      anchor: anchor === HEAD ? null : (anchor as MSlot<T>).id,
    });
  }
}
