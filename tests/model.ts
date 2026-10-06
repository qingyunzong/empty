/**
 * 参考模型：带墓碑的链表序列（与 src/sequence.ts 相互独立实现）。
 *
 * 用数组节点 + 索引链接（-1 为空）表达同一份语义契约：
 * - 删除 = 打墓碑标记；墓碑在被游标保留期间留在链中；
 * - 游标锚定“当前记录”，删除当前项后 next 仍到达原后继；
 * - 插入到锚点之前不重访，插入到锚点之后可访问；
 * - 槽位复用必须提升代际；
 * - 游标关闭释放保留记录，可能触发延迟回收；
 * - 事件流（insert/delete/recycle/cursor-open/cursor-close）与实现逐条比对。
 */

export interface ModelHandle {
  id: number;
  gen: number;
}

export type ModelEvent =
  | { type: "insert"; id: number; gen: number }
  | { type: "delete"; id: number; gen: number }
  | { type: "recycle"; id: number; gen: number }
  | { type: "cursor-open"; cursor: number }
  | { type: "cursor-close"; cursor: number };

interface Node {
  gen: number;
  value: unknown;
  prev: number;
  next: number;
  deleted: boolean;
  retained: number;
  inList: boolean;
}

const NIL = -1;

export class ModelSequence {
  private nodes: (Node | null)[] = [];
  private nextGens: number[] = [];
  private freeList: number[] = [];
  private head = NIL;
  private tail = NIL;
  private cursorSeq = 0;
  readonly events: ModelEvent[] = [];

  private alloc(value: unknown): number {
    let id: number;
    if (this.freeList.length > 0) {
      id = this.freeList.pop()!;
    } else {
      id = this.nodes.length;
      this.nodes.push(null);
      this.nextGens.push(1);
    }
    this.nodes[id] = {
      gen: this.nextGens[id]!,
      value,
      prev: NIL,
      next: NIL,
      deleted: false,
      retained: 0,
      inList: true,
    };
    return id;
  }

  private link(id: number, prev: number, next: number): void {
    const n = this.nodes[id]!;
    n.prev = prev;
    n.next = next;
    if (prev !== NIL) this.nodes[prev]!.next = id;
    else this.head = id;
    if (next !== NIL) this.nodes[next]!.prev = id;
    else this.tail = id;
    this.events.push({ type: "insert", id, gen: n.gen });
  }

  private live(id: number, gen: number): Node {
    const n = this.nodes[id];
    if (!n || n.gen !== gen || n.deleted) {
      throw new RangeError(`stale handle: id=${id} gen=${gen}`);
    }
    return n;
  }

  append(value: unknown): ModelHandle {
    const id = this.alloc(value);
    this.link(id, this.tail, NIL);
    return { id, gen: this.nodes[id]!.gen };
  }

  prepend(value: unknown): ModelHandle {
    const id = this.alloc(value);
    this.link(id, NIL, this.head);
    return { id, gen: this.nodes[id]!.gen };
  }

  insertAfter(at: ModelHandle, value: unknown): ModelHandle {
    const anchor = this.live(at.id, at.gen);
    const id = this.alloc(value);
    this.link(id, at.id, anchor.next);
    return { id, gen: this.nodes[id]!.gen };
  }

  insertBefore(at: ModelHandle, value: unknown): ModelHandle {
    const anchor = this.live(at.id, at.gen);
    const id = this.alloc(value);
    this.link(id, anchor.prev, at.id);
    return { id, gen: this.nodes[id]!.gen };
  }

  delete(h: ModelHandle): void {
    const n = this.live(h.id, h.gen);
    n.deleted = true;
    this.events.push({ type: "delete", id: h.id, gen: h.gen });
    if (n.retained === 0) this.recycle(h.id);
  }

  private recycle(id: number): void {
    const n = this.nodes[id]!;
    if (n.prev !== NIL) this.nodes[n.prev]!.next = n.next;
    else this.head = n.next;
    if (n.next !== NIL) this.nodes[n.next]!.prev = n.prev;
    else this.tail = n.prev;
    n.prev = NIL;
    n.next = NIL;
    n.inList = false;
    this.nodes[id] = null;
    this.nextGens[id] = n.gen + 1;
    this.freeList.push(id);
    this.events.push({ type: "recycle", id, gen: n.gen });
  }

  values(): unknown[] {
    const out: unknown[] = [];
    for (let i = this.head; i !== NIL; i = this.nodes[i]!.next) {
      const n = this.nodes[i]!;
      if (!n.deleted) out.push(n.value);
    }
    return out;
  }

  openCursor(at?: ModelHandle): ModelCursor {
    let anchor = NIL;
    if (at !== undefined) {
      const n = this.nodes[at.id];
      if (!n || n.gen !== at.gen) {
        throw new RangeError(`stale handle: id=${at.id} gen=${at.gen}`);
      }
      anchor = at.id;
    }
    const c = new ModelCursor(this, this.cursorSeq, anchor);
    this.events.push({ type: "cursor-open", cursor: this.cursorSeq });
    this.cursorSeq++;
    return c;
  }

  _retain(id: number): void {
    this.nodes[id]!.retained++;
  }

  _release(id: number): void {
    const n = this.nodes[id]!;
    n.retained--;
    if (n.deleted && n.retained === 0) this.recycle(id);
  }

  _first(): number {
    return this.head;
  }

  _node(id: number): Node {
    return this.nodes[id]!;
  }

  _emitClose(cursorId: number): void {
    this.events.push({ type: "cursor-close", cursor: cursorId });
  }
}

export class ModelCursor {
  private closed = false;

  constructor(
    private readonly model: ModelSequence,
    readonly cursorId: number,
    private anchor: number,
  ) {
    if (anchor !== NIL) this.model._retain(anchor);
  }

  next(): { handle: ModelHandle; value: unknown } | null {
    if (this.closed) throw new Error("cursor is closed");
    let i = this.anchor === NIL ? this.model._first() : this.model._node(this.anchor).next;
    while (i !== NIL && this.model._node(i).deleted) i = this.model._node(i).next;
    if (this.anchor !== NIL) this.model._release(this.anchor);
    this.anchor = i;
    if (i === NIL) return null;
    this.model._retain(i);
    const n = this.model._node(i);
    return { handle: { id: i, gen: n.gen }, value: n.value };
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.anchor !== NIL) {
      this.model._release(this.anchor);
      this.anchor = NIL;
    }
    this.model._emitClose(this.cursorId);
  }
}
