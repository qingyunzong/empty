/**
 * 稳定 ID 序列库。
 *
 * 核心语义：
 * - 每个元素拥有稳定 ID（槽位号）+ 代际（generation）组成的句柄。
 * - 删除是逻辑删除（墓碑）：只要仍有游标保留该记录，记录就留在链表中，
 *   保证“删除当前项后 next() 到达原后继”。
 * - 游标位置 = 锚点记录之后。插入到锚点之前（含锚点处）不会被重访；
 *   插入到锚点之后会被后续 next() 访问。
 * - 墓碑在保留计数归零时被摘除并回收槽位；槽位再用时代际 +1，
 *   旧代际句柄一律失效。
 * - 游标 close() 释放其保留的记录，可能触发延迟的回收。
 * - 所有结构变化都会追加到事件日志，可与墓碑链表模型逐条核验。
 */

export interface Handle {
  /** 稳定槽位 ID */
  readonly id: number;
  /** 代际：同一 id 每次复用都会递增 */
  readonly gen: number;
}

type DistributiveOmit<T, K extends keyof T> = T extends unknown
  ? Omit<T, K>
  : never;

export type SeqEvent =
  | { readonly seq: number; readonly type: "insert"; readonly id: number; readonly gen: number }
  | { readonly seq: number; readonly type: "delete"; readonly id: number; readonly gen: number }
  | { readonly seq: number; readonly type: "recycle"; readonly id: number; readonly gen: number }
  | { readonly seq: number; readonly type: "cursor-open"; readonly cursor: number }
  | { readonly seq: number; readonly type: "cursor-close"; readonly cursor: number };

interface Slot<T> {
  readonly id: number;
  gen: number;
  value: T;
  prev: Slot<T> | null;
  next: Slot<T> | null;
  deleted: boolean;
  retained: number;
}

export class SequenceStore<T> {
  private slots: Array<Slot<T> | null> = [];
  private nextGens: number[] = [];
  private freeList: number[] = [];
  private headSlot: Slot<T> | null = null;
  private tailSlot: Slot<T> | null = null;
  private liveCount = 0;
  private eventSeq = 0;
  private cursorSeq = 0;
  readonly events: SeqEvent[] = [];

  get size(): number {
    return this.liveCount;
  }

  private emit(event: DistributiveOmit<SeqEvent, "seq">): void {
    this.events.push({ seq: this.eventSeq++, ...event } as SeqEvent);
  }

  private resolve(handle: Handle): Slot<T> {
    const slot = this.slots[handle.id];
    if (!slot || slot.gen !== handle.gen || slot.deleted) {
      throw new RangeError(
        `stale handle: id=${handle.id} gen=${handle.gen}`,
      );
    }
    return slot;
  }

  /** 句柄是否指向一个存活元素 */
  has(handle: Handle): boolean {
    const slot = this.slots[handle.id];
    return !!slot && slot.gen === handle.gen && !slot.deleted;
  }

  /** 读取存活元素的值；句柄失效返回 undefined */
  get(handle: Handle): T | undefined {
    const slot = this.slots[handle.id];
    if (!slot || slot.gen !== handle.gen || slot.deleted) return undefined;
    return slot.value;
  }

  private allocate(value: T): Slot<T> {
    let id: number;
    if (this.freeList.length > 0) {
      id = this.freeList.pop()!;
    } else {
      id = this.slots.length;
      this.slots.push(null);
      this.nextGens.push(1);
    }
    const slot: Slot<T> = {
      id,
      gen: this.nextGens[id]!,
      value,
      prev: null,
      next: null,
      deleted: false,
      retained: 0,
    };
    this.slots[id] = slot;
    return slot;
  }

  private linkBetween(
    slot: Slot<T>,
    prev: Slot<T> | null,
    next: Slot<T> | null,
  ): void {
    slot.prev = prev;
    slot.next = next;
    if (prev) prev.next = slot;
    else this.headSlot = slot;
    if (next) next.prev = slot;
    else this.tailSlot = slot;
    this.liveCount++;
    this.emit({ type: "insert", id: slot.id, gen: slot.gen });
  }

  /** 在序列末尾插入，返回新句柄 */
  append(value: T): Handle {
    const slot = this.allocate(value);
    this.linkBetween(slot, this.tailSlot, null);
    return { id: slot.id, gen: slot.gen };
  }

