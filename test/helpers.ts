import { AlertEvent, DisplayItem, sortItems } from '../src/model.js';
import { SubscriberMessage } from '../src/subscription.js';

/** 全排序扫描参照：全部事件排序后取每 key 窗内最早者（左含右不含）。 */
export function referenceDisplay(events: AlertEvent[], start: number, end: number): DisplayItem[] {
  const sorted = [...events].sort((a, b) =>
    a.key < b.key ? -1 : a.key > b.key ? 1 : a.ts - b.ts || a.id - b.id,
  );
  const best = new Map<string, AlertEvent>();
  for (const e of sorted) {
    if (e.ts < start || e.ts >= end) continue;
    if (!best.has(e.key)) best.set(e.key, e);
  }
  return sortItems([...best.entries()].map(([key, e]) => ({ key, eventId: e.id, ts: e.ts })));
}

/** 订阅消息流重建显示集，并记录观察到的版本序列。 */
export function reconstruct(msgs: SubscriberMessage[]): { state: DisplayItem[]; versions: number[] } {
  const map = new Map<string, DisplayItem>();
  const versions: number[] = [];
  for (const m of msgs) {
    if (m.kind === 'snapshot' || m.kind === 'resync') {
      map.clear();
      for (const it of m.items) map.set(it.key, it);
      versions.push(m.version);
    } else {
      for (const r of m.changes.removes) map.delete(r.key);
      for (const a of m.changes.adds) map.set(a.key, a);
      versions.push(m.changes.version);
    }
  }
  return { state: sortItems([...map.values()]), versions };
}
