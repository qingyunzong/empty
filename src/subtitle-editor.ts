/**
 * 字幕编辑器：区间插入、裁剪、撤销，以及可见段计算。
 *
 * 区间均为半开区间 [start, end)，单位毫秒。
 * 遮挡规则：同一时刻，层（layer）大的字幕遮挡层小的；层相同时，后插入的优先。
 */

export type SubtitleId = number;

export interface InsertOptions {
  layer: number;
  /** 起始毫秒（含） */
  start: number;
  /** 结束毫秒（不含） */
  end: number;
  text?: string;
}

export interface SubtitleView {
  id: SubtitleId;
  layer: number;
  start: number;
  end: number;
  text: string;
  /** 插入序号，用于同层时“后插入优先”的判定 */
  seq: number;
}

/** 一段最大连续可见区间及其来源字幕 */
export interface VisibleSegment {
  start: number;
  end: number;
  source: SubtitleId;
  layer: number;
  text: string;
}

interface SubtitleRecord {
  id: SubtitleId;
  layer: number;
  start: number;
  end: number;
  text: string;
  seq: number;
}

interface State {
  subtitles: Map<SubtitleId, SubtitleRecord>;
  nextId: number;
  nextSeq: number;
  version: number;
}

function cloneState(state: State): State {
  const subtitles = new Map<SubtitleId, SubtitleRecord>();
  for (const [id, rec] of state.subtitles) {
    subtitles.set(id, { ...rec });
  }
  return {
    subtitles,
    nextId: state.nextId,
    nextSeq: state.nextSeq,
    version: state.version,
  };
}

function assertValidRange(start: number, end: number): void {
  if (!Number.isInteger(start) || !Number.isInteger(end)) {
    throw new RangeError(`区间端点必须为整数毫秒，收到 [${start}, ${end})`);
  }
  if (start < 0) {
    throw new RangeError(`区间起点不能为负，收到 ${start}`);
  }
  if (start >= end) {
    throw new RangeError(`半开区间需满足 start < end，收到 [${start}, ${end})`);
  }
}

/** 在给定字幕集合中，求 t 毫秒处的可见字幕：层大者优先，同层后插入者优先。 */
function winnerAt(subs: Iterable<SubtitleRecord>, t: number): SubtitleRecord | null {
  let best: SubtitleRecord | null = null;
  for (const sub of subs) {
    if (sub.start > t || t >= sub.end) continue;
    if (
      best === null ||
      sub.layer > best.layer ||
      (sub.layer === best.layer && sub.seq > best.seq)
    ) {
      best = sub;
    }
  }
  return best;
}

export class SubtitleEditor {
  private state: State = {
    subtitles: new Map(),
    nextId: 1,
    nextSeq: 0,
    version: 0,
  };
  private undoStack: State[] = [];

  /** 当前版本号：每次成功的插入/裁剪 +1，撤销后恢复到操作前的版本号。 */
  get version(): number {
    return this.state.version;
  }

  get canUndo(): boolean {
    return this.undoStack.length > 0;
  }

  /** 插入一条字幕，返回其 id。 */
  insert(options: InsertOptions): SubtitleId {
    const { layer, start, end, text = "" } = options;
    if (!Number.isInteger(layer)) {
      throw new RangeError(`layer 必须为整数，收到 ${layer}`);
    }
    assertValidRange(start, end);

    this.pushUndo();
    const id = this.state.nextId++;
    this.state.subtitles.set(id, {
      id,
      layer,
      start,
      end,
      text,
      seq: this.state.nextSeq++,
    });
    return id;
  }

  /**
   * 将 id 对应的字幕裁剪到窗口 [start, end) 内（取交集）。
   * 交集为空时该字幕被移除。id 不存在时返回 false 且不产生版本变化。
   */
  crop(id: SubtitleId, start: number, end: number): boolean {
    const sub = this.state.subtitles.get(id);
    if (!sub) return false;
    assertValidRange(start, end);

    this.pushUndo();
    const newStart = Math.max(sub.start, start);
    const newEnd = Math.min(sub.end, end);
    if (newStart >= newEnd) {
      this.state.subtitles.delete(id);
    } else {
      sub.start = newStart;
      sub.end = newEnd;
    }
    return true;
  }

  /** 撤销最近一次插入/裁剪，恢复到操作前的同一版本。无可撤销时返回 false。 */
  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.state = prev;
    return true;
  }

  /** 按插入顺序列出当前所有字幕（副本）。 */
  list(): SubtitleView[] {
    return [...this.state.subtitles.values()].map((rec) => ({ ...rec }));
  }

  get(id: SubtitleId): SubtitleView | undefined {
    const rec = this.state.subtitles.get(id);
    return rec ? { ...rec } : undefined;
  }

  /** t 毫秒处可见的字幕；无覆盖时返回 null。 */
  visibleAt(t: number): SubtitleView | null {
    const winner = winnerAt(this.state.subtitles.values(), t);
    return winner ? { ...winner } : null;
  }

  /**
   * 计算最大连续可见段：相邻且来源相同的基本区间会被合并。
   * 只返回有字幕覆盖的段，段与段之间按时间升序、互不重叠。
   */
  visibleSegments(): VisibleSegment[] {
    const subs = [...this.state.subtitles.values()];
    if (subs.length === 0) return [];

    const bounds = new Set<number>();
    for (const sub of subs) {
      bounds.add(sub.start);
      bounds.add(sub.end);
    }
    const points = [...bounds].sort((a, b) => a - b);

    const segments: VisibleSegment[] = [];
    for (let i = 0; i < points.length - 1; i++) {
      const segStart = points[i];
      const segEnd = points[i + 1];
      const winner = winnerAt(subs, segStart);
      if (!winner) continue;

      const last = segments[segments.length - 1];
      if (last && last.source === winner.id && last.end === segStart) {
        last.end = segEnd;
      } else {
        segments.push({
          start: segStart,
          end: segEnd,
          source: winner.id,
          layer: winner.layer,
          text: winner.text,
        });
      }
    }
    return segments;
  }

  private pushUndo(): void {
    this.undoStack.push(cloneState(this.state));
    this.state.version++;
  }
}