  /** 在序列开头插入，返回新句柄 */
  prepend(value: T): Handle {
    const slot = this.allocate(value);
    this.linkBetween(slot, null, this.headSlot);
    return { id: slot.id, gen: slot.gen };
  }

  /** 在 at 之后插入；at 失效则抛错 */
  insertAfter(at: Handle, value: T): Handle {
    const anchor = this.resolve(at);
    const slot = this.allocate(value);
    this.linkBetween(slot, anchor, anchor.next);
    return { id: slot.id, gen: slot.gen };
  }

  /** 在 at 之前插入；at 失效则抛错 */
  insertBefore(at: Handle, value: T): Handle {
    const anchor = this.resolve(at);
    const slot = this.allocate(value);
    this.linkBetween(slot, anchor.prev, anchor);
    return { id: slot.id, gen: slot.gen };
  }

  /** 逻辑删除；句柄失效或重复删除抛错 */
  delete(handle: Handle): void {
    const slot = this.resolve(handle);
    slot.deleted = true;
    this.liveCount--;
    this.emit({ type: "delete", id: slot.id, gen: slot.gen });
    if (slot.retained === 0) this.recycle(slot);
  }

  /** 摘除墓碑并回收槽位；再用时 gen+1 */
  private recycle(slot: Slot<T>): void {
    if (slot.prev) slot.prev.next = slot.next;
    else this.headSlot = slot.next;
    if (slot.next) slot.next.prev = slot.prev;
    else this.tailSlot = slot.prev;
    slot.prev = null;
    slot.next = null;
    this.slots[slot.id] = null;
    this.nextGens[slot.id] = slot.gen + 1;
    this.freeList.push(slot.id);
    this.emit({ type: "recycle", id: slot.id, gen: slot.gen });
  }

  /** 当前可见（未删除）元素值，按序列顺序 */
  values(): T[] {
    const out: T[] = [];
    for (let s = this.headSlot; s; s = s.next) {
      if (!s.deleted) out.push(s.value);
    }
    return out;
  }

  /**
   * 打开游标。
   * 不传 at：定位于序列开头之前（next() 返回首个存活元素）。
   * 传入 at：定位于该记录之后（该记录可为墓碑，只要代际仍有效）。
   */
  openCursor(at?: Handle): Cursor<T> {
    let anchor: Slot<T> | null = null;
    if (at !== undefined) {
      const slot = this.slots[at.id];
      if (!slot || slot.gen !== at.gen) {
        throw new RangeError(`stale handle: id=${at.id} gen=${at.gen}`);
      }
      anchor = slot;
    }
    const cursor = new Cursor<T>(this, this.cursorSeq, anchor);
    this.emit({ type: "cursor-open", cursor: this.cursorSeq });
    this.cursorSeq++;
    return cursor;
  }

  /** @internal 游标保留记录，阻止墓碑被回收 */
  _retain(slot: Slot<T>): void {
    slot.retained++;
  }

  /** @internal 释放保留；墓碑计数归零时回收 */
  _release(slot: Slot<T>): void {
    slot.retained--;
    if (slot.deleted && slot.retained === 0) this.recycle(slot);
  }

  /** @internal */
  _first(): Slot<T> | null {
    return this.headSlot;
  }

  /** @internal */
  _emitCursorClose(cursorId: number): void {
    this.emit({ type: "cursor-close", cursor: cursorId });
  }
}

export class Cursor<T> {
  private closed = false;

  constructor(
    private readonly store: SequenceStore<T>,
    readonly cursorId: number,
    private anchor: Slot<T> | null,
  ) {
    if (anchor) this.store._retain(anchor);
  }

  /**
   * 前进到下一个存活元素并返回其句柄与值；到达末尾返回 null。
   * 锚点（含已删除的当前项）被保留，因此删除当前项后仍能到达原后继。
   */
  next(): { handle: Handle; value: T } | null {
    if (this.closed) throw new Error("cursor is closed");
    let slot = this.anchor ? this.anchor.next : this.store._first();
    while (slot && slot.deleted) slot = slot.next;
    if (this.anchor) this.store._release(this.anchor);
    this.anchor = slot;
    if (!slot) return null;
    this.store._retain(slot);
    return { handle: { id: slot.id, gen: slot.gen }, value: slot.value };
  }

  /** 关闭游标，释放保留的记录（可能触发墓碑回收） */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.anchor) {
      this.store._release(this.anchor);
      this.anchor = null;
    }
    this.store._emitCursorClose(this.cursorId);
  }
}
