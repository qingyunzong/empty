/**
 * 可重放轨迹：序列化为 JSON Lines，并可用同一程序重放校验。
 */
import { runEventLoop } from "./simulator.ts";
import type { LoopApi, RunResult, TaskBody, TraceEvent } from "./simulator.ts";

export function serializeTrace(trace: TraceEvent[]): string {
  return trace.map((event) => JSON.stringify(event)).join("\n");
}

export function deserializeTrace(text: string): TraceEvent[] {
  return text
    .split("\n")
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as TraceEvent);
}

export function traceEquals(a: TraceEvent[], b: TraceEvent[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    if (x.step !== y.step || x.kind !== y.kind || x.id !== y.id || x.time !== y.time) {
      return false;
    }
  }
  return true;
}

/**
 * 用同一程序与相同预算重放，要求产生的轨迹与给定轨迹完全一致。
 * 返回重放结果；轨迹不一致时抛错。
 */
export function replay(
  setup: (api: LoopApi) => void,
  stepBudget: number,
  expected: TraceEvent[],
): RunResult {
  const result = runEventLoop(setup, { stepBudget });
  if (!traceEquals(result.trace, expected)) {
    throw new Error(
      `replay mismatch:\nexpected: ${serializeTrace(expected)}\nactual:   ${serializeTrace(result.trace)}`,
    );
  }
  return result;
}
