/** 告警事件：key 为按键，ts 为事件时间戳，id 全局唯一。 */
export interface AlertEvent {
  id: number;
  key: string;
  ts: number;
}

/** 显示项：某按键当前在窗口内可见的最早事件。 */
export interface DisplayItem {
  key: string;
  eventId: number;
  ts: number;
}

/** 变更来源：每个版本批次由哪类操作产生。 */
export type Source = 'add' | 'delete' | 'deleteEarliest' | 'moveWindow' | 'snapshot';

/** 一个版本批次对显示集的净增删（同批被撤销的显示项不出现）。 */
export interface ChangeSet {
  version: number;
  source: Source;
  adds: DisplayItem[];
  removes: DisplayItem[];
}

/** 事件排序：先按时间戳，同时间按 ID。 */
export function cmpEvent(a: AlertEvent, b: AlertEvent): number {
  return a.ts - b.ts || a.id - b.id;
}

/** 显示项按 key 排序，保证输出确定性。 */
export function sortItems(items: DisplayItem[]): DisplayItem[] {
  return [...items].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}
