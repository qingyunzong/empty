import { ChangeSet, DisplayItem, sortItems } from './model.js';

/** 订阅方收到的消息：首次快照 / 净增删 / 慢订阅重同步。 */
export type SubscriberMessage =
  | { kind: 'snapshot'; version: number; items: DisplayItem[] }
  | { kind: 'changes'; changes: ChangeSet }
  | { kind: 'resync'; version: number; items: DisplayItem[]; lostFromVersion: number };

/** 订阅者读取快照所需的最小存储接口（避免循环依赖）。 */
export interface SnapshotSource {
  readonly currentVersion: number;
  displayedItems(): DisplayItem[];
}

/**
 * 订阅：
 * - 创建时捕获首次快照，发布前的变更作为更正缓冲；
 * - 发布时把缓冲更正相对快照做净额合并——同批（同段缓冲）内被撤销的显示项不出现；
 * - 发布后按版本逐批投递净增删；
 * - 慢订阅积压超过容量时转重同步：丢弃积压、记录断点，poll 时给出最新全量与版本，不丢版本号。
 */
export class Subscription {
  readonly id: number;
  private state: 'snapshotting' | 'live' = 'snapshotting';
  private readonly snapshotVersion: number;
  private readonly snapshotItems: DisplayItem[];
  private corrections: ChangeSet[] = [];
  private queue: SubscriberMessage[] = [];
  private resyncPending = false;
  private deliveredVersion: number;

  constructor(id: number, private readonly source: SnapshotSource, private readonly capacity: number) {
    this.id = id;
    this.snapshotVersion = source.currentVersion;
    this.snapshotItems = source.displayedItems();
    this.deliveredVersion = this.snapshotVersion;
  }

  get isSnapshotting(): boolean {
    return this.state === 'snapshotting';
  }

  get isResyncPending(): boolean {
    return this.resyncPending;
  }

  /** 存储侧每次提交版本时调用。 */
  onChange(cs: ChangeSet): void {
    if (this.state === 'snapshotting') {
      this.corrections.push(cs);
      return;
    }
    if (this.resyncPending) return; // 已转重同步，积压由重同步快照覆盖
    if (this.queue.length >= this.capacity) {
      this.queue = [];
      this.resyncPending = true;
      return;
    }
    this.queue.push({ kind: 'changes', changes: cs });
  }

  /** 发布首次快照：返回快照 + 缓冲更正的净增删（若有）。 */
  publishSnapshot(): SubscriberMessage[] {
    if (this.state !== 'snapshotting') return [];
    this.state = 'live';
    const out: SubscriberMessage[] = [
      { kind: 'snapshot', version: this.snapshotVersion, items: this.snapshotItems },
    ];
    const net = new Map<string, DisplayItem>();
    for (const item of this.snapshotItems) net.set(item.key, item);
    let lastVersion = this.snapshotVersion;
    for (const cs of this.corrections) {
      for (const r of cs.removes) net.delete(r.key);
      for (const a of cs.adds) net.set(a.key, a);
      lastVersion = cs.version;
    }
    this.corrections = [];
    const base = new Map(this.snapshotItems.map((i) => [i.key, i]));
    const adds: DisplayItem[] = [];
    const removes: DisplayItem[] = [];
    for (const [key, item] of net) {
      if (base.get(key)?.eventId !== item.eventId) adds.push(item);
    }
    for (const [key, item] of base) {
      if (net.get(key)?.eventId !== item.eventId) removes.push(item);
    }
    if (adds.length > 0 || removes.length > 0) {
      out.push({
        kind: 'changes',
        changes: { version: lastVersion, source: 'snapshot', adds: sortItems(adds), removes: sortItems(removes) },
      });
    }
    this.deliveredVersion = lastVersion;
    return out;
  }

  /** 订阅方取消息：优先发重同步，否则 drain 队列。 */
  poll(): SubscriberMessage[] {
    if (this.resyncPending) {
      this.resyncPending = false;
      const lostFromVersion = this.deliveredVersion;
      this.deliveredVersion = this.source.currentVersion;
      return [
        {
          kind: 'resync',
          version: this.source.currentVersion,
          items: this.source.displayedItems(),
          lostFromVersion,
        },
      ];
    }
    const out = this.queue;
    this.queue = [];
    for (const m of out) {
      if (m.kind === 'changes') this.deliveredVersion = m.changes.version;
    }
    return out;
  }
}
