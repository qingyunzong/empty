import { FingerprintMismatchError, StoragePersistenceError } from "./errors.js";
import { ControlledPromise } from "./controlled-promise.js";
import type {
  ActionOutcome,
  EventStore,
  IntentHandler,
  IntentResult,
  IntentStatus,
  LogEvent,
  ProbeResult,
  SubmitOptions,
} from "./types.js";

interface MutableState {
  fingerprint: string;
  status: IntentStatus;
  result?: IntentResult;
  /** 正在执行中的共享结果；同一 ID 的并发提交全部等待它 */
  inFlight?: Promise<IntentResult>;
  /** 恢复时缺少处理器而挂起：submit 提供处理器后需要重新走“先探测”流程 */
  pendingNoHandler?: boolean;
}

export interface ActionExecutorOptions {
  store: EventStore;
  /** 恢复期间已知意图的处理器（无处理器的未决意图会等 submit 提供） */
  handlers?: Record<string, IntentHandler>;
  now?: () => number;
}

interface RacedAction {
  timedOut: boolean;
  value?: unknown;
  error?: unknown;
}

type WithoutSeq<E> = E extends unknown ? Omit<E, "seq"> : never;
type AppendableEvent = WithoutSeq<LogEvent>;

/**
 * 动作执行器。
 *
 * 不变量：
 * 1. 动作超时后只允许调用只读探测器，只有 verdict=not_executed 才能再次动作。
 * 2. verdict=unknown（含探测器自身抛错）一律升级人工决断，绝不重试动作。
 * 3. 每次状态变更先持久化再推进；持久化失败向调用方报错，调用方重试提交是安全的。
 * 4. 同一 intentId 的并发提交共享同一个结果；指纹不一致直接报错。
 * 5. 恢复时对所有未决意图先探测，再决定复用结果、重试或人工决断。
 */
export class ActionExecutor {
  private states = new Map<string, MutableState>();
  private seq = 0;
  private readonly now: () => number;
  private readonly recovery: Promise<void>;
  private recoveryDone = false;
  /** 串行写入队列：链对象只赋值一次，失败在内部被消费，永不产生游离拒绝 */
  private writeChain: Promise<void> = Promise.resolve();
  private pendingWrites: Array<{
    event: AppendableEvent;
    deferred: ControlledPromise<void>;
  }> = [];
  private writeLoopRunning = false;

  constructor(private readonly options: ActionExecutorOptions) {
    this.now = options.now ?? (() => Date.now());
    this.recovery = this.recover().then(() => {
      this.recoveryDone = true;
    });
  }

  /** 等待启动恢复（重放日志 + 探测未决意图）完成 */
  ready(): Promise<void> {
    return this.recovery;
  }

  submit(opts: SubmitOptions): Promise<IntentResult> {
    // 恢复未完成时先挂起；恢复完成后同步分发，保证并发提交拿到同一个槽位对象
    if (this.recoveryDone) {
      return this.submitAfterRecovery(opts);
    }
    const slot = new ControlledPromise<IntentResult>();
    this.recovery.then(
      () => {
        this.submitAfterRecovery(opts).then(
          (result) => slot.resolve(result),
          (error: unknown) => slot.reject(error),
        );
      },
      (error: unknown) => slot.reject(error),
    );
    return slot;
  }

  private submitAfterRecovery(opts: SubmitOptions): Promise<IntentResult> {
    const existing = this.states.get(opts.intentId);
    if (existing) {
      if (existing.fingerprint !== opts.fingerprint) {
        return Promise.reject(
          new FingerprintMismatchError(
            opts.intentId,
            existing.fingerprint,
            opts.fingerprint,
          ),
        );
      }
      // 同一 ID 并发/重复提交：共享同一个结果，动作不会被再次触发
      if (existing.inFlight) return existing.inFlight;
      if (existing.pendingNoHandler) {
        existing.pendingNoHandler = false;
        const relaunched = this.resolveRecovered(opts.intentId, existing, {
          action: opts.action,
          probe: opts.probe,
        });
        existing.inFlight = relaunched;
        relaunched.then(
          () => {
            existing.inFlight = undefined;
          },
          () => {
            existing.inFlight = undefined;
          },
        );
        return relaunched;
      }
      return Promise.resolve(existing.result!);
    }

    // 先在本地占位，挡住并发提交；持久化失败则回滚占位。
    // 槽位用受控 Promise 持有，避免 .then 包装产生新对象、破坏引用共享。
    const state: MutableState = {
      fingerprint: opts.fingerprint,
      status: "running",
    };
    this.states.set(opts.intentId, state);

    const slot = new ControlledPromise<IntentResult>();
    state.inFlight = slot;

    void (async () => {
      try {
        await this.safeAppend({
          intentId: opts.intentId,
          type: "submitted",
          fingerprint: opts.fingerprint,
          at: this.now(),
        });
        slot.resolve(await this.runIntent(opts, 1));
      } catch (error) {
        slot.reject(error);
      }
    })();
    slot.then(
      () => {
        state.inFlight = undefined;
      },
      () => {
        state.inFlight = undefined;
      },
    );
    slot.catch(() => {
      this.states.delete(opts.intentId);
    });
    return slot;
  }

