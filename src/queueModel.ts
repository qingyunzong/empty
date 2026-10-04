/**
 * 独立队列模型（核对用）。
 *
 * 刻意采用与 simulator.ts 不同的朴素实现：
 *  - 定时器用普通数组 + 线性扫描找最小值（不用堆）；
 *  - 微任务用数组 + shift；
 *  - 只输出 (kind, id, time) 序列，供与主实现交叉核对。
 */
import type { LoopApi, TaskBody, TraceEvent } from "./simulator.ts";

interface TimerEntry {
  id: string;
  fireTime: number;
  seq: number;
  body: TaskBody;
}

export interface ModelResult {
  status: "closed" | "exhausted";
  trace: TraceEvent[];
  pendingTimers: number;
  pendingMicrotasks: number;
}

export function runQueueModel(
  setup: (api: LoopApi) => void,
  stepBudget: number,
): ModelResult {
  const timers: TimerEntry[] = [];
  const microtasks: { id: string; body: TaskBody }[] = [];
  let time = 0;
  let seq = 0;
  let steps = 0;
  const trace: TraceEvent[] = [];

  const api: LoopApi = {
    setTimer(id, delay, body) {
      timers.push({ id, fireTime: time + delay, seq: seq++, body });
    },
    queueMicrotask(id, body) {
      microtasks.push({ id, body });
    },
    now() {
      return time;
    },
  };

  setup(api);

  for (;;) {
    while (microtasks.length > 0) {
      if (steps >= stepBudget) {
        return {
          status: "exhausted",
          trace,
          pendingTimers: timers.length,
          pendingMicrotasks: microtasks.length,
        };
      }
      const micro = microtasks.shift()!;
      trace.push({ step: steps, kind: "micro", id: micro.id, time });
      steps++;
      micro.body(api);
    }
    if (timers.length === 0) {
      return { status: "closed", trace, pendingTimers: 0, pendingMicrotasks: 0 };
    }
    let earliest = 0;
    for (let i = 1; i < timers.length; i++) {
      const t = timers[i];
      const m = timers[earliest];
      if (t.fireTime < m.fireTime || (t.fireTime === m.fireTime && t.seq < m.seq)) {
        earliest = i;
      }
    }
    const [timer] = timers.splice(earliest, 1);
    if (timer.fireTime > time) time = timer.fireTime;
    if (steps >= stepBudget) {
      timers.push(timer);
      return {
        status: "exhausted",
        trace,
        pendingTimers: timers.length,
        pendingMicrotasks: microtasks.length,
      };
    }
    trace.push({ step: steps, kind: "macro", id: timer.id, time });
    steps++;
    timer.body(api);
  }
}
