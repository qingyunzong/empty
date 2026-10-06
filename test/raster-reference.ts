/**
 * 逐毫秒栅格参照实现：与被测库完全独立，用于随机操作对照。
 * 直接维护一份字幕数组 + 快照栈，可见性按毫秒逐点暴力求解。
 */
import type { SubtitleView, VisibleSegment } from "../src/subtitle-editor.js";

interface RasterRecord {
  id: number;
  layer: number;
  start: number;
  end: number;
  text: string;
  seq: number;
}

interface RasterState {
  subs: RasterRecord[];
  nextId: number;
  nextSeq: number;
  version: number;
}

function clone(state: RasterState): RasterState {
  return {
    subs: state.subs.map((s) => ({ ...s })),
    nextId: state.nextId,
    nextSeq: state.nextSeq,
    version: state.version,
  };
}

export class RasterReference {
  private state: RasterState = { subs: [], nextId: 1, nextSeq: 0, version: 0 };
  private undoStack: RasterState[] = [];

  get version(): number {
    return this.state.version;
  }

  insert(layer: number, start: number, end: number, text = ""): number {
    this.undoStack.push(clone(this.state));
    this.state.version++;
    const id = this.state.nextId++;
    this.state.subs.push({ id, layer, start, end, text, seq: this.state.nextSeq++ });
    return id;
  }

  crop(id: number, start: number, end: number): boolean {
    const sub = this.state.subs.find((s) => s.id === id);
    if (!sub) return false;
    this.undoStack.push(clone(this.state));
    this.state.version++;
    const newStart = Math.max(sub.start, start);
    const newEnd = Math.min(sub.end, end);
    if (newStart >= newEnd) {
      this.state.subs = this.state.subs.filter((s) => s.id !== id);
    } else {
      sub.start = newStart;
      sub.end = newEnd;
    }
    return true;
  }

  undo(): boolean {
    const prev = this.undoStack.pop();
    if (!prev) return false;
    this.state = prev;
    return true;
  }

  list(): SubtitleView[] {
    return this.state.subs.map((s) => ({ ...s }));
  }

  /** 逐毫秒求可见者，再合并为最大连续段。 */
  visibleSegments(): VisibleSegment[] {
    if (this.state.subs.length === 0) return [];
    const maxEnd = Math.max(...this.state.subs.map((s) => s.end));
    const segments: VisibleSegment[] = [];
    for (let t = 0; t < maxEnd; t++) {
      const winner = this.winnerAt(t);
      if (!winner) continue;
      const last = segments[segments.length - 1];
      if (last && last.source === winner.id && last.end === t) {
        last.end = t + 1;
      } else {
        segments.push({
          start: t,
          end: t + 1,
          source: winner.id,
          layer: winner.layer,
          text: winner.text,
        });
      }
    }
    return segments;
  }

  winnerAt(t: number): RasterRecord | null {
    let best: RasterRecord | null = null;
    for (const sub of this.state.subs) {
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
}
