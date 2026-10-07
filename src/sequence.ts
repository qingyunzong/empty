/**
 * Stable-cursor sequence.
 *
 * A `Sequence<T>` is an ordered list whose elements are addressed by stable,
 * generational IDs (`"<slot>:<generation>"`). Cursors traverse the sequence
 * by ID and are robust against concurrent structural mutation:
 *
 * - Deleting the cursor's current element moves the next `next()` call to the
 *   element's original successor (the deleted record is retained as a
 *   tombstone for as long as any cursor is anchored on it).
 * - Elements inserted before the cursor's position are never revisited;
 *   elements inserted after it are visited in order.
 * - A removed slot's ID may be reused, but only with a bumped generation, so
 *   stale IDs are detected and rejected.
 * - Closing a cursor releases the tombstone record it retains.
 *
 * Every observable step is reported as a `SequenceEvent`, so callers (and the
 * test-suite's tombstone-list model) can verify the exact event sequence.
 */

export type Id = string;

export type SequenceEvent<T> =
  | { type: "open"; cursor: number; anchor: Id | null }
  | { type: "visit"; cursor: number; id: Id; value: T }
  | { type: "end"; cursor: number }
  | { type: "close"; cursor: number; anchor: Id | null }
  | { type: "insert"; id: Id; value: T; before: Id | null }
  | { type: "remove"; id: Id }
  | { type: "unlink"; id: Id };

export type NextResult<T> =
  | { done: true }
  | { done: false; id: Id; value: T };

interface Rec<T> {
  slot: number;
  gen: number;
  value: T;
  alive: boolean;
  prev: Rec<T> | null;
  next: Rec<T> | null;
  /** Number of cursors currently anchored on this record. */
  refs: number;
}

const SENTINEL_SLOT = -1;

function parseId(id: Id): [slot: number, gen: number] {
  const m = /^(\d+):(\d+)$/.exec(id);
  if (!m) throw new Error(`malformed id: ${JSON.stringify(id)}`);
  return [Number(m[1]), Number(m[2])];
}

export class Sequence<T> {
  private readonly head: Rec<T>; // permanent sentinel, never unlinked
  private readonly live = new Map<number, Rec<T>>(); // slot -> live record
  private readonly gens: number[] = []; // slot -> current generation
  private readonly freeSlots: number[] = [];
  private nextSlot = 0;
  private cursorSeq = 0;
  private tombstoneCount = 0;
  private readonly emit: ((event: SequenceEvent<T>) => void) | undefined;

  constructor(options?: { onEvent?: (event: SequenceEvent<T>) => void }) {
    this.emit = options?.onEvent;
    this.head = {
      slot: SENTINEL_SLOT,
      gen: 0,
      value: undefined as T,
      alive: false,
      prev: null,
      next: null,
      refs: 0,
    };
  }

  /** Number of live elements. */
  get size(): number {
    return this.live.size;
  }

  /** Number of tombstone records retained by open cursors. */
  get tombstones(): number {
    return this.tombstoneCount;
  }

  /** IDs of live elements, in sequence order. */
  ids(): Id[] {
    const out: Id[] = [];
    for (let r = this.head.next; r; r = r.next) {
      if (r.alive) out.push(this.idOf(r));
    }
    return out;
  }

  /** Live element IDs and values, in sequence order. */
  entries(): Array<{ id: Id; value: T }> {
    const out: Array<{ id: Id; value: T }> = [];
    for (let r = this.head.next; r; r = r.next) {
      if (r.alive) out.push({ id: this.idOf(r), value: r.value });
    }
    return out;
  }

  /** True iff `id` refers to a currently live element. */
  isValid(id: Id): boolean {
    try {
      const [slot, gen] = parseId(id);
      return this.gens[slot] === gen && this.live.has(slot);
    } catch {
      return false;
    }
  }

  get(id: Id): T {
    return this.resolve(id).value;
  }

  append(value: T): Id {
    let last = this.head;
    while (last.next) last = last.next;
    return this.linkAfter(last, value);
  }

  insertAfter(id: Id, value: T): Id {
    return this.linkAfter(this.resolve(id), value);
  }

  insertBefore(id: Id, value: T): Id {
    const rec = this.resolve(id);
    return this.linkAfter(rec.prev!, value);
  }

  remove(id: Id): void {
    const rec = this.resolve(id);
    this.live.delete(rec.slot);
    this.freeSlots.push(rec.slot);
    rec.alive = false;
    rec.value = undefined as T;
    this.event({ type: "remove", id });
    if (rec.refs === 0) {
      // Not retained by any cursor: unlink immediately, no tombstone kept.
      this.unlink(rec);
    } else {
      this.tombstoneCount++;
    }
  }

