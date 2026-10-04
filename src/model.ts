/**
 * 独立队列模型（参照实现）。
 *
 * 与 simulator.ts 语义相同，但刻意采用完全不同的实现：
 *  - 定时器用普通数组 + 线性扫描取最小值（不用堆）；
 *  - 微任务用数组 + Array.prototype.shift（不用头索引）；
 *  - 循环组织为「检查点」结构：一个宏任务 + 随后排空微任务。
 * 不 import 主实现的任何代码，用于交叉核对。
 */

export interface ModelApi {
  setTimeout(label: string, delay: number): void;
  queueMicrotask(label: string): void;
  log(message: string): void;
  now(): number;
}

export type ModelTaskBody = (api: ModelApi) => void;

export interface ModelProgram {
  main: ModelTaskBody;
  tasks: Record<string, ModelTaskBody>;
}

export interface ModelTraceEvent {
  step: number;
  phase: 'macro' | 'micro';
  label: string;
  time: number;
}

export interface ModelResult {
  status: 'settled' | 'budget-exceeded';
  steps: number;
  time: number;
  trace: ModelTraceEvent[];
  log: string[];
  pending: { timers: number; microtasks: number };
}

interface ModelTimer {
  time: number;
  seq: number;
  label: string;
}

export function runModel(program: ModelProgram, maxSteps: number): ModelResult {
  let time = 0;
  let steps = 0;
  let seq = 0;
  const timers: ModelTimer[] = [];
  const microtasks: string[] = [];
  const trace: ModelTraceEvent[] = [];
  const log: string[] = [];

  const api: ModelApi = {
    setTimeout(label, delay) {
      if (!Number.isFinite(delay) || delay < 0) {
        throw new Error(`invalid delay for "${label}": ${delay}`);
      }
      timers.push({ time: time + delay, seq, label });
      seq += 1;
    },
    queueMicrotask(label) {
      microtasks.push(label);
    },
    log(message) {
      log.push(message);
    },
    now() {
      return time;
    },
  };

  const lookup = (label: string): ModelTaskBody => {
    const body = program.tasks[label];
    if (body === undefined) throw new Error(`unknown task label: ${label}`);
    return body;
  };

  const finish = (status: ModelResult['status']): ModelResult => ({
    status,
    steps,
    time,
    trace,
    log,
    pending: { timers: timers.length, microtasks: microtasks.length },
  });

  const takeEarliestTimer = (): ModelTimer | undefined => {
    let best = -1;
    for (let i = 0; i < timers.length; i += 1) {
      if (best === -1) {
        best = i;
        continue;
      }
      const candidate = timers[i]!;
      const current = timers[best]!;
      if (candidate.time < current.time || (candidate.time === current.time && candidate.seq < current.seq)) {
        best = i;
      }
    }
    if (best === -1) return undefined;
    return timers.splice(best, 1)[0];
  };

  /** 一个检查点：执行一个宏任务，随后排空微任务。预算耗尽返回 false。 */
  const checkpoint = (label: string, body: ModelTaskBody): boolean => {
    trace.push({ step: steps, phase: 'macro', label, time });
    steps += 1;
    body(api);
    while (microtasks.length > 0) {
      if (steps >= maxSteps) return false;
      const microLabel = microtasks.shift()!;
      trace.push({ step: steps, phase: 'micro', label: microLabel, time });
      steps += 1;
      lookup(microLabel)(api);
    }
    return true;
  };

  if (maxSteps <= 0) return finish('budget-exceeded');
  if (!checkpoint('main', program.main)) return finish('budget-exceeded');

  for (;;) {
    if (timers.length === 0) return finish('settled');
    if (steps >= maxSteps) return finish('budget-exceeded');
    const timer = takeEarliestTimer()!;
    time = timer.time;
    if (!checkpoint(timer.label, lookup(timer.label))) return finish('budget-exceeded');
  }
}