  getStatus(intentId: string): IntentStatus | undefined {
    return this.states.get(intentId)?.status;
  }

  getResult(intentId: string): IntentResult | undefined {
    return this.states.get(intentId)?.result;
  }

  private async recover(): Promise<void> {
    const events = await this.options.store.readAll();
    const byIntent = new Map<string, LogEvent[]>();
    for (const event of events) {
      this.seq = Math.max(this.seq, event.seq);
      const list = byIntent.get(event.intentId) ?? [];
      list.push(event);
      byIntent.set(event.intentId, list);
    }

    const pending: Promise<void>[] = [];
    for (const [intentId, list] of byIntent) {
      const submitted = list.find((event) => event.type === "submitted");
      if (!submitted || submitted.type !== "submitted") continue;

      const state: MutableState = {
        fingerprint: submitted.fingerprint,
        status: "running",
      };
      this.states.set(intentId, state);

      const terminal = [...list]
        .reverse()
        .find(
          (event) =>
            event.type === "resolved" || event.type === "manual_review",
        );

      if (terminal?.type === "resolved") {
        state.status =
          terminal.outcome === "success" ? "succeeded" : "failed";
        state.result = {
          intentId,
          outcome: terminal.outcome,
          status: state.status,
          value: terminal.value,
          reason: terminal.reason,
          attempts: terminal.attempts,
        };
        continue;
      }

      if (terminal?.type === "manual_review") {
        state.status = "manual_review";
        state.result = {
          intentId,
          outcome: "manual_review",
          status: "manual_review",
          reason: terminal.reason,
          attempts: terminal.attempts,
        };
        continue;
      }

      // 未决意图：恢复期间先登记共享 Promise，重复提交会并入它
      const handler = this.options.handlers?.[intentId];
      if (!handler) {
        // 没有处理器无法探测：挂起等待 submit 提供，绝不凭空动作
        state.pendingNoHandler = true;
        continue;
      }
      const promise = this.resolveRecovered(intentId, state, handler);
      state.inFlight = promise;
      pending.push(promise.then(() => undefined, () => undefined));
    }

    await Promise.all(pending);
  }

  /** 恢复未决意图：永远先只读探测，动作只在确认未执行后才可能再次发生 */
  private async resolveRecovered(
    intentId: string,
    state: MutableState,
    handler: IntentHandler,
  ): Promise<IntentResult> {
    const probe = await this.probeOnce(intentId, 0, handler);

    if (probe.verdict === "executed") {
      return this.finish(intentId, state, "success", {
        value: probe.detail,
        attempts: 0,
      });
    }
    if (probe.verdict === "unknown") {
      return this.manualReview(
        intentId,
        state,
        0,
        "恢复时只读探测无法确认动作是否已执行，禁止盲目重试",
        probe.detail,
      );
    }

    // 已确认未执行，重新执行才是安全的
    return this.runIntent(
      {
        intentId,
        fingerprint: state.fingerprint,
        action: handler.action,
        probe: handler.probe,
      },
      1,
    );
  }

  private async runIntent(
    opts: SubmitOptions,
    firstAttempt: number,
  ): Promise<IntentResult> {
    const state = this.states.get(opts.intentId)!;
    const timeoutMs = opts.timeoutMs ?? 30_000;
    // maxRetries = 初始尝试之外允许的重试次数，因此总尝试上限为 1 + maxRetries
    const maxAttempts = firstAttempt + (opts.maxRetries ?? 2);
    let attempt = firstAttempt;

    for (;;) {
      await this.safeAppend({
        intentId: opts.intentId,
        type: "action_started",
        attempt,
        at: this.now(),
      });

      const raced = await this.raceAction(opts.action, timeoutMs);

      if (!raced.timedOut) {
        if (raced.error !== undefined) {
          return this.finish(opts.intentId, state, "failure", {
            reason: `动作执行抛错：${stringifyError(raced.error)}`,
            attempts: attempt,
          });
        }
        return this.finish(opts.intentId, state, "success", {
          value: raced.value,
          attempts: attempt,
        });
      }

      // 超时：动作结果不可信，此后只能走只读探测
      await this.safeAppend({
        intentId: opts.intentId,
        type: "action_timed_out",
        attempt,
        at: this.now(),
      });

      const probe = await this.probeOnce(opts.intentId, attempt, {
        action: opts.action,
        probe: opts.probe,
      });

      if (probe.verdict === "executed") {
        // 超时后仍成功：复用迟到的成功，绝不重新动作
        return this.finish(opts.intentId, state, "success", {
          value: probe.detail,
          attempts: attempt,
        });
      }

      if (probe.verdict === "unknown") {
        return this.manualReview(
          opts.intentId,
          state,
          attempt,
          "超时后只读探测无法确认动作状态，需人工决断",
          probe.detail,
        );
      }

      // verdict === "not_executed"：确认未执行才允许再次动作
      if (attempt >= maxAttempts) {
        return this.finish(opts.intentId, state, "failure", {
          reason: `已重试 ${attempt} 次，动作仍超时且确认未执行，达到重试上限`,
          attempts: attempt,
        });
      }
      attempt += 1;
    }
  }