  /**
   * Open a cursor. With no argument (or `null`) the cursor starts before the
   * first element; with an ID it starts on that element, so the following
   * `next()` returns its successor.
   */
  cursor(at?: Id | null): Cursor<T> {
    const anchor = at == null ? this.head : this.resolve(at);
    anchor.refs++;
    const cursor = new Cursor<T>(this, this.cursorSeq++, anchor);
    this.event({
      type: "open",
      cursor: cursor.cid,
      anchor: anchor.slot === SENTINEL_SLOT ? null : this.idOf(anchor),
    });
    return cursor;
  }

  /** @internal */
  idOf(rec: Rec<T>): Id {
    return `${rec.slot}:${rec.gen}`;
  }

  /** @internal */
  event(e: SequenceEvent<T>): void {
    this.emit?.(e);
  }

  /**
   * Advance `cursor`'s anchor from `from` to `to`, releasing the tombstone
   * record of `from` when the cursor was its last retainer.
   * @internal
   */
  moveAnchor(from: Rec<T>, to: Rec<T>): void {
    to.refs++;
    this.release(from);
  }

  /** @internal */
  release(rec: Rec<T>): void {
    rec.refs--;
    if (!rec.alive && rec.refs === 0 && rec.slot !== SENTINEL_SLOT) {
      this.tombstoneCount--;
      const id = this.idOf(rec);
      this.unlink(rec);
      this.event({ type: "unlink", id });
    }
  }

  private alloc(value: T): Rec<T> {
    const slot = this.freeSlots.length > 0 ? this.freeSlots.pop()! : this.nextSlot++;
    const gen = (this.gens[slot] ?? 0) + 1;
    this.gens[slot] = gen;
    const rec: Rec<T> = {
      slot,
      gen,
      value,
      alive: true,
      prev: null,
      next: null,
      refs: 0,
    };
    this.live.set(slot, rec);
    return rec;
  }

  private linkAfter(prev: Rec<T>, value: T): Id {
    const rec = this.alloc(value);
    rec.prev = prev;
    rec.next = prev.next;
    if (prev.next) prev.next.prev = rec;
    prev.next = rec;
    const id = this.idOf(rec);
    this.event({
      type: "insert",
      id,
      value,
      before: rec.next ? this.idOf(rec.next) : null,
    });
    return id;
  }

  private unlink(rec: Rec<T>): void {
    if (rec.prev) rec.prev.next = rec.next;
    if (rec.next) rec.next.prev = rec.prev;
    rec.prev = null;
    rec.next = null;
  }

  private resolve(id: Id): Rec<T> {
    const [slot, gen] = parseId(id);
    const rec = this.live.get(slot);
    if (!rec || this.gens[slot] !== gen) {
      throw new Error(`stale or unknown id: ${JSON.stringify(id)}`);
    }
    return rec;
  }
}

export class Cursor<T> {
  readonly cid: number;
  private readonly seq: Sequence<T>;
  private anchor: Rec<T>;
  private isClosed = false;

  /** @internal */
  constructor(seq: Sequence<T>, cid: number, anchor: Rec<T>) {
    this.seq = seq;
    this.cid = cid;
    this.anchor = anchor;
  }

  get closed(): boolean {
    return this.isClosed;
  }

  /**
   * Advance to the next live element after the cursor's position. If the
   * current element was deleted, its original successor (or anything inserted
   * ahead of it) is returned. Elements inserted behind the cursor are never
   * revisited.
   */
  next(): NextResult<T> {
    if (this.isClosed) throw new Error("cursor is closed");
    let rec = this.anchor.next;
    while (rec && !rec.alive) rec = rec.next;
    if (!rec) {
      this.seq.event({ type: "end", cursor: this.cid });
      return { done: true };
    }
    this.seq.moveAnchor(this.anchor, rec);
    this.anchor = rec;
    const id = this.seq.idOf(rec);
    this.seq.event({ type: "visit", cursor: this.cid, id, value: rec.value });
    return { done: false, id, value: rec.value };
  }

  /** Close the cursor, releasing the tombstone record it retains (if any). */
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    const anchor = this.anchor;
    this.seq.release(anchor);
    this.seq.event({
      type: "close",
      cursor: this.cid,
      anchor: anchor.slot === -1 ? null : this.seq.idOf(anchor),
    });
  }
}
