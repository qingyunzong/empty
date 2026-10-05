import { AlertEvent, ChangeSet, DisplayItem, Source, cmpEvent, sortItems } from './model.js';
import { Subscription } from './subscription.js';

/**
 * 按键告警滑动时间窗存储。
 * - 窗口 [start, end)：左端含、右端不含；
 * - 每个按键只显示窗口内最早事件（同时间按 ID 小者）；
 * - 最早者被删除后，次早者自动接替显示；
 * - 每次变更操作产生一个连续递增的版本与净增删 ChangeSet。
 */
export class AlertWindowStore {
  private events = new Map<number, AlertEvent>();
  private byKey = new Map<string, AlertEvent[]>(); // 每 key 按 (ts, id) 升序
  private winStart: number;
  private winEnd: number;
  private displayed = new Map<string, AlertEvent>();
  private version = 0;
  readonly history: ChangeSet[] = [];
  private subscribers = new Set<Subscription>();
  private pendingSnapshots: Subscription[] = [];
  private nextSubscriptionId = 1;

  constructor(winStart = 0, winEnd = 0) {
    if (winStart > winEnd) throw new Error('window start must be <= end');
    this.winStart = winStart;
    this.winEnd = winEnd;
  }

  get currentVersion(): number {
    return this.version;
  }

  get window(): { start: number; end: number } {
    return { start: this.winStart, end: this.winEnd };
  }

  /** 当前显示集（按 key 排序）。 */
  displayedItems(): DisplayItem[] {
    return sortItems(
      [...this.displayed.entries()].map(([key, e]) => ({ key, eventId: e.id, ts: e.ts })),
    );
  }

  /** 当前存活的全部事件（测试对照用）。 */
  remainingEvents(): AlertEvent[] {
    return [...this.events.values()];
  }

  /** 窗口内该 key 的最早事件（二分定位左端，右端不含）。 */
  private earliestInWindow(key: string): AlertEvent | undefined {
    const arr = this.byKey.get(key);
    if (!arr) return undefined;
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (arr[mid].ts < this.winStart) lo = mid + 1;
      else hi = mid;
    }
    if (lo < arr.length && arr[lo].ts < this.winEnd) return arr[lo];
    return undefined;
  }

  /** 重算受影响 key 的显示项，生成净增删并提交版本、广播。 */
  private commit(source: Source, affectedKeys: Set<string>): ChangeSet {
    const adds: DisplayItem[] = [];
    const removes: DisplayItem[] = [];
    for (const key of affectedKeys) {
      const prev = this.displayed.get(key);
      const next = this.earliestInWindow(key);
      if (prev?.id === next?.id) continue;
      if (prev) removes.push({ key, eventId: prev.id, ts: prev.ts });
      if (next) {
        this.displayed.set(key, next);
        adds.push({ key, eventId: next.id, ts: next.ts });
      } else {
        this.displayed.delete(key);
      }
    }
    this.version += 1;
    const cs: ChangeSet = {
      version: this.version,
      source,
      adds: sortItems(adds),
      removes: sortItems(removes),
    };
    this.history.push(cs);
    for (const sub of this.subscribers) sub.onChange(cs);
    return cs;
  }

  addEvent(e: AlertEvent): ChangeSet {
    if (this.events.has(e.id)) throw new Error(`duplicate event id ${e.id}`);
    this.events.set(e.id, e);
    const arr = this.byKey.get(e.key) ?? [];
    let lo = 0;
    let hi = arr.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cmpEvent(arr[mid], e) < 0) lo = mid + 1;
      else hi = mid;
    }
    arr.splice(lo, 0, e);
    this.byKey.set(e.key, arr);
    return this.commit('add', new Set([e.key]));
  }

  deleteEvent(id: number): ChangeSet {
    const e = this.events.get(id);
    if (!e) throw new Error(`unknown event id ${id}`);
    this.removeEvent(e);
    return this.commit('delete', new Set([e.key]));
  }

  /** 删除最早事件：指定 key 删该 key 窗内最早者；否则删全窗最早显示项。 */
  deleteEarliest(key?: string): ChangeSet {
    let target: AlertEvent | undefined;
    if (key !== undefined) {
      target = this.earliestInWindow(key);
    } else {
      for (const e of this.displayed.values()) {
        if (!target || cmpEvent(e, target) < 0) target = e;
      }
    }
    if (!target) return this.commit('deleteEarliest', new Set());
    this.removeEvent(target);
    return this.commit('deleteEarliest', new Set([target.key]));
  }

  private removeEvent(e: AlertEvent): void {
    this.events.delete(e.id);
    const arr = this.byKey.get(e.key)!;
    const idx = arr.findIndex((x) => x.id === e.id);
    arr.splice(idx, 1);
    if (arr.length === 0) this.byKey.delete(e.key);
  }

  moveWindow(start: number, end: number): ChangeSet {
    if (start > end) throw new Error('window start must be <= end');
    this.winStart = start;
    this.winEnd = end;
    const affected = new Set<string>([...this.byKey.keys(), ...this.displayed.keys()]);
    return this.commit('moveWindow', affected);
  }

  /** 订阅：立即捕获首次快照，发布前的变更进入更正缓冲。 */
  subscribe(capacity = 16): Subscription {
    const sub = new Subscription(this.nextSubscriptionId++, this, capacity);
    this.subscribers.add(sub);
    this.pendingSnapshots.push(sub);
    return sub;
  }

  unsubscribe(sub: Subscription): void {
    this.subscribers.delete(sub);
    this.pendingSnapshots = this.pendingSnapshots.filter((s) => s !== sub);
  }

  subscriptionById(id: number): Subscription | undefined {
    for (const sub of this.subscribers) if (sub.id === id) return sub;
    return undefined;
  }

  get pendingSnapshotCount(): number {
    return this.pendingSnapshots.length;
  }

  /** 发布最早一个待发布的首次快照（由执行器控制时机）。 */
  completeNextSnapshot(): ReturnType<Subscription['publishSnapshot']> | undefined {
    const sub = this.pendingSnapshots.shift();
    return sub?.publishSnapshot();
  }
}
