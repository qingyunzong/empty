import type {
  Clock,
  PageAdapter,
  TimerHandle,
  VersionedSnapshot,
  WaitForStableOptions,
  WaitResult,
} from "./types.ts";

/**
 * 等待谓词在同一份文档版本上连续成立满 stableForMs。
 *
 * 事件模型（调用方保证串行）：
 * - 订阅变化、取消（AbortSignal）、计时器触发按到达顺序同步处理；
 * - 每次文档变化都用该变化携带的快照重新求值谓词，并重新计时；
 * - 稳定计时器触发时，仅当最新版本仍是计时开始时的版本，
 *   且当前时刻已达期限时才能成功；若总超时已到则超时优先；
 * - 终态产生后解除订阅并移除所有监听，迟到的回调无法再次完成。
 */
export function waitForStable<S>(
  options: WaitForStableOptions<S>,
): Promise<WaitResult<S>> {
  const { adapter, predicate, stableForMs, clock, signal } = options;
  const timeoutMs = options.timeoutMs ?? Number.POSITIVE_INFINITY;

  if (!Number.isFinite(stableForMs) || stableForMs <= 0) {
    throw new RangeError("stableForMs must be a positive finite number");
  }
  if (timeoutMs <= 0) {
    throw new RangeError("timeoutMs must be positive when provided");
  }
  if (typeof adapter?.read !== "function" || typeof adapter?.subscribe !== "function") {
    throw new TypeError("options.adapter must implement read() and subscribe()");
  }
  if (typeof predicate !== "function") {
    throw new TypeError("options.predicate must be a function");
  }
  if (typeof clock?.now !== "function" || typeof clock?.setTimer !== "function") {
    throw new TypeError("options.clock must implement now() and setTimer()");
  }

  return new Promise<WaitResult<S>>((resolve) => {
    // 1. 先读取当前版本与快照，再订阅该版本“之后”的变化，
    //    两次调用之间发生的变化由 subscribe 的重放补齐，不会遗漏。
    const initial = adapter.read();

    if (signal?.aborted) {
      resolve({ status: "cancelled", ...initial });
      return;
    }

    let latest: VersionedSnapshot<S> = initial;
    let settled = false;
    let unsubscribe: (() => void) | null = null;
    let stableHandle: TimerHandle | null = null;
    let totalHandle: TimerHandle | null = null;

    const startedAt = clock.now();
    const totalDeadline =
      timeoutMs === Number.POSITIVE_INFINITY
        ? Number.POSITIVE_INFINITY
        : startedAt + timeoutMs;

    const finish = (result: WaitResult<S>): void => {
      if (settled) {
        // 迟到回调：终态已经产生，直接忽略。
        return;
      }
      settled = true;
      if (stableHandle !== null) {
        clock.clearTimer(stableHandle);
        stableHandle = null;
      }
      if (totalHandle !== null) {
        clock.clearTimer(totalHandle);
        totalHandle = null;
      }
      if (unsubscribe !== null) {
        unsubscribe();
        unsubscribe = null;
      }
      if (signal !== null && signal !== undefined) {
        signal.removeEventListener("abort", onAbort);
      }
      resolve(result);
    };

    const armStableTimer = (sinceVersion: number, deadline: number): void => {
      if (stableHandle !== null) {
        clock.clearTimer(stableHandle);
      }
      const handle: TimerHandle = clock.setTimer(deadline, () => {
        if (settled || stableHandle !== handle) {
          // 已被后续变化重新计时或已终止：忽略这次迟到触发。
          return;
        }
        // 仅当最新版本仍是计时开始时的版本，且当前时刻已达期限。
        if (latest.version !== sinceVersion || clock.now() < deadline) {
          return;
        }
        if (clock.now() >= totalDeadline) {
          // 总超时已到：超时优先于稳定成功。
          finish({ status: "timeout", ...latest });
          return;
        }
        finish({ status: "satisfied", ...latest });
      });
      stableHandle = handle;
    };

    const evaluate = (event: VersionedSnapshot<S>): void => {
      latest = event;
      if (predicate(event.snapshot)) {
        // 每次（重新）求值成立都重新计时，期限绑定当前版本。
        armStableTimer(event.version, clock.now() + stableForMs);
      } else if (stableHandle !== null) {
        clock.clearTimer(stableHandle);
        stableHandle = null;
      }
    };

    const onChange = (event: VersionedSnapshot<S>): void => {
      if (settled) {
        return;
      }
      // 防御：适配器必须按版本顺序投递，旧版本/重复版本一律忽略。
      if (event.version <= latest.version) {
        return;
      }
      evaluate(event);
    };

    const onAbort = (): void => {
      if (settled) {
        return;
      }
      finish({ status: "cancelled", ...latest });
    };

    // 2. 先对读取到的初始快照求值；随后订阅，订阅期间同步重放的变化
    //    版本更高，会按顺序覆盖初始状态，不会被遗漏。
    evaluate(initial);

    unsubscribe = adapter.subscribe(initial.version, onChange);

    if (timeoutMs !== Number.POSITIVE_INFINITY) {
      const totalTimerHandle = clock.setTimer(totalDeadline, () => {
        if (settled || totalHandle !== totalTimerHandle) {
          return;
        }
        finish({ status: "timeout", ...latest });
      });
      totalHandle = totalTimerHandle;
    }

    signal?.addEventListener("abort", onAbort);
  });
}
