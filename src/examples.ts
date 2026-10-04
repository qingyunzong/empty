/**
 * 手写小例：每个例子附带人工推导的期望轨迹，用于测试核对。
 */
import type { LoopApi, TraceEvent } from "./simulator.ts";

export interface Example {
  name: string;
  stepBudget: number;
  setup: (api: LoopApi) => void;
  expectedStatus: "closed" | "exhausted";
  expectedTrace: TraceEvent[];
  expectedPending?: { timers: number; microtasks: number };
}

function trace(events: Array<[string, "macro" | "micro", number]>): TraceEvent[] {
  return events.map(([id, kind, time], step) => ({ step, kind, id, time }));
}

/** 例 1：定时器派生微任务，微任务再派生微任务，宏任务后一次性排空。 */
export const microChain: Example = {
  name: "micro-chain",
  stepBudget: 100,
  setup(api) {
    api.setTimer("t1", 5, () => {});
    api.setTimer("t2", 1, (a) => {
      a.queueMicrotask("m1", (a2) => {
        a2.queueMicrotask("m2", () => {});
      });
    });
  },
  expectedStatus: "closed",
  expectedTrace: trace([
    ["t2", "macro", 1],
    ["m1", "micro", 1],
    ["m2", "micro", 1],
    ["t1", "macro", 5],
  ]),
};

/** 例 2：宏任务执行期间注册新定时器，触发时间基于当前虚拟时钟。 */
export const timerSpawnsTimer: Example = {
  name: "timer-spawns-timer",
  stepBudget: 100,
  setup(api) {
    api.setTimer("t1", 3, (a) => {
      a.setTimer("t3", 1, () => {});
    });
    api.setTimer("t2", 5, () => {});
  },
  expectedStatus: "closed",
  expectedTrace: trace([
    ["t1", "macro", 3],
    ["t3", "macro", 4],
    ["t2", "macro", 5],
  ]),
};

/** 例 3：微任务无限自我派生，预算耗尽，返回未闭合状态。 */
export const microLoopUnclosed: Example = {
  name: "micro-loop-unclosed",
  stepBudget: 10,
  setup(api) {
    const spawn = (a: LoopApi): void => {
      a.queueMicrotask("spin", (a2) => spawn(a2));
    };
    api.queueMicrotask("spin", (a) => spawn(a));
  },
  expectedStatus: "exhausted",
  expectedTrace: trace(
    Array.from({ length: 10 }, () => ["spin", "micro", 0] as [string, "micro", number]),
  ),
  expectedPending: { timers: 0, microtasks: 1 },
};

/** 例 4：预算不足以跑完全部定时器，未闭合且报告剩余定时器数量。 */
export const timersUnclosed: Example = {
  name: "timers-unclosed",
  stepBudget: 2,
  setup(api) {
    api.setTimer("a", 1, () => {});
    api.setTimer("b", 2, () => {});
    api.setTimer("c", 3, () => {});
  },
  expectedStatus: "exhausted",
  expectedTrace: trace([
    ["a", "macro", 1],
    ["b", "macro", 2],
  ]),
  expectedPending: { timers: 1, microtasks: 0 },
};

/** 例 5：同刻定时器按注册顺序触发（先入先出平局裁决）。 */
export const sameTimeFifo: Example = {
  name: "same-time-fifo",
  stepBudget: 100,
  setup(api) {
    api.setTimer("first", 2, () => {});
    api.setTimer("second", 2, () => {});
    api.setTimer("third", 2, () => {});
  },
  expectedStatus: "closed",
  expectedTrace: trace([
    ["first", "macro", 2],
    ["second", "macro", 2],
    ["third", "macro", 2],
  ]),
};

export const allExamples: Example[] = [
  microChain,
  timerSpawnsTimer,
  microLoopUnclosed,
  timersUnclosed,
  sameTimeFifo,
];
