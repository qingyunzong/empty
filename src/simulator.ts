/**
 * 事件循环模拟器（主实现）。
 *
 * 语义规则：
 *  1. 初始脚本 main 作为第一个宏任务执行；
 *  2. 每个宏任务结束后，排空微任务队列（微任务可继续派生微任务，一并排空）；
 *  3. 然后选取触发时间最早的定时项作为下一个宏任务（时间相同按入队先后，FIFO）；
 *  4. 虚拟时钟只在定时项出队时推进到该项的触发时间；
 *  5. 每执行一个回调（宏/微）计 1 步，超出步数预算即返回未闭合状态 budget-exceeded。
 */

export interface ScheduleApi {
  /** 注册一个定时任务，delay 毫秒（虚拟时间）后触发，label 须存在于 Program.tasks。 */
  setTimeout(label: string, delay: number): void;
  /** 派生一个微任务，label 须存在于 Program.tasks。 */
  queueMicrotask(label: string): void;
  /** 追加一条日志（计入运行结果，便于核对副作用顺序）。 */
  log(message: string): void;
  /** 当前虚拟时间。 */
  now(): number;
}

export type TaskBody = (api: ScheduleApi) => void;

export interface Program {
  /** 初始脚本，作为第一个宏任务。 */
  main: TaskBody;
  /** 任务注册表：label -> 回调体。 */
  tasks: Record<string, TaskBody>;
}

export type Phase = 'macro' | 'micro';

export interface TraceEvent {
  step: number;
  phase: Phase;
  label: string;
  time: number;
}

export interface RunOptions {
  /** 步数预算：最多执行的回调（宏任务 + 微任务）总数。 */
  maxSteps: number;
}

export interface PendingState {
  timers: number;
  microtasks: number;
}

export type RunStatus = 'settled' | 'budget-exceeded';

export interface RunResult {
  status: RunStatus;
  steps: number;
  time: number;
  trace: TraceEvent[];
  log: string[];
  /** 未闭合时剩余的工作量；settled 时恒为 0。 */
  pending: PendingState;
}

interface TimerItem {
  time: number;
  seq: number;
  label: string;
}

/** 二叉最小堆，按 (time, seq) 排序：最早触发者优先，并列时先入队者优先。 */
class TimerHeap {
  private items: TimerItem[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: TimerItem): void {
    const items = this.items;
    items.push(item);
    let child = items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (!TimerHeap.less(items[child]!, items[parent]!)) break;
      [items[parent], items[child]] = [items[child]!, items[parent]!];
      child = parent;
    }
  }

  pop(): TimerItem | undefined {
    const items = this.items;
    const top = items[0];
    if (top === undefined) return undefined;
    const last = items.pop()!;
    if (items.length > 0) {
      items[0] = last;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < items.length && TimerHeap.less(items[left]!, items[smallest]!)) smallest = left;
        if (right < items.length && TimerHeap.less(items[right]!, items[smallest]!)) smallest = right;
        if (smallest === parent) break;
        [items[parent], items[smallest]] = [items[smallest]!, items[parent]!];
        parent = smallest;
      }
    }
    return top;
  }

  private static less(a: TimerItem, b: TimerItem): boolean {
    return a.time < b.time || (a.time === b.time && a.seq < b.seq);
  }
}

/** FIFO 微任务队列，头部索引 + 定期压缩，避免 shift 的 O(n)。 */
class MicroQueue {
  private items: string[] = [];
  private head = 0;

  get size(): number {
    return this.items.length - this.head;
  }

  push(label: string): void {
    this.items.push(label);
  }

  shift(): string | undefined {
    if (this.head >= this.items.length) return undefined;
    const label = this.items[this.head]!;
    this.head += 1;
    if (this.head > 64 && this.head * 2 >= this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return label;
  }
}

export function run(program: Program, options: RunOptions): RunResult {
  const maxSteps = options.maxSteps;
  const heap = new TimerHeap();
  const microQueue = new MicroQueue();
  let seq = 0;
  let time = 0;
  let steps = 0;
  const trace: TraceEvent[] = [];
  const log: string[] = [];

  const api: ScheduleApi = {
    setTimeout(label: string, delay: number): void {
      if (!Number.isFinite(delay) || delay < 0) {
        throw new Error(`invalid delay for "${label}": ${delay}`);
      }
      heap.push({ time: time + delay, seq: seq++, label });
    },
    queueMicrotask(label: string): void {
      microQueue.push(label);
    },
    log(message: string): void {
      log.push(message);
    },
    now(): number {
      return time;
    },
  };

  const bodyOf = (label: string): TaskBody => {
    const body = program.tasks[label];
    if (body === undefined) throw new Error(`unknown task label: ${label}`);
    return body;
  };

  const exec = (phase: Phase, label: string, body: TaskBody): void => {
    trace.push({ step: steps, phase, label, time });
    steps += 1;
    body(api);
  };

  const finish = (status: RunStatus): RunResult => ({
    status,
    steps,
    time,
    trace,
    log,
    pending: { timers: heap.size, microtasks: microQueue.size },
  });

  if (maxSteps <= 0) return finish('budget-exceeded');

  // 宏任务 #0：初始脚本
  exec('macro', 'main', program.main);

  for (;;) {
    // 每个宏任务之后：排空微任务（含运行期间新派生的）
    for (;;) {
      if (microQueue.size === 0) break;
      if (steps >= maxSteps) return finish('budget-exceeded');
      const label = microQueue.shift()!;
      exec('micro', label, bodyOf(label));
    }
    // 再选最早的定时项
    if (heap.size === 0) return finish('settled');
    if (steps >= maxSteps) return finish('budget-exceeded');
    const timer = heap.pop()!;
    time = timer.time;
    exec('macro', timer.label, bodyOf(timer.label));
  }
}

/**
 * 重放校验：用同一程序与预算重新执行，要求轨迹与关键结果完全一致。
 * 轨迹可 JSON 序列化；重放前可对 recorded 做 JSON.parse(JSON.stringify(...)) 往返。
 */
export function replayTrace(program: Program, options: RunOptions, recorded: RunResult): RunResult {
  const again = run(program, options);
  const same =
    again.status === recorded.status &&
    again.steps === recorded.steps &&
    again.time === recorded.time &&
    JSON.stringify(again.trace) === JSON.stringify(recorded.trace) &&
    JSON.stringify(again.log) === JSON.stringify(recorded.log) &&
    JSON.stringify(again.pending) === JSON.stringify(recorded.pending);
  if (!same) throw new Error('trace is not replayable: re-execution diverged');
  return again;
}

/** 把轨迹格式化为可读时间线（亦便于落盘比对）。 */
export function formatTrace(result: RunResult): string {
  const lines = result.trace.map(
    (event) =>
      `#${String(event.step).padStart(3, '0')} ${event.phase.padEnd(5)} ${event.label} @t=${event.time}`,
  );
  lines.push(
    `status=${result.status} steps=${result.steps} time=${result.time} ` +
      `pending={timers:${result.pending.timers}, microtasks:${result.pending.microtasks}}`,
  );
  return lines.join('\n');
}