  /** 与动作竞速：超时只表示“暂时不知道结果”，底层 Promise 仍允许迟到完成 */
  private raceAction(
    action: () => Promise<unknown>,
    timeoutMs: number,
  ): Promise<RacedAction> {
    return new Promise<RacedAction>((resolve) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        resolve({ timedOut: true });
      }, timeoutMs);

      Promise.resolve()
        .then(action)
        .then(
          (value) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ timedOut: false, value });
          },
          (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            resolve({ timedOut: false, error });
          },
        );
    });
  }

  /** 调用只读探测器；探测器自身抛错等价于 unknown（无法确定 → 人工决断） */
  private async probeOnce(
    intentId: string,
    attempt: number,
    handler: IntentHandler | undefined,
  ): Promise<ProbeResult> {
    let result: ProbeResult;
    if (!handler) {
      result = {
        verdict: "unknown",
        detail: "未提供只读探测器",
      };
    } else {
      try {
        result = await handler.probe();
      } catch (error) {
        result = {
          verdict: "unknown",
          detail: `探测器抛错：${stringifyError(error)}`,
        };
      }
    }

    await this.safeAppend({
      intentId,
      type: "probed",
      attempt,
      result,
      at: this.now(),
    });
    return result;
  }

  private async finish(
    intentId: string,
    state: MutableState,
    outcome: Extract<ActionOutcome, "success" | "failure">,
    parts: { value?: unknown; reason?: string; attempts: number },
  ): Promise<IntentResult> {
    const result: IntentResult = {
      intentId,
      outcome,
      status: outcome === "success" ? "succeeded" : "failed",
      value: parts.value,
      reason: parts.reason,
      attempts: parts.attempts,
    };
    await this.safeAppend({
      intentId,
      type: "resolved",
      outcome,
      attempts: parts.attempts,
      value: parts.value,
      reason: parts.reason,
      at: this.now(),
    });
    state.status = result.status;
    state.result = result;
    return result;
  }

  private async manualReview(
    intentId: string,
    state: MutableState,
    attempts: number,
    reason: string,
    detail?: unknown,
  ): Promise<IntentResult> {
    let result: IntentResult;
    try {
      await this.append({
        intentId,
        type: "manual_review",
        attempts,
        reason,
        detail,
        at: this.now(),
      });
      result = {
        intentId,
        outcome: "manual_review",
        status: "manual_review",
        reason,
        attempts,
      };
    } catch (error) {
      // 日志已完全不可用：无法再安全推进，只能在内存中挂起并要求人工介入
      result = {
        intentId,
        outcome: "manual_review",
        status: "manual_review",
        reason: `${reason}；且人工决断事件持久化失败：${stringifyError(
          error,
        )}`,
        attempts,
      };
    }
    state.status = "manual_review";
    state.result = result;
    return result;
  }

  private async safeAppend(event: AppendableEvent): Promise<void> {
    await this.append(event);
  }

  private async append(event: AppendableEvent): Promise<void> {
    const deferred = new ControlledPromise<void>();
    this.pendingWrites.push({ event, deferred });
    this.kickWriteLoop();
    await deferred;
  }

  private kickWriteLoop(): void {
    if (this.writeLoopRunning) return;
    this.writeLoopRunning = true;
    this.writeChain = this.writeChain.then(() => this.runWriteLoop());
    this.writeChain.catch(() => undefined);
  }

  private async runWriteLoop(): Promise<void> {
    while (this.pendingWrites.length > 0) {
      const item = this.pendingWrites.shift()!;
      this.seq += 1;
      const full = { ...item.event, seq: this.seq } as LogEvent;
      try {
        await this.options.store.append(full);
        item.deferred.resolve();
      } catch (error) {
        item.deferred.reject(new StoragePersistenceError(error));
      }
    }
    this.writeLoopRunning = false;
  }
}

function stringifyError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
