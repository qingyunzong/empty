import type {
  BeginEvent,
  CancelEvent,
  CompleteEvent,
  DownloadEvent,
  ProgressEvent,
} from '../src/types.js';

/** 确定性伪随机（mulberry32），保证到达排列测试可复现。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher–Yates 洗牌，使用可注入的随机源。 */
export function shuffled<T>(items: readonly T[], random: () => number): T[] {
  const copy = [...items];
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(random() * (index + 1));
    const current = copy[index];
    const target = copy[swap];
    if (current !== undefined && target !== undefined) {
      copy[index] = target;
      copy[swap] = current;
    }
  }
  return copy;
}

/** 生成一批下载事件的构造器，序号由计数器分配，事件 ID 显式可读。 */
export class EventFactory {
  #counter: number;

  constructor(startSeq = 0) {
    this.#counter = startSeq;
  }

  #nextSeq(explicit?: number): number {
    if (explicit !== undefined) {
      return explicit;
    }
    const value = this.#counter;
    this.#counter += 1;
    return value;
  }

  begin(
    downloadId: string,
    url: string,
    labelOrSeq?: string | number,
    seq?: number,
  ): BeginEvent {
    const label = typeof labelOrSeq === 'string' ? labelOrSeq : `begin-${downloadId}`;
    const explicit = typeof labelOrSeq === 'number' ? labelOrSeq : seq;
    return { kind: 'begin', eventId: label, seq: this.#nextSeq(explicit), downloadId, url };
  }

  progress(
    downloadId: string,
    received: number,
    total: number | null,
    label?: string,
    seq?: number,
  ): ProgressEvent {
    return {
      kind: 'progress',
      eventId: label ?? `prog-${downloadId}-${received}`,
      seq: this.#nextSeq(seq),
      downloadId,
      received,
      total,
    };
  }

  complete(
    downloadId: string,
    summary: string,
    label?: string,
    seq?: number,
  ): CompleteEvent {
    return {
      kind: 'complete',
      eventId: label ?? `complete-${downloadId}`,
      seq: this.#nextSeq(seq),
      downloadId,
      summary,
    };
  }

  cancel(downloadId: string, label?: string, seq?: number): CancelEvent {
    return {
      kind: 'cancel',
      eventId: label ?? `cancel-${downloadId}`,
      seq: this.#nextSeq(seq),
      downloadId,
    };
  }
}

export function eventIds(events: readonly DownloadEvent[]): string[] {
  return events.map((event) => event.eventId);
}
