/**
 * 事件循环模拟器（主实现）。
 *
 * 语义：
 *  - 定时任务（宏任务）按 (触发时间, 入队序号) 取最早者执行；
 *  - 每个宏任务结束后排空整个微任务队列（微任务可继续派生微任务）；
 *  - 初始先排空一次微任务队列（相当于 script 宏任务）；
 *  - 虚拟时钟只在定时器触发时前进，永不回退；
 *  - 步数预算：每执行一个任务（宏或微）计 1 步，预算耗尽且仍有未完成任务时
 *    返回未闭合状态 "exhausted"。
 */

export type TaskBody = (api: LoopApi) => void;

export interface LoopApi {
  /** 注册一个定时任务，delay 相对当前虚拟时间。 */
  setTimer(id: string, delay: number, body: TaskBody): void;
  /** 注册一个微任务。 */
  queueMicrotask(id: string, body: TaskBody): void;
  /** 当前虚拟时间。 */
  now(): number;
}

export interface TraceEvent {
  step: number;
  kind: "macro" | "micro";
  id: string;
  time: number;
}

export interface PendingSummary {
  timers: number;
  microtasks: number;
}

export type RunResult =
  | { status: "closed"; trace: TraceEvent[]; steps: number; time: number }
  | {
      status: "exhausted";
      trace: TraceEvent[];
      steps: number;
      time: number;
      pending: PendingSummary;
    };

interface TimerEntry {
  id: string;
  fireTime: number;
  seq: number;
  body: TaskBody;
}

interface MicroEntry {
  id: string;
  body: TaskBody;
}

/** 二叉最小堆，键为 (fireTime, seq)。 */
class TimerHeap {
  private items: TimerEntry[] = [];

  get size(): number {
    return this.items.length;
  }

  private static less(a: TimerEntry, b: TimerEntry): boolean {
    return a.fireTime < b.fireTime || (a.fireTime === b.fireTime && a.seq < b.seq);
  }

  push(entry: TimerEntry): void {
    const items = this.items;
    items.push(entry);
    let i = items.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!TimerHeap.less(items[i], items[parent])) break;
      [items[i], items[parent]] = [items[parent], items[i]];
      i = parent;
    }
  }

  popMin(): TimerEntry | undefined {
    const items = this.items;
    if (items.length === 0) return undefined;
    const top = items[0];
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let i = 0;
      for (;;) {
        const left = 2 * i + 1;
        const right = left + 1;
        let smallest = i;
        if (left < items.length && TimerHeap.less(items[left], items[smallest])) smallest = left;
        if (right < items.length && TimerHeap.less(items[right], items[smallest])) smallest = right;
        if (smallest === i) break;
        [items[i], items[smallest]] = [items[smallest], items[i]];
        i = smallest;
      }
    }
    return top;
  }
}

export interface RunOptions {
  /** 步数预算（每执行一个任务计 1 步）。 */
  stepBudget: number;
}

export function runEventLoop(setup: (api: LoopApi) => void, options: RunOptions): RunResult {
  const heap = new TimerHeap();
  const microQueue: MicroEntry[] = [];
  let microHead = 0;
  let time = 0;
  let seq = 0;
  let steps = 0;
  const trace: TraceEvent[] = [];

  const api: LoopApi = {
    setTimer(id, delay, body) {
      if (!Number.isFinite(delay) || delay < 0) {
        throw new Error(`invalid delay for timer ${id}: ${delay}`);
      }
      heap.push({ id, fireTime: time + delay, seq: seq++, body });
    },
    queueMicrotask(id, body) {
      microQueue.push({ id, body });
    },
    now() {
      return time;
    },
  };

  setup(api);

  const exhausted = (): RunResult => ({
    status: "exhausted",
    trace,
    steps,
    time,
    pending: { timers: heap.size, microtasks: microQueue.length - microHead },
  });

  for (;;) {
    // 排空微任务队列（含执行期间派生的新微任务）。
    while (microHead < microQueue.length) {
      if (steps >= options.stepBudget) return exhausted();
      const micro = microQueue[microHead++];
      trace.push({ step: steps, kind: "micro", id: micro.id, time });
      steps++;
      micro.body(api);
    }
    // 压缩微任务队列。
    microQueue.length = 0;
    microHead = 0;

    // 选最早定时项作为下一个宏任务。
    const timer = heap.popMin();
    if (timer === undefined) {
      return { status: "closed", trace, steps, time };
    }
    if (timer.fireTime > time) time = timer.fireTime;
    if (steps >= options.stepBudget) {
      // 预算耗尽：该定时器尚未执行，重新放回堆中再报告。
      heap.push(timer);
      return exhausted();
    }
    trace.push({ step: steps, kind: "macro", id: timer.id, time });
    steps++;
    timer.body(api);
  }
}
