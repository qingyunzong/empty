/**
 * 事件压缩库。
 *
 * 输入是「事件 / 屏障」交错的有序流：
 *  - 事件：携带 id、key 与一个版本值（字节）。
 *  - 屏障：显式标记，压缩合并禁止跨越它。
 *
 * 压缩把「相邻且同 key」的连续事件合并为一个段（Segment），
 * 段内只保留初值（firstValue）、终值（lastValue）与被合并的全部 id（ids）。
 * 中间版本的值被丢弃（这正是压缩点），但事件顺序无损：
 * 逆压缩 decompress 能按原顺序还原出每个事件/屏障的位置。
 */

export interface EventItem {
  kind: 'event';
  id: number;
  key: string;
  value: Uint8Array;
}

export interface BarrierItem {
  kind: 'barrier';
  id: number;
}

export type InputItem = EventItem | BarrierItem;

/** 压缩后的段：同 key 连续事件合并而成。 */
export interface Segment {
  kind: 'segment';
  key: string;
  /** 段内第一个事件的值（初值）。 */
  firstValue: Uint8Array;
  /** 段内最后一个事件的值（终值）。 */
  lastValue: Uint8Array;
  /** 被合并事件的 id，保持原顺序。 */
  ids: number[];
}

export interface CompressedBarrier {
  kind: 'barrier';
  id: number;
}

export type CompressedItem = Segment | CompressedBarrier;

/**
 * 压缩：相邻同 key 事件合并为段；屏障冲刷当前段并原样保留，
 * 因此任何段都不会跨越屏障。
 */
export function compress(items: readonly InputItem[]): CompressedItem[] {
  const out: CompressedItem[] = [];
  let runKey: string | null = null;
  let runIds: number[] = [];
  let runFirst: Uint8Array | null = null;
  let runLast: Uint8Array | null = null;

  const flush = (): void => {
    if (runKey === null) return;
    out.push({
      kind: 'segment',
      key: runKey,
      firstValue: runFirst as Uint8Array,
      lastValue: runLast as Uint8Array,
      ids: runIds,
    });
    runKey = null;
    runIds = [];
    runFirst = null;
    runLast = null;
  };

  for (const item of items) {
    if (item.kind === 'barrier') {
      flush();
      out.push({ kind: 'barrier', id: item.id });
      continue;
    }
    if (runKey === item.key) {
      runIds.push(item.id);
      runLast = item.value;
    } else {
      flush();
      runKey = item.key;
      runIds = [item.id];
      runFirst = item.value;
      runLast = item.value;
    }
  }
  flush();
  return out;
}

/** 还原后的事件顺序条目（中间版本的值已被压缩丢弃，顺序与 id、key 无损）。 */
export type OrderEntry =
  | { kind: 'event'; id: number; key: string }
  | { kind: 'barrier'; id: number };

/** 逆压缩：按原顺序展开段与屏障，还原事件顺序。 */
export function decompress(items: readonly CompressedItem[]): OrderEntry[] {
  const out: OrderEntry[] = [];
  for (const item of items) {
    if (item.kind === 'barrier') {
      out.push({ kind: 'barrier', id: item.id });
    } else {
      for (const id of item.ids) {
        out.push({ kind: 'event', id, key: item.key });
      }
    }
  }
  return out;
}

/** 提取输入流的顺序条目，用于与 decompress 结果做字节级比对。 */
export function orderOf(items: readonly InputItem[]): OrderEntry[] {
  return items.map((item) =>
    item.kind === 'barrier'
      ? { kind: 'barrier', id: item.id }
      : { kind: 'event', id: item.id, key: item.key },
  );
}

const TAG_EVENT = 0x45; // 'E'
const TAG_BARRIER = 0x42; // 'B'
const MAX_UINT53 = 0x1fffffffffffff;

function asUint53(id: number): bigint {
  if (!Number.isInteger(id) || id < 0 || id > MAX_UINT53) {
    throw new RangeError(`id 必须是 [0, 2^53-1] 内的整数，收到: ${id}`);
  }
  return BigInt(id);
}

/**
 * 把事件顺序编码为确定性的字节序列：
 *   事件: 0x45 | id:uint64be | keyLen:uint16be | key:utf8
 *   屏障: 0x42 | id:uint64be
 */
export function serializeOrder(entries: readonly OrderEntry[]): Uint8Array {
  const encoder = new TextEncoder();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (const entry of entries) {
    const keyBytes = entry.kind === 'event' ? encoder.encode(entry.key) : new Uint8Array(0);
    if (keyBytes.length > 0xffff) {
      throw new RangeError(`key 编码后超过 65535 字节: ${entry.kind === 'event' ? entry.key : ''}`);
    }
    const size = entry.kind === 'event' ? 1 + 8 + 2 + keyBytes.length : 1 + 8;
    const buf = new Uint8Array(size);
    const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    buf[0] = entry.kind === 'event' ? TAG_EVENT : TAG_BARRIER;
    view.setBigUint64(1, asUint53(entry.id));
    if (entry.kind === 'event') {
      view.setUint16(9, keyBytes.length);
      buf.set(keyBytes, 11);
    }
    parts.push(buf);
    total += size;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}
